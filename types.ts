export type AgentStatus =
	| "queued"
	| "starting"
	| "thinking"
	| "running_tool"
	| "idle"
	| "completed"
	| "failed"
	| "cancelled";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface AgentRecord {
	version: 1;
	runId: string;
	parentRunId: string;
	rootRunId: string;
	sessionId: string;
	sessionFile?: string;
	pid?: number;
	/** Linux /proc start time used to reject stale PID reuse during cleanup. */
	pidStartTime?: string;
	name: string;
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	tools?: string[];
	depth: number;
	maxDepth: number;
	status: AgentStatus;
	/** Fresh on each agent_start; scopes parent-owned result/UI markers to one execution. */
	executionId?: string;
	/** Set when the user started a newer turn: hide from the footer tree. History stays reviewable. */
	footerDismissed?: boolean;
	/** Set once this child's result has been delivered to the parent session. */
	resultsDelivered?: boolean;
	activity?: string;
	currentTool?: string;
	latestText?: string;
	error?: string;
	usage: UsageSummary;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
}

export interface SubagentSettings {
	defaultModel?: string;
	defaultThinking?: string;
	maxDepth: number;
	maxConcurrency: number;
}

export interface SpawnAgentInput {
	task: string;
	name?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
}

export const EMPTY_USAGE: UsageSummary = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};
