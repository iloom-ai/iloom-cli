// Core types
export interface Workspace {
  id: string
  path: string
  branch: string
  issueNumber?: string | number
  prNumber?: number
  port: number
  databaseBranch?: string
  createdAt: Date
  lastAccessed: Date
}

export interface WorkspaceInput {
  identifier: string
  type: 'issue' | 'pr' | 'branch'
  skipClaude?: boolean
}

export interface WorkspaceSummary {
  id: string
  issueNumber?: string | number
  prNumber?: number
  title: string
  branch: string
  port: number
  status: 'active' | 'stale' | 'error'
  lastAccessed: string
}

// Git types
export interface Worktree {
  path: string
  branch: string
  commit: string
  isPR: boolean
  prNumber?: number
  issueNumber?: string | number
  port?: number
}

export interface GitStatus {
  hasUncommittedChanges: boolean
  unstagedFiles: string[]
  stagedFiles: string[]
  currentBranch: string
  isAheadOfRemote: boolean
  isBehindRemote: boolean
}

// GitHub types
export interface Issue {
  number: string | number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  url: string
}

export interface PullRequest {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  branch: string
  baseBranch: string
  url: string
  isDraft: boolean
  isFork?: boolean
}

// Issue Tracker types
/**
 * Generic input detection result for issue trackers
 * String-based identifier to support non-numeric IDs (e.g., Linear "ENG-123")
 */
export interface IssueTrackerInputDetection {
	type: 'issue' | 'pr' | 'unknown'
	identifier: string | null
	rawInput: string
}

/**
 * Re-export branch naming types from branch-naming module
 * These types are provider-agnostic and support all issue trackers
 */
export type { BranchNameStrategy, BranchGenerationOptions } from './branch-naming.js'

// Database types

/**
 * Result of database branch deletion operation
 * Distinguishes between successful deletion, branch not found, and errors
 */
export interface DatabaseDeletionResult {
  /** Overall operation succeeded (true even if branch didn't exist) */
  success: boolean
  /** True only if a branch was actually deleted */
  deleted: boolean
  /** True if branch didn't exist (not an error, just nothing to do) */
  notFound: boolean
  /** Error message if operation failed */
  error?: string
  /** User declined deletion (for preview databases) */
  userDeclined?: boolean
  /** Name of the branch that was processed */
  branchName?: string
}

export interface DatabaseProvider {
  // Core operations
  createBranch(name: string, fromBranch?: string, cwd?: string): Promise<string>
  deleteBranch(name: string, isPreview?: boolean, cwd?: string): Promise<DatabaseDeletionResult>
  getConnectionString(branch: string, cwd?: string): Promise<string>
  listBranches(cwd?: string): Promise<string[]>
  branchExists(name: string, cwd?: string): Promise<boolean>

  // Additional operations for Vercel integration and validation
  findPreviewBranch(branchName: string, cwd?: string): Promise<string | null>
  getBranchNameFromEndpoint(endpointId: string, cwd?: string): Promise<string | null>
  sanitizeBranchName(branchName: string): string
  isAuthenticated(cwd?: string): Promise<boolean>
  isCliAvailable(): Promise<boolean>

  // Configuration validation
  isConfigured(): boolean
}

// Configuration types
export interface Config {
  defaultPort: number
  databaseProvider?: 'neon' | 'supabase' | 'planetscale'
  claudeModel?: 'opus' | 'sonnet' | 'haiku'
  skipClaude?: boolean
  customWorkspaceRoot?: string
}

// One-shot automation mode type
export type OneShotMode = 'default' | 'noReview' | 'bypassPermissions'

// Command option types
export interface StartOptions {
  // Individual component flags (can be combined)
  claude?: boolean
  code?: boolean
  devServer?: boolean
  terminal?: boolean
  // Child loom control flag
  childLoom?: boolean
  // Epic loom control flag (for issues with child issues)
  epic?: boolean
  // One-shot automation mode
  oneShot?: OneShotMode
  // Optional body text for issue creation
  body?: string
  // Output result as JSON
  json?: boolean
}

export interface AddIssueOptions {
  // Optional body text for issue (skips AI enhancement)
  body?: string
  // Output result as JSON
  json?: boolean
}

export interface FeedbackOptions {
  // Optional body text for feedback (added after diagnostics)
  body?: string
}

export interface EnhanceOptions {
  noBrowser?: boolean  // --no-browser flag - skip browser opening prompt
  json?: boolean       // --json flag - output result as JSON
}

export interface FinishOptions {
  force?: boolean      // -f, --force - Skip confirmation prompts
  dryRun?: boolean    // -n, --dry-run - Preview actions without executing
  pr?: number         // --pr <number> - Treat input as PR number
  skipBuild?: boolean // --skip-build - Skip post-merge build verification
  noBrowser?: boolean // --no-browser - Skip opening PR in browser (github-pr mode only)
  cleanup?: boolean   // --cleanup / --no-cleanup - Control worktree cleanup after finishing
  json?: boolean      // --json - Output result as JSON
  skipToPr?: boolean  // --skip-to-pr - Skip rebase/validation/commit, go directly to PR creation (debug)
  review?: boolean    // --review - Review commit message before committing (default: auto-commit without review)
}

