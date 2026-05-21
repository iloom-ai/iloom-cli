import { executeGitCommand, fetchOrigin, findMainWorktreePathWithSettings, findWorktreeForBranch, getMergeTargetBranch, GitCommandError } from '../utils/git.js'
import { getLogger } from '../utils/logger-context.js'
import { detectClaudeCli, launchClaude } from '../utils/claude.js'
import { SettingsManager } from './SettingsManager.js'
import { MetadataManager } from './MetadataManager.js'
import { TelemetryService } from './TelemetryService.js'
import type { MergeOptions, RebaseOutcome } from '../types/index.js'

/**
 * MergeManager handles Git rebase and fast-forward merge operations
 * Implements fail-fast behavior for conflicts (Phase 1 - no Claude assistance)
 *
 * Ports bash/merge-and-clean.sh lines 781-1090
 */
export class MergeManager {
	private settingsManager: SettingsManager
	private metadataManager: MetadataManager

	constructor(settingsManager?: SettingsManager, metadataManager?: MetadataManager) {
		this.settingsManager = settingsManager ?? new SettingsManager()
		this.metadataManager = metadataManager ?? new MetadataManager()
	}

	/**
	 * Get the merge target branch for a loom
	 * Priority: parent loom metadata > configured main branch > 'main'
	 * @param worktreePath - Optional path to load settings/metadata from (defaults to process.cwd())
	 * @private
	 */
	private async getMainBranch(worktreePath?: string): Promise<string> {
		// Delegate to shared utility function
		return getMergeTargetBranch(worktreePath ?? process.cwd(), {
			settingsManager: this.settingsManager,
			metadataManager: this.metadataManager,
		})
	}

