# Coagent Desktop

Desktop app for **coagent** — a multi-participant chat where humans and coding agents (Claude Code, Codex) work together in shared workspace rooms.

[한국어](README.ko.md)

## What it does

Coagent spawns multiple coding agents side-by-side, each pinned to its own project directory, and drops them into the same chat. You mention `@agent-name` to address one; agents talk back via a chat tool, can ask each other for project context (`@other-agent how does X work in your repo?`), and run their own tools (Read, Bash, Edit, …) against the directory they're pinned to.

Two backends are supported and can mix in the same room:

- **Claude Code** — Anthropic's `claude` CLI via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Auto-loads `~/.claude/...`, `.claude/settings*.json`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, hooks, and `CLAUDE.md`.
- **Codex** — OpenAI's `codex` CLI ([@openai/codex](https://www.npmjs.com/package/@openai/codex)). Auto-loads `AGENTS.md`, `.agents/skills/`, `~/.codex/config.toml`, `~/.codex/agents/`. Project-scoped layers (`.codex/config.toml`, hooks, project subagents) load after a one-time trust opt-in offered when adding the agent.

## Prerequisites

You need at least one CLI authenticated on your machine before adding an agent of that backend. Both binaries are bundled inside coagent, but each needs its own login flow run once on your machine.

### Claude Code

```bash
# Recommended: log in with your Claude account
claude login

# Or set an API key (add to ~/.zshrc / ~/.bashrc to persist)
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

If you don't have the `claude` command on PATH, install it first with `npm install -g @anthropic-ai/claude-code`.

### Codex

```bash
codex login
```

If you don't have the `codex` command on PATH, install it first with `npm install -g @openai/codex`.

> Coagent ships its own copies of both `claude` and `codex` for the agent runtime, so a global install is only needed if you also want to use these CLIs interactively in a terminal — or to run `claude login` / `codex login` once.

> Each Codex agent is launched with `--dangerously-bypass-approvals-and-sandbox`. This is currently the only mode where Codex auto-approves MCP tool calls, which the chat round-trip requires ([openai/codex#15437](https://github.com/openai/codex/issues/15437)). The agent still operates in your selected project directory; this only relaxes Codex's per-tool approval prompts.

## Installation

### macOS (Homebrew)

```bash
brew tap JangVincent/tap
brew install --cask coagent-app
```

To upgrade later, always run `brew update` first so the tap pulls the latest formula:

```bash
brew update && brew upgrade --cask coagent-app
```

> **Heads up:** the first launch will show **"coagent is damaged and can't be opened"** — this happens with the Homebrew cask too. See [First launch on macOS](#first-launch-on-macos) below to clear it.

### macOS (Manual)

Download the latest `.dmg` from [Releases](https://github.com/JangVincent/coagent-app/releases) and drag to Applications.

> **Note:** Apple Silicon (arm64) only. Intel Macs are not supported.

### First launch on macOS

The app is not notarized, so macOS quarantines it on first launch and shows **"coagent is damaged and can't be opened"**. This affects every install method (Homebrew cask and manual `.dmg`). Clear the quarantine attribute once per install:

```bash
sudo xattr -dr com.apple.quarantine /Applications/coagent.app
```

You'll need to rerun this after every upgrade as well.

### Windows

Download the latest `.exe` installer from [Releases](https://github.com/JangVincent/coagent-app/releases).

Auto-updates are enabled — the app will check for updates hourly and install them automatically.

### Linux

**Debian/Ubuntu:**
```bash
# Download the .deb file from Releases, then:
sudo dpkg -i coagent_*.deb
```

**Other distros (AppImage):**
```bash
# Download the .AppImage file from Releases, then:
chmod +x coagent-*.AppImage
./coagent-*.AppImage
```

Auto-updates are enabled on Linux as well.

## Backends at a glance

| | Claude Code | Codex |
|---|---|---|
| Project memory file | `CLAUDE.md` | `AGENTS.md` |
| Skills | `.claude/skills/` | `.agents/skills/` |
| Subagents | `~/.claude/agents/`, `.claude/agents/` | `~/.codex/agents/`, `.codex/agents/` (project requires trust) |
| Hooks / settings | auto-loaded from `~/.claude`, `.claude/settings*.json` | auto-loaded from `~/.codex/config.toml`; project `.codex/` requires trust |
| `/status` | yes | yes |
| `/usage` | yes | not exposed by codex CLI |
| `/compact` | yes (manual) | not exposed by codex CLI (auto-compacts via `model_auto_compact_token_limit`) |
| `/clear` session | yes | yes |
| `/effort` | Low / Medium / High / XHigh / Max | Low / Medium / High / XHigh |
| `/mode` | Default / Accept edits / Auto / Plan | fixed (bypass — required for MCP, see prereqs) |
| `/model` | Haiku 4.5 / Sonnet 4.6 / Opus 4.7 | gpt-5 / gpt-5-codex (API-key only) |
| Past-session resume from picker | yes | not yet (each new agent starts fresh; resume within the live agent works) |

When you add a Codex agent in a project for the first time, coagent offers to append a `[projects."<path>"] trust_level = "trusted"` entry to `~/.codex/config.toml`. Decline if you'd rather set this manually; the agent still works without it, just without project-scoped `.codex/` overrides.

## Project customization

Both backends pick up per-project conventions automatically once the agent is launched in that directory. If you want an agent to follow specific repo rules:

- **Claude:** drop a `CLAUDE.md` at the repo root (or anywhere in the project — Claude walks parents). Skills go under `.claude/skills/`, sub-agents under `.claude/agents/`, custom slash commands under `.claude/commands/`. Settings live in `.claude/settings.json` (committed) or `.claude/settings.local.json` (per-clone).
- **Codex:** drop an `AGENTS.md` at the repo root. Skills go under `.agents/skills/`. Project-scoped `.codex/config.toml` (MCP servers, hooks, etc.) and `.codex/agents/` load only after the one-time trust opt-in described above.

## Development

```bash
npm install                # Install dependencies
npm run dev                # Run in development mode
npm run build              # Build for production
npm run make               # Package the app

# Smoke tests for the agent runtime
npm run smoke:mcp          # HTTP MCP bridge
```

## Auto-Update

| Platform | Auto-Update | Method |
|----------|-------------|--------|
| Windows  | Yes | Squirrel + update.electronjs.org |
| Linux    | Yes | update.electronjs.org |
| macOS    | No | `brew update && brew upgrade --cask coagent-app` |

macOS auto-update requires code signing, which is not currently configured. Use Homebrew for updates.

## License

MIT
