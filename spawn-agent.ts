import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, validateRpcMaxLineChars, validateThinkingLevel } from "./config.ts";
import { applyChildEvent, type ParsedChildState } from "./events.ts";
import {
	clearRecordPid,
	descendantsOf,
	isProcessAlive,
	isRecordCancelled,
	isTerminalStatus,
	readRecords,
	saveRecord,
	withRecordLock,
} from "./registry.ts";
import { EMPTY_USAGE, type AgentRecord, type SpawnAgentInput, type SubagentSettings } from "./types.ts";

const STDERR_LIMIT = 4000;
const TERMINATION_WAIT_MS = 5000;
const RPC_REQUEST_TIMEOUT_MS = 15_000;
const RPC_STARTUP_TIMEOUT_MS = 30_000;

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
	sendMessage(message: string, signal?: AbortSignal): Promise<void>;
}

interface StartingChild {
	messages: string[];
}

interface OwnedChild {
	pid: number;
	closed: Promise<void>;
	terminate(): Promise<void>;
}

const liveChildren = new Map<string, LiveChild>();
const startingChildren = new Map<string, StartingChild>();
const ownedChildren = new Map<string, OwnedChild>();
const childRuns = new Map<string, Promise<void>>();
const runAbortControllers = new Map<string, AbortController>();

/** Send directly when this process owns the target child, or queue while it starts. */
export async function sendSubagentMessage(record: AgentRecord, message: string, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) throw new Error("Subagent message was aborted");
	const live = liveChildren.get(record.runId);
	if (live) {
		await live.sendMessage(message, signal);
		return true;
	}
	const startup = startingChildren.get(record.runId);
	if (!startup) return false;
	startup.messages.push(message);
	return true;
}

