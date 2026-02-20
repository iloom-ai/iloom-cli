/**
 * Type definitions for the remote daemon feature
 * Handles automatic PR cleanup when PRs are closed/merged on GitHub
 */

/**
 * Options for the remote command CLI
 */
export interface RemoteOptions {
	/** Polling interval in seconds (only for start action) */
	interval?: number
	/** Number of log lines to show (only for logs action) */
	lines?: number
	/** Follow log output in real-time (only for logs action) */
	follow?: boolean
	/** Output result as JSON */
	json?: boolean
}

/**
 * Daemon process status information
 */
export interface DaemonStatus {
	/** Whether the daemon is currently running */
	running: boolean
	/** Process ID if running */
	pid?: number
	/** Uptime in seconds */
	uptime?: number
	/** Last poll timestamp */
	lastPoll?: Date
	/** Polling interval in seconds */
	interval?: number
	/** Number of looms being monitored */
	monitoredLooms?: number
	/** Last poll result */
	lastPollResult?: PollResult
}

/**
 * Result of a single polling cycle
 */
export interface PollResult {
	/** Number of PRs checked */
	checked: number
	/** Number of looms cleaned up */
	cleaned: number
	/** Number of looms skipped (e.g., uncommitted changes) */
	skipped: number
	/** Error messages from failed operations */
	errors: string[]
	/** Timestamp of the poll */
	timestamp: Date
	/** Whether poll was skipped due to rate limiting backoff */
	rateLimited?: boolean
	/** Seconds until rate limit backoff expires (if rate limited) */
	backoffRemainingSeconds?: number
	/** List of monitored PRs in repo#number format (for logging) */
	monitoredPRs?: string[]
}

/**
 * Rate limit backoff state for GitHub API polling
 */
export interface RateLimitBackoffState {
	/** Whether currently in backoff mode */
	isBackingOff: boolean
	/** Number of consecutive rate limit errors */
	consecutiveFailures: number
	/** Timestamp when backoff expires (null if not backing off) */
	backoffUntil: Date | null
	/** Current backoff duration in seconds */
	currentBackoffSeconds: number
}

/**
 * Information about a PR being monitored
 */
export interface MonitoredPR {
	/** PR number */
	prNumber: number
	/** Repository in owner/repo format */
	repo: string
	/** Project path where the loom exists */
	projectPath: string
	/** Loom identifier */
	loomId: string
}

/**
 * State of a GitHub PR for monitoring purposes
 */
export type PRState = 'open' | 'closed' | 'merged'

/**
 * Result of checking a PR's state
 */
export interface PRStateCheckResult {
	/** PR number */
	prNumber: number
	/** Current state of the PR */
	state: PRState
	/** Repository in owner/repo format */
	repo: string
	/** Error message if check failed */
	error?: string
	/** Whether the error was due to rate limiting */
	rateLimited?: boolean
}

/**
 * Result of triggering finish for a loom (used when PRs are closed/merged)
 *
 * Note: Named FinishTriggerResult because we use FinishCommand (not CleanupCommand)
 * to properly archive metadata, handle sessions, and perform complete loom finishing.
 */
export interface FinishTriggerResult {
	/** Whether finish succeeded */
	success: boolean
	/** PR number that triggered finish */
	prNumber: number
	/** Loom identifier that was finished */
	loomId: string
	/** Project path */
	projectPath: string
	/** Whether finish was skipped (e.g., uncommitted changes, child looms exist) */
	skipped: boolean
	/** Reason for skipping if applicable */
	skipReason?: string
	/** Error message if finish failed */
	error?: string
}

/**
 * @deprecated Use FinishTriggerResult instead. Kept for backwards compatibility.
 */
export type CleanupTriggerResult = FinishTriggerResult

/**
 * Configuration for the daemon process
 * Persisted to disk for daemon to read on startup
 */
export interface DaemonConfig {
	/** Polling interval in seconds */
	interval: number
	/** Timestamp when daemon was started */
	startedAt: Date
}
