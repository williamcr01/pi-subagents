import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive } from "./registry.ts";

interface Request {
	version: 1;
	rootRunId: string;
	targetRunId: string;
	text: string;
	pid: number;
}
function removeRequest(dir: string): void {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* Concurrent cleanup, or unavailable storage. */ }
}
const directory = (agentDir: string, owner: string) =>
	join(agentDir, "subagents", "owner-inbox", owner.replace(/[^a-zA-Z0-9._-]/g, "_"));

/** Await owner admission/RPC acceptance, not merely a filesystem enqueue.
 * Removing the request directory revokes a request still waiting for admission.
 */
export async function requestOwnerMessage(
	agentDir: string, owner: string, request: Omit<Request, "pid" | "version">,
	options: { signal?: AbortSignal; ownerAlive: () => boolean; timeoutMs?: number },
): Promise<void> {
	if (options.signal?.aborted) throw new Error("Subagent message was aborted");
	if (!request.text.trim()) throw new Error("Subagent message must not be blank");
	if (!options.ownerAlive()) throw new Error("Subagent owner is no longer running");
	const dir = join(directory(agentDir, owner), `${Date.now()}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(join(dir, "request.tmp"), JSON.stringify({ ...request, version: 1, pid: process.pid }), { mode: 0o600 });
		renameSync(join(dir, "request.tmp"), join(dir, "request.json"));
		const deadline = Date.now() + (options.timeoutMs ?? 300_000);
		while (true) {
			if (options.signal?.aborted) throw new Error("Subagent message was aborted");
			if (existsSync(join(dir, "response.json"))) {
				const response = JSON.parse(readFileSync(join(dir, "response.json"), "utf8"));
				if (response.error) throw new Error(response.error);
				return;
			}
			if (!options.ownerAlive()) throw new Error("Subagent owner is no longer running");
			if (Date.now() >= deadline) throw new Error("Subagent owner message timed out");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	} finally {
		removeRequest(dir);
	}
}

/** Session-scoped owner scheduler ingress. Independent requests must not block
 * polling: steering G2 must still work while a continuation for G1 waits.
 */
export function startOwnerMessageConsumer(
	agentDir: string, owner: string, rootRunId: string,
	deliver: (target: string, text: string, signal: AbortSignal) => Promise<void>,
): () => Promise<void> {
	const base = directory(agentDir, owner);
	const active = new Map<string, { abort: AbortController; done: Promise<void> }>();
	const handled = new Map<string, number>();
	let stopped = false;
	const pollInbox = () => {
		if (stopped) return;
		for (const [dir, entry] of active) {
			if (!existsSync(join(dir, "request.json"))) entry.abort.abort();
		}
		for (const [dir, pid] of handled) {
			if (!isProcessAlive(pid)) removeRequest(dir);
			if (!existsSync(dir)) handled.delete(dir);
		}
		if (!existsSync(base)) return;
		for (const name of readdirSync(base).sort()) {
			const dir = join(base, name);
			if (active.has(dir) || handled.has(dir) || !existsSync(join(dir, "request.json"))) continue;
			let request: Request;
			try {
				request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
				if (request.version !== 1 || request.rootRunId !== rootRunId || typeof request.targetRunId !== "string" || typeof request.text !== "string" || !request.text.trim() || !Number.isInteger(request.pid) || request.pid < 1) throw new Error("Invalid request");
			} catch {
				removeRequest(dir);
				continue;
			}
			if (!isProcessAlive(request.pid)) {
				removeRequest(dir);
				continue;
			}
			if (existsSync(join(dir, "response.json"))) continue;
			const abort = new AbortController();
			// Sender death is equivalent to revocation, including while queued.
			const monitor = setInterval(() => {
				if (!existsSync(join(dir, "request.json")) || !isProcessAlive(request.pid)) abort.abort();
			}, 50);
			monitor.unref?.();
			const done = (async () => {
				let error: string | undefined;
				try {
					if (!isProcessAlive(request.pid)) throw new Error("Subagent sender exited");
					await deliver(request.targetRunId, request.text, abort.signal);
				} catch (cause) {
					error = cause instanceof Error ? cause.message : String(cause);
				}
				try {
					// Never recreate revoked directories or replay accepted prompts.
					writeFileSync(join(dir, "response.tmp"), JSON.stringify({ error }), { mode: 0o600 });
					renameSync(join(dir, "response.tmp"), join(dir, "response.json"));
				} catch { /* Sender revoked the request. */ }
			})().finally(() => {
				clearInterval(monitor);
				active.delete(dir);
				// An acknowledgement persistence failure must not replay a prompt.
				handled.set(dir, request.pid);
				if (!isProcessAlive(request.pid)) removeRequest(dir);
			});
			active.set(dir, { abort, done });
		}
	};
	const timer = setInterval(() => {
		try { pollInbox(); } catch {
			// Senders concurrently revoke directories; storage errors must not
			// escape an interval callback. Retry on the next tick.
		}
	}, 50);
	timer.unref?.();
	return async () => {
		stopped = true;
		clearInterval(timer);
		for (const entry of active.values()) entry.abort.abort();
		await Promise.all([...active.values()].map((entry) => entry.done));
	};
}
