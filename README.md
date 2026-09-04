# pi-subagents

Recursive, isolated, asynchronous subagents for the [Pi coding agent](https://github.com/earendil-works/pi).

`pi-subagents` adds background delegation to Pi without external npm dependencies. Spawn several focused agents in parallel, let agents recursively delegate their own work, monitor the live tree in Pi's footer, inspect real child transcripts, and collect results when they finish.

![pi-subagents running recursive background agents](assets/pi-subagents-demo.png)

## Features

- **Asynchronous spawning** — `spawn_agent` returns immediately while the child runs in its own Pi process and session.
- **Recursive delegation** — children can create grandchildren within the configured depth budget.
- **Parallel work** — concurrency is configurable, including unlimited mode with `maxConcurrency: -1`.
- **Live monitoring** — the footer shows a recursive status tree with provider/model, activity, and elapsed time.
- **Interactive transcripts** — open any child to read its complete Pi session from the original delegation prompt, including messages and tool calls.
- **Steering and follow-ups** — message a running child to redirect it, or message a finished child to continue its existing session.
- **Automatic delivery** — finished results are sent back to the parent when it goes idle; `check_subagents` can collect them explicitly.
- **Cancellation** — stop a running or queued child by run ID, session ID, or name.
- **No added dependencies** — uses Pi's extension and TUI APIs plus Node.js built-ins.

## Install

Install from npm with Pi:

```sh
pi install npm:@williamcr01/pi-subagents
```

Restart Pi or run `/reload` after installing. To install the latest published version explicitly:

```sh
pi update npm:@williamcr01/pi-subagents
```

For local development, the git install still works:

```sh
pi install git:github.com/williamcr01/pi-subagents.git
```

## Usage

Once installed, Pi automatically loads the extension. Ask Pi to delegate work, or use the tools directly:

```text
spawn_agent({
  task: "Inspect the authentication flow and report security risks",
  name: "auth-reviewer",
  cwd: ".",
  tools: ["read", "grep"]
})
```

Use `check_subagents` to inspect progress or wait for results:

```text
check_subagents({ wait: true, timeoutMs: 120000 })
```

Use `send_to_subagent` to steer a running child or continue a completed one. Use `cancel_subagent` to stop a child. Both accept a run ID, session ID, or exact name.

In TUI mode, press **Down** at the bottom of the editor to open the live subagent panel. Open a transcript, type a message, and press **Enter** to steer or continue that subagent. Use `/subagents` to review finished agents and transcripts.

## Tools

### `spawn_agent`

Start an isolated child in the background. It returns immediately, so continue other work while the child runs.

```text
spawn_agent({
  task: "Inspect the authentication flow and report security risks",
  name: "auth-reviewer",
  cwd: ".",
  tools: ["read", "grep"]
})
```

Optional fields are `name`, `agent`, `cwd`, `model`, `thinking`, and an exact `tools` allowlist. Model selection is resolved as:

1. Per-spawn `model`
2. `model` from the named [agent definition](#agent-definitions)
3. `defaultModel` in configuration
4. The creating agent's active model

Thinking level follows the same precedence and is clamped to the selected child model.

### `check_subagents`

Inspect descendants and collect newly finished results without repeating results already delivered. Use `wait: true` before relying on work that is still running:

```text
check_subagents({ wait: true, timeoutMs: 120000 })
```

`timeoutMs` defaults to 30 seconds and is capped at 300 seconds.

### `send_to_subagent`

Steer a running child or continue its completed session by exact name, run ID, or session ID:

```text
send_to_subagent({ target: "auth-reviewer", message: "Focus on the token refresh path." })
```

### `cancel_subagent`

Stop a child by exact name, run ID, or session ID:

```text
cancel_subagent({ target: "auth-reviewer" })
```

## Configuration

Global settings live at `~/.pi/agent/subagents.json`. A trusted project's `.pi/subagents.json` can override them for that project.

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinking": "medium",
  "maxDepth": 4,
  "maxConcurrency": -1
}
```

All fields are optional. Defaults are `maxDepth: 2` and `maxConcurrency: 4`.

- `defaultModel` — fallback model for spawns that omit `model`.
- `defaultThinking` — fallback thinking level for spawns that omit `thinking`.
- `maxDepth` — maximum recursive depth. The root is depth `0`; `maxDepth: 0` disables spawning. Descendants inherit the root limit and may only tighten it.
- `maxConcurrency` — number of children allowed to run at once. Use `-1` for unlimited or a positive integer for a limit; extra children queue automatically.

The `--subagent-depth N` Pi flag overrides configured depth for the tree. An inherited depth limit can never be raised by a descendant.

## Agent definitions

Reusable subagent types are Markdown files with YAML frontmatter, read from `~/.pi/agent/agents/` and, for a trusted project, `.pi/agents/`. A project definition overrides a global one with the same name.

`~/.pi/agent/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews a diff and reports risks
model: anthropic/claude-sonnet-4-5
thinking: high
tools: read, grep
---

Review the given change. Report correctness risks first, then style. Never edit files.
```

All fields are optional. `name` defaults to the filename without `.md` and must match `^[a-z][a-z0-9_-]{0,63}$`; files that fail to parse or resolve to an invalid name are ignored. `tools` accepts a YAML list or a comma-separated string, and `cwd` is resolved like the `spawn_agent` parameter. Everything after the frontmatter becomes extra system prompt for the child.

```text
spawn_agent({ agent: "reviewer", task: "Review the auth middleware rewrite" })
```

Per-spawn parameters override the definition, which overrides configured and inherited defaults. Definitions are re-read on every spawn, so a new file works without restarting Pi.

## Footer controls

When children exist, the footer displays a tree rooted at the current agent:

```text
main · openai-codex/gpt-5.5
├─ ● auth-reviewer · openai-codex/gpt-5.5 · running grep
└─ ● test-runner · openai-codex/gpt-5.5 · running npm test
↓ inspect
```

- Press **Down** at the bottom edge of the editor to inspect subagents.
- Press **Up/Down** to select; **Enter/Right** to open a child transcript; **x** stops a running child.
- In a transcript, type a message and press **Enter** to steer or continue the child.
- Transcripts open in a focused overlay: **Up/Down**, **PageUp/PageDown**, and mouse-wheel scrolling affect only the child transcript, not the main conversation.
- In a transcript, **Esc** or **Left** on an empty input returns.
- Press **Left** to go back; **Esc** is also supported.
- Finished children remain visible until the next user turn, then leave the footer. Use `/subagents` to review full history.

## Development

The extension is plain TypeScript loaded directly by Pi. The regression suite uses a local fake Pi child and makes no API calls:

```sh
node subagents.test.cjs
```

Source files are organized by responsibility:

- `index.ts` — Pi registration, lifecycle hooks, tools, delivery, and UI wiring
- `config.ts` — settings validation and precedence
- `registry.ts` — atomic run records
- `spawn-agent.ts` — RPC process control, concurrency, cancellation, and depth enforcement
- `control.ts` — atomic descendant message inboxes
- `events.ts` — child JSON event parsing and status updates
- `panel.ts` — footer tree, selection, and transcript detail view
- `transcript.ts` — rendering child session files

## Publishing

This repository is ready to publish as `@williamcr01/pi-subagents`:

```sh
npm login
node subagents.test.cjs
npm pack --dry-run
npm publish --access public
```

After publishing, verify the package from a clean Pi installation:

```sh
pi install npm:@williamcr01/pi-subagents
```

For a later release, bump the version (for example with `npm version patch`), push the commit and tag, then run `npm publish` again.

## License

[MIT](LICENSE) © William Crona