	/**
	 * Rebase current branch on main with fail-fast on conflicts
	 * Ports bash/merge-and-clean.sh lines 781-913
	 *
	 * @param worktreePath - Path to the worktree
	 * @param options - Merge options (dryRun, force)
	 * @throws Error if main branch doesn't exist, uncommitted changes exist, or conflicts occur
	 */
	async rebaseOnMain(worktreePath: string, options: MergeOptions = {}): Promise<RebaseOutcome> {
		const { dryRun = false, force = false, jsonStream = false } = options

		// Pre-check: abort any in-progress rebase before starting a new one
		await this.abortInProgressRebase(worktreePath)

		const mainBranch = await this.getMainBranch(worktreePath)

		// Determine whether to use remote (origin/) or local branch reference
		// - Child looms: always use local parent branch (parent may not be pushed)
		// - PR modes (pr, draft-pr) for non-child: fetch and use origin/{branch}
		// - Local mode: use local branch (no fetch)
		const metadata = await this.metadataManager.readMetadata(worktreePath)
		const isChildLoom = !!metadata?.parentLoom
		const settings = await this.settingsManager.loadSettings(worktreePath)
		const mergeBehaviorMode = settings.mergeBehavior?.mode ?? 'local'
		const isPRMode = mergeBehaviorMode === 'pr' || mergeBehaviorMode === 'draft-pr'
		const useRemote = isPRMode && !isChildLoom

		let targetBranch: string
		if (useRemote) {
			// PR modes (non-child): fetch and use origin/{branch}
			getLogger().info('Fetching from origin...')
			await fetchOrigin(worktreePath)
			targetBranch = `origin/${mainBranch}`
		} else {
			// Local mode or child loom: use local branch
			getLogger().info(`Using local branch ${mainBranch} for rebase...`)
			targetBranch = mainBranch
		}

		getLogger().info(`Starting synchronization with ${targetBranch}...`)

		// Step 1: Check if branch exists (remote ref for origin/, local ref otherwise)
		const refPath = useRemote ? `refs/remotes/${targetBranch}` : `refs/heads/${targetBranch}`
		try {
			await executeGitCommand(['show-ref', '--verify', '--quiet', refPath], {
				cwd: worktreePath,
			})
		} catch {
			if (useRemote) {
				throw new Error(
					`Remote branch "${targetBranch}" does not exist. Cannot rebase.\n` +
						`Ensure the repository has a "${mainBranch}" branch on origin.`
				)
			} else {
				throw new Error(
					`Local branch "${targetBranch}" does not exist. Cannot rebase.\n` +
						`Ensure the branch exists locally.`
				)
			}
		}

		// Step 2: Check for uncommitted changes and create WIP commit if needed
		const statusOutput = await executeGitCommand(['status', '--porcelain'], {
			cwd: worktreePath,
		})

		let wipCommitHash: string | null = null
		if (statusOutput.trim()) {
			getLogger().info('Uncommitted changes detected, creating temporary WIP commit...')
			wipCommitHash = await this.createWipCommit(worktreePath)
			getLogger().debug(`Created WIP commit: ${wipCommitHash}`)
		}

		// Step 3: Compute merge-base and target HEAD
		const mergeBase = await executeGitCommand(['merge-base', targetBranch, 'HEAD'], {
			cwd: worktreePath,
		})

		const targetHead = await executeGitCommand(['rev-parse', targetBranch], {
			cwd: worktreePath,
		})

		const mergeBaseTrimmed = mergeBase.trim()
		const targetHeadTrimmed = targetHead.trim()

		// Step 4: Compute commits ahead of target (needed for strategy detection)
		const commitsOutput = await executeGitCommand(['log', '--oneline', `${targetBranch}..HEAD`], {
			cwd: worktreePath,
		})

		const commits = commitsOutput.trim()
		const commitLines = commits ? commits.split('\n') : []

		// Step 5: Detect merge commits from parent branch
		const hasMergesFromParent = await this.hasMergesFromParent(worktreePath, targetBranch)

		// Step 6: Determine strategy (merge-commit detection + commit count threshold)
		const maxCommits = settings.rebase?.maxCommitsForRebase ?? 20
		const commitCountExceedsThreshold =
			maxCommits === 0 || (maxCommits > 0 && commitLines.length >= maxCommits)

		let strategy: 'rebase' | 'merge' = 'rebase'
		let strategyReason = ''

		if (hasMergesFromParent) {
			strategy = 'merge'
			strategyReason = `Found merge commits from ${targetBranch} on this branch`
		} else if (commitCountExceedsThreshold) {
			strategy = 'merge'
			strategyReason =
				maxCommits === 0
					? 'rebase.maxCommitsForRebase is set to 0 (always merge)'
					: `Branch has ${commitLines.length} commits ahead of ${targetBranch} (threshold: ${maxCommits})`
		}

		if (strategy === 'merge') {
			getLogger().info(`${strategyReason} — using merge instead of rebase`)
		}

		// Track strategy selection telemetry
		try {
			const telemetryReason: 'merge_commits' | 'commit_threshold' | 'always_merge' | 'default' =
				hasMergesFromParent ? 'merge_commits'
					: commitCountExceedsThreshold && maxCommits === 0 ? 'always_merge'
						: commitCountExceedsThreshold ? 'commit_threshold'
							: 'default'
			TelemetryService.getInstance().track('rebase.strategy_selected', {
				strategy,
				reason: telemetryReason,
			})
		} catch (error: unknown) {
			getLogger().debug(`Failed to track rebase.strategy_selected telemetry: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Step 6b: Check if already up to date (strategy-aware)
		if (mergeBaseTrimmed === targetHeadTrimmed) {
			if (strategy === 'merge') {
				getLogger().success(`Already synchronized with ${targetBranch}. No new changes to merge.`)
			} else {
				getLogger().success(`Branch is already up to date with ${targetBranch}. No rebase needed.`)
			}
			// Restore WIP commit if created (soft reset to remove temporary commit)
			if (wipCommitHash) {
				await this.restoreWipCommit(worktreePath, wipCommitHash)
			}
			return { conflictsDetected: false, claudeLaunched: false, conflictsResolved: false, strategy, targetBranch }
		}

		// Step 6c: Show commits to be synchronized (for informational purposes)
		if (commits) {
			getLogger().info(`Found ${commitLines.length} commit(s) to ${strategy === 'merge' ? 'merge' : 'rebase'}:`)
			commitLines.forEach((commit) => getLogger().info(`  ${commit}`))
		} else {
			// Target has moved forward but branch has no new commits
			getLogger().info(`${targetBranch} has moved forward. ${strategy === 'merge' ? 'Merging' : 'Rebasing'} to update branch...`)
		}

		// Step 7: User confirmation (unless force mode or dry-run)
		if (!force && !dryRun) {
			// TODO: Implement interactive prompt for confirmation
			// For now, proceeding automatically (use --force to skip this message)
			getLogger().info(`Proceeding with ${strategy}... (use --force to skip confirmations)`)
		}

		// Step 8: Execute rebase or merge (unless dry-run)
		if (dryRun) {
			if (strategy === 'merge') {
				getLogger().info(`[DRY RUN] Would execute: git merge ${targetBranch}`)
			} else {
				getLogger().info(`[DRY RUN] Would execute: git rebase ${targetBranch}`)
			}
			if (commitLines.length > 0) {
				getLogger().info(`[DRY RUN] This would ${strategy} ${commitLines.length} commit(s)`)
			}
			return { conflictsDetected: false, claudeLaunched: false, conflictsResolved: false, strategy, targetBranch }
		}

		if (strategy === 'merge') {
			// Execute merge from parent branch
			try {
				await executeGitCommand(['merge', targetBranch], { cwd: worktreePath })
				getLogger().success('Merge from parent branch completed successfully!')

				if (wipCommitHash) {
					await this.restoreWipCommit(worktreePath, wipCommitHash)
				}
				return { conflictsDetected: false, claudeLaunched: false, conflictsResolved: false, strategy: 'merge', targetBranch }
			} catch (error) {
				const conflictedFiles = await this.detectConflictedFiles(worktreePath)

				if (conflictedFiles.length > 0) {
					getLogger().info('Merge conflicts detected, attempting Claude-assisted resolution...')

					const resolved = await this.attemptClaudeConflictResolution(
						worktreePath,
						conflictedFiles,
						{ jsonStream, conflictType: 'merge' }
					)

					if (resolved) {
						getLogger().success('Conflicts resolved with Claude assistance, merge completed')

						if (wipCommitHash) {
							await this.restoreWipCommit(worktreePath, wipCommitHash)
						}
						return { conflictsDetected: true, claudeLaunched: true, conflictsResolved: true, strategy: 'merge', targetBranch }
					}

					// Claude couldn't resolve - abort merge and fail
					try {
						await executeGitCommand(['merge', '--abort'], { cwd: worktreePath })
					} catch (abortError) {
						getLogger().warn(`Failed to abort merge: ${abortError instanceof Error ? abortError.message : String(abortError)}`)
					}
					const conflictError = this.formatConflictError(conflictedFiles)
					throw new Error(conflictError)
				}

				throw new Error(
					`Merge failed: ${error instanceof Error ? error.message : String(error)}\n` +
						'Run: git status for more details\n' +
						'Or: git merge --abort to cancel the merge'
				)
			}
		}

		// Execute rebase
		// Use -c core.hooksPath=/dev/null to disable hooks during rebase
		// This prevents pre-commit hooks from running when commits are re-applied
		try {
			await executeGitCommand(['-c', 'core.hooksPath=/dev/null', 'rebase', targetBranch], { cwd: worktreePath })
			getLogger().success('Rebase completed successfully!')

			// Restore WIP commit if created
			if (wipCommitHash) {
				await this.restoreWipCommit(worktreePath, wipCommitHash)
			}
			return { conflictsDetected: false, claudeLaunched: false, conflictsResolved: false, strategy: 'rebase', targetBranch }
		} catch (error) {
			// Detect conflicts
			const conflictedFiles = await this.detectConflictedFiles(worktreePath)

			if (conflictedFiles.length > 0) {
				// Try Claude-assisted resolution first
				getLogger().info('Merge conflicts detected, attempting Claude-assisted resolution...')

				const resolved = await this.attemptClaudeConflictResolution(
					worktreePath,
					conflictedFiles,
					{ jsonStream }
				)

				if (resolved) {
					getLogger().success('Conflicts resolved with Claude assistance, rebase completed')

					// Restore WIP commit if created
					if (wipCommitHash) {
						await this.restoreWipCommit(worktreePath, wipCommitHash)
					}
					return { conflictsDetected: true, claudeLaunched: true, conflictsResolved: true, strategy: 'rebase', targetBranch }
				}

				// Claude couldn't resolve or not available - fail fast
				const conflictError = this.formatConflictError(conflictedFiles)
				throw new Error(conflictError)
			}

			// If not a conflict, re-throw the original error
			throw new Error(
				`Rebase failed: ${error instanceof Error ? error.message : String(error)}\n` +
					'Run: git status for more details\n' +
					'Or: git rebase --abort to cancel the rebase'
			)
		}
	}

	/**
	 * Validate that fast-forward merge is possible
	 * Ports bash/merge-and-clean.sh lines 957-968
	 *
	 * @param branchName - Name of the branch to merge
	 * @param mainWorktreePath - Path where main branch is checked out
	 * @throws Error if fast-forward is not possible
	 */
	async validateFastForwardPossible(mainBranch: string, branchName: string, mainWorktreePath: string): Promise<void> {

		// Step 1: Get merge-base between main and branch
		const mergeBase = await executeGitCommand(['merge-base', mainBranch, branchName], {
			cwd: mainWorktreePath,
		})

		// Step 2: Get current HEAD of main
		const mainHead = await executeGitCommand(['rev-parse', mainBranch], {
			cwd: mainWorktreePath,
		})

		// Step 3: Compare - they must match for fast-forward
		const mergeBaseTrimmed = mergeBase.trim()
		const mainHeadTrimmed = mainHead.trim()

		if (mergeBaseTrimmed !== mainHeadTrimmed) {
			throw new Error(
				'Cannot perform fast-forward merge.\n' +
					`The ${mainBranch} branch has moved forward since this branch was created.\n` +
					`Merge base: ${mergeBaseTrimmed}\n` +
					`Main HEAD:  ${mainHeadTrimmed}\n\n` +
					'To fix this:\n' +
					`  1. Rebase the branch on ${mainBranch}: git rebase ${mainBranch}\n` +
					`  2. Or use: il finish to automatically rebase and merge\n`
			)
		}
	}

	/**
	 * Perform fast-forward only merge
	 * Ports bash/merge-and-clean.sh lines 938-994
	 *
	 * @param branchName - Name of the branch to merge
	 * @param worktreePath - Path to the worktree
	 * @param options - Merge options (dryRun, force)
	 * @throws Error if checkout, validation, or merge fails
	 */
	async performFastForwardMerge(
		branchName: string,
		worktreePath: string,
		options: MergeOptions = {}
	): Promise<void> {
		const { dryRun = false, force = false, noFf = false } = options

		getLogger().info(noFf ? 'Starting no-fast-forward merge...' : 'Starting fast-forward merge...')

		// Step 1: Get the merge target branch FIRST
		// For child looms, this will be the parent branch from metadata
		// For regular looms, this falls back to settings.mainBranch or 'main'
		const mainBranch = await this.getMainBranch(worktreePath)

		// Step 2: Find where the merge target branch is checked out
		// CRITICAL: We must find the worktree for the MERGE TARGET, not settings.mainBranch
		// This fixes the child loom bug where we'd find the 'main' worktree instead of the parent branch worktree
		let mainWorktreePath: string
		if (options.repoRoot) {
			mainWorktreePath = options.repoRoot
		} else {
			try {
				// First try to find worktree with the exact merge target branch checked out
				mainWorktreePath = await findWorktreeForBranch(mainBranch, worktreePath)
			} catch {
				// Fallback: if no worktree has the branch checked out, use settings-based lookup
				// This handles edge cases like bare repos or detached HEAD states
				getLogger().debug(`No worktree found for branch '${mainBranch}', falling back to settings-based lookup`)
				mainWorktreePath = await findMainWorktreePathWithSettings(worktreePath, this.settingsManager)
			}
		}

		// Step 3: No need to checkout - the merge target branch is already checked out in mainWorktreePath
		getLogger().debug(`Using ${mainBranch} branch location: ${mainWorktreePath}`)

		// Step 4: Verify we're on the correct branch
		const currentBranch = await executeGitCommand(['branch', '--show-current'], {
			cwd: mainWorktreePath,
		})

		if (currentBranch.trim() !== mainBranch) {
			throw new Error(
				`Expected ${mainBranch} branch but found: ${currentBranch.trim()}\n` +
					`At location: ${mainWorktreePath}\n` +
					'This indicates the main worktree detection failed.'
			)
		}

		// Step 5: Validate fast-forward is possible (skip when using --no-ff)
		if (!noFf) {
			await this.validateFastForwardPossible(mainBranch, branchName, mainWorktreePath)
		}

		// Step 6: Show commits to be merged
		const commitsOutput = await executeGitCommand(['log', '--oneline', `${mainBranch}..${branchName}`], {
			cwd: mainWorktreePath,
		})

		const commits = commitsOutput.trim()

		// If no commits, branch has no changes ahead of main
		if (!commits) {
			getLogger().success(`Branch has no commits ahead of ${mainBranch}. No merge needed.`)
			return
		}

		// Show commits that will be merged
		const commitLines = commits.split('\n')
		getLogger().info(`Found ${commitLines.length} commit(s) to merge:`)
		commitLines.forEach((commit) => getLogger().info(`  ${commit}`))

		// Step 7: User confirmation (unless force mode or dry-run)
		if (!force && !dryRun) {
			// TODO: Implement interactive prompt for confirmation
			// For now, proceeding automatically (use --force to skip this message)
			const mergeType = noFf ? 'no-fast-forward merge' : 'fast-forward merge'
			getLogger().info(`Proceeding with ${mergeType}... (use --force to skip confirmations)`)
		}

		// Step 8: Execute merge (unless dry-run)
		if (dryRun) {
			const mergeFlag = noFf ? '--no-ff' : '--ff-only'
			getLogger().info(`[DRY RUN] Would execute: git merge ${mergeFlag} ${branchName}`)
			getLogger().info(`[DRY RUN] This would merge ${commitLines.length} commit(s)`)
			return
		}

		// Execute merge (fast-forward or no-ff depending on options)
		const mergeArgs = noFf
			? ['merge', '--no-ff', branchName]
			: ['merge', '--ff-only', branchName]
		try {
			const mergeType = noFf ? 'no-fast-forward' : 'fast-forward'
			getLogger().debug(`Executing ${mergeType} merge of ${branchName} into ${mainBranch} using cwd: ${mainWorktreePath}...`)
			await executeGitCommand(mergeArgs, { cwd: mainWorktreePath })
			getLogger().success(`${noFf ? 'No-fast-forward' : 'Fast-forward'} merge completed! Merged ${commitLines.length} commit(s).`)
		} catch (error) {
			const mergeType = noFf ? 'Merge' : 'Fast-forward merge'
			throw new Error(
				`${mergeType} failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
					'To recover:\n' +
					'  1. Check merge status: git status\n' +
					'  2. Abort merge if needed: git merge --abort\n' +
					'  3. Verify branch is rebased: git rebase main\n' +
					'  4. Try merge again: il finish'
			)
		}
	}

