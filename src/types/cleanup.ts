/**
 * Error thrown when cleanup is blocked by a safety check.
 * This allows callers to distinguish between actual errors (network failures, etc.)
 * and intentional blocks due to safety concerns (uncommitted changes, unmerged files, child looms).
 *
 * Use instanceof checks to identify this error type rather than string matching.
 */
export class CleanupSafetyError extends Error {
	/**
	 * The specific safety reason that blocked cleanup.
	 * One of: 'uncommitted', 'unmerged', 'child-loom'
	 */
	public readonly reason: 'uncommitted' | 'unmerged' | 'child-loom'

	constructor(message: string, reason: 'uncommitted' | 'unmerged' | 'child-loom') {
		super(message)
		this.name = 'CleanupSafetyError'
		this.reason = reason
		// Restore prototype chain (required for extending built-in classes in TypeScript)
		Object.setPrototypeOf(this, CleanupSafetyError.prototype)
	}
}

/**
 * Options for ResourceCleanup operations
 */
export interface ResourceCleanupOptions {
	/** Preview operations without executing */
	dryRun?: boolean
	/** Skip confirmations and safety checks */
	force?: boolean
	/** Delete the associated branch */
	deleteBranch?: boolean
	/** Keep database branch instead of deleting */
	keepDatabase?: boolean
	/** Prompt for confirmation before operations */
	interactive?: boolean
	/** Check if branch is merged before allowing cleanup (defaults to true when deleteBranch is true) */
	checkMergeSafety?: boolean
	/** Check if branch exists on remote before allowing cleanup (useful for GitHub-PR mode) */
	checkRemoteBranch?: boolean
}

/**
 * Result of a cleanup operation
 */
export interface CleanupResult {
	/** Identifier that was cleaned up */
	identifier: string
	/** Actual branch name that was found (will differ from identifier) */
	branchName?: string
	/** Overall success status */
	success: boolean
	/** Whether this was a dry-run operation */
	dryRun?: boolean
	/** Individual operation results */
	operations: OperationResult[]
	/** Errors encountered during cleanup */
	errors: Error[]
	/** Whether rollback is required */
	rollbackRequired?: boolean
}

/**
 * Result of an individual cleanup operation
 */
export interface OperationResult {
	/** Type of operation performed */
	type: 'dev-server' | 'worktree' | 'branch' | 'database' | 'cli-symlinks'
	/** Whether operation succeeded */
	success: boolean
	/** Human-readable message */
	message: string
	/** Error message if operation failed */
	error?: string
	/** For database operations: whether branch was actually deleted (vs not found) */
	deleted?: boolean
}

/**
 * Safety check result
 */
export interface SafetyCheck {
	/** Whether cleanup is safe to proceed */
	isSafe: boolean
	/** Non-blocking warnings */
	warnings: string[]
	/** Blocking issues that prevent cleanup */
	blockers: string[]
	/** If not safe, the primary reason for the block (for CleanupSafetyError) */
	safetyReason?: 'uncommitted' | 'unmerged'
}

/**
 * Options for branch deletion
 */
export interface BranchDeleteOptions {
	/** Force delete unmerged branch */
	force?: boolean
	/** Also delete remote branch */
	remote?: boolean
	/** Preview without executing */
	dryRun?: boolean
	/** Path to the worktree being cleaned up (for merge target resolution) - DEPRECATED: use mergeTargetBranch instead */
	worktreePath?: string
	/** Pre-fetched merge target branch (parent branch for child looms, main branch for others).
	 * This must be fetched BEFORE worktree deletion since metadata won't be readable after deletion. */
	mergeTargetBranch?: string
}

/**
 * Target for batch cleanup - represents a branch that may or may not have a worktree
 */
export interface BranchCleanupTarget {
	/** Branch name */
	branchName: string
	/** Whether this branch has an associated worktree */
	hasWorktree: boolean
	/** Path to worktree if it exists */
	worktreePath?: string
}

/**
 * Result of batch cleanup operation for an issue
 */
export interface BatchCleanupResult {
	/** Issue number that was cleaned up */
	issueNumber: string | number
	/** Number of branches found matching the issue */
	targetsFound: number
	/** Number of worktrees successfully removed */
	worktreesRemoved: number
	/** Number of branches successfully deleted */
	branchesDeleted: number
	/** Number of failed operations */
	failed: number
	/** Individual cleanup results for each branch */
	results: CleanupResult[]
}
