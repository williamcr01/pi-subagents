import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { SubagentSettings } from "./types.ts";

export const DEFAULT_SETTINGS: SubagentSettings = {
	maxDepth: 2,
	maxConcurrency: 4,
	rpcMaxLineChars: 64 * 1024 * 1024,
};

export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);

type RawSettings = Partial<SubagentSettings>;

function readSettings(path: string): RawSettings {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return value as RawSettings;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function depth(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value;
}

function concurrency(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || (value !== -1 && value < 1)) {
		throw new Error(`${field} must be -1 (unlimited) or a positive integer`);
	}
	return value;
}

export function validateRpcMaxLineChars(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive safe integer`);
	}
	return value;
}

export function validateThinkingLevel(value: unknown, field: string): string {
	const level = optionalString(value, field)!;
	if (!THINKING_LEVELS.has(level)) throw new Error(`${field} is not a valid thinking level`);
	return level;
}

function validate(raw: RawSettings, source: string): RawSettings {
	const result: RawSettings = {};
	if (raw.defaultModel !== undefined) result.defaultModel = optionalString(raw.defaultModel, `${source}.defaultModel`);
	if (raw.defaultThinking !== undefined) {
		result.defaultThinking = validateThinkingLevel(raw.defaultThinking, `${source}.defaultThinking`);
	}
	if (raw.rpcMaxLineChars !== undefined) {
		result.rpcMaxLineChars = validateRpcMaxLineChars(raw.rpcMaxLineChars, `${source}.rpcMaxLineChars`);
	}
	if (raw.maxDepth !== undefined) result.maxDepth = depth(raw.maxDepth, `${source}.maxDepth`);
	if (raw.maxConcurrency !== undefined) {
		result.maxConcurrency = concurrency(raw.maxConcurrency, `${source}.maxConcurrency`);
	}
	return result;
}

function envNumber(value: string | undefined, parser: (value: unknown, field: string) => number, field: string) {
	if (value === undefined || value === "") return undefined;
	return parser(Number(value), field);
}

export function loadSettings(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	depthFlag?: string;
	env?: NodeJS.ProcessEnv;
}): SubagentSettings {
	const env = options.env ?? process.env;
	const global = validate(readSettings(join(options.agentDir, "subagents.json")), "global subagent settings");
	const project = options.projectTrusted
		? validate(readSettings(join(options.cwd, CONFIG_DIR_NAME, "subagents.json")), "project subagent settings")
		: {};
	const merged: SubagentSettings = { ...DEFAULT_SETTINGS, ...global, ...project };

	const inheritedDepth = envNumber(env.PI_SUBAGENT_MAX_DEPTH, depth, "PI_SUBAGENT_MAX_DEPTH");
	const flagDepth = options.depthFlag === undefined ? undefined : depth(Number(options.depthFlag), "--subagent-depth");
	const configuredDepth = flagDepth ?? merged.maxDepth;
	const envThinking = env.PI_SUBAGENT_DEFAULT_THINKING
		? validateThinkingLevel(env.PI_SUBAGENT_DEFAULT_THINKING, "PI_SUBAGENT_DEFAULT_THINKING")
		: undefined;

	return {
		...merged,
		defaultModel: env.PI_SUBAGENT_DEFAULT_MODEL || merged.defaultModel,
		defaultThinking: envThinking ?? merged.defaultThinking,
		// Descendants inherit the root's effective limit and can only tighten it.
		maxDepth: inheritedDepth === undefined ? configuredDepth : Math.min(inheritedDepth, configuredDepth),
		maxConcurrency: merged.maxConcurrency,
	};
}

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const value = env.PI_SUBAGENT_DEPTH;
	return value === undefined ? 0 : depth(Number(value), "PI_SUBAGENT_DEPTH");
}