	/**
	 * Helper: Detect conflicted files after failed rebase
	 * @private
	 */
	private async detectConflictedFiles(worktreePath: string): Promise<string[]> {
		try {
			const output = await executeGitCommand(['diff', '--name-only', '--diff-filter=U'], {
				cwd: worktreePath,
			})

			return output
				.trim()
				.split('\n')
				.filter((file) => file.length > 0)
		} catch {
			// If command fails, return empty array (might not be a conflict)
			return []
		}
	}

	/**
	 * Create a temporary WIP commit to preserve uncommitted changes during rebase
	 * Stages all changes (tracked, untracked) using git add -A
	 * Uses --no-verify to skip pre-commit hooks since this is a temporary internal commit
	 * @param worktreePath - Path to the worktree
	 * @returns The commit hash of the WIP commit
	 * @private
	 */
	private async createWipCommit(worktreePath: string): Promise<string> {
		// Stage all changes including untracked files
		await executeGitCommand(['add', '-A'], { cwd: worktreePath })

		// Create WIP commit with distinctive message
		// Use --no-verify to skip pre-commit hooks - this is a temporary internal commit
		await executeGitCommand(['commit', '--no-verify', '-m', 'WIP: Auto-stash for rebase'], { cwd: worktreePath })

		// Get and return the commit hash
		const hash = await executeGitCommand(['rev-parse', 'HEAD'], { cwd: worktreePath })
		return hash.trim()
	}

