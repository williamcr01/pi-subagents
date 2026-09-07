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

This version requires Pi 0.85.0 or newer. Restart Pi or run `/reload` after installing. To install the latest published version explicitly:

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

## Isolation model

Each child has a separate Pi process and session, but it is not an OS sandbox. Children use the same user account, filesystem permissions, environment, and installed extensions as the parent.

A trusted parent passes project approval only when the child's canonical working directory remains inside the parent's canonical directory. A symlink that points outside that tree does not inherit approval, so Pi evaluates trust for the target directory normally.

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

Optional fields are `name`, `cwd`, `model`, `thinking`, and an exact `tools` allowlist. Model selection is resolved as:

1. Per-spawn `model`
2. `defaultModel` in configuration
3. The creating agent's active model

When the creating session has a model scope from Pi's `--models` flag or `enabledModels` setting, the selected child model must be in that scope. The scope and its pinned thinking levels are passed to the child. A pin is applied as the child's `--thinking` value; an explicit `thinking` that disagrees with the pin is rejected. An empty scope keeps Pi's unrestricted model behavior.

Omitting `tools` copies the creating session's active tool set. An explicit list can only remove tools from that set, and `tools: []` starts the child with `--no-tools`. Include `spawn_agent` to allow recursive delegation. A child receives it automatically only when `spawn_agent` is active in the parent and `tools` is omitted or explicitly includes it.

Thinking level follows the same precedence and is clamped to the selected child model.

### `check_subagents`

Inspect descendants and collect newly finished results without repeating results already delivered. Use `wait: true` before relying on work that is still running:

```text
check_subagents({ wait: true, timeoutMs: 120000 })
```

`timeoutMs` defaults to 30 seconds and is capped at 300 seconds. The wait returns as soon as every descendant finishes; the timeout is only a maximum.

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

Global settings live at `~/.pi/agent/subagents.json`. A trusted project's `<configDir>/subagents.json` (`.pi` by default; Pi's `CONFIG_DIR_NAME`) can override them for that project.

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
- `wait.ts` — event-driven wait for descendant completion (`check_subagents` wait:true)
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
