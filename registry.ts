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

function atomicWrite(target: string, contents: string): void {
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(temporary, target);
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

function applyMarkers(agentDir: string, record: AgentRecord): AgentRecord {
	let result = record;
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
 * Persist a record atomically. Cancellation and process-close marker files are
 * separate monotonic facts, so a stale writer in another process cannot undo
 * either state by replacing the JSON record later.
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

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
					renameSync(lock, quarantine);
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
			if (!TERMINAL.has(marked.status) && marked.pid && !isProcessAlive(marked.pid)) {
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