	/**
	 * Restore uncommitted changes from WIP commit via soft reset
	 * Logs warning but does not fail if soft reset fails (changes are safe in commit history)
	 * @param worktreePath - Path to the worktree
	 * @param wipCommitHash - Original WIP commit hash for verification logging
	 * @private
	 */
	private async restoreWipCommit(worktreePath: string, wipCommitHash: string): Promise<void> {
		getLogger().info('Restoring uncommitted changes from WIP commit...')

		try {
			// Soft reset to parent - changes become staged
			await executeGitCommand(['reset', '--soft', 'HEAD~1'], { cwd: worktreePath })

			// Unstage files to restore to original working directory state
			await executeGitCommand(['reset', 'HEAD'], { cwd: worktreePath })

			getLogger().success('Restored uncommitted changes from WIP commit')
		} catch (error) {
			// Log warning but consider rebase successful - work is not lost
			getLogger().warn(
				`Failed to restore WIP commit (${wipCommitHash}). ` +
					`Your changes are safe in the commit history. ` +
					`Manual recovery: git reset --soft HEAD~1`,
				{ error: error instanceof Error ? error.message : String(error) }
			)
		}
	}

	/**
	 * Helper: Format conflict error message with manual resolution steps
	 * @private
	 */
	private formatConflictError(conflictedFiles: string[]): string {
		const fileList = conflictedFiles.map((file) => `  • ${file}`).join('\n')

		return (
			'Rebase failed - merge conflicts detected in:\n' +
			fileList +
			'\n\n' +
			'To resolve manually:\n' +
			'  1. Fix conflicts in the files above\n' +
			'  2. Stage resolved files: git add <files>\n' +
			'  3. Continue rebase: git rebase --continue\n' +
			'  4. Or abort rebase: git rebase --abort\n' +
			'  5. Then re-run: il finish <issue-number>'
		)
	}

