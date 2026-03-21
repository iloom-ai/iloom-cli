# src/commands/

> **Maintenance:** Keep this file in sync with the directory contents. If you add, remove, or rename a command, update the table below.

Commands handle CLI parsing, flag validation, and user I/O. They delegate all business logic to services in `src/lib/`. Commands should be thin — orchestration logic belongs in lib/.

## Command Registration

Commands are registered in `src/cli.ts` using Commander.js. Each command class has an `execute()` method that receives parsed options.

## Command Reference

### Core Workspace Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `start` | `new`, `create`, `up` | `start.ts` | LoomManager, GitWorktreeManager, DatabaseManager, AgentManager | Create isolated workspace for issue/PR/epic |
| `finish` | `dn` | `finish.ts` | MergeManager, ValidationRunner, ResourceCleanup, PRManager | Merge branch, cleanup workspace |
| `cleanup` | `remove`, `clean` | `cleanup.ts` | GitWorktreeManager, ResourceCleanup, LoomManager | Remove worktree(s) |
| `list` | — | (inline in cli.ts) | LoomManager, GitWorktreeManager | Show active looms |

### Agent & Planning Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `spin` | `ignite` | `ignite.ts` | PromptTemplateManager, SwarmSetupService, AgentManager | Launch Claude with workspace context; swarm orchestrator for epics |
| `plan` | — | `plan.ts` | PromptTemplateManager, IssueTrackerFactory, AgentManager | Architect-mode decomposition; optional auto-swarm |

### Git & Commit Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `commit` | — | `commit.ts` | CommitManager, ValidationRunner, MetadataManager | Commit with issue reference |
| `rebase` | — | `rebase.ts` | MergeManager, GitWorktreeManager, BuildRunner | Rebase on main with Claude conflict resolution |

### Issue Management Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `add-issue` | `a` | `add-issue.ts` | IssueEnhancementService, SettingsManager | Create + enhance issue (no workspace) |
| `enhance` | — | `enhance.ts` | IssueTracker, IssueEnhancementService | Enhance existing issue description |
| `issues` | — | `issues.ts` | IssueTrackerFactory | List project issues |
| `projects` | — | `projects.ts` | MetadataManager | List configured iloom projects |
| `feedback` | `f` | `feedback.ts` | IssueEnhancementService, GitHubService | Submit feedback to iloom-cli repo |

### Development Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `build` | — | `build.ts` | ScriptCommandBase | Run build script in worktree |
| `lint` | — | `lint.ts` | ScriptCommandBase | Run lint script |
| `test` | — | `test.ts` | ScriptCommandBase | Run test script |
| `compile` | `typecheck` | `compile.ts` | ScriptCommandBase | Run TypeScript compiler check |
| `install-deps` | — | `install-deps.ts` | ScriptCommandBase | Install dependencies |
| `dev-server` | `dev` | `dev-server.ts` | DevServerManager, DockerManager | Start dev server (foreground) |
| `open` | — | `open.ts` | DevServerManager, ProjectCapabilityDetector | Open workspace in browser |
| `run` | — | `run.ts` | DevServerManager, ProjectCapabilityDetector | Run CLI tool or open browser |

### Session & Environment Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `shell` | `terminal` | `shell.ts` | GitWorktreeManager, MetadataManager | Open shell with workspace env |
| `vscode` | — | `vscode.ts` | GitWorktreeManager | Open workspace in VS Code |
| `summary` | — | `summary.ts` | SessionSummaryService, PRManager | Generate session summary |
| `recap` | — | `recap.ts` | GitWorktreeManager | Show loom recap |
| `contribute` | — | `contribute.ts` | GitHub CLI, Git | Fork + clone external repo for contribution |

### Setup & Utility Commands

| Command | Aliases | File | Delegates To | Key Purpose |
|---------|---------|------|-------------|-------------|
| `init` | `config` | `init.ts` | PromptTemplateManager, AgentManager, ShellCompletion | Initialize iloom configuration |
| `update` | — | `update.ts` | Installation detector | Update iloom to latest version |
| `telemetry` | — | (inline in cli.ts) | TelemetryService | Enable/disable/check telemetry status |

### Global Flags

Available on all commands:
- `--debug` — Enable debug output
- `--set <key=value>` — Override any setting using dot notation (repeatable)

### Key Flags by Command

**`start`**: `--epic` (epic loom), `--one-shot <mode>` (automation level), `--complexity <level>` (override triage), `--effort <level>` (set effort level, persists in metadata), `--create-only` (skip Claude/IDE/terminal), `--child-loom` (force child)

**`finish`**: `--merge-strategy <local|pr|draft-pr>`, `--rebase` (rebase before merge), `--build`/`--test` (pre-merge validation)

**`spin`**: `--one-shot <mode>`, `--complexity <level>`, `--effort <level>` (set effort level, session-only), `--json-stream` (headless JSONL output), `--print` (print mode for headless)

**`plan`**: `--planner <claude|gemini|codex>`, `--reviewer <claude|gemini|codex|none>`, `--effort <level>` (set effort level)
