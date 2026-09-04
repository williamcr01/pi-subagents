import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applyChildEvent, type ParsedChildState } from "./events.ts";
import { descendantsOf, isProcessAlive, isTerminalStatus, readRecords, saveRecord } from "./registry.ts";
import { EMPTY_USAGE, type AgentRecord, type SpawnAgentInput, type SubagentSettings } from "./types.ts";

const STDERR_LIMIT = 4000;

export class ConcurrencyGate {
	private running = 0;
	private waiters: Array<{ limit: number; resolve: (release: () => void) => void; reject: (error: Error) => void }> = [];

	/** True when a spawn with this limit would have to queue. */
	isFull(limit: number): boolean {
		return limit !== -1 && this.running >= limit;
	}

	acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
		if (limit === -1 || this.running < limit) {
			this.running++;
			return Promise.resolve(this.releaseOnce());
		}
		return new Promise((resolve, reject) => {
			const waiter = { limit, resolve, reject };
			this.waiters.push(waiter);
			if (signal) {
				const abort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Subagent was aborted while waiting for a concurrency slot"));
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	}

	private releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.running--;
			this.drain();
		};
	}

	private drain(): void {
		for (let index = 0; index < this.waiters.length; index++) {
			const waiter = this.waiters[index]!;
			if (waiter.limit !== -1 && this.running >= waiter.limit) continue;
			this.waiters.splice(index, 1);
			this.running++;
			waiter.resolve(this.releaseOnce());
			index--;
		}
	}
}

export const gate = new ConcurrencyGate();

interface LiveChild {
	sendMessage(message: string): Promise<void>;
}

const liveChildren = new Map<string, LiveChild>();
const startingChildren = new Map<string, Promise<LiveChild | null>>();
const resolveStarting = new Map<string, (child: LiveChild | null) => void>();

/** Send directly when this process owns the target child. */
export async function sendSubagentMessage(record: AgentRecord, message: string): Promise<boolean> {
	const startup = startingChildren.get(record.runId);
	const live = startup ? await startup : liveChildren.get(record.runId);
	if (!live) return false;
	await live.sendMessage(message);
	return true;
}

export interface SpawnContext {
	agentDir: string;
	parentRunId: string;
	rootRunId: string;
	currentDepth: number;
	settings: SubagentSettings;
	parentModel?: string;
	parentThinking: string;
	parentCwd: string;
	projectTrusted: boolean;
	persistAfterSettled?: boolean;
	signal?: AbortSignal;
	onRecord?: (record: AgentRecord) => void;
	onUiRequest?: (record: AgentRecord, request: any) => Promise<Record<string, unknown> | void>;
	/** Fired once per child when it reaches a terminal state. */
	onSettled?: (record: AgentRecord) => void;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Test hook: run a fake child instead of the real pi binary.
	const override = process.env.PI_SUBAGENT_COMMAND;
	if (override) return { command: process.execPath, args: [override, ...args] };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function compactName(input: SpawnAgentInput): string {
	const value = input.name?.trim() || input.task.replace(/\s+/g, " ").trim().slice(0, 60) || "subagent";
	return value.slice(0, 100);
}

function ensureDirectory(value: string): string {
	const cwd = resolve(value);
	let valid = false;
	try {
		valid = statSync(cwd).isDirectory();
	} catch {
		// Report one stable error below.
	}
	if (!valid) throw new Error(`Subagent working directory does not exist: ${cwd}`);
	return cwd;
}

export function killPidTree(pid: number): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 3000).unref();
}

