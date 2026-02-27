# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

iloom is a TypeScript CLI tool that converts existing bash workflow scripts into a robust, testable system for managing isolated Git worktrees with Claude Code integration. The tool enables developers to work on multiple issues simultaneously without context confusion.

## DEVELOPMENT GUIDELINES
* DO NOT SWALLOW ERRORS
* Use Exception throwing, do not use "CommandResult" objects that return "success: true | false" - it either returns successfully or not at all.
* When catching exceptions and returning objects or throwing new exceptions, you must be very specific about the circumstances in which you are doing that. You must explicitly check for the expected error class, message (or substring) or code before returning an object or throwing a new error. Failure to do this effectively swallows the error.
* Use pnpm as your package manager. Don't use npm.
* **Avoid dynamic imports**: Use static imports at the top of files unless there's a genuine need for lazy loading (e.g., CLI commands that may not be invoked) or breaking circular dependencies. Dynamic imports add complexity, hurt performance, and make dependencies harder to trace. Before adding a dynamic import, check if the module is already imported elsewhere in the file or if a static import would work.
* **ALWAYS run `pnpm build` after completing major tasks** to ensure the TypeScript builds successfully and make the functionality available for testing. This catches compilation errors early and enables users to test new features immediately. Major tasks include: implementing new features, refactoring code, adding/modifying CLI commands, or making significant changes to core modules.

### Telemetry Requirements

**Purpose:** Telemetry helps us understand which features are actually used, where users hit errors, and how workflows perform in practice. This data drives decisions about what to improve, what to deprecate, and where to invest effort. Without it, we're guessing.

**What to track:** Add telemetry when adding new commands, features, or significant user-facing workflows. Specifically:
- **Command usage**: When a new CLI command or subcommand is added, track that it was invoked and whether it succeeded
- **Feature adoption**: When adding a new option, mode, or integration, track which variants users choose (e.g., tracker type, merge behavior, one-shot mode)
- **Workflow outcomes**: Track success/failure of multi-step workflows (loom lifecycle, swarm execution, epic planning) with duration and outcome counts
- **Error rates**: Track error types (NOT messages) at top-level catch boundaries so we can identify reliability issues
- **Lifecycle events**: Track install, upgrade, and session start to understand the active user base and version distribution

**You do NOT need to track:** Internal helper functions, intermediate steps within a workflow, or read-only operations (list, status, config display).

The telemetry system is in `src/lib/TelemetryService.ts` and event types are defined in `src/types/telemetry.ts`.

**How to add telemetry:**
- Import `TelemetryService` and call `TelemetryService.getInstance().track('event.name', { properties })` at the success point of the workflow
- All tracking calls must be wrapped in try/catch with `logger.debug()` — telemetry must NEVER break user workflows
- Tracking calls are fire-and-forget (non-blocking)
- If adding a new event type, define its interface in `src/types/telemetry.ts` and add it to the `TelemetryEventMap`

**CRITICAL — Anonymity and privacy rules for telemetry properties:**
- **NEVER** include repository names, URLs, or remote origins
- **NEVER** include branch names, issue titles, issue descriptions, or issue content
- **NEVER** include file paths, code content, or AI-generated analysis/plan content
- **NEVER** include GitHub/Linear/Jira usernames, emails, or any user identifiers
- **NEVER** include error messages (they can contain file paths or PII) — only use `error.constructor.name` for error types
- **DO** include: counts (child_count, duration_minutes), enums (tracker type, merge behavior, source type), booleans (success/failure, feature flags), and the CLI version
- When in doubt, ask: "Could this property identify a specific person, project, or repository?" If yes, do not include it.

**Existing patterns to follow:**
- `src/commands/start.ts` — tracking `loom.created` after successful start
- `src/commands/finish.ts` — tracking `loom.finished` with duration calculation
- `src/commands/cleanup.ts` — `trackLoomAbandoned()` helper for reuse across single and batch cleanup paths

### Documentation Requirements

**IMPORTANT: When adding features or configuration options, update the appropriate documentation file**:

