import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentRecord, AgentStatus } from "./types.ts";

const TERMINAL = new Set<AgentStatus>(["completed", "failed", "cancelled"]);
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const REPLACE_ATTEMPTS = 8;
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_IDENTITY_FRESH_MS = 1_000;
const WINDOWS_PROBE_BACKOFF_MS = 2_000;

interface CachedWindowsStart {
	startTime: string;
	fetchedAt: number;
}

const windowsStartTimeCache = new Map<number, CachedWindowsStart>();
const windowsProbeFailures = new Map<number, number>();
const windowsProbeInflight = new Set<number>();

interface CancellationMarker {
	version: 1;
	runId: string;
	cancelledAt: string;
	error?: string;
}

export function isTerminalStatus(status: AgentStatus): boolean {
	return TERMINAL.has(status);
}

export function registryDir(agentDir: string): string {
	return join(agentDir, "subagents", "runs");
}

function safeRunId(runId: string): string {
	return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function recordPath(agentDir: string, runId: string): string {
	return join(registryDir(agentDir), `${safeRunId(runId)}.json`);
}

function markerPath(agentDir: string, runId: string, kind: "cancelled" | "closed"): string {
	return join(registryDir(agentDir), `${safeRunId(runId)}.${kind}`);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows MoveFileEx fails with EPERM while Defender or an indexer holds the destination. */
export function isTransientFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return !!code && TRANSIENT_FS_CODES.has(code);
}

/** Replace `to` with `from`. Retries the lock errors that kill a POSIX rename on Windows. */
export function renameReplacing(from: string, to: string): void {
	for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (!isTransientFsError(error) || attempt === REPLACE_ATTEMPTS - 1) throw error;
			sleepSync(15 * (attempt + 1));
		}
	}
}

