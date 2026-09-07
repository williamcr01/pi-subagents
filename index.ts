import { resolve } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionUIContext,
	type KeybindingsManager,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, Text, type EditorComponent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { currentDepth, loadSettings, THINKING_LEVEL_VALUES } from "./config.ts";
import { requestOwnerMessage, startOwnerMessageConsumer } from "./owner-control.ts";
import { SubagentPanel } from "./panel.ts";
import { isProcessAlive, isTerminalStatus, markRecordResultState, readRecords } from "./registry.ts";
import { notifyWaiters, waitUntilSubagentsIdle } from "./wait.ts";
import {
	cancelSubagent,
	killPidTree,
	sendSubagentMessage,
	startSubagent,
	terminateOwnedSubagents,
} from "./spawn-agent.ts";
import { descendantsOf, resolveAgentRecord } from "./registry.ts";
import type { AgentRecord, SubagentSettings } from "./types.ts";

interface RuntimeState {
	runId: string;
	rootRunId: string;
	depth: number;
	settings: SubagentSettings;
	projectTrusted: boolean;
}

type EditorFactory = ReturnType<ExtensionUIContext["getEditorComponent"]>;

interface CursorAwareEditor extends EditorComponent {
	isShowingAutocomplete(): boolean;
	getCursor(): { line: number; col: number };
	getLines(): string[];
}

function isCursorAwareEditor(editor: EditorComponent): editor is CursorAwareEditor {
	const candidate = editor as Partial<CursorAwareEditor>;
	return (
		typeof candidate.isShowingAutocomplete === "function" &&
		typeof candidate.getCursor === "function" &&
		typeof candidate.getLines === "function"
	);
}

function composePanelNavigation(
	editor: EditorComponent,
	keybindings: KeybindingsManager,
	openPanel: () => boolean | undefined,
): EditorComponent {
	if (!isCursorAwareEditor(editor)) return editor;
	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		const isDown = keybindings.matches(data, "tui.editor.cursorDown") || matchesKey(data, Key.down);
		if (isDown && !editor.isShowingAutocomplete()) {
			const cursor = editor.getCursor();
			const lines = editor.getLines();
			const lastLine = lines.length - 1;
			if (cursor.line === lastLine && cursor.col === (lines[lastLine]?.length ?? 0) && openPanel()) return;
		}
		handleInput(data);
	};
	return editor;
}

const SpawnAgentSchema = Type.Object({
	task: Type.String({ description: "Focused task to delegate to the subagent" }),
	name: Type.Optional(Type.String({ description: "Readable subagent name" })),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the current agent unless absolute" })),
	model: Type.Optional(Type.String({ description: "Exact model selector. Overrides configured and inherited defaults." })),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level for this subagent", enum: [...THINKING_LEVEL_VALUES] }),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Exact subset of the creating session's active tools; omit to inherit all active tools" })),
});

const CheckSchema = Type.Object({
	wait: Type.Optional(Type.Boolean({ description: "Block until every subagent finishes; returns as soon as they all finish or the timeout elapses" })),
	timeoutMs: Type.Optional(Type.Integer({ description: "Max wait in ms when wait:true (default 30000, max 300000). Returns sooner if every descendant finishes." })),
});

const CancelSchema = Type.Object({
	target: Type.String({ description: "Subagent run id (or unique prefix), session id, or exact name" }),
});

const SendSchema = Type.Object({
	target: Type.String({ description: "Subagent run id (or unique prefix), session id, or exact name" }),
	message: Type.String({ description: "Instruction or follow-up to send to the subagent" }),
});

const RESULT_OUTPUT_CAP = 8000;

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function shortId(runId: string): string {
	return runId.slice(0, 8);
}

