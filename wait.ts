import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { descendantsOf, isTerminalStatus, readRecords, registryDir } from "./registry.ts";
import type { AgentRecord } from "./types.ts";

const DEFAULT_POLL_MS = 250;
const DEBOUNCE_MS = 15;

export interface WaitUntilIdleOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Fallback poll for missed watches and in-memory dead-PID promotion. */
	pollMs?: number;
}

export interface WaitForResultOptions extends WaitUntilIdleOptions {
	/** Called with a fresh snapshot; return true when the caller has something new to report. */
	isReady: (rows: readonly AgentRecord[]) => boolean;
}

interface Waiter {
	agentDir: string;
	wake: () => void;
}

interface WatchState {
	refs: number;
	watcher?: FSWatcher;
	poll: ReturnType<typeof setInterval>;
	debounce?: ReturnType<typeof setTimeout>;
}

const waiters = new Set<Waiter>();
const watches = new Map<string, WatchState>();

function dirKey(agentDir: string): string {
	return resolve(agentDir);
}

function snapshotDescendants(agentDir: string, parentRunId: string): AgentRecord[] {
	return descendantsOf(readRecords(agentDir), parentRunId);
}

function isIdle(rows: readonly AgentRecord[]): boolean {
	return rows.every((record) => isTerminalStatus(record.status));
}

function wakeAgentDir(agentDir: string): void {
	const key = dirKey(agentDir);
	for (const waiter of [...waiters]) {
		if (waiter.agentDir === key) waiter.wake();
	}
}

function scheduleWake(agentDir: string): void {
	const state = watches.get(dirKey(agentDir));
	if (!state) {
		wakeAgentDir(agentDir);
		return;
	}
	if (state.debounce) return;
	state.debounce = setTimeout(() => {
		state.debounce = undefined;
		wakeAgentDir(agentDir);
	}, DEBOUNCE_MS);
	state.debounce.unref?.();
}

function ensureWatch(agentDir: string, pollMs: number): void {
	const key = dirKey(agentDir);
	const existing = watches.get(key);
	if (existing) {
		existing.refs++;
		return;
	}
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(dir, () => scheduleWake(agentDir));
		watcher.on("error", () => {
			try {
				watcher?.close();
			} catch {
				// Polling still covers this directory.
			}
			const state = watches.get(key);
			if (state && state.watcher === watcher) state.watcher = undefined;
		});
	} catch {
		watcher = undefined;
	}
	const poll = setInterval(() => wakeAgentDir(agentDir), Math.max(1, pollMs));
	watches.set(key, { refs: 1, watcher, poll });
}

function releaseWatch(agentDir: string): void {
	const key = dirKey(agentDir);
	const state = watches.get(key);
	if (!state) return;
	state.refs--;
	if (state.refs > 0) return;
	watches.delete(key);
	if (state.debounce) clearTimeout(state.debounce);
	clearInterval(state.poll);
	try {
		state.watcher?.close();
	} catch {
		// Already closed.
	}
}

/** Wake waiters after an in-process record change (spawn/settle/cancel). */
export function notifyWaiters(agentDir?: string): void {
	const key = agentDir === undefined ? undefined : dirKey(agentDir);
	for (const waiter of [...waiters]) {
		if (key === undefined || waiter.agentDir === key) waiter.wake();
	}
}

/** Test helper: live waiters and directory watches. */
export function waitDebugState(): { waiters: number; watches: number } {
	return { waiters: waiters.size, watches: watches.size };
}

/**
 * Block until every descendant of `parentRunId` is terminal, `timeoutMs` elapses,
 * or `signal` aborts. Timeout is a ceiling; completion wakes the waiter immediately.
 */
export async function waitUntilSubagentsIdle(
	agentDir: string,
	parentRunId: string,
	options: WaitUntilIdleOptions,
): Promise<AgentRecord[]> {
	return waitForDescendants(agentDir, parentRunId, options, isIdle);
}

/**
 * Block until the caller has a fresh result, every descendant is terminal,
 * `timeoutMs` elapses, or `signal` aborts. This lets an explicit check wait for
 * the first finished report instead of returning a useless status snapshot.
 */
export async function waitForSubagentResult(
	agentDir: string,
	parentRunId: string,
	options: WaitForResultOptions,
): Promise<AgentRecord[]> {
	return waitForDescendants(agentDir, parentRunId, options, (rows) => isIdle(rows) || options.isReady(rows));
}

async function waitForDescendants(
	agentDir: string,
	parentRunId: string,
	options: WaitUntilIdleOptions,
	isDone: (rows: readonly AgentRecord[]) => boolean,
): Promise<AgentRecord[]> {
	const timeoutMs = options.timeoutMs;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const snapshot = () => snapshotDescendants(agentDir, parentRunId);
	let rows = snapshot();
	if (isDone(rows) || timeoutMs <= 0) return rows;
	if (options.signal?.aborted) throw new Error("check_subagents was aborted");

	return new Promise<AgentRecord[]>((resolveWait, rejectWait) => {
		let settled = false;
		const key = dirKey(agentDir);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => finish(new Error("check_subagents was aborted"));
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			waiters.delete(waiter);
			releaseWatch(agentDir);
			if (error) rejectWait(error);
			else {
				try {
					resolveWait(snapshot());
				} catch (snapshotError) {
					rejectWait(snapshotError instanceof Error ? snapshotError : new Error(String(snapshotError)));
				}
			}
		};
		const waiter: Waiter = {
			agentDir: key,
			wake() {
				try {
					if (isDone(snapshot())) finish();
				} catch {
					// Keep waiting until timeout; a transient read must not fail the tool.
				}
			},
		};
		waiters.add(waiter);
		ensureWatch(agentDir, pollMs);
		timer = setTimeout(() => finish(), timeoutMs);
		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		waiter.wake();
	});
}
