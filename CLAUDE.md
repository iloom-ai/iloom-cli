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
* **Identifier comparisons are case-sensitive risks.** `Map.get`/`Map.has`, `Set.has`, `Array.includes`, and `===` on issue identifiers, branch names, or URL components are case-sensitive in JS — `'WEB-2423' !== 'web-2423'`. Before assuming a comparison is safe, trace BOTH sides to where they were written. If they're populated by different code paths or stored in different fields, treat as risky. Either normalize at write time via `IssueTracker.normalizeIdentifier()`, or do a case-insensitive comparison defensively (handles legacy data already on disk). "Pure iteration" describes how data moves, not whether keys match across sources.

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

- **Subdirectory CLAUDE.md files**: When adding, removing, or changing the responsibility of commands, services, templates, agents, MCP servers, types, or migrations, update the CLAUDE.md in the corresponding directory. See [Component Documentation](#component-documentation) below for the full list.

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

### Execution Contexts

iloom operates in three distinct execution contexts. Understanding which context you're working in is critical for targeting the right component:

1. **Regular mode** (`il start` + `il spin`): A single agent works on one issue in one worktree. Phase agents (analyzer → planner → implementer → reviewer) run sequentially. Prompt: `templates/prompts/issue-prompt.txt`.

2. **Swarm mode** (`il start --epic` + `il spin`): An orchestrator agent manages an epic by spawning parallel child workers — each in its own worktree with its own phase agents. The orchestrator is lean: it parses the dependency DAG, spawns/monitors workers, and merges results. It delegates ALL implementation work (coding, rebasing, conflict resolution) to child agents via the Task tool. Prompt: `templates/prompts/swarm-orchestrator-prompt.txt`. Child workers use `templates/prompts/issue-prompt.txt` with `SWARM_MODE=true`.

3. **Plan mode** (`il plan`): An architect agent decomposes work into issues. No implementation — planning and decomposition only. Can trigger auto-swarm to begin implementation after planning completes. Prompt: `templates/prompts/plan-prompt.txt`.

### Orchestrator vs Child Boundary

The orchestrator and child workers have strictly separated responsibilities. Getting this wrong is a common source of bugs:

- **Orchestrator NEVER**: writes code, runs builds/tests, rebases branches, resolves merge conflicts, creates PRs, manages database branches, runs phase agents
- **Child worker NEVER**: spawns other agents, merges branches to the epic branch, closes issues, manages the dependency DAG, reads other children's worktrees

### Key Architectural Patterns

- **Dependency Injection**: Core classes accept dependencies through constructor injection for test isolation
- **Provider Pattern**: Database (Neon), issue tracker (GitHub, Linear, Jira), VCS (GitHub, BitBucket), dev server (Native, Docker) — all implement pluggable interfaces via factories
- **Strategy Pattern**: Branch naming (Simple vs Claude), dev server (Native vs Docker)
- **Configuration Layering**: Defaults → global (`~/.config/iloom-ai/settings.json`) → project (`.iloom/settings.json`) → local (`.iloom/settings.local.json`) → CLI flags

### Persistent Data Storage

All per-user iloom data lives under `~/.config/iloom-ai/`. Key subdirectories:

- **`looms/`** — Loom metadata JSON files, one per active worktree. Filename is the slugified worktree path (triple underscores replace path separators). Contains issue details, branch name, dependency map, child issues, swarm config, and loom state. Finished looms move to `looms/finished/`.
- **`recaps/`** — Recap JSON files, one per loom. Contains the goal, decisions, insights, risks, assumptions, fixes, and artifacts logged by agents during a loom's lifecycle. Archived recaps move to `recaps/archived/`.
- **`mcp-configs/`** — Per-loom MCP server configuration files used by swarm workers to connect to the orchestrator's MCP server.
- **`cache/`** — Cached issue data fetched from issue trackers.
- **`projects/`** — Project marker files tracking which directories have been configured with `il init`.
- **`settings.json`** — Global user settings (applies to all projects).
- **`migration-state.json`** — Tracks which data migrations have been applied.
- **`telemetry-id` / `telemetry.json`** — Anonymous telemetry state.
- **`update-check.json`** — Version update check cache.
- **`*-first-run`** — First-run markers for features (e.g., `spin-first-run`).

Key code: `MetadataManager` (`src/lib/MetadataManager.ts`) manages loom files, `resolveRecapFilePath()` in `src/utils/mcp.ts` resolves recap paths, `SettingsManager` (`src/lib/SettingsManager.ts`) handles settings.

### Component Documentation

Each major directory has its own CLAUDE.md with detailed component documentation. These load automatically when you access files in that directory:

- `templates/CLAUDE.md` — Template system, prompt ownership, Handlebars conventions
- `templates/agents/CLAUDE.md` — Phase agent lifecycle, YAML frontmatter, model overrides
- `src/commands/CLAUDE.md` — Command layer, CLI flags, delegation to lib/
- `src/lib/CLAUDE.md` — Service layer, class responsibilities, provider patterns
- `src/mcp/CLAUDE.md` — MCP servers, exposed tools, routing rules
- `src/types/CLAUDE.md` — Key interfaces, type organization by domain
- `src/migrations/CLAUDE.md` — Migration versioning convention and lifecycle

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

- **Always mock `process.platform`**: Tests must never rely on the host OS. Code with platform-specific branches (`process.platform === 'darwin'`, etc.) will produce different results on macOS vs Linux/Windows CI. Always mock the platform explicitly in tests that exercise platform-gated code paths, and restore it in `finally`:

```typescript
// ✅ Correct: explicit platform mock
const originalPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
try {
  // test code
} finally {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
}
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

See `src/migrations/CLAUDE.md` for the full versioning convention. Key rule: new migration version = current `package.json` version + one patch. Fold into existing unreleased migrations rather than creating duplicates.

## Agent Workflow Todo Lists

See `templates/CLAUDE.md` for the full todo list convention. Key rule: when adding new workflow steps, you MUST add a corresponding todo list entry in `templates/prompts/issue-prompt.txt` or agents will skip the step.