	/**
	 * Attempt to resolve conflicts using Claude
	 * Ports bash/merge-and-clean.sh lines 839-894
	 *
	 * @param worktreePath - Path to the worktree
	 * @param conflictedFiles - List of files with conflicts
	 * @returns true if conflicts resolved, false otherwise
	 * @private
	 */
	private async attemptClaudeConflictResolution(
		worktreePath: string,
		conflictedFiles: string[],
		options: { jsonStream?: boolean; conflictType?: 'rebase' | 'merge' } = {}
	): Promise<boolean> {
		const conflictType = options.conflictType ?? 'rebase'

		// Check if Claude CLI is available
		const isClaudeAvailable = await detectClaudeCli()
		if (!isClaudeAvailable) {
			getLogger().debug('Claude CLI not available, skipping conflict resolution')
			return false
		}

		getLogger().info(`Launching Claude to resolve ${conflictType} conflicts in ${conflictedFiles.length} file(s)...`)

		// Adapt prompt based on conflict type
		const systemPrompt = conflictType === 'merge'
			? `Please help resolve the git merge conflicts in this repository. ` +
				`Analyze the conflicted files, understand the changes from both branches, ` +
				`fix the conflicts, then run 'git add .' to stage the resolved files, ` +
				`and finally run 'git commit' to finalize the merge. ` +
				`Once the issue is resolved, tell the user they can use /exit to continue with the process.`
			: `Please help resolve the git rebase conflicts in this repository. ` +
				`Analyze the conflicted files, understand the changes from both branches, ` +
				`fix the conflicts, then run 'git add .' to stage the resolved files, ` +
				`and finally run 'git rebase --continue' to continue the rebase process. ` +
				`Once the issue is resolved, tell the user they can use /exit to continue with the process.`

		const prompt = conflictType === 'merge'
			? `Help me with this merge please.`
			: `Help me with this rebase please.`

		// Tools to auto-approve during conflict resolution
		// Includes core file tools for reading/editing conflicted files,
		// plus the essential git commands Claude needs to analyze and resolve conflicts
		// Note: git reset and git checkout are intentionally excluded as they can be destructive
		const allowedTools = conflictType === 'merge'
			? [
				'Read',
				'Grep',
				'Glob',
				'Bash(git status:*)',
				'Bash(git diff:*)',
				'Bash(git log:*)',
				'Bash(git show:*)',
				'Bash(git add:*)',
				'Bash(git commit:*)',
				'Bash(git merge:*)',
			]
			: [
				'Read',
				'Grep',
				'Glob',
				'Bash(git status:*)',
				'Bash(git diff:*)',
				'Bash(git log:*)',
				'Bash(git show:*)',
				'Bash(git add:*)',
				'Bash(git rebase:*)',
				'Bash(GIT_EDITOR=true git rebase:*)',
			]

		try {
			// Launch Claude interactively in current terminal
			// User will interact directly with Claude to resolve conflicts
			// When jsonStream is true, run headless with stdout passthrough for JSONL streaming
			await launchClaude(prompt, {
				appendSystemPrompt: systemPrompt,
				addDir: worktreePath,
				headless: options.jsonStream ? true : false,
				...(options.jsonStream && { permissionMode: 'bypassPermissions' as const }),
				...(options.jsonStream && {
					passthroughStdout: true,
				}),
				allowedTools,
				noSessionPersistence: true, // Utility operation - no session persistence needed
			})

			// After Claude interaction completes, check if conflicts resolved
			const remainingConflicts = await this.detectConflictedFiles(worktreePath)

			if (remainingConflicts.length > 0) {
				getLogger().warn(
					`Conflicts still exist in ${remainingConflicts.length} file(s) after Claude assistance`
				)
				return false
			}

			// Check if operation completed or still in progress
			if (conflictType === 'merge') {
				const mergeInProgress = await this.isMergeInProgress(worktreePath)
				if (mergeInProgress) {
					getLogger().warn('Merge still in progress after Claude assistance')
					return false
				}
			} else {
				const rebaseInProgress = await this.isRebaseInProgress(worktreePath)
				if (rebaseInProgress) {
					getLogger().warn('Rebase still in progress after Claude assistance')
					return false
				}
			}

			return true
		} catch (error) {
			getLogger().warn('Claude conflict resolution failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		}
	}

	/**
	 * Check if a git rebase is currently in progress
	 * Checks for .git/rebase-merge or .git/rebase-apply directories
	 * Ports bash script logic from lines 853-856
	 *
	 * @param worktreePath - Path to the worktree
	 * @returns true if rebase in progress, false otherwise
	 * @private
	 */
	private async isRebaseInProgress(worktreePath: string): Promise<boolean> {
		const fs = await import('node:fs/promises')
		const path = await import('node:path')

		// In git worktrees, .git is a file pointing to the actual git dir.
		// Use git rev-parse to resolve the real git directory.
		const gitDir = (await executeGitCommand(
			['rev-parse', '--absolute-git-dir'],
			{ cwd: worktreePath }
		)).trim()

		const rebaseMergePath = path.join(gitDir, 'rebase-merge')
		const rebaseApplyPath = path.join(gitDir, 'rebase-apply')

		// Check for rebase-merge directory
		try {
			await fs.access(rebaseMergePath)
			return true
		} catch {
			// Directory doesn't exist, continue checking
		}

		// Check for rebase-apply directory
		try {
			await fs.access(rebaseApplyPath)
			return true
		} catch {
			// Directory doesn't exist
		}

		return false
	}

	/**
	 * Check if a git merge is currently in progress
	 * Checks for MERGE_HEAD file in the git directory
	 *
	 * @param worktreePath - Path to the worktree
	 * @returns true if merge in progress, false otherwise
	 * @private
	 */
	private async isMergeInProgress(worktreePath: string): Promise<boolean> {
		const fs = await import('node:fs/promises')
		const path = await import('node:path')

		const gitDir = (await executeGitCommand(
			['rev-parse', '--absolute-git-dir'],
			{ cwd: worktreePath }
		)).trim()

		const mergeHeadPath = path.join(gitDir, 'MERGE_HEAD')

		try {
			await fs.access(mergeHeadPath)
			return true
		} catch {
			// MERGE_HEAD doesn't exist - no merge in progress
			return false
		}
	}

	/**
	 * Detect whether the current branch has merge commits that incorporate
	 * changes from the target branch (e.g., merges from main into the feature branch).
	 *
	 * For each merge commit on the branch, checks if any non-first-parent is an
	 * ancestor of the target branch. This avoids false positives from merges of
	 * other feature branches.
	 *
	 * @param worktreePath - Path to the worktree
	 * @param targetBranch - The branch to check ancestry against (e.g., 'main' or 'origin/main')
	 * @returns true if merges from the target branch are found
	 * @private
	 */
	private async hasMergesFromParent(worktreePath: string, targetBranch: string): Promise<boolean> {
		const mergesOutput = await executeGitCommand(
			['log', '--merges', '--format=%H', `${targetBranch}..HEAD`],
			{ cwd: worktreePath }
		)

		const mergeHashes = mergesOutput.trim().split('\n').filter(h => h.length > 0)
		if (mergeHashes.length === 0) {
			return false
		}

		for (const mergeHash of mergeHashes) {
			// Get all parents of this merge commit (^@ = all parents)
			const parentsOutput = await executeGitCommand(
				['rev-parse', `${mergeHash}^@`],
				{ cwd: worktreePath }
			)
			const parents = parentsOutput.trim().split('\n').filter(p => p.length > 0)

			// Check non-first parents (index 1+) for target branch ancestry
			for (const parent of parents.slice(1)) {
				try {
					await executeGitCommand(
						['merge-base', '--is-ancestor', parent.trim(), targetBranch],
						{ cwd: worktreePath }
					)
					// If the command succeeds (exit 0), the parent IS an ancestor of targetBranch
					return true
				} catch (error) {
					if (error instanceof GitCommandError && error.exitCode === 1) {
						continue
					}
					throw error
				}
			}
		}

		return false
	}

	/**
	 * Abort an in-progress rebase if one is detected
	 * This handles cases where a previous rebase was interrupted (e.g., terminal closed,
	 * Claude session ended, user manually stopped) and the worktree is left in a dirty state.
	 * Since we're about to start a new rebase, the stale rebase state is irrelevant and safe to abort.
	 *
	 * @param worktreePath - Path to the worktree
	 * @private
	 */
	private async abortInProgressRebase(worktreePath: string): Promise<void> {
		const rebaseInProgress = await this.isRebaseInProgress(worktreePath)

		if (!rebaseInProgress) {
			return
		}

		getLogger().warn('A rebase is already in progress. Aborting the stale rebase before proceeding...')

		try {
			await executeGitCommand(['rebase', '--abort'], { cwd: worktreePath })
			getLogger().info('Stale rebase aborted successfully.')
		} catch (error) {
			// Handle race condition: rebase may have been resolved between check and abort
			const errorMsg = error instanceof Error ? error.message : String(error)
			if (errorMsg.includes('No rebase in progress')) {
				getLogger().info('Rebase was already resolved by another process.')
				return
			}
			if (error instanceof GitCommandError) {
				throw new Error(
					`Failed to abort in-progress rebase: ${error.message}\n` +
						'Manual recovery: run "git rebase --abort" in the worktree directory.'
				)
			}
			throw error
		}
	}
}
