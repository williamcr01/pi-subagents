// Offline responsiveness regression: the actual panel and registry, no agents/API calls.
// Run: node panel-performance.test.cjs
// Read-only local measurement: node panel-performance.test.cjs --local-registry
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

let observedDir;
let calls = {};
for (const name of ["existsSync", "readdirSync", "readFileSync", "statSync"]) {
	const original = fs[name];
	fs[name] = function (file, ...args) {
		if (observedDir && String(file).startsWith(observedDir)) calls[name] = (calls[name] ?? 0) + 1;
		return original.call(this, file, ...args);
	};
}
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
const { createJiti } = require(path.join(pi, "node_modules", "jiti"));
const jiti = createJiti(__filename, {
	interopDefault: true, fsCache: false, moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(pi, "dist", "bundle", "index.js"),
		"@earendil-works/pi-tui": path.join(pi, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: require.resolve("typebox", { paths: [pi] }),
	},
});
const theme = { fg: (_c, t) => String(t), bg: (_c, t) => String(t), bold: (t) => String(t) };
const tui = { requestRender() {}, setFocus() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	const { SubagentPanel } = await jiti.import(path.join(__dirname, "panel.ts"));
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-panel-perf-"));
	const local = process.argv.includes("--local-registry");
	const agentDir = local ? (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")) : sandbox;
	const runs = path.join(agentDir, "subagents", "runs");
	if (!local) {
		fs.mkdirSync(runs, { recursive: true });
		for (let i = 0; i < 48; i++) {
			fs.writeFileSync(path.join(runs, `${i}.json`), JSON.stringify({
				version: 1, runId: `old-${i}`, parentRunId: "other-session", rootRunId: "other-session",
				sessionId: `session-${i}`, name: `child-${i}`, task: "completed task", cwd: sandbox,
				depth: 1, maxDepth: 2, status: "completed", model: "test/model", thinking: "off",
				startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z",
				latestText: "x".repeat(2000),
			}));
		}
	}
	let panel;
	try {
		observedDir = runs;
		panel = new SubagentPanel(tui, theme, agentDir, "empty-session-performance-test");
		// Let background initialization settle before simulating typing/scrolling.
		await sleep(150);
		calls = {};
		const start = performance.now();
		for (let i = 0; i < 20; i++) assert.deepEqual(panel.render(100), []);
		const elapsed = performance.now() - start;
		const renderCalls = { ...calls };
		calls = {};
		await sleep(1100);
		const idleCalls = { ...calls };
		console.log(JSON.stringify({ local, renders: 20, renderMs: +elapsed.toFixed(2), renderSyncIO: renderCalls, idleMs: 1100, idleSyncIO: idleCalls }));
		assert.equal(Object.values(renderCalls).reduce((a, b) => a + b, 0), 0, "typing/scrolling must not synchronously scan unrelated subagent history");
		assert.equal(Object.values(idleCalls).reduce((a, b) => a + b, 0), 0, "idle panel monitoring must not block input with synchronous registry I/O");
	} finally {
		panel?.dispose();
		observedDir = undefined;
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
