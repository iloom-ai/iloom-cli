# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

iloom is a TypeScript CLI tool that converts existing bash workflow scripts into a robust, testable system for managing isolated Git worktrees with Claude AI integration. The tool enables developers to work on multiple issues simultaneously without context confusion.

## DEVELOPMENT GUIDELINES
* DO NOT SWALLOW ERRORS
* Use Exception throwing, do not use "CommandResult" objects that return "success: true | false" - it either returns successfully or not at all.
* When catching exceptions and returning objects or throwing new exceptions, you must be very specific about the circumstances in which you are doing that. You must explicitly check for the expected error class, message (or substring) or code before returning an object or throwing a new error. Failure to do this effectively swallows the error.
* Use pnpm as your package manager. Don't use npm.
* **Avoid dynamic imports**: Use static imports at the top of files unless there's a genuine need for lazy loading (e.g., CLI commands that may not be invoked) or breaking circular dependencies. Dynamic imports add complexity, hurt performance, and make dependencies harder to trace. Before adding a dynamic import, check if the module is already imported elsewhere in the file or if a static import would work.
* **ALWAYS run `pnpm build` after completing major tasks** to ensure the TypeScript builds successfully and make the functionality available for testing. This catches compilation errors early and enables users to test new features immediately. Major tasks include: implementing new features, refactoring code, adding/modifying CLI commands, or making significant changes to core modules.

### Documentation Requirements

**IMPORTANT: When adding features or configuration options, you MUST update README.md**:

- **New CLI commands**: Add to the command reference section with usage examples
- **New configuration options**: Document in the configuration section with default values and examples
- **New environment variables**: Add to the environment variables section
- **New flags or options**: Update the relevant command documentation
- **Breaking changes**: Clearly mark and explain migration steps
- **New dependencies or integrations**: Document setup and usage

The README.md is the primary user-facing documentation. Keeping it synchronized ensures users can discover and use new features without diving into the code.

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
npm run typecheck      # Run TypeScript compiler check
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

## Core Functionality Being Ported

**From new-branch-workflow.sh**:

- GitHub issue/PR detection and fetching
- Branch name generation using Claude AI
- Git worktree creation with sanitized naming
- Environment setup (port calculation: 3000 + issue number)
- Database branch creation (Neon integration)
- Claude context generation and CLI launching

**From merge-and-clean.sh**:

- Uncommitted changes detection and auto-commit
- Migration conflict handling (Payload CMS specific)
- Pre-merge validation pipeline (typecheck, lint, test)
- Claude-assisted error fixing workflows
- Branch rebasing and fast-forward merge validation
- Resource cleanup (worktrees, database branches)

**Critical Integration Points**:

- **GitHub CLI**: Issue/PR fetching, branch detection
- **Claude CLI**: Context generation, branch naming, error fixing
- **Neon CLI**: Database branch management for isolation
- **Git**: Worktree operations, branch management, merge workflows
- **pnpm**: Dependency installation in worktrees

## Port Assignment Strategy

Each workspace gets a unique port calculated as `3000 + issue/PR number`. This prevents conflicts when running multiple dev servers simultaneously.

## Database Branch Isolation

Uses Neon database branching to create isolated database copies per workspace. Each branch gets independent schema and data, preventing conflicts between features under development.