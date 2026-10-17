// Async panel/registry compatibility tests: real files, no agents or API calls.
// Run: node panel-refresh.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Hold one completed read to reproduce a stale snapshot racing with a UI action.
let heldRead;
let failListing;
let liveWatches = 0;
const originalReadFile = fsp.readFile;
const originalReaddir = fsp.readdir;
const originalWatch = fs.watch;
fsp.readFile = async function (file, ...args) {
	const text = await originalReadFile.call(this, file, ...args);
	if (heldRead?.file === String(file)) {
		const hold = heldRead;
		heldRead = undefined;
		hold.started();
		await hold.released;
	}
	return text;
};
fsp.readdir = function (dir, ...args) {
	if (failListing === String(dir)) return Promise.reject(Object.assign(new Error("injected EACCES"), { code: "EACCES" }));
	return originalReaddir.call(this, dir, ...args);
};
fs.watch = function (...args) {
	const watcher = originalWatch.apply(this, args);
	liveWatches++;
	watcher.once("close", () => liveWatches--);
	return watcher;
};

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 3000) {
	const deadline = Date.now() + timeout;
	while (!predicate() && Date.now() < deadline) await sleep(10);
	assert.ok(predicate(), message);
}
function holdNextRead(file) {
	let started, release;
	const began = new Promise((resolve) => { started = resolve; });
	const released = new Promise((resolve) => { release = resolve; });
	heldRead = { file, started, released };
	return { began, release };
}
const theme = { fg: (_c, t) => String(t), bg: (_c, t) => `<selected>${t}</selected>`, bold: (t) => String(t) };
const panels = [];
let releasePending;

