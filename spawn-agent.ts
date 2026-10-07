import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
	isTransientFsError,
	probeWindowsStartTime,
	readProcessIdentity,
	type ProcessIdentity,
	readRecords,
	saveRecord,
	withRecordLock,
} from "./registry.ts";
import { EMPTY_USAGE, type AgentRecord, type SpawnAgentInput, type SubagentSettings } from "./types.ts";

const externalKills = new Set<Promise<void>>();

function trackExternalKill(kill: Promise<void>): void {
	externalKills.add(kill);
	void kill.finally(() => {
		externalKills.delete(kill);
	});
}

/**
 * Wait for unowned kills started by cancelSubagent.
 * session_shutdown returns into process.exit, and on Windows the kill waits
 * on PowerShell before taskkill is spawned.
 */
export function settleExternalKills(): Promise<void> {
	return Promise.all([...externalKills]).then(() => undefined);
}

const STDERR_LIMIT = 4000;
const TERMINATION_WAIT_MS = 5000;
const RPC_REQUEST_TIMEOUT_MS = 15_000;
const RPC_STARTUP_TIMEOUT_MS = 30_000;

export class ConcurrencyGate {
	private running = 0;
	private waiters: Array<{ limit: number; resolve: (release: () => void) => void; cleanup?: () => void }> = [];

	/** True when a spawn with this limit would have to queue. */
	isFull(limit: number): boolean {
		return limit !== -1 && this.running >= limit;
	}

	acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted while waiting for a concurrency slot"));
		if (limit === -1 || this.running < limit) {
			this.running++;
			return Promise.resolve(this.releaseOnce());
		}
		return new Promise((resolve, reject) => {
			const waiter: (typeof this.waiters)[number] = { limit, resolve };
			this.waiters.push(waiter);
			if (signal) {
				const abort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Subagent was aborted while waiting for a concurrency slot"));
				};
				waiter.cleanup = () => signal.removeEventListener("abort", abort);
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
			waiter.cleanup?.();
			this.running++;
			waiter.resolve(this.releaseOnce());
			index--;
		}
	}
}

export const gate = new ConcurrencyGate();