- **New CLI commands**: Add to `docs/iloom-commands.md` with usage examples
- **New configuration options**: Document in `docs/iloom-commands.md` with default values and examples
- **New environment variables**: Add to the Environment Variables section in `docs/iloom-commands.md`
- **New flags or options**: Update the relevant command in `docs/iloom-commands.md`
- **Breaking changes**: Clearly mark and explain migration steps in both README.md and `docs/iloom-commands.md`
- **New dependencies or integrations**: Document setup in README.md, detailed usage in `docs/iloom-commands.md`

The `docs/iloom-commands.md` file is the comprehensive command reference. Use it for detailed documentation to avoid flooding README.md. The README.md should remain a concise overview and quick start guide.

**Core Commands**:

- `il start <issue-number>` - Create isolated workspace for an issue/PR
- `il finish <issue-number>` - Merge work and cleanup workspace
- `il cleanup [identifier]` - Remove workspaces
- `il list` - Show active workspaces

## Development Commands

**Build & Test** (when implemented):

```bash
npm run build          # Build TypeScript to dist/
npm test               # Run all tests with Vitest
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Generate coverage report (70% required)
npm run lint           # Run ESLint
npm run compile      # Run TypeScript compiler check
```

**Development Workflow**:

```bash
npm run dev            # Watch mode development
npm run test:single -- <test-file>  # Run specific test file
```

## Architecture Overview

**Test-Driven Development (TDD)**: All code must be written test-first with >70% coverage. Use comprehensive mock factories for external dependencies (Git, GitHub CLI, Neon CLI, Claude CLI).

### Core Module Structure

```
src/
├── cli.ts                    # Main CLI entry point
├── commands/                 # CLI command implementations
│   ├── start.ts             # Port of new-branch-workflow.sh
│   ├── finish.ts            # Port of merge-and-clean.sh
│   ├── cleanup.ts           # Port of cleanup-worktree.sh
│   ├── list.ts              # Enhanced workspace listing
├── lib/                     # Core business logic
│   ├── WorkspaceManager.ts  # Main orchestrator
│   ├── GitWorktreeManager.ts # Git operations
│   ├── GitHubService.ts     # GitHub CLI integration
│   ├── EnvironmentManager.ts # .env file manipulation
│   ├── DatabaseManager.ts   # Database provider abstraction
│   └── ClaudeContextManager.ts # Claude context generation
└── utils/                   # Utility functions
    ├── git.ts, github.ts, env.ts, database.ts, shell.ts
```

### Key Architectural Patterns

**Dependency Injection**: Core classes accept dependencies through constructor injection for complete test isolation.

**Provider Pattern**: Database integrations (Neon, Supabase, PlanetScale) implement `DatabaseProvider` interface.

**Command Pattern**: CLI commands are separate classes with full workflow testing.

**Mock-First Testing**: All external dependencies (shell commands, APIs) are mocked using factory patterns.

## Bash Script Migration Map

The TypeScript implementation maintains exact functional parity with these bash scripts:

- `bash/new-branch-workflow.sh` → `StartCommand` + `WorkspaceManager.createWorkspace()`
- `bash/merge-and-clean.sh` → `FinishCommand` + `WorkspaceManager.finishWorkspace()`
- `bash/cleanup-worktree.sh` → `CleanupCommand` + `WorkspaceManager.cleanupWorkspace()`
- `bash/utils/env-utils.sh` → `EnvironmentManager`
- `bash/utils/neon-utils.sh` → `NeonProvider`
- `bash/utils/worktree-utils.sh` → `GitWorktreeManager`

## Testing Requirements

**Comprehensive Testing Strategy**:

- **Unit Tests**: Every class/function with mocked externals
- **Integration Tests**: Command workflows with temporary Git repos
- **Regression Tests**: Automated comparison with bash script behavior
- **Property-Based Tests**: Edge case discovery using fast-check
- **Performance Tests**: Benchmarking against bash script performance

**Behavior-Focused Testing Principles**:

Write tests that focus on **behavior and contracts** rather than **implementation details** to avoid brittle, hard-to-maintain test suites:

- **Test the "what", not the "how"**: Verify that functions return expected results, not how they achieve them
- **Avoid over-mocking internal details**: Don't test exact API call sequences, method invocation order, or internal state changes unless they're part of the public contract
- **Use parameterized tests**: Test multiple similar scenarios in a single test rather than creating many similar test cases
- **Mock at boundaries**: Mock external dependencies (APIs, file system, shell commands) but avoid mocking internal implementation details
- **Focus on public contracts**: Test the function's inputs, outputs, and side effects that matter to consumers