export interface ScopedModelCapability {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

export interface SpawnContext {
	agentDir: string;
	parentRunId: string;
	rootRunId: string;
	currentDepth: number;
	settings: SubagentSettings;
	parentModel?: string;
	parentThinking?: string;
	parentTools: readonly string[];
	scopedModels: readonly ScopedModelCapability[];
	parentCwd: string;
	projectTrusted: boolean;
	persistAfterSettled?: boolean;
	signal?: AbortSignal;
	onRecord?: (record: AgentRecord) => void;
	onUiRequest?: (record: AgentRecord, request: any) => Promise<Record<string, unknown> | void>;
	/** Fired once per child when it reaches a terminal state. */
	onSettled?: (record: AgentRecord) => void;
	/** Test overrides for transport bounds. */
	rpcRequestTimeoutMs?: number;
	rpcStartupTimeoutMs?: number;
	stdoutLineLimit?: number;
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

function validateToolName(name: string): void {
	if (!name.trim()) throw new Error("Subagent tool names must not be blank");
	if (name !== name.trim()) {
		throw new Error(`Subagent tool name must not have leading or trailing whitespace: ${JSON.stringify(name)}`);
	}
	if (name.includes(",")) throw new Error(`Subagent tool name must not contain a comma: ${JSON.stringify(name)}`);
	if (/\p{Cc}/u.test(name)) throw new Error(`Subagent tool name must not contain control characters: ${JSON.stringify(name)}`);
}

/** Resolve the child's exact tool allowlist without granting anything its parent lacks. */
export function resolveChildTools(requested: readonly string[] | undefined, parentTools: readonly string[]): string[] {
	const effective = requested === undefined ? parentTools : requested;
	for (const name of effective) validateToolName(name);
	if (requested === undefined) return [...new Set(parentTools)];
	const available = new Set(parentTools);
	const unavailable = [...new Set(requested.filter((name) => !available.has(name)))];
	if (unavailable.length > 0) {
		throw new Error(
			`Subagent tools must be a subset of the creating session's active tools; unavailable: ${unavailable.join(", ")}`,
		);
	}
	return [...new Set(requested)];
}

function canonicalModel(model: ScopedModelCapability): string {
	return `${model.provider}/${model.id}`;
}

/** Canonicalize a requested model against a nonempty parent model scope. */
export function resolveChildModel(model: string, scopedModels: readonly ScopedModelCapability[]): string {
	if (scopedModels.length === 0) return model;
	const normalized = model.toLowerCase();
	const exact = scopedModels.find((item) => canonicalModel(item).toLowerCase() === normalized);
	if (exact) return canonicalModel(exact);
	const bareMatches = scopedModels.filter((item) => item.id.toLowerCase() === normalized);
	if (bareMatches.length === 1) return canonicalModel(bareMatches[0]!);
	if (bareMatches.length > 1) {
		throw new Error(`Subagent model "${model}" is ambiguous within the creating session's model scope`);
	}
	throw new Error(`Subagent model "${model}" is outside the creating session's model scope`);
}

function scopedPin(model: string, scopedModels: readonly ScopedModelCapability[]): string | undefined {
	return scopedModels.find((item) => canonicalModel(item).toLowerCase() === model.toLowerCase())?.thinkingLevel;
}

function resolveChildThinking(
	requested: string | undefined,
	model: string,
	scopedModels: readonly ScopedModelCapability[],
	fallback: string,
): string {
	const pinned = scopedPin(model, scopedModels);
	const value = requested?.trim();
	if (value) {
		if (pinned && value !== pinned) {
			throw new Error(`Subagent thinking "${value}" is outside the creating session's pin for ${model} (${pinned})`);
		}
		return value;
	}
	return pinned || fallback;
}

function scopedModelArgs(scopedModels: readonly ScopedModelCapability[]): string[] {
	if (scopedModels.length === 0) return [];
	const names = scopedModels.map((item) => `${canonicalModel(item)}${item.thinkingLevel ? `:${item.thinkingLevel}` : ""}`);
	for (const name of names) {
		if (name.includes(",") || /\p{Cc}/u.test(name)) {
			throw new Error(`Cannot pass scoped model to a subagent: ${JSON.stringify(name)}`);
		}
	}
	return ["--models", names.join(",")];
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
	return realpathSync(cwd);
}

/** Check canonical path containment without relying on platform-specific separators. */
export function isWithinDirectory(path: string, directory: string): boolean {
	const child = relative(directory, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

interface ProcessIdentity {
	pid: number;
	startTime: string;
	processGroup: number;
}

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const processGroup = Number(fields[2]);
		const startTime = fields[19];
		if (!Number.isInteger(processGroup) || !startTime) return undefined;
		return { pid, processGroup, startTime };
	} catch {
		return undefined;
	}
}

function sameProcess(identity: ProcessIdentity): boolean {
	const current = readProcessIdentity(identity.pid);
	return !!current && current.startTime === identity.startTime;
}

function processGroupSnapshot(group: number): ProcessIdentity[] {
	if (process.platform !== "linux") return [];
	const members: ProcessIdentity[] = [];
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			const identity = readProcessIdentity(Number(name));
			if (identity?.processGroup === group) members.push(identity);
		}
	} catch {
		// /proc may be unavailable or restricted.
	}
	return members;
}

function signalPidTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/**
 * Stop a process tree not owned by this Pi process. On Linux, delayed SIGKILL
 * targets only the original process-group members whose PID start time still
 * matches. Other platforms avoid a delayed PID-only kill that could hit a
 * reused PID.
 */
