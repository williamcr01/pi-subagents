import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { descendantsOf, isTerminalStatus, readRecords, saveRecord } from "./registry.ts";
import { buildTranscript, discoverSessionFile } from "./transcript.ts";
import type { AgentRecord } from "./types.ts";

const MAX_FOOTER_ROWS = 8;
const MAX_TRANSCRIPT_LINES = 150;
const SCROLL_STEP = 5;
const SCROLL_PAGE = 20;
const OVERLAY_MARGIN = 1;

interface SubagentPanelOptions {
	onMessage?: (record: AgentRecord, text: string) => Promise<void>;
	onCancel?: (record: AgentRecord) => void;
}

function shortPath(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function elapsed(record: AgentRecord): string {
	const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
	const seconds = Math.max(0, Math.floor((end - Date.parse(record.startedAt)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function isTerminal(record: AgentRecord): boolean {
	return isTerminalStatus(record.status);
}

function statusIcon(record: AgentRecord): string {
	switch (record.status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "✗";
		case "idle":
			return "◐";
		case "queued":
			return "◌";
		default:
			return "●";
	}
}

function statusColor(record: AgentRecord): "success" | "error" | "warning" | "accent" {
	if (record.status === "completed") return "success";
	if (record.status === "failed" || record.status === "cancelled") return "error";
	if (record.status === "idle") return "warning";
	return "accent";
}

/** Strip OSC control sequences (e.g. semantic-prompt markers) that would skew width math. */
function clean(line: string): string {
	return line.replace(/\][^\x07]*\x07/g, "");
}

export class SubagentPanel implements Component, Focusable {
	private _focused = false;
	private records: AgentRecord[] = [];
	private visible: AgentRecord[] = [];
	private selected = 0;
	private detail = false;
	private reviewing = false;
	private editor?: Component;
	private mainModel?: string;
	private transcript: { key: string; components: Component[] } | null = null;
	private transcriptFile?: string;
	private lastDiscover = 0;
	private scrollOffset = 0;
	private detailRunId?: string;
	private messageInput = new Input();
	private messageStatus?: string;
	private detailOverlay?: SubagentDetailOverlay;
	private overlayHandle?: OverlayHandle;
	private timer: ReturnType<typeof setInterval>;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.messageInput.focused = value && this.detail;
	}

	constructor(
		private readonly tui: TUI,
		private theme: Theme,
		private readonly agentDir: string,
		private readonly currentRunId: string,
		private readonly options: SubagentPanelOptions = {},
	) {
		this.messageInput.onSubmit = (value) => {
			const text = value.trim();
			const record = this.rows()[this.selected];
			if (!text || !record || !this.options.onMessage) return;
			this.messageInput.setValue("");
			this.scrollOffset = 0;
			this.messageStatus = "sending…";
			this.tui.requestRender();
			void this.options.onMessage(record, text).then(
				() => {
					this.messageStatus = "sent";
					this.tui.requestRender();
				},
				(error) => {
					this.messageStatus = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				},
			);
		};
		this.refresh();
		this.timer = setInterval(() => {
			const before = JSON.stringify(this.records);
			this.refresh();
			if (before !== JSON.stringify(this.records)) this.tui.requestRender();
		}, 250);
		this.timer.unref?.();
	}

	setEditor(editor: Component): void {
		this.editor = editor;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	setMainModel(model: string | undefined): void {
		this.mainModel = model;
	}

	/** Hide finished subagents from the footer. Runs when the user starts a new turn. */
	dismissFinished(): number {
		this.refresh();
		let count = 0;
		for (const record of this.records) {
			if (!isTerminal(record) || record.footerDismissed) continue;
			try {
				saveRecord(this.agentDir, { ...record, footerDismissed: true, updatedAt: new Date().toISOString() });
				count++;
			} catch {
				// One bad write must not block the rest.
			}
		}
		if (count > 0) this.refresh();
		return count;
	}

	/** Down-arrow entry: only non-dismissed subagents. */
	open(): boolean {
		if (this.overlayHandle) this.closeDetail();
		this.refresh();
		if (this.visible.length === 0) return false;
		this.reviewing = false;
		this.detail = false;
		this.selected = Math.min(this.selected, this.visible.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	/** /subagents entry: full history including dismissed. */
	openReview(): boolean {
		if (this.overlayHandle) this.closeDetail();
		this.refresh();
		if (this.records.length === 0) return false;
		this.reviewing = true;
		this.detail = false;
		this.selected = Math.min(this.selected, this.records.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	private rows(): AgentRecord[] {
		return this.reviewing ? this.records : this.visible;
	}

	private close(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.reviewing = false;
		this.tui.setFocus(this.editor ?? null);
		this.tui.requestRender();
	}

	private openDetail(): void {
		if (this.rows().length === 0) return;
		this.detail = true;
		this.messageStatus = undefined;
		this.scrollOffset = 0;

		// A focused overlay is important here: Pi's fullscreen TUI otherwise
		// consumes page keys and mouse-wheel events for the main conversation
		// before they reach this widget.
		const showOverlay = (this.tui as TUI & { showOverlay?: TUI["showOverlay"] }).showOverlay;
		if (typeof showOverlay === "function") {
			const overlay = new SubagentDetailOverlay(this);
			this.detailOverlay = overlay;
			this.overlayHandle = showOverlay.call(this.tui, overlay, {
				width: "100%",
				maxHeight: "100%",
				anchor: "center",
				margin: OVERLAY_MARGIN,
			});
		} else {
			// Keeps lightweight callers/tests that provide only the old TUI subset
			// usable; real Pi always has showOverlay().
			this.messageInput.focused = true;
		}
		this.tui.requestRender();
	}

	private closeDetail(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.scrollOffset = 0;
		const handle = this.overlayHandle;
		this.overlayHandle = undefined;
		this.detailOverlay = undefined;
		if (handle) {
			handle.hide();
		} else {
			this.tui.setFocus(this);
		}
		this.tui.requestRender();
	}

	/** Called by the overlay wrapper so the embedded editor keeps IME focus. */
	setDetailInputFocused(value: boolean): void {
		this.messageInput.focused = value && this.detail;
	}

	private detailMaxHeight(): number {
		const rows = this.tui.terminal?.rows;
		return typeof rows === "number" && Number.isFinite(rows)
			? Math.max(1, rows - OVERLAY_MARGIN * 2)
			: MAX_TRANSCRIPT_LINES + 8;
	}

	renderDetailForOverlay(width: number): string[] {
		return this.renderDetail(width, this.detailMaxHeight());
	}

	private refresh(): void {
		const selectedId = this.rows()[this.selected]?.runId;
		this.records = descendantsOf(readRecords(this.agentDir), this.currentRunId);
		this.visible = this.records.filter((record) => !record.footerDismissed);
		const rows = this.rows();
		const restored = selectedId ? rows.findIndex((record) => record.runId === selectedId) : -1;
		this.selected = restored >= 0 ? restored : Math.min(this.selected, Math.max(0, rows.length - 1));
		if (this.focused && rows.length === 0) this.close();
	}

	private handleWheel(data: string): boolean {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (!match) return false;
		const button = Number(match[1]);
		if (!Number.isFinite(button) || (button & 64) === 0) return false;
		const direction = button & 3;
		if (direction === 0) this.scrollOffset += SCROLL_STEP;
		else if (direction === 1) this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
		this.tui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		// Left arrow (Esc as an alias) always goes back one level:
		// detail -> list -> editor.
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			(matchesKey(data, Key.left) && (!this.detail || this.messageInput.getValue().length === 0))
		) {
			if (this.detail) this.closeDetail();
			else this.close();
			return;
		}
		if (this.detail) {
			if (this.handleWheel(data)) return;
			if (matchesKey(data, Key.up)) {
				this.scrollOffset += SCROLL_STEP;
				this.tui.requestRender();
			} else if (matchesKey(data, Key.down)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
				this.tui.requestRender();
			} else if (matchesKey(data, Key.pageUp)) {
				this.scrollOffset += SCROLL_PAGE;
				this.tui.requestRender();
			} else if (matchesKey(data, Key.pageDown)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_PAGE);
				this.tui.requestRender();
			} else {
				this.messageInput.handleInput(data);
				this.tui.requestRender();
			}
			return;
		}
		// Enter or Right arrow opens the selected subagent.
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.openDetail();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selected === 0) this.close();
			else this.selected--;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.rows().length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			const record = this.rows()[this.selected];
			if (record && !isTerminal(record)) this.options.onCancel?.(record);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		this.refresh();
		if (this.focused && this.detail && !this.overlayHandle) return this.renderDetail(width);
		return this.renderTree(width);
	}

	private mainLine(): string {
		const main = this.theme.fg("accent", this.theme.bold("main"));
		return this.mainModel ? `${main} ${this.theme.fg("dim", `· ${this.mainModel}`)}` : main;
	}

	private rowBody(record: AgentRecord): string {
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const activity = record.currentTool || record.activity || record.status;
		const sep = this.theme.fg("dim", " · ");
		const segments = [
			record.model ? this.theme.fg("dim", record.model) : undefined,
			this.theme.fg("dim", activity),
			...(isTerminal(record) ? [this.theme.fg("dim", elapsed(record))] : []),
		].filter((segment): segment is string => Boolean(segment));
		const name =
			record.agent && record.agent !== record.name
				? `${record.name} ${this.theme.fg("dim", `(${record.agent})`)}`
				: record.name;
		return `${icon} ${name}  ${segments.join(sep)}`;
	}

	private renderTree(width: number): string[] {
		// One tree for every state: the footer while typing, the focused list
		// after Down, and /subagents history. Only selection and hints differ.
		const rows = this.rows();
		if (rows.length === 0) return [];
		const byId = new Map(rows.map((r) => [r.runId, r]));
		const isLast = (record: AgentRecord): boolean => {
			const siblings = rows.filter((r) => r.parentRunId === record.parentRunId);
			return siblings[siblings.length - 1]?.runId === record.runId;
		};
		const ancestorChain = (record: AgentRecord): AgentRecord[] => {
			const chain: AgentRecord[] = [];
			let current = record;
			while (current.parentRunId !== this.currentRunId && byId.has(current.parentRunId)) {
				current = byId.get(current.parentRunId)!;
				chain.unshift(current);
			}
			return chain;
		};
		const selectedRunId = this.focused ? rows[this.selected]?.runId : undefined;
		const start = this.focused
			? Math.max(0, Math.min(rows.length - MAX_FOOTER_ROWS, this.selected - Math.floor(MAX_FOOTER_ROWS / 2)))
			: 0;
		const window = rows.slice(start, start + MAX_FOOTER_ROWS);
		const lines = [this.mainLine() + (this.reviewing ? this.theme.fg("dim", "  · history") : "")];
		if (start > 0) lines.push(this.theme.fg("dim", "  …"));
		for (const record of window) {
			const prefix =
				ancestorChain(record).map((a) => (isLast(a) ? "   " : "│  ")).join("") +
				(isLast(record) ? "└─ " : "├─ ");
			const line = truncateToWidth(prefix + this.rowBody(record), width, "…");
			if (this.focused && record.runId === selectedRunId) {
				lines.push(this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))));
			} else {
				lines.push(line);
			}
		}
		if (start + window.length < rows.length) {
			lines.push(this.theme.fg("dim", `… +${rows.length - start - window.length} more`));
		}
		lines.push(this.theme.fg("dim", this.focused ? "↑/↓ select   Enter/→ open   x stop   ← back" : "↓ inspect"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private transcriptComponents(record: AgentRecord): Component[] | null {
		const file = record.sessionFile ?? this.transcriptFile;
		if (!file) {
			const now = Date.now();
			if (now - this.lastDiscover > 2000) {
				this.lastDiscover = now;
				void discoverSessionFile(record.cwd, record.sessionId).then((found) => {
					if (found && this.records[this.selected]?.runId === record.runId) {
						this.transcriptFile = found;
						this.tui.requestRender();
					}
				});
			}
			return null;
		}
		if (record.sessionFile) this.transcriptFile = record.sessionFile;
		let key: string;
		try {
			const stat = statSync(file);
			key = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return null;
		}
		if (!this.transcript || this.transcript.key !== key) {
			const components = buildTranscript(file, this.tui, record.cwd);
			this.transcript = components ? { key, components } : null;
		}
		return this.transcript?.components ?? null;
	}

	private legacyDetail(record: AgentRecord, width: number): string[] {
		const lines = [
			this.theme.fg("muted", "Task"),
			...wrapTextWithAnsi(record.task, Math.max(1, width)).slice(0, 3),
			"",
			this.theme.fg("muted", "Current activity"),
			truncateToWidth(record.currentTool || record.activity || record.status, width, "…"),
		];
		if (record.latestText) {
			lines.push("", this.theme.fg("muted", "Latest output"), ...wrapTextWithAnsi(record.latestText, Math.max(1, width)).slice(-4));
		}
		if (record.error) lines.push("", this.theme.fg("error", truncateToWidth(record.error, width, "…")));
		return lines;
	}

	private renderDetail(width: number, maxHeight = MAX_TRANSCRIPT_LINES + 8): string[] {
		const record = this.rows()[this.selected];
		if (!record) return [];
		if (this.detailRunId !== record.runId) {
			this.detailRunId = record.runId;
			this.scrollOffset = 0;
			this.transcript = null;
			this.transcriptFile = undefined;
		}
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const header = [
			truncateToWidth(`${icon} ${this.theme.bold(record.name)} ${this.theme.fg("dim", `· ${record.status} · ${elapsed(record)}`)}`, width),
			this.theme.fg("dim", `${record.model}${record.thinking !== "off" ? `:${record.thinking}` : ""} · depth ${record.depth}/${record.maxDepth} · ${shortPath(record.cwd)}`),
			"",
		];
		const footer = [
			"",
			...(this.messageStatus
				? [this.theme.fg(this.messageStatus === "sent" || this.messageStatus === "sending…" ? "dim" : "error", this.messageStatus)]
				: []),
			this.theme.fg("muted", "Message this subagent:"),
			...this.messageInput.render(width),
			this.theme.fg("dim", "Enter send   ↑/↓/PgUp/PgDn scroll   Esc back"),
		];
		const available = Math.max(1, maxHeight - header.length - footer.length);
		const lines = [...header];
		const components = this.transcriptComponents(record);
		if (!components || components.length === 0) {
			lines.push(...this.legacyDetail(record, width).slice(0, available));
		} else {
			const body: string[] = [];
			for (const component of components) {
				for (const line of component.render(width)) body.push(clean(line));
			}
			if (record.activity === "responding" && record.latestText) {
				body.push("", this.theme.fg("dim", "live"), ...wrapTextWithAnsi(record.latestText, Math.max(1, width)));
			}
			const bodyViewport = Math.max(1, available - 2);
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - bodyViewport));
			const end = Math.max(0, body.length - this.scrollOffset);
			const start = Math.max(0, end - bodyViewport);
			const content: string[] = [];
			if (start > 0) content.push(this.theme.fg("dim", `… ${start} earlier lines · ↑/PgUp scroll`));
			content.push(...body.slice(start, end));
			if (this.scrollOffset > 0) content.push(this.theme.fg("dim", `… ${body.length - end} newer lines · ↓/PgDn follow`));
			lines.push(...content.slice(0, available));
		}
		lines.push(...footer);
		return lines.slice(0, maxHeight).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.messageInput.invalidate();
	}

	dispose(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.overlayHandle?.hide();
		this.overlayHandle = undefined;
		this.detailOverlay = undefined;
		clearInterval(this.timer);
	}
}

/**
 * Focus target used by the transcript overlay. The persistent panel remains a
 * below-editor widget; this wrapper lets Pi's viewport defer page/mouse scroll
 * events while the transcript is open.
 */
class SubagentDetailOverlay implements Component, Focusable {
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.panel.setDetailInputFocused(value);
	}

	constructor(private readonly panel: SubagentPanel) {}

	handleInput(data: string): void {
		this.panel.handleInput(data);
	}

	render(width: number): string[] {
		return this.panel.renderDetailForOverlay(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}
