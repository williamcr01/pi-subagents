// Regression tests for the subagents extension. No dependencies, no API calls.
// Run: node subagents.test.cjs
const { execSync, execFileSync, spawn: spawnProcess } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findPiRoot() {
	const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
	const real = fs.realpathSync(bin);
	// <root>/dist/bundle/cli.js
	return path.resolve(path.dirname(real), "..", "..");
}

const PI = process.env.PI_ROOT || findPiRoot();
const PIN = path.join(PI, "node_modules");
const { createJiti } = require(path.join(PIN, "jiti"));

const HERE = __dirname;
const jiti = createJiti(__filename, {
	interopDefault: true,
	fsCache: false,
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(PI, "dist", "bundle", "index.js"),
		"@earendil-works/pi-tui": path.join(PIN, "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: require.resolve("typebox", { paths: [PI] }),
	},
});

let failures = 0;
function check(name, cond, extra) {
	if (cond) console.log(`ok - ${name}`);
	else {
		failures++;
		console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
	}
}

(async () => {
	const config = await jiti.import(path.join(HERE, "config.ts"));
	const registry = await jiti.import(path.join(HERE, "registry.ts"));
	const events = await jiti.import(path.join(HERE, "events.ts"));
	const control = await jiti.import(path.join(HERE, "control.ts"));
	const spawn = await jiti.import(path.join(HERE, "spawn-agent.ts"));
	const wait = await jiti.import(path.join(HERE, "wait.ts"));
	const { SubagentPanel } = await jiti.import(path.join(HERE, "panel.ts"));
	const { default: subagentsExtension } = await jiti.import(path.join(HERE, "index.ts"));

	// --- config ---
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
	const agentDir = path.join(sandbox, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	let s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("default RPC bound is 64 Mi characters", s.rpcMaxLineChars === 64 * 1024 * 1024);
	for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1024", null]) {
		let threw = false;
		try { config.validateRpcMaxLineChars(value, "test"); } catch { threw = true; }
		check(`invalid RPC bound ${String(value)} rejected`, threw);
	}
	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ rpcMaxLineChars: 12345 }));
	check("RPC bound loads from configuration", config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} }).rpcMaxLineChars === 12345);
	check("defaults maxDepth=2", s.maxDepth === 2, s.maxDepth);
	check("defaults maxConcurrency=4", s.maxConcurrency === 4, s.maxConcurrency);

	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ defaultModel: "a/b", maxDepth: 5, maxConcurrency: 2 }));
	fs.mkdirSync(path.join(sandbox, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, ".pi", "subagents.json"), JSON.stringify({ maxDepth: 9 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, env: {} });
	check("project maxDepth wins", s.maxDepth === 9, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("untrusted project ignored", s.maxDepth === 5, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, depthFlag: "3", env: {} });
	check("flag wins", s.maxDepth === 3, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, depthFlag: "30", env: { PI_SUBAGENT_MAX_DEPTH: "4" } });
	check("inherited caps flag", s.maxDepth === 4, s.maxDepth);

	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrency: -1, maxDepth: 100 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("concurrency -1 kept", s.maxConcurrency === -1, s.maxConcurrency);
	check("depth 100 kept (no cap)", s.maxDepth === 100, s.maxDepth);

	for (const [label, bad] of [["depth -1", { maxDepth: -1 }], ["depth 1.5", { maxDepth: 1.5 }], ["concurrency 0", { maxConcurrency: 0 }], ["concurrency -2", { maxConcurrency: -2 }], ["bad thinking", { defaultThinking: "ultra" }]]) {
		fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify(bad));
		let threw = false;
		try { config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} }); } catch { threw = true; }
		check(`invalid ${label} throws`, threw);
	}
	fs.writeFileSync(path.join(agentDir, "subagents.json"), "{}");
	let envThinkingThrew = false;
	try {
		config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: { PI_SUBAGENT_DEFAULT_THINKING: "ultra" } });
	} catch {
		envThinkingThrew = true;
	}
	check("invalid environment thinking throws", envThinkingThrew);

	// --- registry ---
	const agentDir2 = path.join(sandbox, "agent2");
	const now = new Date().toISOString();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const mk = (runId, parent, extra = {}) => ({
		version: 1, runId, parentRunId: parent, rootRunId: "root", sessionId: runId,
		name: runId, task: "t", cwd: "/tmp", model: "m", thinking: "off",
		depth: 1, maxDepth: 2, status: "completed", usage: { ...usage },
		startedAt: now, updatedAt: now, ...extra,
	});
	registry.saveRecord(agentDir2, mk("root", ""));
	registry.saveRecord(agentDir2, mk("child1", "root"));
	registry.saveRecord(agentDir2, mk("child2", "root"));
	registry.saveRecord(agentDir2, mk("grand", "child1"));
	fs.writeFileSync(path.join(agentDir2, "subagents", "runs", "junk.json"), "not json{");
	const all = registry.readRecords(agentDir2);
	check("malformed record skipped", all.length === 4, all.length);
	const desc = registry.descendantsOf(all, "root").map((r) => r.runId);
	check("descendants order", JSON.stringify(desc) === JSON.stringify(["child1", "grand", "child2"]), desc.join(","));
	const depths = registry.relativeDepths(all, "root");
	check("relative depths", depths.get("child1") === 0 && depths.get("grand") === 1, JSON.stringify([...depths]));

	// --- actionable run IDs ---
	const targetA = mk("12345678-aaaa-4000-8000-000000000001", "root", { name: "review", sessionId: "session-a" });
	const targetB = mk("87654321-bbbb-4000-8000-000000000002", "root", { name: "review", sessionId: "session-b" });
	const targets = [targetA, targetB];
	check("displayed eight-character run ID resolves", registry.resolveAgentRecord(targets, "12345678") === targetA);
	check("full run ID resolves", registry.resolveAgentRecord(targets, targetB.runId) === targetB);
	check("exact session ID resolves", registry.resolveAgentRecord(targets, "session-b") === targetB);
	check("target whitespace is trimmed", registry.resolveAgentRecord(targets, " 12345678 ") === targetA);
	const named = mk("other-id", "root", { name: "12345678", sessionId: "other-session" });
	check("exact name takes precedence over run prefix", registry.resolveAgentRecord([...targets, named], "12345678") === named);
	const collision = mk("12345678-cccc-4000-8000-000000000003", "root");
	for (const [label, rows, target] of [
		["duplicate name", targets, "review"],
		["ambiguous prefix", [...targets, collision], "12345678"],
	]) {
		let error;
		try { registry.resolveAgentRecord(rows, target); } catch (caught) { error = caught; }
		check(`${label} rejected with actionable full IDs`, error?.message.includes("ambiguous") && error.message.includes(targetA.runId) && error.message.includes(label === "duplicate name" ? targetB.runId : collision.runId), error?.message);
	}
	for (const target of ["", "   ", "unknown"]) {
		let rejected = false;
		try { registry.resolveAgentRecord(targets, target); } catch { rejected = true; }
		check(`invalid target ${JSON.stringify(target)} rejected`, rejected);
	}

	// --- execution-scoped parent state (including legacy records) ---
	{
		const dir = path.join(sandbox, "result-state");
		let owner = registry.saveRecord(dir, mk("result", "root", { latestText: "first" }));
		const staleParent = { ...owner };
		registry.markRecordResultState(dir, staleParent, "resultsDelivered");
		registry.markRecordResultState(dir, staleParent, "footerDismissed");
		owner = registry.saveRecord(dir, { ...owner, resultsDelivered: false, footerDismissed: false });
		check("stale owner publish preserves both parent flags", owner.resultsDelivered && owner.footerDismissed);
		const parsed = { finalText: "first" };
		events.applyChildEvent(owner, parsed, { type: "agent_start" });
		owner.latestText = "second in progress";
		owner = registry.saveRecord(dir, owner);
		check("agent_start resets legacy flags for a new execution", !!owner.executionId && !owner.resultsDelivered && !owner.footerDismissed);
		const recordFile = path.join(registry.registryDir(dir), "result.json");
		const before = fs.readFileSync(recordFile, "utf8");
		// A separate process with an old terminal snapshot must write only old
		// execution markers, never replace the newer execution's JSON.
		execFileSync(process.execPath, ["-e", `
			const { createJiti } = require(${JSON.stringify(path.join(PIN, "jiti"))});
			const jiti = createJiti(${JSON.stringify(__filename)}, { fsCache: false });
			(async () => {
				const registry = await jiti.import(${JSON.stringify(path.join(HERE, "registry.ts"))});
				const record = ${JSON.stringify(staleParent)};
				registry.markRecordResultState(${JSON.stringify(dir)}, record, "resultsDelivered");
				registry.markRecordResultState(${JSON.stringify(dir)}, record, "footerDismissed");
			})();
		`]);
		check("cross-process stale UI writes leave execution JSON untouched", fs.readFileSync(recordFile, "utf8") === before);
		const current = registry.readRecords(dir)[0];
		check("old execution claims do not mark continuation", current.status === "thinking" && current.latestText === "second in progress" && !current.resultsDelivered && !current.footerDismissed);
		registry.markRecordResultState(dir, current, "resultsDelivered");
		registry.markRecordResultState(dir, current, "footerDismissed");
		const closed = registry.clearRecordPid(dir, { ...owner, pid: process.pid });
		check("clearRecordPid preserves current execution claims", closed.pid === undefined && closed.resultsDelivered && closed.footerDismissed);
	}

	// --- wait ---
	const waitSleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
	const waitCase = (name) => path.join(sandbox, `wait-${name}`);
	const waitRecord = (dir, parent, runId, status, extra = {}) =>
		registry.saveRecord(dir, mk(runId, parent, { rootRunId: parent, status, ...extra }));

	{
		const dir = waitCase("idle");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000 });
		check("wait returns immediately when no children", rows.length === 0 && Date.now() - started < 200, String(Date.now() - started));
	}

	{
		const dir = waitCase("already");
		waitRecord(dir, "parent", "done", "completed");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000 });
		check("wait returns immediately when all terminal", rows.length === 1 && Date.now() - started < 200, String(Date.now() - started));
	}

	{
		const dir = waitCase("notify");
		waitRecord(dir, "parent", "live", "thinking");
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, pollMs: 10000 });
		setTimeout(() => {
			waitRecord(dir, "parent", "live", "completed", { latestText: "notified" });
			wait.notifyWaiters(dir);
		}, 40);
		const rows = await pending;
		check("in-process notify wakes wait immediately", Date.now() - started < 500, String(Date.now() - started));
		check("notify wait sees completed child", rows.some((r) => r.runId === "live" && r.status === "completed"));
		check("notify wait releases resources", wait.waitDebugState().waiters === 0 && wait.waitDebugState().watches === 0, JSON.stringify(wait.waitDebugState()));
	}

	{
		const dir = waitCase("all");
		waitRecord(dir, "parent", "a", "thinking");
		waitRecord(dir, "parent", "b", "thinking");
		let resolved = false;
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, pollMs: 10000 }).then((rows) => {
			resolved = true;
			return rows;
		});
		await waitSleep(30);
		waitRecord(dir, "parent", "a", "completed");
		wait.notifyWaiters(dir);
		await waitSleep(50);
		check("wait-for-all stays pending after first child", resolved === false);
		waitRecord(dir, "parent", "b", "completed");
		wait.notifyWaiters(dir);
		await pending;
		check("wait-for-all returns after last child", resolved && Date.now() - started < 500, String(Date.now() - started));
	}

	{
		const dir = waitCase("watch");
		waitRecord(dir, "parent", "watched", "thinking");
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 3000, pollMs: 10000 });
		setTimeout(() => {
			waitRecord(dir, "parent", "watched", "completed");
		}, 40);
		await pending;
		check("fs.watch wakes wait without notify", Date.now() - started < 1500, String(Date.now() - started));
	}

	{
		const dir = waitCase("abort");
		waitRecord(dir, "parent", "abort-me", "thinking");
		const ac = new AbortController();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, signal: ac.signal, pollMs: 10000 });
		ac.abort();
		let abortThrew = false;
		try {
			await pending;
		} catch (error) {
			abortThrew = error instanceof Error && error.message.includes("aborted");
		}
		check("abort rejects wait", abortThrew);
		check("abort releases waiters", wait.waitDebugState().waiters === 0 && wait.waitDebugState().watches === 0, JSON.stringify(wait.waitDebugState()));
	}

	{
		const dir = waitCase("zero");
		waitRecord(dir, "parent", "still-running", "thinking");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 0 });
		check("timeout 0 does not wait", rows.some((r) => r.status === "thinking") && Date.now() - started < 200, String(Date.now() - started));
	}

	{
		const dir = waitCase("dead-pid");
		waitRecord(dir, "parent", "ghost", "thinking", { pid: 2147483647 });
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000 });
		const ghost = rows.find((r) => r.runId === "ghost");
		check("dead pid treated as terminal without waiting", ghost && ghost.status === "failed" && Date.now() - started < 200, ghost && `${ghost.status} ${Date.now() - started}`);
	}

	{
		const dir = waitCase("dead-while");
		const child = spawnProcess("sleep", ["30"], { stdio: "ignore" });
		waitRecord(dir, "parent", "live-pid", "thinking", { pid: child.pid });
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 3000, pollMs: 50 });
		await waitSleep(20);
		child.kill("SIGKILL");
		await new Promise((resolveWait) => child.once("close", resolveWait));
		const rows = await pending;
		const live = rows.find((r) => r.runId === "live-pid");
		check("dead pid during wait is noticed by poll", live && live.status === "failed" && Date.now() - started < 500, live && `${live.status} ${Date.now() - started}`);
	}

	// --- incremental check results ---
	const checkAgentDir = path.join(sandbox, "check-agent");
	fs.mkdirSync(checkAgentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRunId = process.env.PI_SUBAGENT_RUN_ID;
	const previousRootId = process.env.PI_SUBAGENT_ROOT_ID;
	delete process.env.PI_SUBAGENT_RUN_ID;
	delete process.env.PI_SUBAGENT_ROOT_ID;
	process.env.PI_CODING_AGENT_DIR = checkAgentDir;
	const checkHandlers = new Map();
	const checkTools = new Map();
	const checkPi = {
		registerFlag: () => {},
		on: (event, handler) => checkHandlers.set(event, handler),
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerTool: (tool) => checkTools.set(tool.name, tool),
		getFlag: () => undefined,
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	try {
		subagentsExtension(checkPi);
		await checkHandlers.get("session_start")({}, {
			sessionManager: { getSessionId: () => "check-parent" },
			cwd: sandbox,
			isProjectTrusted: () => false,
			mode: "rpc",
			hasUI: false,
		});
		const prefixRecord = mk("abcd1234-aaaa-4000-8000-000000000004", "check-parent", { rootRunId: "check-parent", status: "completed" });
		registry.saveRecord(checkAgentDir, prefixRecord);
		const prefixCancel = await checkTools.get("cancel_subagent").execute("cancel-prefix", { target: "abcd1234" }, undefined, undefined, {});
		check("cancel tool accepts displayed run prefix", prefixCancel.details.record.runId === prefixRecord.runId);
		let prefixSendError;
		try { await checkTools.get("send_to_subagent").execute("send-prefix", { target: "abcd1234", message: "hello" }); } catch (error) { prefixSendError = error; }
		check("send tool resolves prefix before checking liveness", prefixSendError?.message.includes("is no longer running"), prefixSendError?.message);
		const checkTool = checkTools.get("check_subagents");
		const checkRecord = (runId, status, extra = {}) => mk(runId, "check-parent", { rootRunId: "check-parent", status, ...extra });
		registry.saveRecord(checkAgentDir, checkRecord("first", "completed", { latestText: "first result" }));
		registry.saveRecord(checkAgentDir, checkRecord("second", "thinking", { activity: "working" }));
		const firstCheck = await checkTool.execute("check-1", { wait: false }, undefined, undefined, {});
		const firstText = firstCheck.content[0].text;
		check("first check returns first result", firstText.includes("first result"), firstText);
		check("first check reports second running", firstText.includes("second") && firstText.includes("still running"), firstText);

		const finishTimer = setTimeout(() => {
			registry.saveRecord(checkAgentDir, checkRecord("second", "completed", { latestText: "second result" }));
		}, 50);
		const waitStarted = Date.now();
		const secondCheck = await checkTool.execute("check-2", { wait: true, timeoutMs: 1000 }, undefined, undefined, {});
		clearTimeout(finishTimer);
		const secondText = secondCheck.content[0].text;
		check("second check returns newly finished result", secondText.includes("second result"), secondText);
		check("second check returns before timeout once child finishes", Date.now() - waitStarted < 800, String(Date.now() - waitStarted));
		check("second check omits previously delivered result", !secondText.includes("first result"), secondText);
		const thirdCheck = await checkTool.execute("check-3", { wait: false }, undefined, undefined, {});
		const thirdText = thirdCheck.content[0].text;
		check("later check omits all delivered results", !thirdText.includes("first result") && !thirdText.includes("second result"), thirdText);
		check("later check explains no new results", thirdText.includes("No new subagent results since the last check."), thirdText);

		// A recursive result belongs to its direct parent, even when the root can inspect it.
		registry.saveRecord(checkAgentDir, checkRecord("owner-child", "completed", { latestText: "child result" }));
		registry.saveRecord(checkAgentDir, mk("owner-grand", "owner-child", {
			rootRunId: "check-parent", depth: 2, status: "completed", latestText: "grandchild result",
		}));
		const rootOwnershipCheck = await checkTool.execute("check-owner-root", { wait: false }, undefined, undefined, {});
		const rootOwnershipText = rootOwnershipCheck.content[0].text;
		const afterRootOwnership = registry.readRecords(checkAgentDir);
		check("root claims its direct child result", afterRootOwnership.find((r) => r.runId === "owner-child")?.resultsDelivered === true);
		check("root does not claim grandchild result", afterRootOwnership.find((r) => r.runId === "owner-grand")?.resultsDelivered !== true);
		check("root can inspect grandchild result read-only", rootOwnershipText.includes("grandchild result") && rootOwnershipText.includes("read-only descendant"), rootOwnershipText);

		const childHandlers = new Map();
		const childTools = new Map();
		const childPi = {
			...checkPi,
			on: (event, handler) => childHandlers.set(event, handler),
			registerTool: (tool) => childTools.set(tool.name, tool),
		};
		process.env.PI_SUBAGENT_RUN_ID = "owner-child";
		process.env.PI_SUBAGENT_ROOT_ID = "check-parent";
		subagentsExtension(childPi);
		await childHandlers.get("session_start")({}, {
			sessionManager: { getSessionId: () => "owner-child" },
			cwd: sandbox,
			isProjectTrusted: () => false,
			mode: "rpc",
			hasUI: false,
		});
		delete process.env.PI_SUBAGENT_RUN_ID;
		delete process.env.PI_SUBAGENT_ROOT_ID;
		const childOwnershipCheck = await childTools.get("check_subagents").execute("check-owner-child", { wait: false }, undefined, undefined, {});
		check("child receives grandchild result", childOwnershipCheck.content[0].text.includes("grandchild result"), childOwnershipCheck.content[0].text);
		check("child claims grandchild result", registry.readRecords(checkAgentDir).find((r) => r.runId === "owner-grand")?.resultsDelivered === true);
		const rootAfterParentClaim = await checkTool.execute("check-owner-root-again", { wait: false }, undefined, undefined, {});
		check("root omits grandchild after parent claims it", !rootAfterParentClaim.content[0].text.includes("grandchild result"), rootAfterParentClaim.content[0].text);

		let automaticGrandchildMessages = 0;
		childPi.sendMessage = async (message) => {
			if (message.content.includes("automatic-grand")) automaticGrandchildMessages++;
		};
		registry.saveRecord(checkAgentDir, mk("automatic-grand", "owner-child", {
			rootRunId: "check-parent", depth: 2, status: "thinking", latestText: "automatic grandchild result",
		}));
		await childTools.get("cancel_subagent").execute("cancel-automatic-grand", { target: "automatic-grand" }, undefined, undefined, {});
		for (let i = 0; i < 100 && automaticGrandchildMessages < 1; i++) await new Promise((r) => setTimeout(r, 25));
		check("automatic grandchild delivery reaches direct parent", automaticGrandchildMessages === 1, String(automaticGrandchildMessages));
		check("automatic grandchild delivery is claimed by direct parent", registry.readRecords(checkAgentDir).find((r) => r.runId === "automatic-grand")?.resultsDelivered === true);
		childHandlers.get("session_shutdown")?.({}, { mode: "rpc" });

		// A failed automatic send leaves the result pending and schedules another attempt.
		let automaticSendAttempts = 0;
		checkPi.sendMessage = () => {
			automaticSendAttempts++;
			if (automaticSendAttempts === 1) throw new Error("temporary send failure");
		};
		registry.saveRecord(checkAgentDir, checkRecord("retry-child", "thinking"));
		await checkTools.get("cancel_subagent").execute("cancel-retry", { target: "retry-child" }, undefined, undefined, {});
		for (let i = 0; i < 100 && automaticSendAttempts < 1; i++) await new Promise((r) => setTimeout(r, 25));
		check("failed automatic send leaves result unclaimed", registry.readRecords(checkAgentDir).find((r) => r.runId === "retry-child")?.resultsDelivered !== true);
		for (let i = 0; i < 100 && automaticSendAttempts < 2; i++) await new Promise((r) => setTimeout(r, 25));
		check("failed automatic send is retried", automaticSendAttempts >= 2, String(automaticSendAttempts));
		check("successful automatic retry claims result", registry.readRecords(checkAgentDir).find((r) => r.runId === "retry-child")?.resultsDelivered === true);

		// An asynchronous send failure must behave like a synchronous one: the
		// result stays pending and the delivery loop retries it.
		let asyncAutomaticSendAttempts = 0;
		checkPi.sendMessage = async () => {
			asyncAutomaticSendAttempts++;
			if (asyncAutomaticSendAttempts === 1) throw new Error("temporary async send failure");
		};
		registry.saveRecord(checkAgentDir, checkRecord("async-retry-child", "thinking"));
		await checkTools.get("cancel_subagent").execute("cancel-async-retry", { target: "async-retry-child" }, undefined, undefined, {});
		for (let i = 0; i < 100 && asyncAutomaticSendAttempts < 1; i++) await new Promise((r) => setTimeout(r, 25));
		check("async failed automatic send leaves result unclaimed", registry.readRecords(checkAgentDir).find((r) => r.runId === "async-retry-child")?.resultsDelivered !== true);
		for (let i = 0; i < 100 && asyncAutomaticSendAttempts < 2; i++) await new Promise((r) => setTimeout(r, 25));
		check("async failed automatic send is retried", asyncAutomaticSendAttempts >= 2, String(asyncAutomaticSendAttempts));
		check("successful async automatic retry claims result", registry.readRecords(checkAgentDir).find((r) => r.runId === "async-retry-child")?.resultsDelivered === true);
	} finally {
		checkHandlers.get("session_shutdown")?.({}, { mode: "rpc" });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
		else process.env.PI_SUBAGENT_RUN_ID = previousRunId;
		if (previousRootId === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
		else process.env.PI_SUBAGENT_ROOT_ID = previousRootId;
	}

	// --- editor composition ---
	const editorHandlers = new Map();
	let installedEditorFactory;
	let delegatedInput;
	const existingEditor = {
		render: () => [],
		invalidate: () => {},
		getText: () => "",
		setText: () => {},
		handleInput: (data) => { delegatedInput = data; },
		isShowingAutocomplete: () => false,
		getCursor: () => ({ line: 0, col: 0 }),
		getLines: () => [""],
	};
	const originalEditorFactory = () => existingEditor;
	let currentEditorFactory = originalEditorFactory;
	const editorUi = {
		setWidget: () => {},
		getEditorComponent: () => currentEditorFactory,
		setEditorComponent: (factory) => {
			currentEditorFactory = factory;
			if (factory !== originalEditorFactory) installedEditorFactory = factory;
		},
		notify: () => {},
	};
	const editorPi = {
		...checkPi,
		on: (event, handler) => editorHandlers.set(event, handler),
	};
	subagentsExtension(editorPi);
	editorHandlers.get("session_start")({}, {
		sessionManager: { getSessionId: () => "editor-parent" },
		cwd: sandbox,
		isProjectTrusted: () => false,
		mode: "tui",
		hasUI: true,
		model: undefined,
		ui: editorUi,
	});
	const composedEditor = installedEditorFactory({}, {}, { matches: () => false });
	composedEditor.handleInput("z");
	check("existing custom editor is composed instead of replaced", composedEditor === existingEditor && delegatedInput === "z");
	editorHandlers.get("session_shutdown")?.({}, { mode: "tui", ui: editorUi });
	check("session shutdown restores the previous custom editor", currentEditorFactory === originalEditorFactory);

	// --- control inbox ---
	control.queueSubagentMessage(agentDir2, { targetRunId: "child1", rootRunId: "root", text: "change direction" });
	const inbox = control.consumeSubagentMessages(agentDir2, "child1", "root");
	check("control inbox delivers message", inbox.length === 1 && inbox[0].text === "change direction", JSON.stringify(inbox));
	check("control inbox consumes once", control.consumeSubagentMessages(agentDir2, "child1", "root").length === 0);
	registry.saveRecord(agentDir2, mk("child1", "root", { status: "thinking" }));
	registry.saveRecord(agentDir2, mk("grand", "child1", { status: "running_tool" }));
	const child1StaleWriter = registry.readRecords(agentDir2).find((r) => r.runId === "child1");
	spawn.cancelSubagent(agentDir2, child1StaleWriter);
	const cancelledTree = registry.readRecords(agentDir2);
	check("cancelling parent cancels descendants", ["child1", "grand"].every((id) => cancelledTree.find((r) => r.runId === id)?.status === "cancelled"));
	fs.writeFileSync(
		path.join(agentDir2, "subagents", "runs", "child1.json"),
		`${JSON.stringify({ ...child1StaleWriter, status: "completed", latestText: "stale completion" })}\n`,
	);
	const monotonicCancel = registry.readRecords(agentDir2).find((r) => r.runId === "child1");
	check("stale record writer cannot undo cancellation", monotonicCancel?.status === "cancelled", monotonicCancel?.status);
	registry.clearRecordPid(agentDir2, { ...monotonicCancel, pid: 2147483647 });
	fs.writeFileSync(
		path.join(agentDir2, "subagents", "runs", "child1.json"),
		`${JSON.stringify({ ...monotonicCancel, pid: 2147483647 })}\n`,
	);
	const clearedPid = registry.readRecords(agentDir2).find((r) => r.runId === "child1")?.pid;
	check("stale record writer cannot restore cleared PID", clearedPid === undefined, String(clearedPid));
	registry.saveRecord(agentDir2, mk("stale", "root", { status: "running_tool", pid: 2147483647 }));
	const stale = registry.readRecords(agentDir2).find((r) => r.runId === "stale");
	check("dead pid reconciled to failed", stale && stale.status === "failed", stale && stale.status);

	// --- events ---
	const rec = mk("x", "root", { status: "starting", activity: "starting" });
	const state = { finalText: "" };
	for (const e of [
		{ type: "session", id: "sess-1" },
		{ type: "agent_start" },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello " } },
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false },
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hello done" }], provider: "p", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } }, stopReason: "stop", timestamp: 1 },
		},
		{ type: "agent_end", messages: [] },
	]) events.applyChildEvent(rec, state, e);
	check("session id captured", rec.sessionId === "sess-1", rec.sessionId);
	check("tool cleared after end", rec.currentTool === undefined, String(rec.currentTool));
	check("final text", state.finalText === "hello done", state.finalText);
	check("usage summed", rec.usage.input === 10 && rec.usage.cost === 0.001, JSON.stringify(rec.usage));
	check("idle after agent_end", rec.status === "idle", rec.status);

	// --- gate ---
	const g1 = new spawn.ConcurrencyGate();
	const slots = await Promise.all([g1.acquire(-1), g1.acquire(-1), g1.acquire(-1)]);
	check("unlimited acquires immediately", slots.length === 3);
	slots.forEach((r) => r());
	const g2 = new spawn.ConcurrencyGate();
	const r1 = await g2.acquire(1);
	let secondResolved = false;
	const p2 = g2.acquire(1).then((r) => { secondResolved = true; return r; });
	await new Promise((r) => setTimeout(r, 50));
	check("second acquire waits at limit 1", secondResolved === false);
	r1();
	const r2 = await p2;
	check("second acquire resolves after release", secondResolved === true);
	r2();

	// --- capability narrowing ---
	const inheritedTools = spawn.resolveChildTools(undefined, ["read", "spawn_agent", "read"]);
	check("omitted tools inherit active tools", JSON.stringify(inheritedTools) === JSON.stringify(["read", "spawn_agent"]), JSON.stringify(inheritedTools));
	const narrowedTools = spawn.resolveChildTools(["read"], ["read", "bash", "spawn_agent"]);
	check("explicit tools may narrow active tools", JSON.stringify(narrowedTools) === JSON.stringify(["read"]), JSON.stringify(narrowedTools));
	check("explicit empty tools stays empty", spawn.resolveChildTools([], ["read", "spawn_agent"]).length === 0);
	for (const [label, tools] of [["blank", ["  "]], ["surrounding whitespace", [" read"]], ["comma", ["read,bash"]], ["control", ["read\n"]]]) {
		let threw = false;
		try { spawn.resolveChildTools(tools, ["read", "bash"]); } catch { threw = true; }
		check(`${label} tool name rejected`, threw);
	}
	let escalationThrew = false;
	try { spawn.resolveChildTools(["read", "write"], ["read"]); } catch (error) { escalationThrew = String(error).includes("subset"); }
	check("explicit tools cannot add a parent-inactive tool", escalationThrew);
	const safeSubset = spawn.resolveChildTools(["read"], ["read", "bad,parent-tool"]);
	check("excluded unserializable parent tool does not block a subset", JSON.stringify(safeSubset) === JSON.stringify(["read"]), JSON.stringify(safeSubset));
	check("empty model scope keeps legacy model selection", spawn.resolveChildModel("fuzzy-model", []) === "fuzzy-model");
	const modelScope = [{ provider: "one", id: "shared" }, { provider: "two", id: "other" }];
	check("scoped bare model canonicalized", spawn.resolveChildModel("OTHER", modelScope) === "two/other");
	check("scoped canonical model matching ignores case", spawn.resolveChildModel("TWO/OTHER", modelScope) === "two/other");
	let modelScopeThrew = false;
	try { spawn.resolveChildModel("outside", modelScope); } catch (error) { modelScopeThrew = String(error).includes("outside"); }
	check("out-of-scope child model rejected", modelScopeThrew);
	let ambiguousModelThrew = false;
	try { spawn.resolveChildModel("shared", [...modelScope, { provider: "three", id: "shared" }]); } catch (error) { ambiguousModelThrew = String(error).includes("ambiguous"); }
	check("ambiguous bare scoped model rejected", ambiguousModelThrew);

	// --- panel ---
	const piRoot = await jiti.import("@earendil-works/pi-coding-agent");
	piRoot.initTheme("dark");
	const theme = { fg: (_c, t) => String(t), bg: (_c, t) => String(t), bold: (t) => String(t), getSelectionBackgroundColor: () => (t) => String(t) };
	const focusedTarget = { value: "unset" };
	let focusedComponent;
	let activeOverlay;
	const tui = {
		terminal: { rows: 40, columns: 100 },
		requestRender: () => {},
		setFocus: (component) => {
			if (focusedComponent && "focused" in focusedComponent) focusedComponent.focused = false;
			focusedComponent = component;
			if (focusedComponent && "focused" in focusedComponent) focusedComponent.focused = true;
			focusedTarget.value = component ? "panel" : "null";
		},
		showOverlay: function (component) {
			const previous = focusedComponent;
			activeOverlay = component;
			this.setFocus(component);
			return {
				hide: () => {
					if (activeOverlay !== component) return;
					activeOverlay = undefined;
					this.setFocus(previous ?? null);
				},
				setHidden: () => {},
				isHidden: () => false,
				focus: () => this.setFocus(component),
				unfocus: () => this.setFocus(previous ?? null),
				isFocused: () => focusedComponent === component,
			};
		},
	};
	let panel = new SubagentPanel(tui, theme, agentDir2, "nope");
	check("empty renders nothing", panel.render(80).length === 0);
	panel.dispose();

	registry.saveRecord(agentDir2, mk("alpha", "root2", { status: "running_tool", currentTool: "bash npm test", latestText: "testing…", model: "prov/model-x" }));
	registry.saveRecord(agentDir2, mk("beta", "root2"));
	panel = new SubagentPanel(tui, theme, agentDir2, "root2");
	panel.setMainModel("p/m");
	const summary = panel.render(100);
	check("footer shows main with model", summary.length > 0 && summary[0].includes("main") && summary[0].includes("p/m"), JSON.stringify(summary));
	check("footer shows running child", summary.some((l) => l.includes("alpha")) && summary.some((l) => l.includes("npm test")), summary.join(" | "));
	check("footer shows child provider/model", summary.some((l) => l.includes("prov/model-x")), summary.join(" | "));
	tui.setFocus(panel);
	const list = panel.render(100);
	check("list shows children", list.some((l) => l.includes("alpha")) && list.some((l) => l.includes("beta")), list.join(" | "));
	panel.handleInput("");
	check("esc returns focus", focusedTarget.value === "null", focusedTarget.value);
	const strip = (l) => l.replace(/\[[0-9;]*m/g, "");
	for (const w of [20, 80, 200]) {
		const over = panel.render(w).filter((l) => [...strip(l)].length > w);
		check(`no overflow at width ${w}`, over.length === 0, over.join(" | "));
	}
	panel.dispose();

	// --- async spawn: returns immediately, settles in background, auto-cancels ---
	const fakePi = path.join(HERE, "fake-pi.cjs");
	const spawnDir = path.join(sandbox, "spawn");
	fs.mkdirSync(spawnDir, { recursive: true });
	const spawnAgentDir = path.join(sandbox, "spawn-agent");
	fs.mkdirSync(spawnAgentDir, { recursive: true });
	const baseCtx = () => ({
		agentDir: spawnAgentDir,
		parentRunId: "parent",
		rootRunId: "parent",
		currentDepth: 0,
		settings: { maxDepth: 2, maxConcurrency: -1 },
		parentModel: "fake/parent",
		parentThinking: "off",
		parentTools: ["read", "spawn_agent"],
		scopedModels: [],
		parentCwd: spawnDir,
		projectTrusted: false,
	});
	process.env.PI_SUBAGENT_COMMAND = fakePi;

	// --- project trust follows canonical paths ---
	const fakeArgsDir = path.join(sandbox, "trust-args");
	process.env.FAKE_ARGS_DIR = fakeArgsDir;
	const internalDir = path.join(spawnDir, "internal");
	const externalDir = path.join(sandbox, "external-project");
	const externalLink = path.join(spawnDir, "external-link");
	fs.mkdirSync(internalDir);
	fs.mkdirSync(externalDir);
	fs.symlinkSync(externalDir, externalLink, process.platform === "win32" ? "junction" : "dir");
	const internalRec = await spawn.startSubagent(
		{ task: "trusted internal", cwd: internalDir },
		{ ...baseCtx(), projectTrusted: true, persistAfterSettled: false },
	);
	const externalRec = await spawn.startSubagent(
		{ task: "untrusted symlink", cwd: externalLink },
		{ ...baseCtx(), projectTrusted: true, persistAfterSettled: false },
	);
	for (let i = 0; i < 100; i++) {
		const rows = registry.readRecords(spawnAgentDir);
		if ([internalRec, externalRec].every((record) => rows.find((row) => row.runId === record.runId)?.status === "completed")) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const internalArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${internalRec.runId}.json`), "utf8"));
	const externalArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${externalRec.runId}.json`), "utf8"));
	check("trusted canonical descendant inherits approval", internalArgs.includes("--approve"), JSON.stringify(internalArgs));
	check("symlink escape does not inherit approval", !externalArgs.includes("--approve"), JSON.stringify(externalArgs));
	check("child cwd is canonicalized", externalRec.cwd === fs.realpathSync(externalDir), externalRec.cwd);

	let requestedModelThrew = false;
	try {
		await spawn.startSubagent({ task: "x", model: "fake/outside" }, { ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed" }] });
	} catch (error) {
		requestedModelThrew = String(error).includes("outside");
	}
	check("requested child model must be in nonempty parent scope", requestedModelThrew);
	let defaultModelThrew = false;
	try {
		await spawn.startSubagent(
			{ task: "x" },
			{ ...baseCtx(), settings: { ...baseCtx().settings, defaultModel: "fake/outside" }, scopedModels: [{ provider: "fake", id: "allowed" }] },
		);
	} catch (error) {
		defaultModelThrew = String(error).includes("outside");
	}
	check("configured default child model must be in nonempty parent scope", defaultModelThrew);
	let inheritedModelThrew = false;
	try {
		await spawn.startSubagent({ task: "x" }, { ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed" }] });
	} catch (error) {
		inheritedModelThrew = String(error).includes("outside");
	}
	check("inherited child model must be in nonempty parent scope", inheritedModelThrew);
	let pinThrew = false;
	try {
		await spawn.startSubagent(
			{ task: "x", model: "allowed", thinking: "off" },
			{ ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed", thinkingLevel: "high" }] },
		);
	} catch (error) {
		pinThrew = String(error).includes("pin");
	}
	check("explicit thinking cannot escape scoped pin", pinThrew);
	check("capability validation fails before saving a run", registry.readRecords(spawnAgentDir).length === 2, registry.readRecords(spawnAgentDir).length);

	const t0 = Date.now();
	const settled = [];
	const rec1 = await spawn.startSubagent({ task: "say hi", name: "alpha" }, { ...baseCtx(), onSettled: (r) => settled.push(r.status) });
	check("startSubagent returns fast", Date.now() - t0 < 1000, String(Date.now() - t0));
	check("startSubagent returns non-terminal record", !spawn.isTerminalStatus ? rec1.status !== "completed" : true, rec1.status);
	let polled;
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (polled && ["completed", "failed"].includes(polled.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("background child completes", polled && polled.status === "completed", polled && polled.status);
	check("fake output captured", polled && polled.latestText === "fake done", polled && polled.latestText);
	check("usage captured", polled && polled.usage.input === 10, polled && JSON.stringify(polled.usage));
	const inheritedArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${rec1.runId}.json`), "utf8"));
	check("omitted tools become a child CLI allowlist", inheritedArgs[inheritedArgs.indexOf("--tools") + 1] === "read,spawn_agent", JSON.stringify(inheritedArgs));
	check("empty model scope emits no --models flag", !inheritedArgs.includes("--models"), JSON.stringify(inheritedArgs));
	await new Promise((r) => setTimeout(r, 250));
	check("onSettled fired", settled.includes("completed"), JSON.stringify(settled));

	// Claim/dismiss at settlement while the owning process still has stale flags.
	// A real child close must not resurrect either UI state.
	const closeRec = await spawn.startSubagent({ task: "close after result" }, {
		...baseCtx(), persistAfterSettled: false,
		onSettled: (record) => {
			registry.markRecordResultState(spawnAgentDir, { ...record }, "resultsDelivered");
			registry.markRecordResultState(spawnAgentDir, { ...record }, "footerDismissed");
		},
	});
	let closedResult;
	for (let i = 0; i < 100; i++) {
		closedResult = registry.readRecords(spawnAgentDir).find((r) => r.runId === closeRec.runId);
		if (closedResult?.status === "completed" && closedResult.pid === undefined) break;
		await waitSleep(25);
	}
	check("actual child close clears PID and preserves claimed/dismissed result", closedResult?.status === "completed" && closedResult.pid === undefined && closedResult.resultsDelivered && closedResult.footerDismissed);

	// A persistent RPC child starts a genuinely new execution on continuation.
	const previousResult = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
	registry.markRecordResultState(spawnAgentDir, previousResult, "resultsDelivered");
	registry.markRecordResultState(spawnAgentDir, previousResult, "footerDismissed");
	await spawn.sendSubagentMessage(previousResult, "next result");
	let continued;
	for (let i = 0; i < 100; i++) {
		continued = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (continued?.status === "completed" && continued.executionId !== previousResult.executionId) break;
		await waitSleep(25);
	}
	registry.markRecordResultState(spawnAgentDir, previousResult, "resultsDelivered");
	registry.markRecordResultState(spawnAgentDir, previousResult, "footerDismissed");
	continued = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
	check("RPC continuation resets delivery and footer state despite stale claims", continued?.status === "completed" && continued.latestText === "steered: next result" && continued.executionId !== previousResult.executionId && !continued.resultsDelivered && !continued.footerDismissed);

	const noToolsRec = await spawn.startSubagent({ task: "none", tools: [] }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === noToolsRec.runId);
		if (row && ["completed", "failed"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const noToolsArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${noToolsRec.runId}.json`), "utf8"));
	check("explicit empty tools emits --no-tools", noToolsArgs.includes("--no-tools") && !noToolsArgs.includes("--tools"), JSON.stringify(noToolsArgs));

	const narrowedRec = await spawn.startSubagent({ task: "narrow", tools: ["read"] }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === narrowedRec.runId);
		if (row && ["completed", "failed"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const narrowedArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${narrowedRec.runId}.json`), "utf8"));
	check("explicit tools remove recursive spawn when excluded", narrowedArgs[narrowedArgs.indexOf("--tools") + 1] === "read", JSON.stringify(narrowedArgs));

	const scopedRec = await spawn.startSubagent(
		{ task: "scoped", model: "allowed" },
		{ ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed", thinkingLevel: "high" }, { provider: "fake", id: "other" }] },
	);
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === scopedRec.runId);
		if (row && ["completed", "failed"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const scopedArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${scopedRec.runId}.json`), "utf8"));
	check("bare scoped child model becomes canonical", scopedArgs[scopedArgs.indexOf("--model") + 1] === "fake/allowed", JSON.stringify(scopedArgs));
	check("parent model scope propagates to child CLI", scopedArgs[scopedArgs.indexOf("--models") + 1] === "fake/allowed:high,fake/other", JSON.stringify(scopedArgs));
	check("scoped pin is applied as --thinking", scopedArgs[scopedArgs.indexOf("--thinking") + 1] === "high", JSON.stringify(scopedArgs));
	delete process.env.FAKE_ARGS_DIR;

	process.env.FAKE_MODE = "split-utf8";
	process.env.FAKE_TEXT = "unicode 😀 survives";
	const unicodeRec = await spawn.startSubagent({ task: "unicode", name: "unicode-child" }, baseCtx());
	delete process.env.FAKE_MODE;
	delete process.env.FAKE_TEXT;
	let unicodeDone;
	for (let i = 0; i < 100; i++) {
		unicodeDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === unicodeRec.runId);
		if (unicodeDone?.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("split UTF-8 stdout is decoded intact", unicodeDone?.latestText === "unicode 😀 survives", unicodeDone?.latestText);

	const steered = await spawn.sendSubagentMessage(polled, "focus on tests");
	check("live RPC child accepts steering", steered === true);
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (polled && polled.status === "completed" && polled.latestText === "steered: focus on tests") break;
		await new Promise((r) => setTimeout(r, 50));
	}
	check("steered child completes another turn", polled && polled.latestText === "steered: focus on tests", polled && polled.latestText);

	process.env.FAKE_DELAY_MS = "100";
	const immediateRec = await spawn.startSubagent({ task: "initial", name: "immediate-child" }, baseCtx());
	const immediateAccepted = await spawn.sendSubagentMessage(immediateRec, "immediate steer");
	delete process.env.FAKE_DELAY_MS;
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === immediateRec.runId);
		if (row?.latestText === "steered: immediate steer" && row.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const immediateDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === immediateRec.runId);
	check("immediate steering waits for RPC startup", immediateAccepted && immediateDone?.latestText === "steered: immediate steer", immediateDone?.latestText);

	let uiRequest;
	const uiRec = await spawn.startSubagent({ task: "ui-request", name: "ui-child" }, {
		...baseCtx(),
		onUiRequest: async (_record, request) => {
			uiRequest = request;
			return { value: "approved" };
		},
	});
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === uiRec.runId);
		if (row && row.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const uiDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === uiRec.runId);
	check("child UI request forwarded", uiRequest && uiRequest.method === "select", uiRequest && JSON.stringify(uiRequest));
	check("child UI response returned", uiDone && uiDone.latestText === "ui: approved", uiDone && uiDone.latestText);

	const rejectedRec = await spawn.startSubagent({ task: "reject", name: "rejected-child" }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === rejectedRec.runId);
		if (row?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const rejectedDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === rejectedRec.runId);
	check("rejected RPC prompt fails without hanging", rejectedDone?.status === "failed" && rejectedDone.error?.includes("fake rejection"), rejectedDone && `${rejectedDone.status} ${rejectedDone.error}`);

	process.env.FAKE_MODE = "ignore-state";
	const timeoutRec = await spawn.startSubagent(
		{ task: "never starts", name: "timeout-child" },
		{ ...baseCtx(), rpcRequestTimeoutMs: 1000, rpcStartupTimeoutMs: 100 },
	);
	delete process.env.FAKE_MODE;
	let timeoutDone;
	for (let i = 0; i < 100; i++) {
		timeoutDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === timeoutRec.runId);
		if (timeoutDone?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("RPC startup has a deadline", timeoutDone?.error?.includes("startup timed out"), timeoutDone && `${timeoutDone.status} ${timeoutDone.error}`);

	const boundedRec = await spawn.startSubagent(
		{ task: "ready", name: "bounded-child" },
		{ ...baseCtx(), rpcRequestTimeoutMs: 100 },
	);
	let boundedDone;
	for (let i = 0; i < 100; i++) {
		boundedDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === boundedRec.runId);
		if (boundedDone?.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const abortController = new AbortController();
	const abortTimer = setTimeout(() => abortController.abort(), 50);
	let abortError;
	try { await spawn.sendSubagentMessage(boundedDone, "hang", abortController.signal); } catch (error) { abortError = String(error); }
	clearTimeout(abortTimer);
	check("aborted RPC request rejects promptly", abortError?.includes("aborted"), abortError);
	let requestError;
	try { await spawn.sendSubagentMessage(boundedDone, "hang"); } catch (error) { requestError = String(error); }
	check("RPC requests have a deadline", requestError?.includes("request timed out"), requestError);

	process.env.FAKE_MODE = "close-stdin";
	const writeRec = await spawn.startSubagent(
		{ task: "cannot write", name: "write-child" },
		{ ...baseCtx(), rpcRequestTimeoutMs: 2000, rpcStartupTimeoutMs: 2000 },
	);
	delete process.env.FAKE_MODE;
	let writeDone;
	for (let i = 0; i < 100; i++) {
		writeDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === writeRec.runId);
		if (writeDone?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("RPC stdin errors fail without waiting for deadline", writeDone?.status === "failed" && !writeDone.error?.includes("timed out"), writeDone && `${writeDone.status} ${writeDone.error}`);

	for (const mode of ["large-image", "large-aggregate"]) {
		for (const limit of [undefined, 1024 * 1024]) {
			process.env.FAKE_MODE = mode;
			const rec = await spawn.startSubagent(
				{ task: "image payload", name: mode },
				{ ...baseCtx(), persistAfterSettled: false, settings: { ...baseCtx().settings, rpcMaxLineChars: limit } },
			);
			delete process.env.FAKE_MODE;
			let done;
			for (let i = 0; i < 200; i++) {
				done = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec.runId);
				if (done && ["completed", "failed"].includes(done.status) && !done.pid) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			check(`${mode} ${limit ? "fails above configured bound" : "completes above 1 MiB"}`,
				limit ? done?.status === "failed" && done.error?.includes(`stdout line exceeded ${limit}`)
					: done?.status === "completed" && done.latestText === (process.env.FAKE_TEXT ?? "fake done"),
				done && `${done.status} ${done.error ?? done.latestText}`);
			check(`${mode} child closed after payload test`, !done?.pid);
		}
	}

	process.env.FAKE_MODE = "oversized-line";
	process.env.FAKE_LINE_LENGTH = "4096";
	const oversizedRec = await spawn.startSubagent(
		{ task: "too much stdout", name: "oversized-child" },
		{ ...baseCtx(), stdoutLineLimit: 512 },
	);
	delete process.env.FAKE_MODE;
	delete process.env.FAKE_LINE_LENGTH;
	let oversizedDone;
	for (let i = 0; i < 100; i++) {
		oversizedDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === oversizedRec.runId);
		if (oversizedDone?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("unterminated RPC stdout line is capped", oversizedDone?.error?.includes("stdout line exceeded 512"), oversizedDone && `${oversizedDone.status} ${oversizedDone.error}`);

	process.env.FAKE_EXIT = "1";
	const failRec = await spawn.startSubagent({ task: "fail", name: "failer" }, { ...baseCtx(), onSettled: (r) => settled.push(r.status) });
	delete process.env.FAKE_EXIT;
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === failRec.runId);
		if (polled && ["completed", "failed"].includes(polled.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("failing child marked failed", polled && polled.status === "failed" && (polled.error || "").includes("fake failure"), polled && `${polled.status} ${polled.error}`);

	// depth and thinking validation still throw synchronously
	let thinkingThrew = false;
	try {
		await spawn.startSubagent({ task: "x", thinking: "ultra" }, baseCtx());
	} catch (error) {
		thinkingThrew = String(error).includes("thinking level");
	}
	check("per-spawn invalid thinking throws", thinkingThrew);

	let depthThrew = false;
	try {
		await spawn.startSubagent({ task: "x" }, { ...baseCtx(), currentDepth: 2 });
	} catch (error) {
		depthThrew = String(error).includes("depth limit");
	}
	check("depth limit throws at spawn", depthThrew);

	// cancel a slow child
	const slowRec = await spawn.startSubagent({ task: "slow", name: "slowpoke" }, { ...baseCtx() });
	const cancelled = spawn.cancelSubagent(spawnAgentDir, slowRec);
	check("cancel marks cancelled", cancelled.status === "cancelled", cancelled.status);
	await spawn.terminateOwnedSubagents([slowRec.runId]);
	const closedSlow = registry.readRecords(spawnAgentDir).find((r) => r.runId === slowRec.runId);
	check("owned cancellation waits for child exit", !registry.isProcessAlive(slowRec.pid), String(slowRec.pid));
	check("child close persists PID clearing", closedSlow?.pid === undefined, String(closedSlow?.pid));

	if (process.platform === "linux") {
		const pidProbe = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		spawn.killPidTree(pidProbe.pid, "not-the-recorded-start-time");
		await new Promise((resolve) => setTimeout(resolve, 50));
		check("PID identity mismatch prevents stale-record kill", registry.isProcessAlive(pidProbe.pid), String(pidProbe.pid));
		try { process.kill(-pidProbe.pid, "SIGTERM"); } catch { pidProbe.kill("SIGTERM"); }
		await new Promise((resolve) => pidProbe.once("close", resolve));
	}

	// queued when the gate is full
	const held = await spawn.gate.acquire(1);
	const queuedRec = await spawn.startSubagent(
		{ task: "q", name: "queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } },
	);
	check("full gate queues the spawn", queuedRec.status === "queued", queuedRec.status);
	const queuedSendStarted = Date.now();
	const queuedAccepted = await spawn.sendSubagentMessage(queuedRec, "queued steer");
	check("steering a queued child returns immediately", queuedAccepted && Date.now() - queuedSendStarted < 250, String(Date.now() - queuedSendStarted));
	held();
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === queuedRec.runId);
		if (polled?.status === "completed" && polled.latestText === "steered: queued steer") break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("queued child receives startup steering", polled?.status === "completed" && polled.latestText === "steered: queued steer", polled && `${polled.status} ${polled.latestText}`);

	const heldForAbort = await spawn.gate.acquire(1);
	const abortQueuedCtl = new AbortController();
	const abortQueued = await spawn.startSubagent(
		{ task: "must not launch", name: "abort-queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 }, signal: abortQueuedCtl.signal },
	);
	check("abort target starts queued", abortQueued.status === "queued", abortQueued.status);
	abortQueuedCtl.abort();
	await new Promise((r) => setTimeout(r, 20));
	heldForAbort();
	let abortQueuedFinal;
	for (let i = 0; i < 50; i++) {
		abortQueuedFinal = registry.readRecords(spawnAgentDir).find((r) => r.runId === abortQueued.runId);
		if (abortQueuedFinal && ["failed", "cancelled"].includes(abortQueuedFinal.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check(
		"queued spawn abort does not launch a child",
		abortQueuedFinal?.pid === undefined && !abortQueuedFinal?.latestText && String(abortQueuedFinal?.error || "").includes("aborted"),
		JSON.stringify(abortQueuedFinal),
	);

	const heldForCancel = await spawn.gate.acquire(1);
	const cancelledQueued = await spawn.startSubagent(
		{ task: "must not launch", name: "cancelled-queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } },
	);
	spawn.cancelSubagent(spawnAgentDir, cancelledQueued);
	let queuedCancelDrained = false;
	await Promise.race([
		spawn.terminateOwnedSubagents([cancelledQueued.runId]).then(() => { queuedCancelDrained = true; }),
		new Promise((resolve) => setTimeout(resolve, 500)),
	]);
	check("queued cancellation removes gate waiter", queuedCancelDrained);
	heldForCancel();
	const cancelledQueuedFinal = registry.readRecords(spawnAgentDir).find((r) => r.runId === cancelledQueued.runId);
	check("queued cancellation wins launch race", cancelledQueuedFinal?.status === "cancelled" && cancelledQueuedFinal.pid === undefined && !cancelledQueuedFinal.latestText, JSON.stringify(cancelledQueuedFinal));

	// --- cancel race: a cancelled child must stay cancelled, not flip to failed ---
	process.env.FAKE_DELAY_MS = "4000";
	const raceRec = await spawn.startSubagent({ task: "race", name: "racer" }, baseCtx());
	await new Promise((r) => setTimeout(r, 300));
	spawn.cancelSubagent(spawnAgentDir, raceRec);
	let raceFinal;
	for (let i = 0; i < 80; i++) {
		raceFinal = registry.readRecords(spawnAgentDir).find((r) => r.runId === raceRec.runId);
		if (raceFinal && ["completed", "failed", "cancelled"].includes(raceFinal.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("cancelled child stays cancelled", raceFinal && raceFinal.status === "cancelled", raceFinal && raceFinal.status);
	delete process.env.FAKE_DELAY_MS;

	// --- navigation: right opens detail, left goes back, left closes ---
	const navSession = path.join(sandbox, "nav-child.jsonl");
	const navLines = [{ type: "session", version: 3, id: "nav", timestamp: new Date().toISOString(), cwd: "/tmp" }];
	let navParent = null;
	for (let i = 0; i < 80; i++) {
		const id = `nav-${i}`;
		navLines.push({ type: "message", id, parentId: navParent, timestamp: new Date().toISOString(), message: { role: "user", content: `navigation message ${i}`, timestamp: i } });
		navParent = id;
	}
	fs.writeFileSync(navSession, navLines.map((line) => JSON.stringify(line)).join("\n"));
	registry.saveRecord(agentDir2, mk("alpha", "root2", { status: "running_tool", currentTool: "bash npm test", latestText: "testing…", model: "prov/model-x", sessionId: "nav", sessionFile: navSession }));
	let sentFromPanel;
	const navPanel = new SubagentPanel(tui, theme, agentDir2, "root2", {
		onMessage: async (record, text) => { sentFromPanel = `${record.runId}:${text}`; },
	});
	tui.setFocus(navPanel);
	navPanel.handleInput("\x1b[C");
	const detailView = activeOverlay ? activeOverlay.render(100) : navPanel.render(100);
	check("right opens focused transcript overlay", !!activeOverlay && detailView.some((l) => l.includes("navigation message")), detailView.join(" | "));
	check("transcript overlay owns focus", focusedComponent === activeOverlay && navPanel.focused === false, `${focusedComponent === activeOverlay} ${navPanel.focused} ${focusedComponent?.constructor?.name} ${activeOverlay?.constructor?.name}`);
	const beforePageScroll = activeOverlay.render(100).join("\n");
	activeOverlay.handleInput("\x1b[5~");
	const afterPageScroll = activeOverlay.render(100).join("\n");
	check("page scroll changes child transcript", beforePageScroll !== afterPageScroll && afterPageScroll.includes("navigation message"));
	activeOverlay.handleMouse({
		type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0,
		width: 100, height: 40, shift: false, alt: false, ctrl: false, wheelDelta: -1,
	});
	check("normalized mouse wheel reaches child transcript", activeOverlay.render(100).join("\n") !== afterPageScroll);
	navPanel.handleInput("g");
	navPanel.handleInput("o");
	navPanel.handleInput("\r");
	await new Promise((r) => setTimeout(r, 0));
	check("transcript input sends without closing", sentFromPanel === "alpha:go" && activeOverlay?.render(100).some((l) => l.includes("Message this subagent")), sentFromPanel);
	navPanel.handleInput("\x1b[D");
	const backToList = navPanel.render(100);
	check("left returns to list", backToList.some((l) => l.includes("alpha")) && !backToList.some((l) => l.includes("Task")), backToList.join(" | "));
	navPanel.handleInput("\x1b[D");
	check("left closes panel", focusedTarget.value === "null", focusedTarget.value);
	navPanel.dispose();

	// A footer selection indexes visible rows, not the full history array.
	const selectionAgentDir = path.join(sandbox, "selection-agent");
	const selectionCwd = path.join(sandbox, "selection-cwd");
	fs.mkdirSync(selectionCwd, { recursive: true });
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = selectionAgentDir;
	const selectedSession = piRoot.SessionManager.create(selectionCwd);
	selectedSession.appendMessage({ role: "user", content: "selected visible transcript", timestamp: Date.now() });
	selectedSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "selected reply" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const selectionRegistry = path.join(sandbox, "selection-registry");
	registry.saveRecord(selectionRegistry, mk("hidden", "selection-root", { footerDismissed: true }));
	registry.saveRecord(selectionRegistry, mk("visible", "selection-root", {
		cwd: selectionCwd,
		sessionId: selectedSession.getSessionId(),
	}));
	const selectionPanel = new SubagentPanel(tui, theme, selectionRegistry, "selection-root");
	tui.setFocus(selectionPanel);
	selectionPanel.handleInput("\x1b[C");
	activeOverlay.render(100);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const selectedTranscript = activeOverlay.render(100).join("\n");
	check("transcript discovery follows the selected visible row", selectedTranscript.includes("selected visible transcript"), selectedTranscript);
	selectionPanel.dispose();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;

	delete process.env.PI_SUBAGENT_COMMAND;

	// --- footer tree: main + nested children ---
	const agentDir3 = path.join(sandbox, "agent3");
	const r3 = (runId, parent, extra = {}) => mk(runId, parent, extra);
	registry.saveRecord(agentDir3, r3("root", ""));
	registry.saveRecord(agentDir3, r3("a", "root", { name: "a", status: "running_tool", currentTool: "bash npm test" }));
	registry.saveRecord(agentDir3, r3("a1", "a", { name: "a1" }));
	registry.saveRecord(agentDir3, r3("a2", "a", { name: "a2" }));
	registry.saveRecord(agentDir3, r3("b", "root", { name: "b" }));
	const tree = new SubagentPanel(tui, theme, agentDir3, "root");
	const foot = tree.render(100);
	check("footer nests grandchildren", foot.some((l) => l.includes("a1")) && foot.some((l) => l.includes("b")), foot.join(" | "));
	check("footer uses tree guides", foot.some((l) => l.includes("├─") || l.includes("└─")), foot.join(" | "));

	// --- dismissal: finished leave the footer on a new turn, history remains ---
	check("open works while live", tree.open() === true);
	tui.setFocus = () => {};
	const dismissed = tree.dismissFinished();
	check("dismissFinished flags terminal ones", dismissed === 3, String(dismissed));
	const afterDismiss = tree.render(100);
	check("footer keeps only running", afterDismiss.some((l) => l.includes("bash npm test")) && !afterDismiss.some((l) => l.includes("a1")), afterDismiss.join(" | "));
	check("review still opens history", tree.openReview() === true);
	tree.dispose();

	// --- transcript: child session renders like the main agent ---
	const { buildTranscript } = await jiti.import(path.join(HERE, "transcript.ts"));
	const sessFile = path.join(sandbox, "child.jsonl");
	const usageFull = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
	const sessLines = [
		{ type: "session", version: 3, id: "sess1", timestamp: new Date().toISOString(), cwd: "/tmp" },
		{ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "do the thing", timestamp: 1 } },
		{ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } }], api: "x", provider: "p", model: "m", usage: usageFull, stopReason: "toolUse", timestamp: 2 } },
		{ type: "message", id: "m3", parentId: "m2", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false, timestamp: 3 } },
		{ type: "message", id: "m4", parentId: "m3", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "all done" }], api: "x", provider: "p", model: "m", usage: usageFull, stopReason: "stop", timestamp: 4 } },
	].map((l) => JSON.stringify(l)).join("\n");
	fs.writeFileSync(sessFile, sessLines);
	const tuiMock = { requestRender: () => {}, setFocus: () => {} };
	const comps = buildTranscript(sessFile, tuiMock, "/tmp");
	check("transcript builds components", Array.isArray(comps) && comps.length === 4, String(comps && comps.length));
	if (comps) {
		const rendered = comps.flatMap((c) => c.render(80)).join("\n");
		check("transcript shows user text", rendered.includes("do the thing"), rendered.slice(0, 300));
		check("transcript shows assistant text", rendered.includes("on it") && rendered.includes("all done"), rendered.slice(0, 300));
		check("transcript shows tool call", rendered.includes("echo hi"), rendered.slice(0, 500));
	}
	check("transcript null for missing file", buildTranscript(path.join(sandbox, "nope.jsonl"), tuiMock, "/tmp") === null);

	const longFile = path.join(sandbox, "long-child.jsonl");
	const longLines = [{ type: "session", version: 3, id: "long", timestamp: new Date().toISOString(), cwd: "/tmp" }];
	let parentId = null;
	for (let i = 0; i < 70; i++) {
		const id = `m${String(i).padStart(7, "0")}`;
		longLines.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: i === 0 ? "the very first delegated prompt" : `later ${i}`, timestamp: i } });
		parentId = id;
	}
	longLines.push({ type: "compaction", id: "compact1", parentId, timestamp: new Date().toISOString(), summary: "recent history", firstKeptEntryId: "m0000060", tokensBefore: 10000 });
	longLines.push({ type: "message", id: "aftercmp", parentId: "compact1", timestamp: new Date().toISOString(), message: { role: "user", content: "after compaction", timestamp: 71 } });
	fs.writeFileSync(longFile, longLines.map((line) => JSON.stringify(line)).join("\n"));
	const longComps = buildTranscript(longFile, tuiMock, "/tmp");
	const longRendered = longComps && longComps.flatMap((c) => c.render(100)).join("\n");
	check("full transcript keeps first prompt past 60 messages", !!longRendered && longRendered.includes("the very first delegated prompt"), longRendered && longRendered.slice(0, 200));

	fs.rmSync(sandbox, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
	process.exit(2);
});
