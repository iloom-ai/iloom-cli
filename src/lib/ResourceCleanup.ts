import path from 'path'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { DatabaseManager } from './DatabaseManager.js'
import { ProcessManager } from './process/ProcessManager.js'
import { CLIIsolationManager } from './CLIIsolationManager.js'
import { SettingsManager } from './SettingsManager.js'
import { MetadataManager } from './MetadataManager.js'
import { getLogger } from '../utils/logger-context.js'
import { hasUncommittedChanges, executeGitCommand, findMainWorktreePathWithSettings, extractIssueNumber, isBranchMergedIntoMain, checkRemoteBranchStatus, getMergeTargetBranch, findWorktreeForBranch, type RemoteBranchStatus } from '../utils/git.js'
import { calculatePortFromIdentifier } from '../utils/port.js'
import { archiveRecap } from '../utils/recap-archiver.js'

import type {
	ResourceCleanupOptions,
	CleanupResult,
	OperationResult,
	SafetyCheck,
	BranchDeleteOptions,
} from '../types/cleanup.js'
import type { GitWorktree } from '../types/worktree.js'
import type { ParsedInput } from '../commands/start.js'

/**
 * Manages resource cleanup for worktrees
 * Provides shared cleanup functionality for finish and cleanup commands
 */
export class ResourceCleanup {
	private settingsManager: SettingsManager
	private metadataManager: MetadataManager

	constructor(
		private gitWorktree: GitWorktreeManager,
		private processManager: ProcessManager,
		private database?: DatabaseManager,
		private cliIsolation?: CLIIsolationManager,
		settingsManager?: SettingsManager
	) {
		this.settingsManager = settingsManager ?? new SettingsManager()
		this.metadataManager = new MetadataManager()
	}

