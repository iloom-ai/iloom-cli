---
name: iloom
description: Manage isolated Git worktrees and AI-assisted development workflows with iloom CLI. Use when you need to create workspaces for issues/PRs, commit and merge code, run dev servers, plan and decompose features into issues, enhance issue descriptions with AI, list active workspaces, or configure iloom projects. Covers the full loom lifecycle (init, start, finish, cleanup) and all development commands (spin, commit, rebase, build, test, lint). Also use when the user has an idea for improvement or new feature — route through `il plan` for ideation and decomposition.
metadata: { "openclaw": { "emoji": "🧵", "requires": { "anyBins": ["il", "iloom"] } } }
---

# iloom

Manage isolated Git worktrees with AI-assisted development workflows.

## Terminology

`<workItem>` — the identifier for a work item on your configured issue tracker. Examples: `42` or `#42` (GitHub), `ENG-456` (Linear), `PROJ-789` (Jira).

## Execution Modes

| Mode | Commands | Notes |
|------|----------|-------|
| **Plain exec** (no PTY, no background) | `list`, `issues`, `projects`, `recap`, `--version`, `start --no-claude --no-code --no-dev-server --no-terminal`, `cleanup --force`, `build`, `test`, `lint`, `compile`, `add-issue` | Fast, clean JSON output |
| **Background** (`background:true`) | `plan`, `spin`, `start` (with Claude), `summary`, `enhance`, `commit`, `finish`, `rebase` | Long-running or spawns Claude — monitor with `process action:poll sessionId:XXX` |
| **Foreground PTY only** | `init`, `shell` | Interactive — not for AI agents |

See `{baseDir}/references/non-interactive-patterns.md` for the complete execution mode guide, session lifecycle, decision bypass map, and recommended autonomous flag combinations.

## Project Initialization (First-Time Setup)

Before using any iloom commands, the project must have a `.iloom/settings.json` file.

```bash
mkdir -p .iloom
echo '{"mainBranch": "main"}' > .iloom/settings.json
```

See `{baseDir}/references/initialization.md` for the complete settings schema, all configuration options, remote configuration for fork workflows, and example configurations.

## Workflow: Choosing the Right Approach

### Sizeable Changes (multiple issues, architectural work)

Use the **plan → review → start → spin → finish** workflow:

1. **Plan:** `il plan --yolo --print --json-stream 'Description'` (background) — decomposes work into issues
2. **Review:** Present the created epic to the user; wait for approval before continuing
3. **Start:** `il start <workItem> --yolo --no-code --no-dev-server --no-claude --no-terminal --json` (plain exec) — creates workspace without Claude
4. **Spin:** `il spin --yolo --print --json-stream` (background) — launches Claude separately
5. **Finish:** `il finish --force --cleanup --no-browser --json-stream` (background) — merges and cleans up

### Small Changes (single issue, quick fix)

Create issue + workspace + launch Claude in one step:

```bash
bash background:true command:"il start 'Add dark mode support to the settings page' --yolo --no-code --json"
```

See `{baseDir}/references/core-workflow.md` for full command flags/examples and `{baseDir}/references/planning-and-issues.md` for planning details.

## References

- **Project initialization and settings schema:** See `{baseDir}/references/initialization.md`
- **Core lifecycle commands (init, start, finish, cleanup, list):** See `{baseDir}/references/core-workflow.md`
- **Development commands (spin, commit, rebase, build, test, etc.):** See `{baseDir}/references/development-commands.md`
- **Planning and issue management (plan, add-issue, enhance, issues):** See `{baseDir}/references/planning-and-issues.md`
- **Settings, env vars, and global flags:** See `{baseDir}/references/configuration.md`
- **Non-interactive patterns (PTY, background, autonomous operation):** See `{baseDir}/references/non-interactive-patterns.md`

## Safety Rules

1. **Use the right execution mode** for each command — see the Execution Modes table above and `{baseDir}/references/non-interactive-patterns.md` for details.
2. **Use `background:true`** for commands that launch Claude or run extended operations: `start` (with Claude), `spin`, `plan`, `commit`, `finish`, `rebase`.
3. **Never run `il finish` without `--force`** in autonomous mode — it will hang on confirmation prompts.
4. **Always pass explicit flags** to avoid interactive prompts. See `{baseDir}/references/non-interactive-patterns.md` for the complete decision bypass map.
5. **Use `--json`** when you need to parse command output programmatically. **`--json` and `--json-stream` are mutually exclusive** — prefer `--json-stream` for commands that support it (commit, finish, rebase) since it provides incremental visibility. Use `--json` only for commands without `--json-stream` support (list, cleanup, start, etc.).
6. **Prefer manual initialization** over `il init` — create `.iloom/settings.json` directly. See `{baseDir}/references/initialization.md`.
7. **Respect worktree isolation** — each loom is an independent workspace. Run commands from within the correct worktree directory.
8. **NEVER kill a background session you did not start.** Other looms may be running from separate planning or development sessions (the user's own work, other agents, or prior conversations). When you see unfamiliar background sessions, **leave them alone**. Only kill sessions you explicitly launched in the current workflow. If unsure, ask the user.
9. **Send progress updates mid-turn.** Long-running loom operations (plan, spin, commit, finish) can take minutes. Use the `message` tool to send incremental status updates to the user while waiting — don't go silent. Examples: "🧵 Spin started for issue #5, monitoring…", "✅ Tests passing, spin entering code review phase", "🔀 Merging to main…". Keep the user in the loop.
10. **GitHub labels must already exist on the repo.** `gh issue create --label` will fail if the label doesn't exist. If the user has **write or triage permissions** on the `issueManagement.github.remote` repo, you can create labels first (`gh label create <name> -R <repo>`). Otherwise, list existing labels (`gh label list -R <repo>`) and only use those, or omit labels entirely if none match.