interface LiveChild {
	abort(): void;
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

function cliJsBeside(directory: string): string | undefined {
	const script = join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	return existsSync(script) ? script : undefined;
}

function isPiCli(script: string): boolean {
	const normalized = resolve(script).replace(/[\\/]/g, "\\").toLowerCase();
	return normalized.endsWith("\\pi-coding-agent\\dist\\bundle\\cli.js") && existsSync(resolve(script));
}

/** Read cli.js out of a pi.cmd / pi.ps1 shim. npm writes `%dp0%`, cmd's own form is `%~dp0`. */
export function scriptFromShim(shimPath: string): string | undefined {
	let text = "";
	try {
		text = readFileSync(shimPath, "utf8");
	} catch {
		return undefined;
	}
	const dir = dirname(shimPath);
	// A string replacement treats $& and $' as pieces of the match.
	const expand = (): string => `${dir}\\`;
	const expanded = text.replace(/%~dp0/gi, expand).replace(/%dp0%/gi, expand);
	const match = expanded.match(/[A-Za-z]:\\[^"'\r\n]*\\cli\.js|(?:\/|[A-Za-z]:\/)[^"'\r\n]*\/cli\.js/);
	if (!match) return undefined;
	const script = resolve(match[0]);
	return isPiCli(script) ? script : undefined;
}

function launchPiCli(script: string, args: string[]): { command: string; args: string[] } {
	return { command: process.execPath, args: [script, ...args] };
}

/**
 * Find the pi CLI without launching pi.cmd or an unrelated pi.exe/pi.js.
 * PATH wins over a stale global npm prefix. Nothing found returns undefined;
 * the caller falls back to spawn("pi") rather than throwing.
 */
export function windowsPiLaunch(args: string[]): { command: string; args: string[] } | undefined {
	const fromTarget = (target: string): { command: string; args: string[] } | undefined => {
		const lower = target.toLowerCase();
		if (lower.endsWith(".js")) {
			const script = resolve(target);
			return isPiCli(script) ? launchPiCli(script, args) : undefined;
		}
		if (lower.endsWith(".exe")) {
			const beside = cliJsBeside(dirname(target));
			return beside ? launchPiCli(beside, args) : undefined;
		}
		const beside = cliJsBeside(dirname(target));
		if (beside) return launchPiCli(beside, args);
		const parsed = scriptFromShim(target);
		return parsed ? launchPiCli(parsed, args) : undefined;
	};
	let listed = "";
	try {
		listed = execFileSync("where.exe", ["pi"], { encoding: "utf8", windowsHide: true, timeout: 2000 });
	} catch {
		listed = "";
	}
	for (const line of listed.split(/\r?\n/)) {
		const target = line.trim();
		if (!target || !existsSync(target)) continue;
		const launch = fromTarget(target);
		if (launch) return launch;
	}
	const prefixes = [
		process.env.APPDATA && join(process.env.APPDATA, "npm"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "npm"),
		process.env.npm_config_prefix,
	].filter((prefix): prefix is string => !!prefix);
	for (const prefix of prefixes) {
		const script = cliJsBeside(prefix);
		if (script) return launchPiCli(script, args);
	}
	return undefined;
}

function resolvePiLaunch(): { command: string; leadingArgs: string[] } {
	// Test hook: run a fake child instead of the real pi binary.
	const override = process.env.PI_SUBAGENT_COMMAND;
	if (override) return { command: process.execPath, leadingArgs: [override] };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, leadingArgs: [currentScript] };
	}
	// spawn("pi") cannot execute pi.cmd, and shell:true would parse the prompt as cmd syntax.
	if (process.platform === "win32") {
		const launch = windowsPiLaunch([]);
		if (launch) return { command: launch.command, leadingArgs: launch.args };
		const host = basename(process.execPath).toLowerCase();
		return /^(node|bun)(\.exe)?$/.test(host)
			? { command: "pi", leadingArgs: [] }
			: { command: process.execPath, leadingArgs: [] };
	}
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", leadingArgs: [] }
		: { command: process.execPath, leadingArgs: [] };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const launch = resolvePiLaunch();
	return { command: launch.command, args: [...launch.leadingArgs, ...args] };
}

function taskkillTree(
	pid: number,
	remaining = 1,
	expectedStartTime?: string,
	exited?: () => boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let detail = "";
		let settled = false;
		const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			child.kill();
		}, 15_000);
		child.stdout?.on("data", (chunk: Buffer) => { detail += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { detail += chunk.toString("utf8"); });
		// The first taskkill can fail after this pid has been reused. Check again
		// before the retry, or the second taskkill stops whoever owns the number now.
		const retry = async (): Promise<void> => {
			if (exited?.()) return;
			if (!isProcessAlive(pid)) return;
			if (expectedStartTime) {
				let startTime = await probeWindowsStartTime(pid);
				if (startTime === undefined) startTime = await probeWindowsStartTime(pid);
				if (exited?.()) return;
				if (!isProcessAlive(pid)) return;
				if (startTime !== undefined && startTime !== expectedStartTime) return;
			}
			return taskkillTree(pid, remaining - 1, expectedStartTime, exited);
		};
		const finish = (status: number | null, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!isProcessAlive(pid) || status === 0 || status === 128 || /not found|no running instance/i.test(detail)) {
				resolve();
				return;
			}
			if (remaining > 0) {
				resolve(retry());
				return;
			}
			reject(error ?? new Error(detail.trim() || `taskkill failed for pid ${pid}`));
		};
		child.once("error", (error) => finish(null, error));
		child.once("close", (status) => finish(status));
	});
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
export async function killPidTree(pid: number, expectedStartTime?: string): Promise<void> {
	if (process.platform === "win32") {
		if (expectedStartTime) {
			if (!isProcessAlive(pid)) return;
			let startTime = await probeWindowsStartTime(pid);
			if (startTime === undefined) startTime = await probeWindowsStartTime(pid);
			// A different creation time is a reused PID. A failed probe still kills:
			// the caller asked to stop this recorded process, and the cache is not a match.
			if (startTime !== undefined && startTime !== expectedStartTime) return;
			if (!isProcessAlive(pid)) return;
		}
		await taskkillTree(pid, 1, expectedStartTime);
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

function ownChild(
	runId: string,
	child: ChildProcessWithoutNullStreams,
	expectedStartTime?: () => string | undefined,
): OwnedChild {
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
	// Windows kill does not use this sample, and a cache miss blocks on PowerShell.
	const identity = process.platform === "win32" ? undefined : readProcessIdentity(pid);
	let terminating: Promise<void> | undefined;
	const owned: OwnedChild = {
		pid,
		closed: closedPromise,
		terminate() {
			if (terminating) return terminating;
			terminating = (async () => {
				if (process.platform === "win32") {
					// `close` waits for stdio, so after `exit` this pid may already belong to someone else.
					const exited = () => child.exitCode !== null || child.signalCode !== null;
					if (!exited()) await taskkillTree(pid, 1, expectedStartTime?.(), exited);
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
		let startTime: string | undefined;
		let owned: OwnedChild | undefined;
		const armStop = () => {
			owned = owned ?? ownedChildren.get(item.runId);
			runAbortControllers.get(item.runId)?.abort();
			liveChildren.get(item.runId)?.abort();
		};
		try {
			withRecordLock(agentDir, item.runId, () => {
				const latest = readRecords(agentDir).find((candidate) => candidate.runId === item.runId) ?? item;
				pid = latest.pid;
				startTime = latest.pidStartTime;
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
				pid = updated.pid ?? pid;
				startTime = updated.pidStartTime ?? startTime;
				armStop();
			});
		} catch (error) {
			// The marker is written before the JSON rename. A sharing violation must not
			// leave the panel showing cancelled while the child keeps running.
			if (!isRecordCancelled(agentDir, item.runId)) throw error;
			armStop();
			updated = readRecords(agentDir).find((candidate) => candidate.runId === item.runId) ?? {
				...item,
				status: "cancelled",
				activity: "cancelled",
				currentTool: undefined,
				error: item.error ?? "Cancelled",
			};
			pid = pid ?? updated.pid;
			startTime = startTime ?? updated.pidStartTime;
		}
		if (owned) {
			const termination = owned.terminate();
			void termination.catch(() => {
				// Cancel already persisted. Shutdown awaits this same promise and sees the failure.
			});
		} else if (pid && isProcessAlive(pid)) {
			const runId = updated.runId;
			const killStartTime = startTime ?? updated.pidStartTime;
			const kill = killPidTree(pid, killStartTime).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				try {
					withRecordLock(agentDir, runId, () => {
						const latest = readRecords(agentDir).find((candidate) => candidate.runId === runId);
						if (!latest) return;
						saveRecord(agentDir, {
							...latest,
							error: latest.error ? `${latest.error}; ${message}` : message,
						});
					});
				} catch {
					// The cancelled status is already on disk.
				}
			});
			trackExternalKill(kill);
		}
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
		runAbortControllers.get(runId)?.abort();
		liveChildren.get(runId)?.abort();
		const owned = ownedChildren.get(runId);
		if (owned) terminations.push(owned.terminate());
	}
	// One taskkill failure must not skip the other children: session_shutdown returns into process.exit.
	await Promise.allSettled(terminations);
	const runs = [...ids].map((runId) => childRuns.get(runId)).filter((run): run is Promise<void> => !!run);
	await Promise.race([Promise.allSettled(runs).then(() => {}), waitTimeout(TERMINATION_WAIT_MS)]);
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
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retryAttempt = 0;
	let retryClosesRecord = false;
	let registryWriteErrorLogged = false;
	// One slot, but a close must replace a pending status write. The close
	// marker is what stops a later save from putting the old pid back.
	const scheduleRetry = (operation: () => void, closesRecord = false) => {
		if (retryTimer) {
			if (!closesRecord || retryClosesRecord) return;
			clearTimeout(retryTimer);
			retryTimer = undefined;
		}
		retryClosesRecord = closesRecord;
		const delay = Math.min(200 * (retryAttempt + 1), 2_000);
		retryAttempt += 1;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			retryClosesRecord = false;
			operation();
		}, delay);
		retryTimer.unref?.();
	};
	const noteRegistryWriteError = (error: unknown) => {
		if (registryWriteErrorLogged) return;
		registryWriteErrorLogged = true;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`pi-subagents: registry write failed for ${record.runId}: ${message}\n`);
	};
	const publish = () => {
		try {
			Object.assign(record, saveRecord(context.agentDir, record));
			context.onRecord?.(record);
			retryAttempt = 0;
		} catch (error) {
			// Timer and stdout callbacks are uncaughtException territory. A locked JSON must not exit Pi.
			if (isTransientFsError(error)) scheduleRetry(publish);
			else noteRegistryWriteError(error);
		}
	};
	const publishClosed = () => {
		try {
			Object.assign(record, clearRecordPid(context.agentDir, record));
			context.onRecord?.(record);
			retryAttempt = 0;
		} catch (error) {
			record.pid = undefined;
			record.pidStartTime = undefined;
			if (isTransientFsError(error)) scheduleRetry(publishClosed, true);
			else noteRegistryWriteError(error);
		}
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
		// where.exe can take seconds. Resolve it before the record lock so cancel can still get in.
		const piLaunch = resolvePiLaunch();
		withRecordLock(context.agentDir, record.runId, () => {
			if (diskCancelled()) return;
			// Re-resolve immediately before spawn so a swapped symlink cannot keep --approve.
			record.cwd = ensureDirectory(record.cwd);
			const trustedRoot = ensureDirectory(context.parentCwd);
			if (context.projectTrusted && isWithinDirectory(record.cwd, trustedRoot)) {
				args.push("--approve");
			}
			const invocation = { command: piLaunch.command, args: [...piLaunch.leadingArgs, ...args] };
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
					PI_SUBAGENT_DEPTH_FLAG_OVERRIDE: context.settings.maxDepthFlagOverride ? "1" : "0",
				},
			});
			ownChild(record.runId, child, () => record.pidStartTime);
			record.pid = child.pid;
			record.pidStartTime = process.platform === "win32" || !child.pid
				? undefined
				: readProcessIdentity(child.pid)?.startTime;
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
			// Persist before taskkill. A dead PID otherwise reconciles as "no longer running"
			// and hides the transport error from the next registry read.
			if (!closing && !isTerminalStatus(record.status)) settle("failed", error.message);
			if (closing) return;
			launchedChild.stdin.destroy();
			const owned = ownedChildren.get(record.runId);
			if (owned) {
				const termination = owned.terminate();
				void termination.catch(() => {});
			} else if (record.pid && isProcessAlive(record.pid)) {
				void killPidTree(record.pid, record.pidStartTime).catch(() => {});
			}
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
		const lifetime = new AbortController();
		const liveChild: LiveChild = {
			abort: () => lifetime.abort(),
			sendMessage(message: string, signal?: AbortSignal) {
				signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
				const result = messageQueue.then(async () => {
					if (signal?.aborted) throw new Error("Subagent message was aborted");
					const followUp = isTerminalStatus(record.status);
					if (closing || diskCancelled()) throw new Error("Subagent is no longer running");
					const previousStatus = record.status;
					if (followUp) {
						record.status = "queued";
						record.activity = "waiting for a concurrency slot";
						publish();
					}
					let releaseTurn: (() => void) | undefined;
					let promptIssued = false;
					try {
						releaseTurn = followUp ? await gate.acquire(context.settings.maxConcurrency, signal) : undefined;
						if (releaseTurn) continuationReleases.push(releaseTurn);
						if (signal?.aborted || closing || diskCancelled()) throw new Error("Subagent message was aborted");
						const pendingPrompt = send(
							{
								type: "prompt",
								message,
								...(followUp ? {} : { streamingBehavior: "steer" }),
							},
							// Once a follow-up is on stdin, the child owns the turn. Caller abort
							// must not drop the slot; agent_settled/close still release it.
							{ signal: followUp ? lifetime.signal : signal },
						);
						promptIssued = true;
						await pendingPrompt;
					} catch (error) {
						const keepSlot =
							followUp &&
							promptIssued &&
							!!releaseTurn &&
							error instanceof Error &&
							/aborted/.test(error.message);
						if (releaseTurn && !keepSlot) {
							const index = continuationReleases.indexOf(releaseTurn);
							if (index >= 0) continuationReleases.splice(index, 1);
							releaseTurn();
						}
						// A rejected or aborted follow-up never started a turn, so the child is
						// still in its previous state: only the optimistic "queued" publish needs
						// undoing. Once the child accepts the prompt, agent_start moves it off
						// "queued" and this must not overwrite that newer state.
						if (followUp && record.status === "queued" && !diskCancelled()) {
							record.status = previousStatus;
							record.activity = previousStatus;
							publish();
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
			lifetime.abort();
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
		if (process.platform === "win32" && launchedChild.pid) {
			const pid = launchedChild.pid;
			const childExited = () => launchedChild.exitCode !== null || launchedChild.signalCode !== null;
			// execFileSync stalls the event loop, so a pid can die and be reused without either liveness check noticing.
			// The async probe watches for that and must not be stored once this child has exited.
			if (childExited()) {
				record.pid = undefined;
				record.pidStartTime = undefined;
			} else {
				const startTime = await probeWindowsStartTime(pid);
				if (childExited()) {
					record.pid = undefined;
					record.pidStartTime = undefined;
				} else {
					record.pidStartTime = startTime;
				}
			}
			publish();
		}

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
			if (owned) void owned.terminate().catch(() => {});
			throw error;
		}
	} finally {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
			publish();
		}
		release?.();
	}
}