	/**
	 * Cleanup a worktree and associated resources
	 * Main orchestration method
	 *
	 * @param parsed - ParsedInput from IdentifierParser with type information
	 * @param options - Cleanup options
	 */
	async cleanupWorktree(
		parsed: ParsedInput,
		options: ResourceCleanupOptions = {}
	): Promise<CleanupResult> {
		const operations: OperationResult[] = []
		const errors: Error[] = []

		const displayIdentifier = parsed.branchName ?? parsed.number?.toString() ?? parsed.originalInput
		getLogger().info(`Starting cleanup for: ${displayIdentifier}`)

		// Extract number from ParsedInput for port calculation
		const number = parsed.number

		// Step 1: Terminate dev server if applicable
		if (number !== undefined) {
			// Load settings to get basePort
			const settings = await this.settingsManager.loadSettings()
			const basePort = settings?.capabilities?.web?.basePort ?? 3000
			const port = calculatePortFromIdentifier(number, basePort)

			if (options.dryRun) {
				operations.push({
					type: 'dev-server',
					success: true,
					message: `[DRY RUN] Would check for dev server on port ${port}`,
				})
			} else {
				try {
					const terminated = await this.terminateDevServer(port)
					operations.push({
						type: 'dev-server',
						success: true,
						message: terminated
							? `Dev server on port ${port} terminated`
							: `No dev server running on port ${port}`,
					})
				} catch (error) {
					const err = error instanceof Error ? error : new Error('Unknown error')
					errors.push(err)
					operations.push({
						type: 'dev-server',
						success: false,
						message: `Failed to terminate dev server`,
						error: err.message,
					})
				}
			}
		}

		// Step 2: Find worktree using specific methods based on type
		let worktree: GitWorktree | null = null
		try {
			// Use specific finding methods based on parsed type for precision
			if (parsed.type === 'pr' && parsed.number !== undefined) {
				// For PRs, ensure the number is numeric (PRs are always numeric per GitHub)
				const prNumber = typeof parsed.number === 'number' ? parsed.number : Number(parsed.number)
				if (isNaN(prNumber) || !isFinite(prNumber)) {
					throw new Error(`Invalid PR number: ${parsed.number}. PR numbers must be numeric.`)
				}
				// For PRs, pass empty string for branchName since we're detecting from path pattern
				worktree = await this.gitWorktree.findWorktreeForPR(prNumber, '')
			} else if (parsed.type === 'issue' && parsed.number !== undefined) {
				worktree = await this.gitWorktree.findWorktreeForIssue(parsed.number)
			} else if (parsed.type === 'branch' && parsed.branchName) {
				worktree = await this.gitWorktree.findWorktreeForBranch(parsed.branchName)
			}

			if (!worktree) {
				throw new Error(`No worktree found for identifier: ${displayIdentifier}`)
			}

			getLogger().debug(`Found worktree: path="${worktree.path}", branch="${worktree.branch}"`)
		} catch (error) {
			const err = error instanceof Error ? error : new Error('Unknown error')
			errors.push(err)

			return {
				identifier: displayIdentifier,
				success: false,
				operations,
				errors,
				rollbackRequired: false,
			}
		}

		// Step 2.5: Validate safety before proceeding with cleanup (unless force flag is set)
		// Check merge safety if: deleteBranch is true AND checkMergeSafety is not explicitly false
		// This prevents the scenario where worktree is deleted but branch deletion fails
		if (!options.force) {
			const shouldCheckMergeSafety = options.checkMergeSafety ?? (options.deleteBranch === true)
			const shouldCheckRemoteBranch = options.checkRemoteBranch ?? false
			const safety = await this.validateWorktreeSafety(worktree, parsed.originalInput, shouldCheckMergeSafety, shouldCheckRemoteBranch)

			if (!safety.isSafe) {
				// Format blocker messages for error output
				const blockerMessage = safety.blockers.join('\n\n')
				throw new Error(`Cannot cleanup:\n\n${blockerMessage}`)
			}

			// Log warnings if any
			if (safety.warnings.length > 0) {
				safety.warnings.forEach(warning => {
					getLogger().warn(warning)
				})
			}
		}

		// Step 3: Pre-fetch database configuration before worktree removal
		// This config is used AFTER worktree deletion when env file no longer exists
		let databaseConfig: { shouldCleanup: boolean; envFilePath: string } | null = null
		if (!options.keepDatabase && worktree) {
			const envFilePath = path.join(worktree.path, '.env')
			try {
				// Pre-check if database cleanup should happen by reading .env file now
				const shouldCleanup = this.database
					? await this.database.shouldUseDatabaseBranching(envFilePath)
					: false
				databaseConfig = { shouldCleanup, envFilePath }
			} catch (error) {
				// If we can't read the config, we'll skip database cleanup
			getLogger().warn(
					`Failed to read database config from ${envFilePath}, skipping database cleanup: ${
						error instanceof Error ? error.message : String(error)
					}`
				)
				databaseConfig = { shouldCleanup: false, envFilePath }
			}
		}

		// Step 3.5: Find main worktree path before deletion (needed for branch and database operations)
		let mainWorktreePath: string | null = null
		if (!options.dryRun) {
			try {
				mainWorktreePath = await findMainWorktreePathWithSettings(worktree.path, this.settingsManager)
			} catch (error) {
			getLogger().warn(
					`Failed to find main worktree path: ${error instanceof Error ? error.message : String(error)}`
				)
			}
		}

		// Step 3.6: Pre-fetch merge target branch before worktree deletion
		// This is needed because deleteBranch() needs to know the merge target (parent branch for child looms)
		// but the worktree metadata won't be readable after deletion in Step 4
		let mergeTargetBranch: string | null = null
		if (options.deleteBranch && worktree && !options.dryRun) {
			try {
				mergeTargetBranch = await getMergeTargetBranch(worktree.path, {
					settingsManager: this.settingsManager,
					metadataManager: this.metadataManager,
				})
				getLogger().debug(`Pre-fetched merge target branch: ${mergeTargetBranch}`)
			} catch (error) {
				getLogger().warn(
					`Failed to pre-fetch merge target branch: ${error instanceof Error ? error.message : String(error)}`
				)
			}
		}

		// Step 4: Remove worktree
		if (options.dryRun) {
			operations.push({
				type: 'worktree',
				success: true,
				message: `[DRY RUN] Would remove worktree: ${worktree.path}`,
			})
		} else {
			try {
				const worktreeOptions: { force?: boolean; removeDirectory: true; removeBranch: false } =
					{
						removeDirectory: true,
						removeBranch: false, // Handle branch separately
					}
				if (options.force !== undefined) {
					worktreeOptions.force = options.force
				}
				await this.gitWorktree.removeWorktree(worktree.path, worktreeOptions)

				operations.push({
					type: 'worktree',
					success: true,
					message: `Worktree removed: ${worktree.path}`,
				})
			} catch (error) {
				const err = error instanceof Error ? error : new Error('Unknown error')
				errors.push(err)
				operations.push({
					type: 'worktree',
					success: false,
					message: `Failed to remove worktree`,
					error: err.message,
				})
			}
		}

		// Step 4.5: Archive recap file
		if (worktree) {
			if (options.dryRun) {
				operations.push({
					type: 'recap',
					success: true,
					message: `[DRY RUN] Would archive recap file for: ${worktree.path}`,
				})
			} else {
				try {
					await archiveRecap(worktree.path)
					operations.push({
						type: 'recap',
						success: true,
						message: `Recap file archived`,
					})
				} catch (error) {
					// Non-fatal: log warning but don't add to errors
					const err = error instanceof Error ? error : new Error('Unknown error')
					getLogger().warn(`Recap archival failed: ${err.message}`)
					operations.push({
						type: 'recap',
						success: false,
						message: 'Recap archival failed (non-fatal)',
						error: err.message,
					})
				}
			}
		}

		// Step 5: Delete branch if requested
		if (options.deleteBranch && worktree) {
			if (options.dryRun) {
				operations.push({
					type: 'branch',
					success: true,
					message: `[DRY RUN] Would delete branch: ${worktree.branch}`,
				})
			} else {
				try {
					const branchOptions: BranchDeleteOptions = {
						dryRun: false,
					}
					// Pass pre-fetched merge target (fetched in Step 3.6 before worktree deletion)
					if (mergeTargetBranch !== null) {
						branchOptions.mergeTargetBranch = mergeTargetBranch
					}
					if (options.force !== undefined) {
						branchOptions.force = options.force
					}
					// Pass main worktree path to ensure we can execute git commands
					await this.deleteBranch(worktree.branch, branchOptions, mainWorktreePath ?? undefined)

					operations.push({
						type: 'branch',
						success: true,
						message: `Branch deleted: ${worktree.branch}`,
					})
				} catch (error) {
					const err = error instanceof Error ? error : new Error('Unknown error')
					errors.push(err)
					operations.push({
						type: 'branch',
						success: false,
						message: `Failed to delete branch`,
						error: err.message,
					})
				}
			}
		}

		// Step 5.5: Cleanup CLI symlinks if CLI isolation is available
		// Derive identifier from parsed input (number for issue/PR, branchName for branch)
		const cliIdentifier = parsed.number ?? parsed.branchName
		if (this.cliIsolation && cliIdentifier !== undefined) {
			if (options.dryRun) {
				operations.push({
					type: 'cli-symlinks',
					success: true,
					message: `[DRY RUN] Would cleanup CLI symlinks for: ${cliIdentifier}`,
				})
			} else {
				try {
					const removed = await this.cliIsolation.cleanupVersionedExecutables(cliIdentifier)
					operations.push({
						type: 'cli-symlinks',
						success: true,
						message: removed.length > 0
							? `CLI symlinks removed: ${removed.length}`
							: 'No CLI symlinks to cleanup',
					})
				} catch (error) {
					// Log warning but don't fail
					const err = error instanceof Error ? error : new Error('Unknown error')
					errors.push(err)
				getLogger().warn(
						`CLI symlink cleanup failed: ${err.message}`
					)
					operations.push({
						type: 'cli-symlinks',
						success: false,
						message: 'CLI symlink cleanup failed (non-fatal)',
					})
				}
			}
		}

		// Step 6: Cleanup database after worktree and branch removal (using pre-read config)
		if (databaseConfig && worktree) {
			if (options.dryRun) {
				operations.push({
					type: 'database',
					success: true,
					message: `[DRY RUN] Would cleanup database branch for: ${worktree.branch}`,
				})
			} else {
				try {
					if (databaseConfig.shouldCleanup && this.database) {
						try {
							// Call database deletion with pre-fetched shouldCleanup value and main worktree path
							// This avoids reading the already-deleted env file and running commands from deleted directories
							const deletionResult = await this.database.deleteBranchIfConfigured(
								worktree.branch,
								databaseConfig.shouldCleanup,
								false, // isPreview
								mainWorktreePath ?? undefined
							)

							// Create operation result based on what actually happened
							if (deletionResult.deleted) {
								// Branch was actually deleted
							getLogger().info(`Database branch deleted: ${worktree.branch}`)
								operations.push({
									type: 'database',
									success: true,
									message: `Database branch deleted`,
									deleted: true,
								})
							} else if (deletionResult.notFound) {
								// Branch didn't exist - not an error, just nothing to delete
							getLogger().debug(`No database branch found for: ${worktree.branch}`)
								operations.push({
									type: 'database',
									success: true,
									message: `No database branch found (skipped)`,
									deleted: false,
								})
							} else if (deletionResult.userDeclined) {
								// User declined preview database deletion
							getLogger().info('Preview database deletion declined by user')
								operations.push({
									type: 'database',
									success: true,
									message: `Database cleanup skipped (user declined)`,
									deleted: false,
								})
							} else if (!deletionResult.success) {
								// Deletion failed with error
								const errorMsg = deletionResult.error ?? 'Unknown error'
								errors.push(new Error(errorMsg))
							getLogger().warn(`Database cleanup failed: ${errorMsg}`)
								operations.push({
									type: 'database',
									success: false, // Non-fatal, but report error
									message: `Database cleanup failed`,
									error: errorMsg,
									deleted: false,
								})
							} else {
								// Unexpected state - log for debugging
								errors.push(new Error('Database cleanup in an unknown state'))
							getLogger().warn('Database deletion returned unexpected result state')
								operations.push({
									type: 'database',
									success: false,
									message: `Database cleanup in an unknown state`,
									deleted: false,
								})
							}
						} catch (error) {
							// Unexpected exception (shouldn't happen with result object pattern)
							errors.push(error instanceof Error ? error : new Error(String(error)))
						getLogger().warn(
								`Unexpected database cleanup exception: ${error instanceof Error ? error.message : String(error)}`
							)
							operations.push({
								type: 'database',
								success: false,
								message: `Database cleanup failed`,
								error: error instanceof Error ? error.message : String(error),
								deleted: false,
							})
						}
					} else {
						// Database manager not available or not configured
						operations.push({
							type: 'database',
							success: true,
							message: `Database cleanup skipped (not available)`,
							deleted: false,
						})
					}
				} catch (error) {
					// This catch block is for any unexpected errors in the outer logic
					const err = error instanceof Error ? error : new Error('Unknown error')
					errors.push(err)
					operations.push({
						type: 'database',
						success: false,
						message: `Database cleanup failed`,
						error: err.message,
						deleted: false,
					})
				}
			}
		}

		// Step 7: Delete metadata file
		if (worktree) {
			if (options.dryRun) {
				operations.push({
					type: 'metadata',
					success: true,
					message: `[DRY RUN] Would delete metadata for worktree: ${worktree.path}`,
				})
			} else {
				try {
					await this.metadataManager.deleteMetadata(worktree.path)
					getLogger().info(`Metadata deleted for worktree: ${worktree.path}`)
					operations.push({
						type: 'metadata',
						success: true,
						message: 'Metadata deleted',
					})
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error))
					errors.push(err)
					getLogger().warn(`Metadata deletion failed: ${err.message}`)
					operations.push({
						type: 'metadata',
						success: false,
						message: 'Metadata deletion failed (non-fatal)',
						error: err.message,
					})
				}
			}
		}

		// Calculate overall success
		const success = errors.length === 0

		return {
			identifier: displayIdentifier,
			branchName: worktree?.branch,
			success,
			operations,
			errors,
			rollbackRequired: false, // Cleanup operations are generally not reversible
		}
	}

	/**
	 * Terminate dev server on specified port
	 */
	async terminateDevServer(port: number): Promise<boolean> {
	getLogger().debug(`Checking for dev server on port ${port}`)

		const processInfo = await this.processManager.detectDevServer(port)

		if (!processInfo) {
		getLogger().debug(`No process found on port ${port}`)
			return false
		}

		if (!processInfo.isDevServer) {
		getLogger().warn(
				`Process on port ${port} (${processInfo.name}) doesn't appear to be a dev server, skipping`
			)
			return false
		}

	getLogger().info(`Terminating dev server: ${processInfo.name} (PID: ${processInfo.pid})`)

		await this.processManager.terminateProcess(processInfo.pid)

		// Verify termination
		const isFree = await this.processManager.verifyPortFree(port)
		if (!isFree) {
			throw new Error(`Dev server may still be running on port ${port}`)
		}

		return true
	}

	/**
	 * Delete a Git branch with safety checks
	 *
	 * @param branchName - Name of the branch to delete
	 * @param options - Delete options (force, dryRun)
	 * @param cwd - Working directory to execute git command from (defaults to finding main worktree)
	 */
	async deleteBranch(
		branchName: string,
		options: BranchDeleteOptions = {},
		cwd?: string
	): Promise<boolean> {
		// Get protected branches list from centralized method
		const protectedBranches = await this.settingsManager.getProtectedBranches(cwd)

		// Check for protected branches
		if (protectedBranches.includes(branchName)) {
			throw new Error(`Cannot delete protected branch: ${branchName}`)
		}

		// Use provided cwd, or find main worktree path as fallback
		// This ensures we're not running git commands from a deleted directory
		const workingDir = cwd ?? await findMainWorktreePathWithSettings(undefined, this.settingsManager)

		// Check if branch exists before attempting deletion (idempotent behavior)
		try {
			await executeGitCommand(['rev-parse', '--verify', `refs/heads/${branchName}`], {
				cwd: workingDir
			})
		} catch {
			// Branch doesn't exist - already deleted, return success
		getLogger().debug(`Branch ${branchName} does not exist, skipping deletion`)
			return true
		}

		if (options.dryRun) {
		getLogger().info(`[DRY RUN] Would delete branch: ${branchName}`)
			return true
		}

		// Execute git branch deletion
		try {
			// Determine the correct delete flag and working directory
			let deleteFlag = '-d'  // Default: safe delete
			let deleteCwd = workingDir  // Default: main worktree

			if (options.force) {
				// User explicitly requested force delete
				deleteFlag = '-D'
			} else if (options.mergeTargetBranch) {
				// Use pre-fetched merge target (from Step 3.6, fetched before worktree deletion)
				// For child looms, git branch -d checks against HEAD, which may not be the correct target
				// Instead of using -D (force), we run git branch -d from the worktree where the
				// parent branch is checked out. This lets git do its own safety verification.
				const mergeTarget = options.mergeTargetBranch

				// Find the worktree where the merge target (parent branch) is checked out
				try {
					const targetWorktreePath = await findWorktreeForBranch(mergeTarget, workingDir)
					// Run git branch -d from that worktree - HEAD will be the correct branch
					// and git will correctly verify the merge itself
					getLogger().debug(`Running branch delete from worktree where '${mergeTarget}' is checked out: ${targetWorktreePath}`)
					deleteCwd = targetWorktreePath
				} catch {
					// If we can't find the worktree for the target branch, fall back to checking merge status
					// and using -D if merged (the previous behavior)
					getLogger().debug(`Could not find worktree for branch '${mergeTarget}', falling back to merge check`)
					const isMerged = await isBranchMergedIntoMain(branchName, mergeTarget, workingDir)

					if (isMerged) {
						getLogger().debug(`Branch '${branchName}' verified merged into '${mergeTarget}', using force delete`)
						deleteFlag = '-D'
					}
				}
			} else if (options.worktreePath) {
				// DEPRECATED: Fall back to reading from worktree path if mergeTargetBranch not provided
				// This path should not be used when called from cleanupWorktree() since the worktree
				// has already been deleted by the time deleteBranch() is called
				getLogger().warn('deleteBranch called with worktreePath but no mergeTargetBranch - this may fail if worktree was deleted')
				try {
					const mergeTarget = await getMergeTargetBranch(options.worktreePath, {
						settingsManager: this.settingsManager,
						metadataManager: this.metadataManager,
					})

					// Find the worktree where the merge target (parent branch) is checked out
					try {
						const targetWorktreePath = await findWorktreeForBranch(mergeTarget, workingDir)
						getLogger().debug(`Running branch delete from worktree where '${mergeTarget}' is checked out: ${targetWorktreePath}`)
						deleteCwd = targetWorktreePath
					} catch {
						getLogger().debug(`Could not find worktree for branch '${mergeTarget}', falling back to merge check`)
						const isMerged = await isBranchMergedIntoMain(branchName, mergeTarget, workingDir)

						if (isMerged) {
							getLogger().debug(`Branch '${branchName}' verified merged into '${mergeTarget}', using force delete`)
							deleteFlag = '-D'
						}
					}
				} catch (error) {
					// If we can't read the merge target (e.g., worktree deleted), just use safe delete
					getLogger().debug(`Could not read merge target from worktreePath: ${error instanceof Error ? error.message : String(error)}`)
				}
			}

			await executeGitCommand(['branch', deleteFlag, branchName], {
				cwd: deleteCwd
			})

		getLogger().info(`Branch deleted: ${branchName}`)
			return true
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)

			// Handle "branch not found" - may occur in race conditions
			if (errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
			getLogger().debug(`Branch ${branchName} already deleted`)
				return true
			}

			if (options.force) {
				throw error
			}

			// Git error for unmerged branch typically contains "not fully merged"
			if (errorMessage.includes('not fully merged')) {
				throw new Error(
					`Cannot delete unmerged branch '${branchName}'. Use --force to delete anyway.`
				)
			}

			// For other errors, show the actual git error
			throw error
		}
	}

	/**
	 * Cleanup database branch
	 * Gracefully handles missing DatabaseManager
	 *
	 * @deprecated This method is deprecated and should not be used for post-deletion cleanup.
	 * Use the pre-fetch mechanism in cleanupWorktree() instead.
	 * This method will fail if called after worktree deletion because
	 * it attempts to read the .env file which has been deleted.
	 *
	 * @param branchName - Name of the branch to delete
	 * @param worktreePath - Path to worktree (must still exist with .env file)
	 */
	async cleanupDatabase(branchName: string, worktreePath: string): Promise<boolean> {
		if (!this.database) {
		getLogger().debug('Database manager not available, skipping database cleanup')
			return false
		}

		try {
			// Pre-fetch configuration before deletion
			const envFilePath = path.join(worktreePath, '.env')
			const shouldCleanup = await this.database.shouldUseDatabaseBranching(envFilePath)

			// Find main worktree path to avoid running commands from potentially deleted directories
			let cwd: string | undefined
			try {
				cwd = await findMainWorktreePathWithSettings(worktreePath, this.settingsManager)
			} catch (error) {
				// If we can't find main worktree, commands will run from current directory
			getLogger().debug(
					`Could not find main worktree path, using current directory: ${error instanceof Error ? error.message : String(error)}`
				)
			}

			const result = await this.database.deleteBranchIfConfigured(
				branchName,
				shouldCleanup,
				false, // isPreview
				cwd
			)

			// Only return true if deletion actually occurred
			if (result.deleted) {
			getLogger().info(`Database branch deleted: ${branchName}`)
				return true
			} else if (result.notFound) {
			getLogger().debug(`No database branch found for: ${branchName}`)
				return false
			} else if (result.userDeclined) {
			getLogger().info('Preview database deletion declined by user')
				return false
			} else if (!result.success) {
			getLogger().warn(`Database cleanup failed: ${result.error ?? 'Unknown error'}`)
				return false
			} else {
				// Unexpected state
			getLogger().debug('Database deletion returned unexpected result')
				return false
			}
		} catch (error) {
			// Unexpected exception
		getLogger().warn(
				`Unexpected database cleanup error: ${error instanceof Error ? error.message : String(error)}`
			)
			return false
		}
	}

	/**
	 * Cleanup multiple worktrees
	 */
	async cleanupMultipleWorktrees(
		identifiers: string[],
		options: ResourceCleanupOptions = {}
	): Promise<CleanupResult[]> {
		const results: CleanupResult[] = []

		for (const identifier of identifiers) {
			// Parse the identifier to get ParsedInput format
			const parsed = this.parseIdentifier(identifier)
			const result = await this.cleanupWorktree(parsed, options)
			results.push(result)
		}

		return results
	}

	/**
	 * Validate worktree safety given a worktree object
	 * Private method used internally when worktree is already known
	 *
	 * @param worktree - The worktree to validate
	 * @param identifier - The original identifier used (for error messages)
	 * @param checkBranchMerge - Whether to check if branch is merged into main (for branch deletion)
	 * @param checkRemoteBranch - Whether to check if branch exists on remote (for GitHub-PR mode)
	 */
	private async validateWorktreeSafety(
		worktree: GitWorktree,
		identifier: string,
		checkBranchMerge: boolean = false,
		checkRemoteBranch: boolean = false
	): Promise<SafetyCheck> {
		const warnings: string[] = []
		const blockers: string[] = []

		// Check if main worktree
		const isMain = await this.gitWorktree.isMainWorktree(worktree, this.settingsManager)
		if (isMain) {
			blockers.push(`Cannot cleanup main worktree: "${worktree.branch}" @ "${worktree.path}"`)
		}

		// Check for uncommitted changes
		const hasChanges = await hasUncommittedChanges(worktree.path)
		if (hasChanges) {
			// Create simple blocker message with actionable guidance
			const blockerMessage =
				`Worktree has uncommitted changes.\n\n` +
				`Please resolve before cleanup - you have some options:\n` +
				`  • Commit changes: cd ${worktree.path} && git commit -am "message"\n` +
				`  • Stash changes: cd ${worktree.path} && git stash\n` +
				`  • Force cleanup: il cleanup ${identifier} --force (WARNING: will discard changes)`

			blockers.push(blockerMessage)
		}

		// 5-point safety check for branch deletion
		// The key insight: we care about DATA LOSS, not about remote state
		// - Remote ahead of local is SAFE (commits exist on remote, no data loss)
		// - Local ahead of remote is DANGEROUS (unpushed commits would be lost)
		//
		// 1. Network error -> BLOCK (can't verify safety)
		// 2. Remote ahead of local -> OK (no data loss - commits exist on remote)
		// 3. Local ahead of remote (unpushed commits) -> BLOCK (data loss risk)
		// 4. No remote, merged to main -> OK (work is in main)
		// 5. No remote, NOT merged to main -> BLOCK (unmerged work would be lost)
		if ((checkBranchMerge || checkRemoteBranch) && worktree.branch) {
			// Use shared utility to get merge target (parent branch for child looms, main for others)
			const mainBranch = await getMergeTargetBranch(worktree.path, {
				settingsManager: this.settingsManager,
				metadataManager: this.metadataManager,
			})

			// Check remote branch status
			const remoteStatus: RemoteBranchStatus = await checkRemoteBranchStatus(worktree.branch, worktree.path)

			// Scenario 1: Network error checking remote -> Block
			if (remoteStatus.networkError) {
				const blockerMessage =
					`Cannot verify remote branch status due to network error.\n\n` +
					`Error: ${remoteStatus.errorMessage ?? 'Unknown network error'}\n\n` +
					`Unable to determine if branch '${worktree.branch}' is safely backed up.\n` +
					`Use --force to proceed without verification.`

				blockers.push(blockerMessage)
			}
			// Scenario 3: Local ahead of remote (unpushed commits) -> Block (data loss risk)
			else if (remoteStatus.exists && remoteStatus.localAhead) {
				const blockerMessage =
					`Branch '${worktree.branch}' has unpushed commits that would be lost.\n` +
					`The remote branch exists but your local branch is ahead.\n\n` +
					`Please resolve before cleanup:\n` +
					`  • Push your commits: git push origin ${worktree.branch}\n` +
					`  • Force cleanup: il cleanup ${identifier} --force (WARNING: will lose commits)`

				blockers.push(blockerMessage)
			}
			// Scenario 2: Remote ahead of local OR same commits -> Safe (work is on remote)
			else if (remoteStatus.exists && !remoteStatus.localAhead) {
				// Work is safely on remote (either remote is ahead or same commits)
				// No blocker needed
			}
			// Remote doesn't exist - need to check merge status
			else if (!remoteStatus.exists) {
				const isMerged = await isBranchMergedIntoMain(worktree.branch, mainBranch, worktree.path)

				if (isMerged) {
					// Scenario 4: Remote doesn't exist, but merged to main -> Safe
					// No blocker needed
				} else {
					// Scenario 5: Remote doesn't exist AND not merged to main -> Block
					const blockerMessage =
						`Branch '${worktree.branch}' has not been pushed to remote and is not merged into '${mainBranch}'.\n` +
						`Deleting this branch would result in data loss.\n\n` +
						`Please resolve before cleanup - you have some options:\n` +
						`  • Push to remote: git push -u origin ${worktree.branch}\n` +
						`  • Merge to ${mainBranch}: git checkout ${mainBranch} && git merge ${worktree.branch}\n` +
						`  • Force cleanup: il cleanup ${identifier} --force (WARNING: will lose commits)`

					blockers.push(blockerMessage)
				}
			}
		}

		return {
			isSafe: blockers.length === 0,
			warnings,
			blockers,
		}
	}

	/**
	 * Validate cleanup safety
	 */
	async validateCleanupSafety(identifier: string): Promise<SafetyCheck> {
		const warnings: string[] = []
		const blockers: string[] = []

		// Find worktree
		const worktrees = await this.gitWorktree.findWorktreesByIdentifier(identifier)

		if (worktrees.length === 0) {
			blockers.push(`No worktree found for: ${identifier}`)
			return { isSafe: false, warnings, blockers }
		}

		const worktree = worktrees[0]
		if (!worktree) {
			blockers.push(`No worktree found for: ${identifier}`)
			return { isSafe: false, warnings, blockers }
		}

		// Delegate to private method that validates the worktree
		return await this.validateWorktreeSafety(worktree, identifier)
	}

	/**
	 * Parse identifier to determine type and extract number
	 * Helper method for port calculation
	 */
	private parseIdentifier(identifier: string): ParsedInput {
		// Check for issue pattern
		const issueId = extractIssueNumber(identifier)
		if (issueId !== null) {
			return {
				type: 'issue',
				number: issueId,
				originalInput: identifier
			}
		}

		// Check for PR pattern
		const prMatch = identifier.match(/(?:pr|PR)[/-](\d+)/)
		if (prMatch?.[1]) {
			return {
				type: 'pr',
				number: parseInt(prMatch[1], 10),
				originalInput: identifier
			}
		}

		// Check for numeric identifier
		const numericMatch = identifier.match(/^#?(\d+)$/)
		if (numericMatch?.[1]) {
			// Assume issue for numeric identifiers
			return {
				type: 'issue',
				number: parseInt(numericMatch[1], 10),
				originalInput: identifier
			}
		}

		// Treat as branch name
		return {
			type: 'branch',
			branchName: identifier,
			originalInput: identifier
		}
	}
}
