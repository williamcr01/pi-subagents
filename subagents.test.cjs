// Regression tests for the subagents extension. No dependencies, no API calls.
// Run: node subagents.test.cjs
const { execSync } = require("node:child_process");
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
		"@earendil-works/pi-coding-agent": path.join(PI, "dist", "index.js"),
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
	const agents = await jiti.import(path.join(HERE, "agents.ts"));
	const config = await jiti.import(path.join(HERE, "config.ts"));
	const registry = await jiti.import(path.join(HERE, "registry.ts"));
	const events = await jiti.import(path.join(HERE, "events.ts"));
	const control = await jiti.import(path.join(HERE, "control.ts"));
	const spawn = await jiti.import(path.join(HERE, "spawn-agent.ts"));
	const { SubagentPanel } = await jiti.import(path.join(HERE, "panel.ts"));
	const { default: subagentsExtension } = await jiti.import(path.join(HERE, "index.ts"));

	// --- config ---
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
	const agentDir = path.join(sandbox, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	let s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
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

	// --- agent definitions ---
	const defsDir = path.join(sandbox, "agent-defs");
	const globalAgents = path.join(defsDir, "agents");
	fs.mkdirSync(globalAgents, { recursive: true });
	fs.writeFileSync(path.join(globalAgents, "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\nmodel: p/global\nthinking: high\ntools:\n  - read\n  - grep\n---\nReview carefully.\n");
	fs.writeFileSync(path.join(globalAgents, "from-filename.md"), "Body only.\n");
	fs.writeFileSync(path.join(globalAgents, "comma-tools.md"), "---\ntools: read, grep, bash\n---\n");
	fs.writeFileSync(path.join(globalAgents, "Bad Name.md"), "---\ndescription: invalid name\n---\n");
	fs.writeFileSync(path.join(globalAgents, "broken.md"), "---\nname: [unclosed\n---\nbody\n");
	const globalDefs = agents.loadAgentDefinitions({ agentDir: defsDir, cwd: sandbox, projectTrusted: false });
	check("loads global definitions", globalDefs.get("reviewer")?.model === "p/global", JSON.stringify([...globalDefs.keys()]));
	check("name falls back to the filename", globalDefs.get("from-filename")?.prompt === "Body only.", JSON.stringify(globalDefs.get("from-filename")));
	check("frontmatter tools as a list", JSON.stringify(globalDefs.get("reviewer")?.tools) === JSON.stringify(["read", "grep"]), JSON.stringify(globalDefs.get("reviewer")?.tools));
	check("frontmatter tools as a comma string", JSON.stringify(globalDefs.get("comma-tools")?.tools) === JSON.stringify(["read", "grep", "bash"]), JSON.stringify(globalDefs.get("comma-tools")?.tools));
	check("invalid agent name skipped", !globalDefs.has("Bad Name"), JSON.stringify([...globalDefs.keys()]));
	check("unparseable definition skipped", !globalDefs.has("broken"), JSON.stringify([...globalDefs.keys()]));

	const projectAgents = path.join(sandbox, ".pi", "agents");
	fs.mkdirSync(projectAgents, { recursive: true });
	fs.writeFileSync(path.join(projectAgents, "reviewer.md"), "---\nname: reviewer\nmodel: p/project\n---\nProject review.\n");
	const trustedDefs = agents.loadAgentDefinitions({ agentDir: defsDir, cwd: sandbox, projectTrusted: true });
	check("project definition overrides global", trustedDefs.get("reviewer")?.model === "p/project", trustedDefs.get("reviewer")?.model);
	check("untrusted project definitions ignored", agents.loadAgentDefinitions({ agentDir: defsDir, cwd: sandbox, projectTrusted: false }).get("reviewer")?.model === "p/global");

	const merged = agents.resolveSpawnInput({ task: "t", agent: "reviewer", model: "p/explicit" }, globalDefs);
	check("explicit parameter beats the definition", merged.model === "p/explicit", merged.model);
	check("definition fills unset parameters", merged.thinking === "high" && merged.name === "reviewer" && JSON.stringify(merged.tools) === JSON.stringify(["read", "grep"]), JSON.stringify(merged));
	check("definition body becomes the system prompt", merged.systemPrompt === "Review carefully.", merged.systemPrompt);
	check("spawn without an agent is untouched", agents.resolveSpawnInput({ task: "t", name: "n" }, globalDefs).systemPrompt === undefined);
	let unknownAgentError = "";
	try {
		agents.resolveSpawnInput({ task: "t", agent: "nope" }, globalDefs);
	} catch (error) {
		unknownAgentError = String(error);
	}
	check("unknown agent lists the available names", unknownAgentError.includes("Unknown agent") && unknownAgentError.includes("reviewer") && unknownAgentError.includes("comma-tools"), unknownAgentError);
	check("described agents carry their description", agents.describeAgents(globalDefs, { agentDir: defsDir, cwd: sandbox }).includes("reviewer — Reviews code"));
	const emptyDescription = agents.describeAgents(new Map(), { agentDir: defsDir, cwd: sandbox });
	check("empty listing names both directories", emptyDescription.includes(globalAgents) && emptyDescription.includes(projectAgents), emptyDescription);

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
		const secondCheck = await checkTool.execute("check-2", { wait: true, timeoutMs: 1000 }, undefined, undefined, {});
		clearTimeout(finishTimer);
		const secondText = secondCheck.content[0].text;
		check("second check returns newly finished result", secondText.includes("second result"), secondText);
		check("second check omits previously delivered result", !secondText.includes("first result"), secondText);
		const thirdCheck = await checkTool.execute("check-3", { wait: false }, undefined, undefined, {});
		const thirdText = thirdCheck.content[0].text;
		check("later check omits all delivered results", !thirdText.includes("first result") && !thirdText.includes("second result"), thirdText);
		check("later check explains no new results", thirdText.includes("No new subagent results since the last check."), thirdText);
	} finally {
		checkHandlers.get("session_shutdown")?.({}, { mode: "rpc" });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
		else process.env.PI_SUBAGENT_RUN_ID = previousRunId;
		if (previousRootId === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
		else process.env.PI_SUBAGENT_ROOT_ID = previousRootId;
	}

	// --- control inbox ---
	control.queueSubagentMessage(agentDir2, { targetRunId: "child1", rootRunId: "root", text: "change direction" });
	const inbox = control.consumeSubagentMessages(agentDir2, "child1", "root");
	check("control inbox delivers message", inbox.length === 1 && inbox[0].text === "change direction", JSON.stringify(inbox));
	check("control inbox consumes once", control.consumeSubagentMessages(agentDir2, "child1", "root").length === 0);
	registry.saveRecord(agentDir2, mk("child1", "root", { status: "thinking" }));
	registry.saveRecord(agentDir2, mk("grand", "child1", { status: "running_tool" }));
	spawn.cancelSubagent(agentDir2, registry.readRecords(agentDir2).find((r) => r.runId === "child1"));
	const cancelledTree = registry.readRecords(agentDir2);
	check("cancelling parent cancels descendants", ["child1", "grand"].every((id) => cancelledTree.find((r) => r.runId === id)?.status === "cancelled"));
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
	registry.saveRecord(agentDir2, mk("beta", "root2", { agent: "reviewer" }));
	panel = new SubagentPanel(tui, theme, agentDir2, "root2");
	panel.setMainModel("p/m");
	const summary = panel.render(100);
	check("footer shows main with model", summary.length > 0 && summary[0].includes("main") && summary[0].includes("p/m"), JSON.stringify(summary));
	check("footer shows running child", summary.some((l) => l.includes("alpha")) && summary.some((l) => l.includes("npm test")), summary.join(" | "));
	check("footer shows child provider/model", summary.some((l) => l.includes("prov/model-x")), summary.join(" | "));
	tui.setFocus(panel);
	const list = panel.render(100);
	check("list shows children", list.some((l) => l.includes("alpha")) && list.some((l) => l.includes("beta")), list.join(" | "));
	check("row labels the agent definition", list.some((l) => l.includes("beta (reviewer)")), list.join(" | "));
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
		parentCwd: spawnDir,
		projectTrusted: false,
	});
	process.env.PI_SUBAGENT_COMMAND = fakePi;

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
	await new Promise((r) => setTimeout(r, 250));
	check("onSettled fired", settled.includes("completed"), JSON.stringify(settled));

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

	process.env.FAKE_EXIT = "1";
	const failRec = await spawn.startSubagent({ task: "fail", name: "failer" }, { ...baseCtx(), onSettled: (r) => settled.push(r.status) });
	delete process.env.FAKE_EXIT;
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === failRec.runId);
		if (polled && ["completed", "failed"].includes(polled.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("failing child marked failed", polled && polled.status === "failed" && (polled.error || "").includes("fake failure"), polled && `${polled.status} ${polled.error}`);

	// depth limit still throws synchronously
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
	let slowGone = false;
	for (let i = 0; i < 50; i++) {
		if (!slowRec.pid || !registry.isProcessAlive(slowRec.pid)) { slowGone = true; break; }
		await new Promise((r) => setTimeout(r, 100));
	}
	check("cancelled child process exits", slowGone, String(slowRec.pid));

	// queued when the gate is full
	const held = await spawn.gate.acquire(1);
	const queuedRec = await spawn.startSubagent(
		{ task: "q", name: "queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } },
	);
	check("full gate queues the spawn", queuedRec.status === "queued", queuedRec.status);
	held();
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === queuedRec.runId);
		if (polled && ["completed", "failed"].includes(polled.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("queued child runs after release", polled && polled.status === "completed", polled && polled.status);

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
	activeOverlay.handleInput("\x1b[<64;1;1M");
	check("mouse wheel reaches child transcript", activeOverlay.render(100).join("\n") !== afterPageScroll);
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

	// --- agent definition body reaches the child system prompt ---
	const probe = path.join(sandbox, "argv-probe.cjs");
	const argvOut = path.join(sandbox, "argv.json");
	fs.writeFileSync(probe, `require("node:fs").writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\n`);
	process.env.PI_SUBAGENT_COMMAND = probe;
	const promptRec = await spawn.startSubagent({ task: "prompted", name: "prompted", agent: "reviewer", systemPrompt: "Review carefully." }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === promptRec.runId);
		if (row && ["completed", "failed", "cancelled"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const probeArgv = fs.existsSync(argvOut) ? JSON.parse(fs.readFileSync(argvOut, "utf8")) : [];
	const appendedPrompt = probeArgv[probeArgv.indexOf("--append-system-prompt") + 1] ?? "";
	check("agent body appended after the built-in system prompt", appendedPrompt.startsWith("You are subagent") && appendedPrompt.endsWith("Review carefully."), appendedPrompt);
	check("record keeps the agent name", registry.readRecords(spawnAgentDir).find((r) => r.runId === promptRec.runId)?.agent === "reviewer");

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
