# src/lib/

> **Maintenance:** Keep this file in sync with the directory contents. If you add, remove, or change the responsibility of a service, update the relevant section below.

This is the service layer — all business logic lives here. Commands in `src/commands/` delegate to these services. Services accept dependencies via constructor injection for testability.

## Orchestrator vs Child Boundary

This is the most common source of architectural mistakes. Memorize these rules:

**Orchestrator (swarm-orchestrator-prompt.txt) NEVER:**
- Writes code or runs phase agents (analyzer, planner, implementer, reviewer)
- Runs builds, tests, or linting
- Rebases branches or resolves merge conflicts
- Creates PRs or manages database branches
- It stays lean: parse DAG → spawn workers → monitor → merge → finalize

**Child worker (issue-prompt.txt with SWARM_MODE=true) NEVER:**
- Spawns other agents or manages the team
- Merges branches to the epic branch (orchestrator merges via git)
- Closes issues (orchestrator closes after successful merge)
- Reads other children's worktrees or manages the dependency DAG
- It focuses: receive assignment → implement → report done/failed

## Service Responsibilities

### Workspace & Loom Lifecycle

| Service | Responsibility | Used By |
|---------|---------------|---------|
| **LoomManager** | Orchestrate loom creation: worktree + env + deps + capabilities + metadata | `start` command |
| **GitWorktreeManager** | Git worktree CRUD: list, create, find, remove | All workspace commands |
| **MetadataManager** | Loom metadata persistence to `~/.config/iloom-ai/looms/` | All commands needing loom state |
| **ResourceCleanup** | Teardown: kill processes, delete database branch, remove worktree | `finish`, `cleanup` |
| **MergeManager** | Git rebase, merge target resolution, conflict detection, smart rebase/merge strategy detection (merge-commit detection, commit count threshold), merge-from-parent execution, `--no-ff` merge support | `finish`, `rebase` |
| **CommitManager** | Git commit with issue references, message generation | `commit` |
| **ValidationRunner** | Run lint/test scripts as pre-merge validation | `finish`, `commit` |
| **BuildRunner** | Execute project build scripts | `finish`, `rebase`, `build` |
| **BranchNamingService** | Generate branch names via strategy pattern (Simple or Claude) | `start` |

### Claude Integration

| Service | Responsibility | Used By |
|---------|---------------|---------|
| **ClaudeService** | Claude CLI invocation, permission mode resolution | `start`, `spin` |
| **ClaudeContextManager** | Prepare Claude context with workspace info | `start` |
| **PromptTemplateManager** | Handlebars template rendering for prompts and agents | `spin`, `plan`, `init` |
| **AgentManager** | Load agent templates from markdown, apply model overrides | `spin`, `plan`, `start` |
| **SwarmSetupService** | Render swarm agents/skills to `.claude/agents/` and `.claude/skills/` | `spin` (epic only) |
| **ClaudeHookManager** | Hook execution for Claude CLI events | Swarm child |
| **SwarmReportCollector** | Collect and aggregate swarm worker outputs | Swarm orchestrator |

### Issue & Version Control

| Service | Responsibility | Used By |
|---------|---------------|---------|
| **IssueTrackerFactory** | Create IssueTracker for configured provider (GitHub/Linear/Jira) | Commands needing issues |
| **GitHubService** | GitHub-specific issue/PR operations via `gh` CLI | GitHub projects |
| **LinearService** | Linear issue operations via `@linear/sdk` | Linear projects |
| **PRManager** | GitHub PR create/check/merge (legacy, pre-VCS-factory) | `finish`, `start` |
| **VCSProviderFactory** | Create VCS provider (BitBucket); GitHub uses PRManager | Multi-VCS projects |
| **IssueEnhancementService** | Enhance issue descriptions with AI-generated context | `add-issue`, `enhance` |

### Environment & Infrastructure

| Service | Responsibility | Used By |
|---------|---------------|---------|
| **SettingsManager** | Hierarchical settings resolution with Zod validation | All commands |
| **DatabaseManager** | Conditional database branching orchestration | `start`, `cleanup` |
| **EnvironmentManager** | .env file read/write, DATABASE_URL management | `start`, `cleanup` |
| **DevServerManager** | Dev server lifecycle via strategy (Native or Docker) | `open`, `run`, `dev-server` |
| **DockerManager** | Docker build/run/inspect utility functions | Docker dev server |
| **ProjectCapabilityDetector** | Detect project capabilities (cli, web) from package.json | `start`, `open`, `run` |
| **CLIIsolationManager** | Symlink project CLI into worktree for agent use | `start` (cli capability) |
| **ProcessManager** | Process detection/termination (cross-platform) | Dev server, cleanup |

### Telemetry & Sessions

| Service | Responsibility | Used By |
|---------|---------------|---------|
| **TelemetryService** | Anonymous event tracking (fire-and-forget, never breaks workflows) | All commands |
| **SessionSummaryService** | Generate session summaries from Claude transcripts | `finish`, `summary` |

## Configuration Layering

Settings resolve in this order (highest priority wins):

1. **CLI flags** — `--set key.nested.value` or typed flags like `--merge-strategy pr`
2. **Local** — `.iloom/settings.local.json` (per-developer, gitignored)
3. **Project** — `.iloom/settings.json` (shared, committed)
4. **Global** — `~/.config/iloom-ai/settings.json` (user home)
5. **Defaults** — Hardcoded in Zod schema

Scalar values: higher priority fully overrides. Objects/arrays: deep-merged via `deepmerge`.

## Provider Patterns

Four provider abstractions with factory/strategy implementations:

| Abstraction | Interface | Implementations | Factory |
|------------|-----------|-----------------|---------|
| Database | `DatabaseProvider` | NeonProvider | DatabaseManager detects provider |
| Issue Tracker | `IssueTracker` | GitHubService, LinearService, JiraIssueTracker | `IssueTrackerFactory.create()` |
| Version Control | `VersionControlProvider` | BitBucketVCSProvider (GitHub uses PRManager) | `VCSProviderFactory.create()` |
| Dev Server | `DevServerStrategy` | NativeDevServerStrategy, DockerDevServerStrategy | DevServerManager selects by config |

### providers/ subdirectory

| File | Provider | Purpose |
|------|----------|---------|
| `NeonProvider.ts` | Neon | Database branching via Neon CLI |
| `jira/JiraIssueTracker.ts` | Jira | Issue tracking via Jira API |
| `jira/JiraApiClient.ts` | Jira | Low-level Jira REST API |
| `BitBucketVCSProvider.ts` | BitBucket | PR/MR operations via BitBucket API |