**Example - Brittle vs Robust**:
```typescript
// ❌ Brittle: Tests implementation details
expect(mockStdin.setRawMode).toHaveBeenCalledWith(true)
expect(mockStdin.resume).toHaveBeenCalled()
expect(mockStdin.setRawMode).toHaveBeenCalledWith(false)
expect(mockStdin.pause).toHaveBeenCalled()

// ✅ Robust: Tests behavior
await expect(waitForKeypress()).resolves.toBeUndefined()
expect(mockStdin.setRawMode).toHaveBeenCalledWith(true) // Setup
expect(mockStdin.setRawMode).toHaveBeenCalledWith(false) // Cleanup
```

**Test Configuration Best Practices**:

- **Leverage vitest.config.ts**: The global config already has `mockReset: true`, `clearMocks: true`, and `restoreMocks: true`. Do NOT manually call `vi.clearAllMocks()` or `vi.restoreAllMocks()` in `afterEach` hooks - these are redundant and hurt performance.

```typescript
// ❌ Redundant: Already done by vitest.config.ts
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

// ✅ Correct: Let the global config handle it
// No afterEach needed for basic mock cleanup
```

- **Avoid Dynamic Imports**: Do NOT use dynamic imports in tests unless absolutely necessary. They significantly slow down test execution and add complexity. Use static imports with proper mocking instead.

```typescript
// ❌ Slow: Dynamic import
const { someFunction } = await import('../utils/helpers.js')

// ✅ Fast: Static import with mocking
import { someFunction } from '../utils/helpers.js'
vi.mock('../utils/helpers.js')
```

**Mock Factories Required**:

```typescript
MockGitProvider        # Mock git commands and responses
MockGitHubProvider     # Mock gh CLI responses
MockNeonProvider       # Mock Neon CLI and API responses
MockClaudeProvider     # Mock Claude CLI integration
MockFileSystem         # Mock file operations
```

## Port Assignment Strategy

Each workspace gets a unique port calculated as `3000 + issue/PR number`. This prevents conflicts when running multiple dev servers simultaneously.

## Database Branch Isolation

Uses Neon database branching to create isolated database copies per workspace. Each branch gets independent schema and data, preventing conflicts between features under development.

## Migration Versioning

Migrations live in `src/migrations/index.ts` and run automatically on CLI startup via `VersionMigrationManager`. Each migration has a `version` field that determines when it runs: it must be greater than `lastMigratedVersion` (stored in `~/.config/iloom-ai/migration-state.json`) and less than or equal to the current package version.

**Versioning convention:** A new migration's version should be one patch version higher than the current `package.json` version. For example, if `package.json` is at `0.10.2`, the next migration should be `0.10.3`. If an unreleased migration already exists at that version (check `git tag` to confirm it hasn't been released), fold new migration logic into it rather than creating a separate entry.

## Agent Workflow Todo Lists

The todo list in `templates/prompts/issue-prompt.txt` is critical for ensuring agents follow the implementation plan correctly.

**Why the Todo List Matters:**
- Agents use the todo list as both a progress tracker and an execution checklist
- Each numbered item represents a workflow step that must be completed
- Agents check off items as they complete each step, providing visibility into progress
- The todo list serves as the source of truth for what steps need to be executed

**When Adding New Workflow Steps:**
- New workflow steps MUST be added to the todo list to ensure they are executed
- Position the item appropriately based on when it should run in the workflow
- Use Handlebars conditionals (e.g., `{{#if FLAG_NAME}}`) when steps are conditional
- Ensure numbering remains sequential within each conditional branch

**Example - Adding a Conditional Step:**
```handlebars
{{#if SOME_MODE}}
{{#if SOME_FLAG}}
17. Execute conditional step (STEP X.X)
18. Next step...
{{else}}
17. Next step...
{{/if}}
{{else}}
17. Next step...
{{/if}}
```

Without the todo list entry, agents may skip steps even if they are fully documented elsewhere in the prompt.