function atomicWrite(target: string, contents: string): void {
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	// mode is a chmod on Windows and can itself fail with EPERM. The directory is already private.
	const options: { encoding: "utf8"; mode?: number } = { encoding: "utf8" };
	if (process.platform !== "win32") options.mode = 0o600;
	writeFileSync(temporary, contents, options);
	try {
		renameReplacing(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function writeCancellationMarker(agentDir: string, record: AgentRecord): void {
	const target = markerPath(agentDir, record.runId, "cancelled");
	if (existsSync(target)) return;
	const marker: CancellationMarker = {
		version: 1,
		runId: record.runId,
		cancelledAt: record.finishedAt ?? new Date().toISOString(),
		error: record.error,
	};
	atomicWrite(target, `${JSON.stringify(marker)}\n`);
}

function readCancellationMarker(agentDir: string, runId: string): CancellationMarker | undefined {
	const target = markerPath(agentDir, runId, "cancelled");
	if (!existsSync(target)) return undefined;
	try {
		const value = JSON.parse(readFileSync(target, "utf8")) as Partial<CancellationMarker>;
		if (value.version === 1 && value.runId === runId && typeof value.cancelledAt === "string") {
			return value as CancellationMarker;
		}
	} catch {
		// The marker's existence is enough to keep cancellation monotonic.
	}
	return { version: 1, runId, cancelledAt: new Date().toISOString(), error: "Cancelled" };
}

type ResultStateFlag = "resultsDelivered" | "resultsPreviewed" | "footerDismissed";

function resultStatePath(agentDir: string, record: AgentRecord, flag: ResultStateFlag): string {
	return join(registryDir(agentDir), `${safeRunId(record.runId)}.${safeRunId(record.executionId ?? "legacy")}.${flag}`);
}

/**
 * Parent/UI writes must never replace the execution owner's JSON snapshot.
 * Each flag is an independent monotonic fact scoped to the observed execution,
 * so even a delayed cross-process write cannot mark a newer turn or regress it.
 */
export function markRecordResultState(agentDir: string, record: AgentRecord, flag: ResultStateFlag): void {
	mkdirSync(registryDir(agentDir), { recursive: true, mode: 0o700 });
	atomicWrite(resultStatePath(agentDir, record, flag), "true\n");
}

function applyMarkers(agentDir: string, record: AgentRecord): AgentRecord {
	let result = record;
	for (const flag of ["resultsDelivered", "resultsPreviewed", "footerDismissed"] as const) {
		if (existsSync(resultStatePath(agentDir, record, flag))) result = { ...result, [flag]: true };
	}
	const cancellation = readCancellationMarker(agentDir, record.runId);
	if (cancellation) {
		result = {
			...result,
			status: "cancelled",
			activity: "cancelled",
			currentTool: undefined,
			error: cancellation.error ?? result.error ?? "Cancelled",
			finishedAt: cancellation.cancelledAt,
			updatedAt:
				Date.parse(result.updatedAt) > Date.parse(cancellation.cancelledAt)
					? result.updatedAt
					: cancellation.cancelledAt,
		};
	}
	if (existsSync(markerPath(agentDir, record.runId, "closed"))) {
		result = { ...result, pid: undefined, pidStartTime: undefined };
	}
	return result;
}

/**
 * Persist an execution-owner record atomically. Parent/UI flags must use
 * markRecordResultState instead. Result flags, cancellation and close markers are
 * separate monotonic facts, so a stale writer in another process cannot undo
 * these facts by replacing the JSON record later (within the same execution).
 */
export function saveRecord(agentDir: string, record: AgentRecord): AgentRecord {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (record.status === "cancelled") writeCancellationMarker(agentDir, record);
	const saved = applyMarkers(agentDir, record);
	atomicWrite(recordPath(agentDir, record.runId), `${JSON.stringify(saved)}\n`);
	return saved;
}

/** Mark a child PID as permanently cleared before writing its final record. */
export function clearRecordPid(agentDir: string, record: AgentRecord): AgentRecord {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = markerPath(agentDir, record.runId, "closed");
	if (!existsSync(target)) atomicWrite(target, `${new Date().toISOString()}\n`);
	return saveRecord(agentDir, { ...record, pid: undefined, pidStartTime: undefined });
}

export function isRecordCancelled(agentDir: string, runId: string): boolean {
	return existsSync(markerPath(agentDir, runId, "cancelled"));
}

function randomToken(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Serialize the launch/cancel decision for one run across Pi processes. */
export function withRecordLock<T>(agentDir: string, runId: string, operation: () => T): T {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, `${safeRunId(runId)}.lock`);
	const token = `${process.pid}-${randomToken()}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			try {
				writeFileSync(join(lock, "owner"), `${token}\n`, { encoding: "utf8", mode: 0o600 });
			} catch (error) {
				rmSync(lock, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			let stale = false;
			try {
				const age = Date.now() - statSync(lock).mtimeMs;
				if (age > LOCK_STALE_MS) stale = true;
				else {
					const owner = Number(readFileSync(join(lock, "owner"), "utf8").trim().split("-", 1)[0]);
					stale = Number.isInteger(owner) && owner > 0 && !isProcessAlive(owner);
				}
			} catch {
				// A creator may be between mkdir and writing owner. Give it time.
			}
			if (stale) {
				const quarantine = `${lock}.stale-${process.pid}-${randomToken()}`;
				try {
					renameReplacing(lock, quarantine);
					rmSync(quarantine, { recursive: true, force: true });
				} catch {
					// Another contender replaced or removed the stale lock.
				}
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for subagent record lock: ${runId}`);
			sleepSync(5);
		}
	}
	try {
		return operation();
	} finally {
		try {
			if (readFileSync(join(lock, "owner"), "utf8").trim() === token) {
				rmSync(lock, { recursive: true, force: true });
			}
		} catch {
			// A stale-lock recovery may already have moved this lock aside.
		}
	}
}

function isRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<AgentRecord>;
	return (
		item.version === 1 &&
		typeof item.runId === "string" &&
		typeof item.parentRunId === "string" &&
		typeof item.rootRunId === "string" &&
		typeof item.sessionId === "string" &&
		typeof item.name === "string" &&
		typeof item.task === "string" &&
		typeof item.cwd === "string" &&
		typeof item.depth === "number" &&
		typeof item.status === "string" &&
		typeof item.startedAt === "string" &&
		typeof item.updatedAt === "string"
	);
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface ProcessIdentity {
	pid: number;
	processGroup: number;
	/** Linux /proc start ticks, or Windows creation time in Unix milliseconds. */
	startTime: string;
}

function windowsIdentityArgs(pid: number): string[] {
	return [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
	];
}

function parseWindowsStartTime(raw: string): string | undefined {
	const output = raw.replace(/^\uFEFF/, "").trim().split(/\r?\n/).at(-1) ?? "";
	return /^\d+$/.test(output) ? output : undefined;
}

function queryWindowsStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	try {
		const raw = execFileSync("powershell.exe", windowsIdentityArgs(pid), {
			windowsHide: true, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
		});
		return parseWindowsStartTime(String(raw));
	} catch {
		return undefined;
	}
}

function forgetWindowsProcess(pid: number): void {
	windowsStartTimeCache.delete(pid);
	windowsProbeFailures.delete(pid);
}

function rememberWindowsStartTime(pid: number, startTime: string | undefined): void {
	if (!isProcessAlive(pid)) {
		forgetWindowsProcess(pid);
		return;
	}
	if (!startTime) {
		windowsProbeFailures.set(pid, Date.now());
		windowsStartTimeCache.delete(pid);
		return;
	}
	windowsProbeFailures.delete(pid);
	windowsStartTimeCache.set(pid, { startTime, fetchedAt: Date.now() });
}

/**
 * Ask PowerShell off the caller stack. A failed probe is not filled from the cache.
 * A sample that finishes after this pid died, or after a newer sample was stored,
 * is dropped: the pid may already belong to another process.
 */
export function probeWindowsStartTime(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid < 1) return Promise.resolve(undefined);
	if (!isProcessAlive(pid)) {
		forgetWindowsProcess(pid);
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let sawDeath = false;
		const watch = setInterval(() => {
			if (!isProcessAlive(pid)) sawDeath = true;
		}, 20);
		watch.unref();
		const finish = (startTime: string | undefined) => {
			clearInterval(watch);
			const cached = windowsStartTimeCache.get(pid);
			const newer = !!cached && cached.fetchedAt >= startedAt;
			if (sawDeath || !isProcessAlive(pid)) {
				if (!newer) {
					windowsStartTimeCache.delete(pid);
					windowsProbeFailures.delete(pid);
				}
				// That sample belongs to a process that has exited. Returning it would
				// make a reused pid look like the process a kill is allowed to stop.
				resolve(undefined);
				return;
			}
			if (newer) {
				resolve(cached!.startTime);
				return;
			}
			rememberWindowsStartTime(pid, startTime);
			// The pid can die inside remember. Publish only the sample it kept.
			resolve(windowsStartTimeCache.get(pid)?.startTime);
		};
		try {
			execFile("powershell.exe", windowsIdentityArgs(pid), {
				windowsHide: true, encoding: "utf8", timeout: 2000,
			}, (error, stdout) => {
				const startTime = error ? undefined : parseWindowsStartTime(String(stdout ?? ""));
				finish(startTime);
			});
		} catch {
			clearInterval(watch);
			resolve(undefined);
		}
	});
}

function refreshProcessIdentitySoon(pid: number): void {
	if (windowsProbeInflight.has(pid)) return;
	const failedAt = windowsProbeFailures.get(pid);
	if (failedAt !== undefined && Date.now() - failedAt < WINDOWS_PROBE_BACKOFF_MS) return;
	const cached = windowsStartTimeCache.get(pid);
	if (cached && Date.now() - cached.fetchedAt < WINDOWS_IDENTITY_FRESH_MS) return;
	windowsProbeInflight.add(pid);
	void probeWindowsStartTime(pid).finally(() => {
		windowsProbeInflight.delete(pid);
	});
}

function readWindowsProcessIdentity(pid: number, refresh: boolean): ProcessIdentity | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	if (!isProcessAlive(pid)) {
		forgetWindowsProcess(pid);
		return undefined;
	}
	const queried = (): ProcessIdentity | undefined => {
		const startTime = queryWindowsStartTime(pid);
		// A blocking query cannot see a reuse that finishes before this check: the
		// event loop is stalled. Callers that store a start time for a later kill
		// use probeWindowsStartTime, whose death watch runs during the query.
		if (!isProcessAlive(pid)) {
			forgetWindowsProcess(pid);
			return undefined;
		}
		rememberWindowsStartTime(pid, startTime);
		// remember drops the sample if the pid dies before the store.
		const stored = windowsStartTimeCache.get(pid)?.startTime;
		if (!stored || stored !== startTime) return undefined;
		return { pid, processGroup: pid, startTime: stored };
	};
	if (!refresh) {
		const cached = windowsStartTimeCache.get(pid);
		if (cached) return { pid, processGroup: pid, startTime: cached.startTime };
		// Cache miss is a one-time probe. Reconciliation does not use this path:
		// the footer would block on PowerShell for every cold PID.
		return queried();
	}
	// A refresh that misses must not answer with the previous creation time.
	return queried();
}