/** Force-cancel a running or queued child and all of its descendants. */
export function cancelSubagent(agentDir: string, record: AgentRecord): AgentRecord {
	const cancelOne = (item: AgentRecord): AgentRecord => {
		if (item.pid && isProcessAlive(item.pid)) killPidTree(item.pid);
		const updated: AgentRecord = {
			...item,
			status: "cancelled",
			activity: "cancelled",
			error: item.error ?? "Cancelled",
			finishedAt: item.finishedAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		saveRecord(agentDir, updated);
		return updated;
	};
	for (const child of descendantsOf(readRecords(agentDir), record.runId).reverse()) {
		if (!isTerminalStatus(child.status)) cancelOne(child);
	}
	return cancelOne(record);
}

async function findSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		return (await SessionManager.list(cwd)).find((session) => session.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

/**
 * Launch a subagent without waiting for it. Validates everything the caller
 * should see as a tool error (depth, model, cwd), persists the record, and
 * returns immediately. The process runs in the background; progress lands in
 * the registry and onSettled fires when it reaches a terminal state.
 */
export async function startSubagent(input: SpawnAgentInput, context: SpawnContext): Promise<AgentRecord> {
	if (context.signal?.aborted) throw new Error("Subagent spawn was aborted");
	if (context.currentDepth >= context.settings.maxDepth) {
		throw new Error(`Subagent depth limit reached (${context.currentDepth}/${context.settings.maxDepth})`);
	}
	const queued = gate.isFull(context.settings.maxConcurrency);
	const runId = randomUUID();
	const cwd = ensureDirectory(input.cwd ? resolve(context.parentCwd, input.cwd) : context.parentCwd);
	const model = input.model?.trim() || context.settings.defaultModel || context.parentModel;
	if (!model) {
		throw new Error("No subagent model is available; choose a parent model or configure defaultModel");
	}
	const thinking = input.thinking?.trim() || context.settings.defaultThinking || context.parentThinking;
	const now = new Date().toISOString();
	const record: AgentRecord = {
		version: 1,
		runId,
		parentRunId: context.parentRunId,
		rootRunId: context.rootRunId,
		sessionId: runId,
		name: compactName(input),
		agent: input.agent,
		task: input.task,
		cwd,
		model,
		thinking,
		tools: input.tools,
		depth: context.currentDepth + 1,
		maxDepth: context.settings.maxDepth,
		status: queued ? "queued" : "starting",
		activity: queued ? "waiting for a concurrency slot" : "starting",
		usage: { ...EMPTY_USAGE },
		startedAt: now,
		updatedAt: now,
	};
	saveRecord(context.agentDir, record);
	context.onRecord?.(record);

	startingChildren.set(record.runId, new Promise((resolveChild) => resolveStarting.set(record.runId, resolveChild)));
	void runSubagentProcess(input, context, record)
		.catch((error) => {
			if (isTerminalStatus(record.status)) return;
			record.status = "failed";
			record.activity = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.finishedAt = record.finishedAt ?? new Date().toISOString();
			record.updatedAt = record.finishedAt;
			saveRecord(context.agentDir, record);
			context.onRecord?.(record);
			context.onSettled?.(record);
		})
		.finally(() => {
			resolveStarting.get(record.runId)?.(isTerminalStatus(record.status) ? null : liveChildren.get(record.runId) ?? null);
			resolveStarting.delete(record.runId);
			startingChildren.delete(record.runId);
		});
	return record;
}

async function runSubagentProcess(
	input: SpawnAgentInput,
	context: SpawnContext,
	record: AgentRecord,
): Promise<void> {
	let release: (() => void) | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const publish = () => {
		saveRecord(context.agentDir, record);
		context.onRecord?.(record);
	};
	const diskCancelled = () =>
		readRecords(context.agentDir).find((r) => r.runId === record.runId)?.status === "cancelled";
	const schedulePublish = (immediate = false) => {
		if (immediate) {
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = undefined;
			publish();
			return;
		}
		if (!flushTimer) {
			flushTimer = setTimeout(() => {
				flushTimer = undefined;
				publish();
			}, 200);
			flushTimer.unref?.();
		}
	};
	const settle = (status: AgentRecord["status"], detail?: string) => {
		record.status = status;
		record.activity = status;
		record.currentTool = undefined;
		if (detail) record.error = detail;
		record.finishedAt = new Date().toISOString();
		record.updatedAt = record.finishedAt;
		publish();
		context.onSettled?.(record);
	};

	try {
		release = await gate.acquire(context.settings.maxConcurrency);
		if (record.status === "cancelled" || diskCancelled()) return;

		const intro = `You are subagent "${record.name}" at depth ${record.depth}/${record.maxDepth}. Complete delegated tasks and return concise, self-contained results.`;
		const systemPrompt = input.systemPrompt ? `${intro}\n\n${input.systemPrompt}` : intro;
		const args = [
			"--mode",
			"rpc",
			"--session-id",
			record.runId,
			"--name",
			record.name,
			"--model",
			record.model,
			"--append-system-prompt",
			systemPrompt,
		];
		if (record.thinking) args.push("--thinking", record.thinking);
		if (input.tools?.length) args.push("--tools", input.tools.join(","));
		if (context.projectTrusted && (record.cwd === context.parentCwd || record.cwd.startsWith(`${context.parentCwd}/`))) {
			args.push("--approve");
		}

		let stderr = "";
		let buffer = "";
		let requestId = 0;
		let initialSettled = false;
		let resolveInitial!: () => void;
		const initialDone = new Promise<void>((resolveDone) => {
			resolveInitial = resolveDone;
		});
		const state: ParsedChildState = { finalText: "" };
		const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
		const continuationReleases: Array<() => void> = [];

		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: record.cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT_RUN_ID: record.runId,
				PI_SUBAGENT_PARENT_ID: context.parentRunId,
				PI_SUBAGENT_ROOT_ID: context.rootRunId,
				PI_SUBAGENT_DEPTH: String(record.depth),
				PI_SUBAGENT_MAX_DEPTH: String(context.settings.maxDepth),
			},
		});
		record.pid = child.pid;
		record.status = "starting";
		record.activity = "starting";
		publish();

		const send = (command: Record<string, unknown>): Promise<any> => {
			const id = `subagent-${++requestId}`;
			return new Promise((resolveCommand, rejectCommand) => {
				pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
				if (!child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)) {
					child.stdin.once("drain", () => {});
				}
			});
		};

		const liveChild: LiveChild = {
			async sendMessage(message: string) {
				const followUp = isTerminalStatus(record.status);
				const releaseTurn = followUp ? await gate.acquire(context.settings.maxConcurrency) : undefined;
				if (releaseTurn) continuationReleases.push(releaseTurn);
				try {
					await send({
						type: "prompt",
						message,
						...(followUp ? {} : { streamingBehavior: "steer" }),
					});
				} catch (error) {
					if (releaseTurn) {
						const index = continuationReleases.indexOf(releaseTurn);
						if (index >= 0) continuationReleases.splice(index, 1);
						releaseTurn();
					}
					throw error;
				}
			},
		};
		liveChildren.set(record.runId, liveChild);

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "response" && typeof event.id === "string") {
				const request = pending.get(event.id);
				if (!request) return;
				pending.delete(event.id);
				if (event.success) request.resolve(event);
				else request.reject(new Error(event.error || `${event.command || "RPC command"} failed`));
				return;
			}
			if (event.type === "extension_ui_request" && typeof event.id === "string") {
				const dialog = ["select", "confirm", "input", "editor"].includes(event.method);
				if (context.onUiRequest) {
					void context.onUiRequest(record, event).then(
						(response) => {
							if (dialog) child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, ...(response ?? { cancelled: true }) })}\n`);
						},
						() => {
							if (dialog) child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
						},
					);
				} else if (dialog) {
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				}
				return;
			}
			const important = applyChildEvent(record, state, event);
			if (event.type === "agent_settled") {
				if (initialSettled) continuationReleases.shift()?.();
				if (record.status === "cancelled" || diskCancelled()) {
					const onDisk = readRecords(context.agentDir).find((r) => r.runId === record.runId);
					if (onDisk) Object.assign(record, onDisk);
				} else if (state.stopReason === "aborted") {
					settle("cancelled", "Subagent was aborted");
				} else if (state.stopReason === "error") {
					settle("failed", state.errorMessage || stderr.trim() || "Subagent failed");
				} else {
					record.latestText = state.finalText || record.latestText || "(no output)";
					settle("completed");
				}
				if (!initialSettled) {
					initialSettled = true;
					resolveInitial();
				}
				if (context.persistAfterSettled === false) child.stdin.end();
				return;
			}
			schedulePublish(important);
		};

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
		});
		child.stdin.on("error", () => {});
		child.on("close", (code) => {
			liveChildren.delete(record.runId);
			for (const releaseTurn of continuationReleases.splice(0)) releaseTurn();
			if (buffer.trim()) processLine(buffer);
			for (const request of pending.values()) request.reject(new Error(stderr.trim() || `Subagent exited with code ${code ?? 1}`));
			pending.clear();
			const wasCancelled = record.status === "cancelled" || diskCancelled();
			record.pid = undefined;
			if (!wasCancelled && !isTerminalStatus(record.status)) {
				settle("failed", stderr.trim() || `Subagent exited with code ${code ?? 1}`);
			}
			if (!initialSettled) {
				initialSettled = true;
				resolveInitial();
			}
		});
		child.on("error", (error) => {
			stderr = `${stderr}\n${error.message}`.slice(-STDERR_LIMIT);
		});

		try {
			const stateResponse = await send({ type: "get_state" });
			if (typeof stateResponse.data?.sessionFile === "string") {
				record.sessionFile = stateResponse.data.sessionFile;
				publish();
			} else {
				record.sessionFile = await findSessionFile(record.cwd, record.runId);
			}
			await send({ type: "prompt", message: input.task });
			resolveStarting.get(record.runId)?.(liveChild);
			await initialDone;
		} catch (error) {
			child.stdin.end();
			setTimeout(() => {
				if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid);
			}, 1000).unref();
			throw error;
		}
	} finally {
		if (flushTimer) clearTimeout(flushTimer);
		release?.();
	}
}
