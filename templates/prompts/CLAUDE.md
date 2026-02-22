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

**Orchestrator** (`swarm-orchestrator-prompt.txt`) — runs in the epic worktree, fully autonomous (`bypassPermissions`). Manages a DAG-based dependency scheduler: spawns child agents in parallel for unblocked issues, monitors completions, rebases + fast-forward merges children into the epic branch, spawns newly unblocked children, handles failures.

**Child agents** (`iloom-swarm-worker` custom agent type) — each implements one child issue in its own worktree. Strict isolation: only works in its assigned worktree, never merges branches or closes issues (orchestrator handles that). Reports success/failure back to orchestrator then stops.

## Key Files

| Area | Files |
|------|-------|
| CLI entry | `src/commands/ignite.ts` — detects epic, calls `SwarmSetupService`, launches orchestrator |
| Setup | `src/lib/SwarmSetupService.ts` — creates child worktrees, renders agents, generates MCP configs |
| Dependencies | `src/utils/dependency-map.ts` — builds DAG from issue tracker APIs (sibling deps only) |
| Child data | `src/utils/list-children.ts` — fetches child issue details from tracker |
| Metadata | `src/lib/MetadataManager.ts` — stores `childIssues`, `dependencyMap`, per-loom state |
| Orchestrator prompt | `templates/prompts/swarm-orchestrator-prompt.txt` (5 phases) |
| Worker prompt | `templates/prompts/issue-prompt.txt` (rendered with `SWARM_MODE=true`) |
| Phase agents | `templates/agents/*.md` — analyzer, planner, implementer, etc. |
| State tracking | `src/mcp/recap-server.ts` — `set_loom_state`, `add_artifact`, `add_entry` tools |

## Branch & Worktree Layout

```
main
└── issue/<epic-id>           # Epic branch + worktree
    ├── issue/<child-1>       # Child branch + worktree
    ├── issue/<child-2>       # Child branch + worktree
    └── ...
```

Each child worktree gets its own `iloom-metadata.json` with `parentLoom` reference and state tracking (`pending` → `in_progress` → `done`/`failed`).

## Merge Strategy

Rebase child onto epic branch (from child worktree), then `git merge --ff-only` from epic worktree. Keeps linear history. Conflicts are auto-resolved by spawning a subagent; unresolvable conflicts mark the child as failed.

## State Flow

Per-child: `pending` → `in_progress` → `done` | `failed`

Failed children cascade: any child depending on a failed child is also marked `failed`. Other children continue unaffected.

## Configuration

- Worker model: `.iloom/settings.json` → `agents.iloom-swarm-worker.model` (default: `opus`)
- Phase agent models: `.iloom/settings.json` → `agents.iloom-issue-implementer.model`, etc.
- Draft PR mode: `draftPrNumber` in metadata triggers auto-push via `--force-with-lease`
- Issue tracker: `issueManagement.provider` (`github` | `linear` | `jira`)
