import { randomUUID } from "node:crypto";
import type { AgentRecord, UsageSummary } from "./types.ts";

const TEXT_LIMIT = 4000;

function boundedTail(text: string, limit = TEXT_LIMIT): string {
	return text.length <= limit ? text : text.slice(-limit);
}

function messageText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function addUsage(target: UsageSummary, usage: any): void {
	if (!usage || typeof usage !== "object") return;
	target.input += Number(usage.input) || 0;
	target.output += Number(usage.output) || 0;
	target.cacheRead += Number(usage.cacheRead) || 0;
	target.cacheWrite += Number(usage.cacheWrite) || 0;
	target.totalTokens += Number(usage.totalTokens) || 0;
	target.cost += Number(usage.cost?.total) || 0;
}

function shortArgs(args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args ?? {});
	} catch {
		text = "{}";
	}
	return text.length <= 180 ? text : `${text.slice(0, 177)}…`;
}

export interface ParsedChildState {
	finalText: string;
	stopReason?: string;
	errorMessage?: string;
}

export function applyChildEvent(record: AgentRecord, state: ParsedChildState, event: any): boolean {
	let important = false;
	const now = new Date().toISOString();

	switch (event?.type) {
		case "session":
			if (typeof event.id === "string") record.sessionId = event.id;
			break;
		case "agent_start":
			record.executionId = randomUUID();
			state.finalText = "";
			state.stopReason = undefined;
			state.errorMessage = undefined;
			record.status = "thinking";
			record.activity = "thinking";
			record.currentTool = undefined;
			record.error = undefined;
			record.finishedAt = undefined;
			record.resultsDelivered = false;
			record.footerDismissed = false;
			important = true;
			break;
		case "message_start":
			if (event.message?.role === "assistant") {
				record.status = "thinking";
				record.activity = "thinking";
				record.latestText = undefined;
				important = true;
			}
			break;
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				record.latestText = boundedTail(`${record.latestText ?? ""}${update.delta}`);
				record.activity = "responding";
			} else if (update?.type === "thinking_delta") {
				record.activity = "thinking";
			} else if (update?.type === "toolcall_start") {
				record.status = "running_tool";
				record.currentTool = typeof update.toolName === "string" ? update.toolName : "tool";
				record.activity = `preparing ${record.currentTool}`;
				important = true;
			}
			break;
		}
		case "tool_execution_start":
			record.status = "running_tool";
			record.currentTool = `${event.toolName ?? "tool"} ${shortArgs(event.args)}`;
			record.activity = `running ${event.toolName ?? "tool"}`;
			important = true;
			break;
		case "tool_execution_end":
			record.currentTool = undefined;
			record.status = "thinking";
			record.activity = event.isError ? `${event.toolName ?? "tool"} failed` : "thinking";
			important = true;
			break;
		case "message_end":
			if (event.message?.role === "assistant") {
				const text = messageText(event.message);
				if (text) {
					state.finalText = text;
					record.latestText = boundedTail(text);
				}
				if (typeof event.message.model === "string") record.model = `${event.message.provider}/${event.message.model}`;
				state.stopReason = event.message.stopReason;
				state.errorMessage = event.message.errorMessage;
				record.activity = "thinking";
				addUsage(record.usage, event.message.usage);
				important = true;
			}
			break;
		case "agent_end":
			record.status = "idle";
			record.activity = "finishing";
			important = true;
			break;
	}

	record.updatedAt = now;
	return important;
}

export function toolUsage(usage: UsageSummary) {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}