/**
 * Options for the cleanup command
 * All flags are optional and can be combined (subject to validation)
 */
export interface CleanupOptions {
  /** List all worktrees without removing anything */
  list?: boolean
  /** Remove all worktrees (interactive confirmation required unless --force) */
  all?: boolean
  /** Cleanup by specific issue number */
  issue?: number
  /** Skip confirmations and force removal */
  force?: boolean
  /** Show what would be done without actually doing it */
  dryRun?: boolean
  /** Output result as JSON */
  json?: boolean
  /** Wait specified milliseconds before cleanup execution */
  defer?: number
}

export interface ListOptions {
  json?: boolean
}

// JSON output result types for add-issue and enhance commands
export interface AddIssueResult {
  url: string
  id: number
  title: string
  created_at: string
}

export interface EnhanceResult {
  url: string
  id: number
  title: string
  created_at: string
  enhanced: boolean
}

export interface StartResult {
  id: string
  path: string
  branch: string
  port?: number
  type: 'issue' | 'pr' | 'branch' | 'epic'
  identifier: string | number
  title?: string
  capabilities?: string[]
  childIssueNumbers?: string[]
}

export interface FinishResult {
  success: boolean
  type: 'issue' | 'pr' | 'branch' | 'epic'
  identifier: string | number
  /** Whether this was a dry-run operation */
  dryRun?: boolean
  operations: Array<{
    type: 'validation' | 'commit' | 'rebase' | 'merge' | 'cleanup' | 'pr-creation' | 'pr-ready' | 'build'
    message: string
    success: boolean
    error?: string
  }>
  prUrl?: string
  cleanupResult?: import('./cleanup.js').CleanupResult
}

export interface SummaryResult {
  summary: string
  sessionId: string
  issueNumber?: string | number
  branchName: string
  loomType: 'issue' | 'pr' | 'branch' | 'epic'
}

// Deprecated: Result types - use exception-based error handling instead
// export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E }

// Mock factory types for testing
export interface MockOptions {
  scenario: 'empty' | 'existing' | 'conflicts' | 'error'
  data?: unknown
}

// Worktree management types
export * from './worktree.js'

// Environment management types
export * from './environment.js'

// Loom types
export * from './loom.js'

// Cleanup types
export * from './cleanup.js'

// Process types (excluding Platform which is already defined above)
export type { ProcessInfo } from './process.js'

// Color synchronization types
export interface RgbColor {
	r: number
	g: number
	b: number
}

export interface ColorData {
	rgb: RgbColor
	hex: string
	index: number
}

export type Platform = 'darwin' | 'linux' | 'win32' | 'unsupported'

// Validation types
export interface ValidationOptions {
	dryRun?: boolean
	skipTypecheck?: boolean
	skipLint?: boolean
	skipTests?: boolean
}

export interface ValidationStepResult {
	step: 'typecheck' | 'compile' | 'lint' | 'test'
	passed: boolean
	skipped: boolean
	output?: string
	error?: string
	duration?: number
}

export interface ValidationResult {
	success: boolean
	steps: ValidationStepResult[]
	totalDuration: number
}

// Commit management types
export interface CommitOptions {
	dryRun?: boolean
	issueNumber?: string | number  // For "Fixes #N" or "Refs #N" trailer
	issuePrefix: string            // "#" for GitHub, "" for Linear
	message?: string      // Custom message override
	noReview?: boolean    // Skip user review of commit message
	skipVerify?: boolean  // Skip pre-commit hooks (--no-verify flag)
	skipVerifySilent?: boolean  // Skip without warning (for --wip-commit)
	trailerType?: 'Refs' | 'Fixes'  // Trailer type: "Refs" references issue, "Fixes" closes it (default: 'Fixes' for backward compat)
	timeout?: number      // Timeout in milliseconds for commit operation
}

/**
 * Error thrown when user aborts a commit operation
 * Used by CommitManager when user selects 'abort' at the commit prompt
 */
export class UserAbortedCommitError extends Error {
	constructor(message = 'User aborted the commit') {
		super(message)
		this.name = 'UserAbortedCommitError'
	}
}

// Merge management types
export interface MergeOptions {
	dryRun?: boolean      // Preview actions without executing
	force?: boolean       // Skip confirmation prompts
	repoRoot?: string     // Repository root path (optional, auto-detected if not provided)
}

export interface MergeResult {
	success: boolean
	branchName: string
	commitsMerged: number
	rebaseCompleted: boolean
	mergeCompleted: boolean
}

// Update notification types
export interface UpdateCheckCache {
	lastCheck: number  // Unix timestamp
	latestVersion: string
}

export interface UpdateCheckResult {
	currentVersion: string
	latestVersion: string
	updateAvailable: boolean
}

export type InstallationMethod = 'global' | 'local' | 'linked' | 'unknown'

// Telemetry types
export * from './telemetry.js'
