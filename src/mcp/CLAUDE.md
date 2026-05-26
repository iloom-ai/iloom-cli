# src/mcp/

> **Maintenance:** Keep this file in sync with the directory contents. If you add, remove, or change an MCP server or its tools, update the relevant section below.

This directory contains MCP (Model Context Protocol) servers that expose tools to Claude during agent workflows. These run as sidecar processes alongside Claude sessions.

## MCP Servers

### issue-management-server.ts

Exposes issue/PR operations to agents. Provider-agnostic — routes to GitHub, Linear, or Jira based on `ISSUE_PROVIDER` env var.

**Tools (28):** `get_issue`, `get_pr`, `get_review_comments`, `get_reviews`, `get_comment`, `create_comment`, `update_comment`, `create_issue`, `create_child_issue`, `create_dependency`, `get_dependencies`, `remove_dependency`, `get_child_issues`, `close_issue`, `reopen_issue`, `edit_issue`, and more.

**Used by:** All execution contexts (regular, swarm child, swarm orchestrator).

**Routing:** Provider determined by `ISSUE_PROVIDER` env var. PR comment operations always route through GitHub regardless of issue provider. Jira Wiki markup is auto-converted to GFM.

### recap-server.ts

Manages the recap system — structured knowledge capture (decisions, insights, risks, fixes, artifacts) displayed in the VS Code sidebar.

**Tools:** `set_goal`, `set_complexity`, `add_entry`, `add_artifact`, `get_recap`, `set_loom_state`, `get_loom_state`

**Used by:** All execution contexts.

**Routing (critical for swarm):** Recap entries are routed by `worktreePath` parameter. When provided, entries write to `~/.config/iloom-ai/recaps/[slugified-path].json`. In swarm mode, child workers MUST pass `worktreePath` on every recap call — otherwise entries go to the epic's recap instead of the child's. This is a common bug source.

**Deduplication:** `add_entry` skips if type+content already exists. `add_artifact` replaces if `primaryUrl` matches.

### harness-server.ts

One-way signaling from Claude to the iloom harness process (e.g., plan mode auto-swarm).

**Tools:** `signal`

**Used by:** Plan mode (signal "done" to trigger auto-swarm), child workers in swarm.

**Routing:** Via Unix domain socket at `ILOOM_HARNESS_SOCKET` env var.

## Provider Implementations

MCP issue management uses its own provider layer (separate from `src/lib/` issue trackers):

| File | Provider | Purpose |
|------|----------|---------|
| `GitHubIssueManagementProvider.ts` | GitHub | Issue/PR ops via `gh` CLI |
| `LinearIssueManagementProvider.ts` | Linear | Issue ops via Linear SDK |
| `JiraIssueManagementProvider.ts` | Jira | Issue ops via Jira API |

Factory: `IssueManagementProviderFactory` creates the right provider based on settings.

## Type Definitions

`types.ts` — Input/output schemas for all MCP operations.
`recap-types.ts` — `RecapFile`, `RecapEntry`, `RecapArtifact`, `RecapComplexity`.