export default function subagentsExtension(pi: ExtensionAPI) {
	let runtime: RuntimeState | undefined;
	let panel: SubagentPanel | undefined;
	let mainModel: string | undefined;
	let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	let deliveryRetryDelay = 1000;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	let stopOwnerConsumer: (() => Promise<void>) | undefined;
	let sessionAbort = new AbortController();
	let shuttingDown = false;
	let agentActive = false;
	let isIdle: (() => boolean) | undefined;
	let delivering = false;
	let deliveryPaused = false;
	let activeSignal: AbortSignal | undefined;
	const deliveredResults = new Set<string>();
	const seenDescendantResults = new Set<string>();
	const resultKey = (record: AgentRecord) => JSON.stringify([
		record.runId, record.executionId ?? record.finishedAt ?? record.updatedAt,
	]);
	const rememberDelivered = (records: AgentRecord[]) => {
		for (const record of records) {
			deliveredResults.add(resultKey(record));
			try { markRecordResultState(getAgentDir(), record, "resultsDelivered"); } catch {
				// Keep the report in the returned content even if disk persistence fails.
				// Session receipts restore this in-memory claim after reload.
			}
		}
	};
	const restoreReceipts = (entries: readonly SessionEntry[]) => {
		seenDescendantResults.clear();
		for (const entry of entries) {
			const rawDetails = entry.type === "custom_message" && entry.customType === "subagent-results"
				? entry.details : entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
			const details = rawDetails as { resultKeys?: unknown; seenDescendantResults?: unknown } | undefined;
			for (const key of Array.isArray(details?.resultKeys) ? details.resultKeys : []) {
				if (typeof key === "string") deliveredResults.add(key);
			}
			for (const key of Array.isArray(details?.seenDescendantResults) ? details.seenDescendantResults : []) {
				if (typeof key === "string") seenDescendantResults.add(key);
			}
		}
	};
	let previousEditorFactory: EditorFactory;
	let installedEditorFactory: EditorFactory;

	const modelLabel = (ctx: { model?: { provider: string; id: string } }): string | undefined =>
		ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	/** Hold the event loop open while background children run (matters for print-mode parents). */
	const refreshKeepAlive = () => {
		if (!runtime || shuttingDown) return;
		const pending = readRecords(getAgentDir()).some(
			(record) => record.parentRunId === runtime!.runId && !isTerminalStatus(record.status),
		);
		if (pending && !keepAlive) {
			keepAlive = setInterval(() => {}, 60000);
		} else if (!pending && keepAlive) {
			clearInterval(keepAlive);
			keepAlive = undefined;
		}
	};

	/** Deliver finished-but-undelivered child results to this session, debounced so parallel finishes batch into one message. */
	const scheduleDelivery = (delay = 1000) => {
		if (deliveryTimer || shuttingDown) return;
		deliveryTimer = setTimeout(async () => {
			deliveryTimer = undefined;
			try {
				await deliverResults();
				deliveryRetryDelay = 1000;
			} catch {
				// Keep the result unclaimed and back off while this session is alive.
				const retryDelay = deliveryRetryDelay;
				deliveryRetryDelay = Math.min(deliveryRetryDelay * 2, 30000);
				scheduleDelivery(retryDelay);
			}
		}, delay);
		// Unlike progress/debounce timers, this timer is the only thing that can
		// deliver a completed result after a print-mode parent becomes idle. Keep it
		// referenced so the parent cannot exit before the automatic delivery runs.
	};

	const deliverResults = async () => {
		// Never put result snapshots in Pi's follow-up queue while work is active.
		// Tool results drain the inbox during a run; agent_settled wakes it at idle.
		if (!runtime || shuttingDown || delivering || deliveryPaused || agentActive || isIdle?.() === false) return;
		const agentDir = getAgentDir();
		const children = readRecords(agentDir).filter((record) => record.parentRunId === runtime!.runId);
		const pending = children.filter((record) => isTerminalStatus(record.status) && !record.resultsDelivered && !deliveredResults.has(resultKey(record)));
		if (pending.length === 0) return;
		const stillRunning = children.filter((record) => !isTerminalStatus(record.status)).length;
		const parts = pending.map((record) => {
			const head = `### ${record.name} — ${record.status}`;
			const body =
				record.status === "completed"
					? cap(record.latestText || "(no output)", RESULT_OUTPUT_CAP)
					: cap(record.error || record.status, RESULT_OUTPUT_CAP);
			return `${head}\n\n${body}`;
		});
		const intro =
			stillRunning > 0
				? `Subagent results (${pending.length} finished, ${stillRunning} still running):`
				: `All ${pending.length} subagent${pending.length === 1 ? "" : "s"} finished:`;
		// Pi's extension binding returns void, not a model-completion receipt.
		// At idle it starts the prompt directly instead of queueing a follow-up.
		// Also honor rejection from hosts that return a promise.
		delivering = true;
		try {
			await pi.sendMessage(
				{
					customType: "subagent-results",
					content: `${intro}\n\n${parts.join("\n\n")}`,
					display: true,
					details: { resultKeys: pending.map(resultKey) },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			rememberDelivered(pending);
		} finally {
			delivering = false;
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		agentActive = true;
		deliveryPaused = false;
		activeSignal = ctx.signal;
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") deliveryPaused = true;
	});
	pi.on("agent_settled", () => {
		agentActive = false;
		if (activeSignal?.aborted) deliveryPaused = true;
		if (!deliveryPaused) scheduleDelivery(0);
	});
	pi.on("session_tree", (_event, ctx) => restoreReceipts(ctx.sessionManager.getBranch()));

	// Attach fresh results to a completed tool, rather than queueing a separate
	// prompt. Pi persists this content and includes it in the next model call.
	// This does not steer the agent or skip any sibling tool calls.
	pi.on("tool_result", (event, ctx) => {
		if (ctx.signal?.aborted) { deliveryPaused = true; return; }
		if (!runtime || shuttingDown || delivering || deliveryPaused) return;
		// Custom tools may use scalar/array details. Leave their result shape alone.
		if (event.details !== undefined && (!event.details || typeof event.details !== "object" || Array.isArray(event.details))) return;
		const details = event.details as Record<string, unknown> | undefined;
		const previousKeys = Array.isArray(details?.resultKeys) ? details.resultKeys : [];
		const agentDir = getAgentDir();
		const pending = readRecords(agentDir).filter(
			(record) => record.parentRunId === runtime!.runId && isTerminalStatus(record.status) && !record.resultsDelivered && !deliveredResults.has(resultKey(record)),
		);
		if (pending.length === 0) return;
		const text = pending.map((record) => {
			const body = record.status === "completed" ? record.latestText || "(no output)" : record.error || record.status;
			return `### ${record.name} — ${record.status}\n\n${cap(body, RESULT_OUTPUT_CAP)}`;
		}).join("\n\n");
		rememberDelivered(pending);
		return {
			content: [...event.content, { type: "text" as const, text: `Subagent results:\n\n${text}` }],
			details: { ...details, resultKeys: [...previousKeys, ...pending.map(resultKey)] },
		};
	});

	pi.registerFlag("subagent-depth", {
		description: "Maximum recursive subagent depth (any non-negative integer)",
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		agentActive = false;
		isIdle = () => ctx.isIdle?.() ?? !agentActive;
		deliveryPaused = false;
		deliveredResults.clear();
		restoreReceipts(ctx.sessionManager.getBranch?.() ?? []);
		const runId = process.env.PI_SUBAGENT_RUN_ID || ctx.sessionManager.getSessionId();
		const rootRunId = process.env.PI_SUBAGENT_ROOT_ID || runId;
		try {
			runtime = {
				runId,
				rootRunId,
				depth: currentDepth(),
				settings: loadSettings({
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					depthFlag: typeof pi.getFlag("subagent-depth") === "string" ? String(pi.getFlag("subagent-depth")) : undefined,
				}),
				projectTrusted: ctx.isProjectTrusted(),
			};
		} catch (error) {
			runtime = undefined;
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}

		if (!runtime) return;
		scheduleDelivery();

		// Recursive messages go to the target's owner, never directly to its
		// input loop: only the owner can reserve/release its concurrency slot.
		sessionAbort = new AbortController();
		const owner = runtime;
		stopOwnerConsumer = startOwnerMessageConsumer(getAgentDir(), owner.runId, owner.rootRunId, async (target, text, signal) => {
			const record = readRecords(getAgentDir()).find((item) => item.runId === target);
			if (!record || record.parentRunId !== owner.runId || record.rootRunId !== owner.rootRunId) {
				throw new Error("Subagent is not owned by this session");
			}
			if (record.status === "cancelled") throw new Error(`${record.name} was cancelled`);
			if (!await sendSubagentMessage(record, text, signal)) throw new Error(`${record.name} is no longer running`);
		});

		if (ctx.mode !== "tui") return;

		mainModel = modelLabel(ctx);

		let editor: EditorComponent | undefined;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				if (!panel) {
					panel = new SubagentPanel(tui, theme, getAgentDir(), runtime!.runId, {
						onMessage: async (record, text) => sendToRecord(record, text),
						onCancel: (record) => {
							const latest = readRecords(getAgentDir()).find((item) => item.runId === record.runId) ?? record;
							if (!isTerminalStatus(latest.status)) trackChild(cancelSubagent(getAgentDir(), latest));
						},
					});
					if (editor) panel.setEditor(editor);
					panel.setMainModel(mainModel);
				} else {
					panel.setTheme(theme);
				}
				return panel;
			},
			{ placement: "belowEditor" },
		);

		previousEditorFactory = ctx.ui.getEditorComponent();
		installedEditorFactory = (tui, theme, keybindings) => {
			const baseEditor = previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			editor = composePanelNavigation(baseEditor, keybindings, () => panel?.open());
			panel?.setEditor(editor);
			return editor;
		};
		ctx.ui.setEditorComponent(installedEditorFactory);
	});

	pi.registerMessageRenderer("subagent-results", (message, _options, _theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		return new Markdown(text, 1, 0, getMarkdownTheme());
	});

	const trackChild = (record: AgentRecord) => {
		if (shuttingDown) return;
		refreshKeepAlive();
		notifyWaiters(getAgentDir());
		if (isTerminalStatus(record.status)) scheduleDelivery();
	};

	const resolveRecord = (target: string): AgentRecord => {
		if (!runtime) throw new Error("Subagent extension settings failed to initialize");
		const rows = descendantsOf(readRecords(getAgentDir()), runtime.runId);
		return resolveAgentRecord(rows, target);
	};

	const sendToRecord = async (record: AgentRecord, text: string, signal?: AbortSignal): Promise<void> => {
		if (!runtime) throw new Error("Subagent extension settings failed to initialize");
		signal = signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
		const latest = readRecords(getAgentDir()).find((item) => item.runId === record.runId) ?? record;
		if (latest.status === "cancelled") throw new Error(`${latest.name} was cancelled`);
		if (await sendSubagentMessage(latest, text, signal)) return;
		if (isTerminalStatus(latest.status) && (!latest.pid || !isProcessAlive(latest.pid))) {
			throw new Error(`${latest.name} is no longer running`);
		}
		await requestOwnerMessage(getAgentDir(), latest.parentRunId, {
			targetRunId: latest.runId,
			rootRunId: runtime.rootRunId,
			text,
		}, {
			signal,
			ownerAlive: () => {
				const owner = readRecords(getAgentDir()).find((item) => item.runId === latest.parentRunId);
				return !!owner?.pid && isProcessAlive(owner.pid);
			},
		});
	};

	pi.on("input", (event) => {
		// A new user turn cleans finished subagents out of the footer tree.
		// History (including transcripts) stays reviewable via /subagents.
		if (event.source !== "interactive") return;
		try {
			panel?.dismissFinished();
		} catch {
			// Footer cleanup must never block the user's message.
		}
	});

	pi.on("model_select", (_event, ctx) => {
		panel?.setMainModel(modelLabel(ctx));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		panel?.dispose();
		panel = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("subagents", undefined);
			if (ctx.ui.getEditorComponent() === installedEditorFactory) {
				ctx.ui.setEditorComponent(previousEditorFactory);
			}
			previousEditorFactory = undefined;
			installedEditorFactory = undefined;
		}
		if (deliveryTimer) {
			clearTimeout(deliveryTimer);
			deliveryTimer = undefined;
		}
		if (keepAlive) {
			clearInterval(keepAlive);
			keepAlive = undefined;
		}
		sessionAbort.abort();
		const consumerStopped = stopOwnerConsumer?.();
		stopOwnerConsumer = undefined;
		// This pi process is going away: stop every live descendant. Completed
		// RPC children stay resumable only for the lifetime of their parent session.
		if (!runtime) return;
		const agentDir = getAgentDir();
		const records = descendantsOf(readRecords(agentDir), runtime.runId);
		for (const record of records.slice().reverse()) {
			try {
				if (isTerminalStatus(record.status)) {
					if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid, record.pidStartTime);
				} else {
					cancelSubagent(agentDir, record);
				}
			} catch {
				// Cross-process cleanup is best effort. Owned children are awaited below.
			}
		}
		await terminateOwnedSubagents(records.map((record) => record.runId));
		await consumerStopped;
	});

	pi.registerCommand("subagents", {
		description: "Review the current agent's subagents, including finished ones",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!panel?.openReview()) ctx.ui.notify("This agent has no subagents yet", "info");
		},
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn an isolated recursive Pi subagent that runs in the background and returns immediately. Omit model to use subagents.json defaultModel, or inherit the creating agent's active model. Omit tools to inherit the creating session's active tools; an explicit list may only remove tools. The child keeps running while you do other work; collect results with check_subagents. Finished results also arrive with the next completed tool result, or automatically when you go idle.",
		promptSnippet: "Delegate focused independent work to an isolated recursive subagent running in the background",
		promptGuidelines: [
			"spawn_agent returns immediately; the child keeps running while you continue other work.",
			"Call check_subagents with wait:true before your final answer whenever spawned results matter, and use cancel_subagent to stop a runaway child.",
		],
		parameters: SpawnAgentSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const record = await startSubagent(
				{
					task: params.task,
					name: params.name,
					cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : undefined,
					model: params.model,
					thinking: params.thinking,
					tools: params.tools,
				},
				{
					agentDir: getAgentDir(),
					parentRunId: runtime.runId,
					rootRunId: runtime.rootRunId,
					currentDepth: runtime.depth,
					settings: runtime.settings,
					parentModel,
					parentThinking: ctx.thinkingLevel ?? "off",
					parentTools: pi.getActiveTools(),
					scopedModels: ctx.scopedModels.map(({ model, thinkingLevel }) => ({ provider: model.provider, id: model.id, thinkingLevel })),
					parentCwd: ctx.cwd,
					projectTrusted: runtime.projectTrusted,
					persistAfterSettled: ctx.mode === "tui" || ctx.mode === "rpc",
					signal,
					onRecord: trackChild,
					onUiRequest: async (child, request) => {
						const title = `[${child.name}] ${request.title || "Subagent request"}`;
						const opts = typeof request.timeout === "number" ? { timeout: request.timeout } : undefined;
						switch (request.method) {
							case "select": {
								const value = await ctx.ui.select(title, request.options ?? [], opts);
								return value === undefined ? { cancelled: true } : { value };
							}
							case "confirm":
								return { confirmed: await ctx.ui.confirm(title, request.message ?? "", opts) };
							case "input": {
								const value = await ctx.ui.input(title, request.placeholder, opts);
								return value === undefined ? { cancelled: true } : { value };
							}
							case "editor": {
								const value = await ctx.ui.editor(title, request.prefill);
								return value === undefined ? { cancelled: true } : { value };
							}
							case "notify":
								ctx.ui.notify(`[${child.name}] ${request.message ?? ""}`, request.notifyType);
						}
					},
					onSettled: trackChild,
				},
			);
			return {
				content: [
					{
						type: "text",
						text: `Spawned subagent "${record.name}" (run ${shortId(record.runId)}, depth ${record.depth}/${record.maxDepth}, model ${record.model}). It is ${record.status === "queued" ? "queued" : "running in the background"} — continue with other work and call check_subagents (wait:true) to collect its result.`,
					},
				],
				details: { record },
			};
		},
		renderCall(args, theme) {
			const name = args.name?.trim() || args.task.replace(/\s+/g, " ").slice(0, 50);
			const model = args.model ? ` · ${args.model}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent"))} ${theme.fg("accent", name)}${theme.fg("dim", model)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const record = (result.details as { record?: AgentRecord } | undefined)?.record;
			if (!record) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(
				`${theme.fg("accent", "◌")} ${theme.fg("accent", record.name)} ${theme.fg("dim", "· spawned in background")}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "check_subagents",
		label: "Check Subagents",
		description:
			"Check the status of this session's subagents and collect newly finished results without repeating ones already delivered. Use wait:true to block until they all finish; the call returns as soon as they do, and timeoutMs is only a maximum.",
		promptSnippet: "Check or wait for background subagent results",
		parameters: CheckSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			const agentDir = getAgentDir();
			const snapshot = () => descendantsOf(readRecords(agentDir), runtime!.runId);
			if (params.wait) {
				const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 30000, 0), 300000);
				await waitUntilSubagentsIdle(agentDir, runtime.runId, { timeoutMs, signal });
			}
			// Refresh before claiming results so auto-delivery that happened while
			// waiting is not repeated by this check.
			const rows = snapshot();
			// This session owns delivery only for its direct children. Descendant
			// results remain visible, but their direct parent must claim them.
			const newlyFinished = rows.filter(
				(record) => record.parentRunId === runtime!.runId && isTerminalStatus(record.status) && !record.resultsDelivered && !deliveredResults.has(resultKey(record)),
			);
			rememberDelivered(newlyFinished);
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No subagents have been spawned by this session." }], details: { records: [] } };
			}
			const running = rows.filter((record) => !isTerminalStatus(record.status));
			const newlyFinishedIds = new Set(newlyFinished.map((record) => record.runId));
			const observedDescendants: string[] = [];
			const sections = rows
				.filter(
					(record) =>
						!isTerminalStatus(record.status) ||
						newlyFinishedIds.has(record.runId) ||
						(record.parentRunId !== runtime!.runId && !record.resultsDelivered && !seenDescendantResults.has(resultKey(record))),
				)
				.map((record) => {
					if (record.parentRunId !== runtime!.runId && isTerminalStatus(record.status)) {
						const key = resultKey(record);
						seenDescendantResults.add(key);
						observedDescendants.push(key);
					}
					const readOnly = record.parentRunId !== runtime!.runId ? " · read-only descendant" : "";
					const meta = `${record.model} · depth ${record.depth}/${record.maxDepth} · ${record.cwd}${record.runId ? ` · run ${shortId(record.runId)}` : ""}${readOnly}`;
					let body: string;
					if (isTerminalStatus(record.status)) {
						body =
							record.status === "completed"
								? cap(record.latestText || "(no output)", RESULT_OUTPUT_CAP)
								: cap(record.error || record.status, RESULT_OUTPUT_CAP);
					} else {
						body = `still running: ${record.currentTool || record.activity || record.status}`;
					}
					return `### ${record.name} — ${record.status}\n${meta}\n\n${body}`;
				});
			const summary =
				running.length > 0
					? `${rows.length - running.length}/${rows.length} finished, ${running.length} still running.`
					: `All ${rows.length} subagent${rows.length === 1 ? "" : "s"} finished.`;
			const sectionText = sections.length > 0 ? sections.join("\n\n") : "No new subagent results since the last check.";
			return {
				content: [{ type: "text", text: `${summary}\n\n${sectionText}` }],
				details: { records: rows, resultKeys: newlyFinished.map(resultKey), seenDescendantResults: observedDescendants },
			};
		},
	});

	pi.registerTool({
		name: "send_to_subagent",
		label: "Send to Subagent",
		description: "Send a course correction or follow-up to a live subagent by run id, session id, or exact name.",
		promptSnippet: "Steer or follow up with a live background subagent",
		parameters: SendSchema,
		async execute(_toolCallId, params, signal) {
			const record = resolveRecord(params.target);
			await sendToRecord(record, params.message, signal);
			return {
				content: [{ type: "text", text: `Sent a message to ${record.name}.` }],
				details: { record },
			};
		},
	});

	pi.registerTool({
		name: "cancel_subagent",
		label: "Cancel Subagent",
		description: "Cancel a running or queued subagent of this session by run id, session id, or exact name.",
		promptSnippet: "Stop a running background subagent",
		parameters: CancelSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const agentDir = getAgentDir();
			const record = resolveRecord(params.target);
			if (isTerminalStatus(record.status)) {
				return { content: [{ type: "text", text: `${record.name} already finished (${record.status}).` }], details: { record } };
			}
			const cancelled = cancelSubagent(agentDir, record);
			trackChild(cancelled);
			return { content: [{ type: "text", text: `Cancelled ${cancelled.name}.` }], details: { record: cancelled } };
		},
	});

	// Keep killPidTree referenced for session_shutdown cleanup paths that go
	// through cancelSubagent; exported for tests and future direct use.
	void killPidTree;
}