export function killPidTree(pid: number, expectedStartTime?: string): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	const leader = readProcessIdentity(pid);
	if (expectedStartTime && leader?.startTime !== expectedStartTime) return;
	const members = processGroupSnapshot(pid);
	signalPidTree(pid, "SIGTERM");
	if (members.length === 0) return;
	setTimeout(() => {
		for (const member of members) {
			if (!sameProcess(member)) continue;
			try {
				process.kill(member.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 3000).unref();
}

function waitTimeout(ms: number): Promise<void> {
	return new Promise((resolveWait) => {
		const timer = setTimeout(resolveWait, ms);
		timer.unref();
	});
}

function ownChild(runId: string, child: ChildProcessWithoutNullStreams): OwnedChild {
	const pid = child.pid;
	if (!pid) throw new Error("Subagent process started without a PID");
	let closed = false;
	let resolveClosed!: () => void;
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	child.once("close", () => {
		closed = true;
		resolveClosed();
	});
	const identity = readProcessIdentity(pid);
	let terminating: Promise<void> | undefined;
	const owned: OwnedChild = {
		pid,
		closed: closedPromise,
		terminate() {
			if (terminating) return terminating;
			terminating = (async () => {
				if (process.platform === "win32") {
					spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				} else {
					signalPidTree(pid, "SIGTERM");
					const timer = setTimeout(() => {
						if (
							!closed &&
							child.exitCode === null &&
							child.signalCode === null &&
							(!identity || sameProcess(identity))
						) {
							signalPidTree(pid, "SIGKILL");
						}
					}, 3000);
					timer.unref();
					closedPromise.finally(() => clearTimeout(timer));
				}
				await Promise.race([closedPromise, waitTimeout(TERMINATION_WAIT_MS)]);
			})();
			return terminating;
		},
	};
	ownedChildren.set(runId, owned);
	closedPromise.finally(() => {
		if (ownedChildren.get(runId) === owned) ownedChildren.delete(runId);
	});
	return owned;
}

/** Force-cancel a running or queued child and all of its descendants. */
export function cancelSubagent(agentDir: string, record: AgentRecord): AgentRecord {
	const cancelOne = (item: AgentRecord): AgentRecord => {
		let updated!: AgentRecord;
		let pid: number | undefined;
		let owned: OwnedChild | undefined;
		withRecordLock(agentDir, item.runId, () => {
			const latest = readRecords(agentDir).find((candidate) => candidate.runId === item.runId) ?? item;
			const now = new Date().toISOString();
			updated = saveRecord(agentDir, {
				...latest,
				status: "cancelled",
				activity: "cancelled",
				currentTool: undefined,
				error: latest.error ?? "Cancelled",
				finishedAt: latest.finishedAt ?? now,
				updatedAt: now,
			});
			owned = ownedChildren.get(item.runId);
			pid = updated.pid;
			runAbortControllers.get(item.runId)?.abort();
		});
		if (owned) void owned.terminate();
		else if (pid && isProcessAlive(pid)) killPidTree(pid, updated.pidStartTime);
		return updated;
	};
	for (const child of descendantsOf(readRecords(agentDir), record.runId).reverse()) {
		if (!isTerminalStatus(child.status)) cancelOne(child);
	}
	return cancelOne(record);
}

/** Stop and await children owned by this process. Queued run loops also drain. */
export async function terminateOwnedSubagents(runIds: readonly string[]): Promise<void> {
	const ids = new Set(runIds);
	const terminations: Promise<void>[] = [];
	for (const runId of ids) {
		const owned = ownedChildren.get(runId);
		if (owned) terminations.push(owned.terminate());
	}
	await Promise.all(terminations);
	const runs = [...ids].map((runId) => childRuns.get(runId)).filter((run): run is Promise<void> => !!run);
	await Promise.race([Promise.all(runs).then(() => {}), waitTimeout(TERMINATION_WAIT_MS)]);
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
	const parentCwd = ensureDirectory(context.parentCwd);
	const cwd = ensureDirectory(input.cwd ? resolve(parentCwd, input.cwd) : parentCwd);
	const selectedModel = input.model?.trim() || context.settings.defaultModel || context.parentModel;
	if (!selectedModel) {
		throw new Error("No subagent model is available; choose a parent model or configure defaultModel");
	}
	const model = resolveChildModel(selectedModel, context.scopedModels);
	const tools = resolveChildTools(input.tools, context.parentTools);
	scopedModelArgs(context.scopedModels);
	const thinking = validateThinkingLevel(
		resolveChildThinking(
			input.thinking,
			model,
			context.scopedModels,
			context.settings.defaultThinking || context.parentThinking || "off",
		),
		"thinking",
	);
	const now = new Date().toISOString();
	const record: AgentRecord = {
		version: 1,
		runId,
		parentRunId: context.parentRunId,
		rootRunId: context.rootRunId,
		sessionId: runId,
		name: compactName(input),
		task: input.task,
		cwd,
		model,
		thinking,
		tools,
		depth: context.currentDepth + 1,
		maxDepth: context.settings.maxDepth,
		status: queued ? "queued" : "starting",
		activity: queued ? "waiting for a concurrency slot" : "starting",
		usage: { ...EMPTY_USAGE },
		startedAt: now,
		updatedAt: now,
	};
	Object.assign(record, saveRecord(context.agentDir, record));
	context.onRecord?.(record);

	startingChildren.set(record.runId, { messages: [] });
	const runAbort = new AbortController();
	runAbortControllers.set(record.runId, runAbort);
	if (context.signal) {
		const abortRun = () => runAbort.abort();
		if (context.signal.aborted) runAbort.abort();
		else context.signal.addEventListener("abort", abortRun, { once: true });
	}
	const run = runSubagentProcess(input, context, record, runAbort.signal)
		.catch((error) => {
			if (isRecordCancelled(context.agentDir, record.runId)) {
				const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
				if (onDisk) Object.assign(record, onDisk);
				return;
			}
			if (isTerminalStatus(record.status)) return;
			record.status = "failed";
			record.activity = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.finishedAt = record.finishedAt ?? new Date().toISOString();
			record.updatedAt = record.finishedAt;
			Object.assign(record, saveRecord(context.agentDir, record));
			context.onRecord?.(record);
			context.onSettled?.(record);
		})
		.finally(() => {
			if (runAbortControllers.get(record.runId) === runAbort) runAbortControllers.delete(record.runId);
			startingChildren.delete(record.runId);
		});
	childRuns.set(record.runId, run);
	void run.finally(() => {
		if (childRuns.get(record.runId) === run) childRuns.delete(record.runId);
	});
	return record;
}

async function runSubagentProcess(
	input: SpawnAgentInput,
	context: SpawnContext,
	record: AgentRecord,
	runSignal: AbortSignal,
): Promise<void> {
	let release: (() => void) | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const publish = () => {
		Object.assign(record, saveRecord(context.agentDir, record));
		context.onRecord?.(record);
	};
	const publishClosed = () => {
		Object.assign(record, clearRecordPid(context.agentDir, record));
		context.onRecord?.(record);
	};
	const diskCancelled = () => isRecordCancelled(context.agentDir, record.runId);
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
		if (diskCancelled()) status = "cancelled";
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
		release = await gate.acquire(context.settings.maxConcurrency, runSignal);
		if (record.status === "cancelled" || diskCancelled()) return;

		const systemPrompt = `You are subagent "${record.name}" at depth ${record.depth}/${record.maxDepth}. Complete delegated tasks and return concise, self-contained results.`;
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
		args.push(...scopedModelArgs(context.scopedModels));
		if (record.tools?.length) args.push("--tools", record.tools.join(","));
		else args.push("--no-tools");

		let stderr = "";
		let lineParts: string[] = [];
		let lineLength = 0;
		let transportError: string | undefined;
		let requestId = 0;
		let initialSettled = false;
		let closing = false;
		let resolveInitial!: () => void;
		const initialDone = new Promise<void>((resolveDone) => {
			resolveInitial = resolveDone;
		});
		const state: ParsedChildState = { finalText: "" };
		type PendingRequest = {
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			signal?: AbortSignal;
			onAbort?: () => void;
		};
		const pending = new Map<string, PendingRequest>();
		const continuationReleases: Array<() => void> = [];
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const requestTimeoutMs = Math.max(1, context.rpcRequestTimeoutMs ?? RPC_REQUEST_TIMEOUT_MS);
		const startupDeadline = Date.now() + Math.max(1, context.rpcStartupTimeoutMs ?? RPC_STARTUP_TIMEOUT_MS);
		const stdoutLineLimit = validateRpcMaxLineChars(
			context.stdoutLineLimit ?? context.settings.rpcMaxLineChars ?? DEFAULT_SETTINGS.rpcMaxLineChars,
			"rpcMaxLineChars",
		);

		let child: ChildProcessWithoutNullStreams | undefined;
		withRecordLock(context.agentDir, record.runId, () => {
			if (diskCancelled()) return;
			// Re-resolve immediately before spawn so a swapped symlink cannot keep --approve.
			record.cwd = ensureDirectory(record.cwd);
			const trustedRoot = ensureDirectory(context.parentCwd);
			if (context.projectTrusted && isWithinDirectory(record.cwd, trustedRoot)) {
				args.push("--approve");
			}
			const invocation = getPiInvocation(args);
			child = spawn(invocation.command, invocation.args, {
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
			ownChild(record.runId, child);
			record.pid = child.pid;
			record.pidStartTime = child.pid ? readProcessIdentity(child.pid)?.startTime : undefined;
			record.status = "starting";
			record.activity = "starting";
			publish();
		});
		if (!child) return;
		const launchedChild = child;

		const cleanupPending = (request: PendingRequest) => {
			clearTimeout(request.timer);
			if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort);
		};
		const rejectPending = (error: Error) => {
			for (const request of pending.values()) {
				cleanupPending(request);
				request.reject(error);
			}
			pending.clear();
		};
		const failTransport = (error: Error) => {
			if (transportError) return;
			transportError = error.message;
			lineParts = [];
			lineLength = 0;
			rejectPending(error);
			if (closing) return;
			launchedChild.stdin.destroy();
			const owned = ownedChildren.get(record.runId);
			if (owned) void owned.terminate();
			else if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid, record.pidStartTime);
		};
		const writeLine = (value: Record<string, unknown>, id?: string) => {
			if (launchedChild.stdin.destroyed || launchedChild.stdin.writableEnded) {
				const error = new Error("Subagent RPC stdin is not writable");
				if (id) {
					const request = pending.get(id);
					if (request) {
						pending.delete(id);
						cleanupPending(request);
						request.reject(error);
					}
				}
				failTransport(error);
				return;
			}
			try {
				launchedChild.stdin.write(`${JSON.stringify(value)}\n`, "utf8", (error) => {
					if (error) failTransport(error);
				});
			} catch (error) {
				failTransport(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const send = (
			command: Record<string, unknown>,
			options: { signal?: AbortSignal; deadline?: number } = {},
		): Promise<any> => {
			const id = `subagent-${++requestId}`;
			const commandName = typeof command.type === "string" ? command.type : "RPC command";
			const timeoutMs = Math.min(
				requestTimeoutMs,
				options.deadline === undefined ? requestTimeoutMs : Math.max(0, options.deadline - Date.now()),
			);
			if (options.signal?.aborted) return Promise.reject(new Error(`${commandName} was aborted`));
			if (timeoutMs <= 0) return Promise.reject(new Error(`Subagent RPC startup timed out after ${context.rpcStartupTimeoutMs ?? RPC_STARTUP_TIMEOUT_MS}ms`));
			return new Promise((resolveCommand, rejectCommand) => {
				const finish = (error?: Error, value?: any) => {
					const request = pending.get(id);
					if (!request) return;
					pending.delete(id);
					cleanupPending(request);
					if (error) request.reject(error);
					else request.resolve(value);
				};
				const timer = setTimeout(() => {
					const label = options.deadline === undefined ? `${commandName} request` : "Subagent RPC startup";
					const error = new Error(`${label} timed out after ${timeoutMs}ms`);
					finish(error);
					failTransport(error);
				}, timeoutMs);
				timer.unref?.();
				const onAbort = options.signal ? () => finish(new Error(`${commandName} was aborted`)) : undefined;
				pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer, signal: options.signal, onAbort });
				options.signal?.addEventListener("abort", onAbort!, { once: true });
				writeLine({ ...command, id }, id);
			});
		};

		let messageQueue = Promise.resolve();
		const liveChild: LiveChild = {
			sendMessage(message: string, signal?: AbortSignal) {
				const result = messageQueue.then(async () => {
					if (signal?.aborted) throw new Error("Subagent message was aborted");
					const followUp = isTerminalStatus(record.status);
					const releaseTurn = followUp ? await gate.acquire(context.settings.maxConcurrency, signal) : undefined;
					if (releaseTurn) continuationReleases.push(releaseTurn);
					try {
						await send(
							{
								type: "prompt",
								message,
								...(followUp ? {} : { streamingBehavior: "steer" }),
							},
							{ signal },
						);
					} catch (error) {
						if (releaseTurn) {
							const index = continuationReleases.indexOf(releaseTurn);
							if (index >= 0) continuationReleases.splice(index, 1);
							releaseTurn();
						}
						throw error;
					}
				});
				messageQueue = result.catch(() => {});
				return result;
			},
		};

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
				cleanupPending(request);
				if (event.success) request.resolve(event);
				else request.reject(new Error(event.error || `${event.command || "RPC command"} failed`));
				return;
			}
			if (event.type === "extension_ui_request" && typeof event.id === "string") {
				const dialog = ["select", "confirm", "input", "editor"].includes(event.method);
				if (context.onUiRequest) {
					void context.onUiRequest(record, event).then(
						(response) => {
							if (dialog) writeLine({ type: "extension_ui_response", id: event.id, ...(response ?? { cancelled: true }) });
						},
						() => {
							if (dialog) writeLine({ type: "extension_ui_response", id: event.id, cancelled: true });
						},
					);
				} else if (dialog) {
					writeLine({ type: "extension_ui_response", id: event.id, cancelled: true });
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
				if (context.persistAfterSettled === false) launchedChild.stdin.end();
				return;
			}
			schedulePublish(important);
		};

		const consumeStdout = (text: string) => {
			if (!text || transportError) return;
			// Scan each chunk once; don't repeatedly copy/scan a growing image payload.
			let start = 0;
			while (start < text.length && !transportError) {
				const newline = text.indexOf("\n", start);
				const end = newline < 0 ? text.length : newline;
				const length = end - start;
				if (lineLength + length > stdoutLineLimit) {
					failTransport(new Error(`Subagent RPC stdout line exceeded ${stdoutLineLimit} characters (rpcMaxLineChars)`));
					return;
				}
				if (length) lineParts.push(text.slice(start, end));
				lineLength += length;
				if (newline < 0) return;
				let line = lineParts.join("");
				lineParts = [];
				lineLength = 0;
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
				start = newline + 1;
			}
		};
		launchedChild.stdout.on("data", (chunk: Buffer) => {
			consumeStdout(stdoutDecoder.write(chunk));
		});
		launchedChild.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${stderrDecoder.write(chunk)}`.slice(-STDERR_LIMIT);
		});
		launchedChild.stdin.on("error", (error) => failTransport(error));
		launchedChild.on("close", (code) => {
			closing = true;
			liveChildren.delete(record.runId);
			for (const releaseTurn of continuationReleases.splice(0)) releaseTurn();
			consumeStdout(stdoutDecoder.end());
			stderr = `${stderr}${stderrDecoder.end()}`.slice(-STDERR_LIMIT);
			if (!transportError && lineLength) processLine(lineParts.join(""));
			lineParts = [];
			lineLength = 0;
			const exitError = new Error(transportError || stderr.trim() || `Subagent exited with code ${code ?? 1}`);
			rejectPending(exitError);
			const wasCancelled = record.status === "cancelled" || diskCancelled();
			if (wasCancelled) {
				const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
				if (onDisk) Object.assign(record, onDisk);
			}
			let newlySettled = false;
			if (!wasCancelled && !isTerminalStatus(record.status)) {
				record.status = "failed";
				record.activity = "failed";
				record.currentTool = undefined;
				record.error = exitError.message;
				record.finishedAt = new Date().toISOString();
				record.updatedAt = record.finishedAt;
				newlySettled = true;
			}
			record.pid = undefined;
			publishClosed();
			if (newlySettled) context.onSettled?.(record);
			if (!initialSettled) {
				initialSettled = true;
				resolveInitial();
			}
		});
		launchedChild.on("error", (error) => {
			stderr = `${stderr}\n${error.message}`.slice(-STDERR_LIMIT);
			failTransport(error);
		});

		try {
			const stateResponse = await send({ type: "get_state" }, { signal: runSignal, deadline: startupDeadline });
			if (typeof stateResponse.data?.sessionFile === "string") {
				record.sessionFile = stateResponse.data.sessionFile;
				publish();
			} else {
				record.sessionFile = await findSessionFile(record.cwd, record.runId);
			}
			await send({ type: "prompt", message: input.task }, { signal: runSignal, deadline: startupDeadline });
			const startup = startingChildren.get(record.runId);
			liveChildren.set(record.runId, liveChild);
			startingChildren.delete(record.runId);
			for (const message of startup?.messages ?? []) {
				void liveChild.sendMessage(message).catch(() => {});
			}
			await initialDone;
		} catch (error) {
			launchedChild.stdin.end();
			const owned = ownedChildren.get(record.runId);
			if (owned) void owned.terminate();
			throw error;
		}
	} finally {
		if (flushTimer) clearTimeout(flushTimer);
		release?.();
	}
}
