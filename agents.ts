import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SpawnAgentInput } from "./types.ts";

export interface AgentDefinition {
	name: string;
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	/** Markdown body after the frontmatter, appended to the child's system prompt. */
	prompt: string;
}

export const AGENT_PARAMETER_DESCRIPTION =
	"Named agent definition to apply. Explicit parameters override the definition.";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const globalAgentsDir = (agentDir: string): string => join(agentDir, "agents");

export const projectAgentsDir = (cwd: string): string => join(cwd, ".pi", "agents");

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolList(value: unknown): string[] | undefined {
	const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	const tools = items.map((item) => String(item).trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Undefined when the file is unreadable, has broken frontmatter, or resolves to an invalid name. */
function readDefinition(path: string): AgentDefinition | undefined {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
	const name = text(frontmatter.name) ?? basename(path, ".md");
	if (!NAME_PATTERN.test(name)) return undefined;
	return {
		name,
		description: text(frontmatter.description),
		model: text(frontmatter.model),
		thinking: text(frontmatter.thinking),
		tools: toolList(frontmatter.tools),
		cwd: text(frontmatter.cwd),
		prompt: body.trim(),
	};
}

/** Global definitions first, so a trusted project's definitions win on name collisions. */
export function loadAgentDefinitions(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): Map<string, AgentDefinition> {
	const directories = [globalAgentsDir(options.agentDir)];
	if (options.projectTrusted) directories.push(projectAgentsDir(options.cwd));
	const definitions = new Map<string, AgentDefinition>();
	for (const directory of directories) {
		let files: string[];
		try {
			files = readdirSync(directory).filter((file) => file.endsWith(".md")).sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const definition = readDefinition(join(directory, file));
			if (definition) definitions.set(definition.name, definition);
		}
	}
	return definitions;
}

export function describeAgents(
	definitions: Map<string, AgentDefinition>,
	options: { agentDir: string; cwd: string },
): string {
	if (definitions.size === 0) {
		return `${AGENT_PARAMETER_DESCRIPTION} No agent definitions found in ${globalAgentsDir(options.agentDir)} or ${projectAgentsDir(options.cwd)}.`;
	}
	const rows = [...definitions.values()].map((definition) =>
		definition.description ? `${definition.name} — ${definition.description}` : definition.name,
	);
	return `${AGENT_PARAMETER_DESCRIPTION} Available:\n${rows.join("\n")}`;
}

/** Fold a named definition into a spawn request; explicit parameters always win. */
export function resolveSpawnInput(input: SpawnAgentInput, definitions: Map<string, AgentDefinition>): SpawnAgentInput {
	const requested = input.agent?.trim();
	if (!requested) return input;
	const definition = definitions.get(requested);
	if (!definition) {
		const names = [...definitions.keys()];
		throw new Error(
			`Unknown agent "${requested}". Available agents: ${names.length > 0 ? names.join(", ") : "none"}`,
		);
	}
	return {
		...input,
		agent: definition.name,
		name: input.name ?? definition.name,
		cwd: input.cwd ?? definition.cwd,
		model: input.model ?? definition.model,
		thinking: input.thinking ?? definition.thinking,
		tools: input.tools ?? definition.tools,
		systemPrompt: definition.prompt || undefined,
	};
}
