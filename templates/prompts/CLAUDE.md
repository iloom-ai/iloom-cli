# Swarm Mode Overview

Swarm mode orchestrates parallel AI agents to implement epic issues. An epic is decomposed into child issues, each executed in an isolated worktree by an independent agent, then merged back into the epic branch.

## Lifecycle

```
il plan <epic>     Decompose epic into child issues (creates the children that trigger swarm)
il start <epic>    Create epic loom (detects children, builds dependency map)
il spin            Launch orchestrator (auto-detects epic, enters swarm mode)
il list --json     Monitor progress (shows swarmIssues with per-child state)
il finish <epic>   Merge epic branch back to main
```

## Architecture

**Orchestrator** (`swarm-orchestrator-prompt.txt`) — runs in the epic worktree, fully autonomous (`bypassPermissions`). Stays lean as a pure coordinator: manages a DAG-based dependency scheduler, spawns child agents in parallel for unblocked issues, monitors completions, delegates all heavy git operations (rebasing, merging, pushing, conflict resolution) to subagents, spawns newly unblocked children, handles failures.

**Child agents** (`iloom-swarm-worker` custom agent type) — each implements one child issue in its own worktree. Strict isolation: only works in its assigned worktree, never merges branches or closes issues (orchestrator handles that). Reports success/failure back to orchestrator then stops.

## Key Files

| Area | Files |
|------|-------|
| CLI entry | `src/commands/ignite.ts` — detects epic, calls `SwarmSetupService`, launches orchestrator |
| Setup | `src/lib/SwarmSetupService.ts` — creates metadata entries for child issues, renders agents, generates MCP configs (worktrees created on-demand by orchestrator) |
| Dependencies | `src/utils/dependency-map.ts` — builds DAG from issue tracker APIs (sibling deps only) |
| Child data | `src/utils/list-children.ts` — fetches child issue details from tracker |
| Metadata | `src/lib/MetadataManager.ts` — stores `childIssues`, `dependencyMap`, per-loom state |
| Orchestrator prompt | `templates/prompts/swarm-orchestrator-prompt.txt` (5 phases) |
| Worker prompt | `templates/prompts/issue-prompt.txt` (rendered with `SWARM_MODE=true`) |
| Phase agents | `templates/agents/*.md` — analyzer, planner, implementer, etc. |
| State tracking | `src/mcp/recap-server.ts` — `set_loom_state`, `add_artifact`, `add_entry` tools |
| Worktree MCP | `src/mcp/worktree-server.ts` — MCP tool for just-in-time child worktree creation |

## Branch & Worktree Layout

```
main
└── issue/<epic-id>           # Epic branch + worktree (created at spin time)
    ├── issue/<child-1>       # Child branch + worktree (created on-demand by orchestrator)
    ├── issue/<child-2>       # Child branch + worktree (created on-demand by orchestrator)
    └── ...
```

Child worktrees are created on-demand by the orchestrator (not at `il spin` time) via the `mcp__worktree__create_worktree` MCP tool. This ensures each child branches from the latest epic branch HEAD, which includes all previously merged work from earlier waves.

Each child has metadata written at spin time (state: `pending`, with `parentLoom` reference). The actual worktree and branch are created just-in-time when the orchestrator is ready to spawn an agent for that child. State tracking: `pending` → `in_progress` → `done`/`failed`.

## Merge Strategy

Rebase child onto epic branch (from child worktree), then `git merge --ff-only` from epic worktree. Keeps linear history. The entire rebase+merge operation (including conflict resolution) is delegated to a subagent -- the orchestrator never runs git rebase/merge directly. Unresolvable conflicts mark the child as failed.

## State Flow

Per-child: `pending` → `in_progress` → `done` | `failed`

Failed children cascade: any child depending on a failed child is also marked `failed`. Other children continue unaffected.

## Configuration

- Worker model: `.iloom/settings.json` → `agents.iloom-swarm-worker.model` (default: `sonnet`)
- Phase agent models: `.iloom/settings.json` → `agents.iloom-issue-implementer.model`, etc.
- Draft PR mode: `draftPrNumber` in metadata triggers auto-push via `--force-with-lease`
- Issue tracker: `issueManagement.provider` (`github` | `linear` | `jira`)