/**
 * Read a live process identity. `refresh` bypasses the Windows cache.
 * A kill uses probeWindowsStartTime, which notices the pid dying during the query.
 * Do not call refresh from a render or reconcile path: a cache miss blocks on PowerShell.
 */
export function readProcessIdentity(pid: number, options?: { refresh?: boolean }): ProcessIdentity | undefined {
	if (process.platform === "win32") return readWindowsProcessIdentity(pid, options?.refresh === true);
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

/**
 * A recorded PID is only alive when the process still exists and, when a start
 * time was recorded, still refers to the same process. Without the start-time
 * check a recycled PID would keep a dead run looking active forever.
 */
function isRecordedProcessAlive(record: AgentRecord): boolean {
	if (!record.pid || !isProcessAlive(record.pid)) {
		if (record.pid !== undefined && Number.isInteger(record.pid) && record.pid >= 1) forgetWindowsProcess(record.pid);
		return false;
	}
	if (!record.pidStartTime) return true;
	if (process.platform === "win32") {
		const cached = windowsStartTimeCache.get(record.pid);
		// A cached creation time that disagrees is a reused PID, even if the sample is old.
		if (cached && cached.startTime !== record.pidStartTime) return false;
		const fresh = !!cached && Date.now() - cached.fetchedAt < WINDOWS_IDENTITY_FRESH_MS;
		if (!fresh) refreshProcessIdentitySoon(record.pid);
		// Missing or stale agreement is not proof. Wait for a probe instead of marking the run dead.
		return true;
	}
	const identity = readProcessIdentity(record.pid);
	return !identity || identity.startTime === record.pidStartTime;
}

export function readRecords(agentDir: string): AgentRecord[] {
	const dir = registryDir(agentDir);
	if (!existsSync(dir)) return [];
	const records: AgentRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (!isRecord(value)) continue;
			const marked = applyMarkers(agentDir, value);
			if (!TERMINAL.has(marked.status) && marked.pid && !isRecordedProcessAlive(marked)) {
				records.push({
					...marked,
					status: "failed",
					activity: "process exited unexpectedly",
					error: marked.error ?? "Subagent process is no longer running",
				});
			} else {
				records.push(marked);
			}
		} catch {
			// A malformed or half-cleaned record must not break the whole panel.
		}
	}
	return records;
}

export function descendantsOf(records: readonly AgentRecord[], parentRunId: string): AgentRecord[] {
	const children = new Map<string, AgentRecord[]>();
	for (const record of records) {
		const list = children.get(record.parentRunId) ?? [];
		list.push(record);
		children.set(record.parentRunId, list);
	}
	for (const list of children.values()) {
		list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	}
	const result: AgentRecord[] = [];
	const visit = (parent: string) => {
		for (const child of children.get(parent) ?? []) {
			result.push(child);
			visit(child.runId);
		}
	};
	visit(parentRunId);
	return result;
}

/** Resolve exact identities first, then an unambiguous run-ID prefix. */
export function resolveAgentRecord(records: readonly AgentRecord[], target: string): AgentRecord {
	const value = target.trim();
	const exact = value ? records.filter((record) => record.runId === value || record.sessionId === value || record.name === value) : [];
	const matches = exact.length > 0 ? exact : value ? records.filter((record) => record.runId.startsWith(value)) : [];
	if (matches.length === 0) throw new Error(`No subagent matches "${value}".`);
	if (matches.length > 1) {
		throw new Error(`"${value}" is ambiguous; matches: ${matches.map((record) => `${record.name} (${record.runId})`).join(", ")}`);
	}
	return matches[0]!;
}

export function relativeDepths(records: readonly AgentRecord[], parentRunId: string): Map<string, number> {
	const depths = new Map<string, number>();
	const byParent = new Map<string, AgentRecord[]>();
	for (const record of records) {
		const list = byParent.get(record.parentRunId) ?? [];
		list.push(record);
		byParent.set(record.parentRunId, list);
	}
	const visit = (parent: string, depth: number) => {
		for (const child of byParent.get(parent) ?? []) {
			depths.set(child.runId, depth);
			visit(child.runId, depth + 1);
		}
	};
	visit(parentRunId, 0);
	return depths;
}
