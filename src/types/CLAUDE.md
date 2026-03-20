# src/types/

> **Maintenance:** Keep this file in sync with the directory contents. If you add a new type file or move key interfaces, update the table below.

Type definitions organized by domain. When adding new types, put them in the file that matches their domain rather than dumping everything in `index.ts`.

## Type Files by Domain

| File | Domain | Key Types |
|------|--------|-----------|
| `index.ts` | Top-level command I/O | `StartResult`, `FinishResult`, `Workspace`, `Issue`, `PullRequest`, `Config`, `DatabaseProvider` interface |
| `loom.ts` | Loom lifecycle | `Loom`, `CreateLoomInput`, `LaunchMode`, `ProjectCapability`, `LoomType` |
| `worktree.ts` | Git worktree ops | `GitWorktree`, `WorktreeCreateOptions`, `WorktreeValidation`, `WorktreeStatus` |
| `telemetry.ts` | Telemetry events | `TelemetryConfig`, `TelemetryEventMap`, per-event property interfaces (14 event types) |
| `environment.ts` | .env management | `EnvVariable`, `EnvFileOptions`, `PortAssignmentOptions` |
| `cleanup.ts` | Workspace teardown | `ResourceCleanupOptions`, `CleanupResult`, `SafetyCheck` |
| `branch-naming.ts` | Branch generation | `BranchNameStrategy`, `BranchGenerationOptions` |
| `github.ts` | GitHub API models | `GitHubIssue`, `GitHubPullRequest`, `GitHubProject`, `GitHubInputDetection` |
| `linear.ts` | Linear API models | Linear-specific response types |
| `process.ts` | Process management | Process detection and lifecycle types |

## Conventions

- **Error handling**: Exception-based. Do NOT add `Result<T, E>` wrapper types — functions either return successfully or throw.
- **New telemetry events**: Define the property interface in `telemetry.ts` and add it to `TelemetryEventMap`.
- **Provider interfaces**: `DatabaseProvider` is in `index.ts`. Issue tracker and VCS provider interfaces are in their respective service files in `src/lib/`.