(async () => {
	const registry = await jiti.import(path.join(__dirname, "registry.ts"));
	const { SubagentPanel } = await jiti.import(path.join(__dirname, "panel.ts"));
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-panel-refresh-"));
	const mk = (runId, extra = {}) => ({
		version: 1, runId, parentRunId: "root", rootRunId: "root", sessionId: runId,
		name: runId, task: "test", cwd: sandbox, depth: 1, maxDepth: 2,
		status: "thinking", model: "test/model", thinking: "off",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
	});
	const recordPath = (dir, runId) => path.join(registry.registryDir(dir), `${runId}.json`);
	const writeRaw = (dir, record) => fs.writeFileSync(recordPath(dir, record.runId), JSON.stringify(record));
	try {
		const dir = path.join(sandbox, "parity");
		const flags = mk("flags", { executionId: "turn1" });
		registry.saveRecord(dir, flags);
		for (const flag of ["resultsDelivered", "resultsPreviewed", "footerDismissed"]) registry.markRecordResultState(dir, flags, flag);
		const nextExecution = mk("new-execution", { executionId: "turn1" });
		registry.saveRecord(dir, nextExecution);
		for (const flag of ["resultsDelivered", "resultsPreviewed", "footerDismissed"]) registry.markRecordResultState(dir, nextExecution, flag);
		writeRaw(dir, { ...nextExecution, executionId: "turn2" });
		const cancelled = mk("cancelled", { pid: process.pid, status: "cancelled", finishedAt: "2026-01-01T00:00:02Z", error: "user cancelled" });
		registry.saveRecord(dir, cancelled);
		writeRaw(dir, { ...cancelled, status: "thinking", error: undefined, finishedAt: undefined });
		const closed = mk("closed", { pid: process.pid, pidStartTime: "stale" });
		registry.clearRecordPid(dir, closed);
		writeRaw(dir, closed);
		registry.saveRecord(dir, mk("dead", { pid: 2147483647 }));
		registry.saveRecord(dir, mk("live", { pid: process.pid }));
		const identity = registry.readProcessIdentity(process.pid);
		if (process.platform === "linux") assert.ok(identity?.startTime, "Linux identity fixture must obtain this process's real start time");
		if (identity?.startTime) {
			registry.saveRecord(dir, mk("same-process", { pid: process.pid, pidStartTime: identity.startTime }));
			registry.saveRecord(dir, mk("recycled-process", { pid: process.pid, pidStartTime: "0" }));
		}
		fs.writeFileSync(path.join(registry.registryDir(dir), "bad.json"), "{");
		fs.writeFileSync(path.join(registry.registryDir(dir), "null.json"), "null");
		const rows = await registry.readRecordsAsync(dir);
		assert.deepEqual(rows, registry.readRecords(dir), "async snapshot must preserve every sync registry field and ordering");
		const byId = new Map(rows.map((r) => [r.runId, r]));
		assert.equal(byId.get("flags").footerDismissed, true);
		assert.equal(byId.get("new-execution").resultsDelivered, undefined, "old execution flags must not leak into the next turn");
		assert.equal(byId.get("cancelled").status, "cancelled", "stale execution JSON cannot undo cancellation");
		assert.equal(byId.get("closed").pid, undefined, "a close marker must clear a stale PID");
		assert.equal(byId.get("dead").status, "failed");
		assert.equal(byId.get("live").status, "thinking");
		if (byId.has("same-process")) {
			assert.equal(byId.get("same-process").status, "thinking");
			assert.equal(byId.get("recycled-process").status, "failed", "a reused PID must not keep a stale row active");
		}
		assert.deepEqual(await registry.readRecordsAsync(path.join(sandbox, "absent")), []);
		registry.saveRecord(dir, mk("broken-marker"));
		fs.writeFileSync(path.join(registry.registryDir(dir), "broken-marker.cancelled"), "null");
		assert.equal((await registry.readRecordsAsync(dir)).find((r) => r.runId === "broken-marker").status, "cancelled");
		console.log("ok - async registry parity, execution flags, cancellation, close, dead/live PIDs, malformed files");

		let renders = 0;
		const tui = { requestRender() { renders++; }, setFocus(component) { if (component) component.focused = true; } };
		const panelDir = path.join(sandbox, "panel");
		const first = mk("first", { startedAt: "2026-01-01T00:00:01Z" });
		const second = mk("second", { startedAt: "2026-01-01T00:00:02Z" });
		registry.saveRecord(panelDir, first);
		registry.saveRecord(panelDir, second);
		const panel = new SubagentPanel(tui, theme, panelDir, "root");
		panels.push(panel);
		assert.equal(panel.open(), true);
		panel.handleInput("\x1b[B");
		const text = () => panel.render(120).join("\n");
		const selectedLine = () => panel.render(120).find((line) => line.includes("<selected>")) || "";
		assert.ok(selectedLine().includes("second"));
		registry.saveRecord(panelDir, { ...second, currentTool: "updated tool", status: "running_tool" });
		await until(() => text().includes("updated tool"), "file changes must refresh the panel");
		registry.saveRecord(panelDir, mk("earlier"));
		await until(() => text().includes("earlier"), "new agents must appear without a keyboard-triggered read");
		assert.ok(selectedLine().includes("second"), "selection follows runId when another row is inserted before it");
		console.log("ok - live file updates, new rows and stable selection");

		// A failed listing must not clear the last good UI snapshot.
		failListing = registry.registryDir(panelDir);
		registry.saveRecord(panelDir, { ...second, activity: "after recovery" });
		await sleep(150);
		assert.ok(text().includes("updated tool"));
		assert.ok(!text().includes("after recovery"));
		failListing = undefined;
		await until(() => text().includes("after recovery"), "fallback poll must recover after an I/O error");

		// Hold a pre-dismissal snapshot; releasing it must not resurrect a dismissed row.
		const hold = holdNextRead(recordPath(panelDir, second.runId));
		releasePending = hold.release;
		registry.saveRecord(panelDir, { ...second, status: "completed" });
		let readBegan = false;
		void hold.began.then(() => { readBegan = true; });
		await until(() => readBegan, "watch must start the asynchronous snapshot");
		assert.equal(panel.dismissFinished(), 1);
		assert.ok(!text().includes("second"));
		hold.release();
		releasePending = undefined;
		await sleep(200);
		assert.ok(!text().includes("second"), "an older in-flight snapshot cannot undo dismissal");
		assert.equal(panel.openReview(), true);
		assert.ok(text().includes("second"), "dismissal must retain full history");
		console.log("ok - storage recovery and dismissal racing with an in-flight snapshot");

		const missingDir = path.join(sandbox, "created-later");
		const latePanel = new SubagentPanel(tui, theme, missingDir, "root");
		panels.push(latePanel);
		assert.deepEqual(latePanel.render(100), []);
		registry.saveRecord(missingDir, mk("late"));
		await until(() => latePanel.render(100).some((line) => line.includes("late")), "poll must discover a registry created after panel construction");
		assert.equal(liveWatches, 2, "fallback attaches the previously missing directory watch");
		console.log("ok - missing registry fallback and watch attachment");

		const disposing = holdNextRead(recordPath(panelDir, first.runId));
		releasePending = disposing.release;
		registry.saveRecord(panelDir, { ...first, activity: "pending at disposal" });
		let disposingBegan = false;
		void disposing.began.then(() => { disposingBegan = true; });
		await until(() => disposingBegan, "snapshot must be in flight before disposal");
		for (const p of panels) p.dispose();
		const beforeDispose = renders;
		disposing.release();
		releasePending = undefined;
		await until(() => liveWatches === 0, "dispose must close every watch");
		registry.saveRecord(panelDir, { ...first, activity: "after disposal" });
		await sleep(1150);
		assert.equal(renders, beforeDispose, "disposed panels must not render from watches, polls or in-flight reads");
		console.log("ok - disposal closes watches/timers and ignores pending snapshots");
		console.log("ALL PASS");
	} finally {
		failListing = undefined;
		releasePending?.();
		for (const panel of panels) panel.dispose();
		await sleep(50);
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
