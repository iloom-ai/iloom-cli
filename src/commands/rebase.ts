import { logger } from '../utils/logger.js'
import { MergeManager } from '../lib/MergeManager.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { BuildRunner } from '../lib/BuildRunner.js'
import { isValidGitRepo, getWorktreeRoot } from '../utils/git.js'
import { installDependencies } from '../utils/package-manager.js'
import type { MergeOptions, RebaseResult } from '../types/index.js'

export interface RebaseOptions {
	force?: boolean
	dryRun?: boolean
	jsonStream?: boolean
}

/**
 * Error thrown when the rebase command is run from an invalid location
 */
export class WorktreeValidationError extends Error {
	constructor(
		message: string,
		public readonly suggestion: string
	) {
		super(message)
		this.name = 'WorktreeValidationError'
	}
}

/**
 * RebaseCommand: Rebase current branch on main with Claude-assisted conflict resolution
 *
 * This command:
 * 1. Validates the current directory is an iloom-managed worktree
 * 2. Detects the worktree root (supports running from subdirectories)
 * 3. Delegates to MergeManager.rebaseOnMain() which handles:
 *    - Checking main branch exists
 *    - Detecting uncommitted changes (throws if found)
 *    - Checking if already up-to-date
 *    - Executing rebase
 *    - Claude-assisted conflict resolution
 * 4. Reports success
 */
export class RebaseCommand {
	private mergeManager: MergeManager
	private gitWorktreeManager: GitWorktreeManager
	private settingsManager: SettingsManager
	private buildRunner: BuildRunner

	constructor(mergeManager?: MergeManager, gitWorktreeManager?: GitWorktreeManager, settingsManager?: SettingsManager, buildRunner?: BuildRunner) {
		this.mergeManager = mergeManager ?? new MergeManager()
		this.gitWorktreeManager = gitWorktreeManager ?? new GitWorktreeManager()
		this.settingsManager = settingsManager ?? new SettingsManager()
		this.buildRunner = buildRunner ?? new BuildRunner()
	}

	/**
	 * Validate that the current directory is within an iloom-managed worktree
	 * Returns the worktree root path if valid
	 * @throws WorktreeValidationError if validation fails
	 */
	private async validateWorktreeContext(): Promise<string> {
		const currentDir = process.cwd()

		// Step 1: Check if we're in a git repository at all
		const isGitRepo = await isValidGitRepo(currentDir)
		if (!isGitRepo) {
			throw new WorktreeValidationError(
				'Not a git repository.',
				"Run 'il rebase' from within an iloom worktree created by 'il start'."
			)
		}

		// Step 2: Get the worktree root (handles subdirectories)
		const worktreeRoot = await getWorktreeRoot(currentDir)
		if (!worktreeRoot) {
			throw new WorktreeValidationError(
				'Could not determine repository root.',
				"Run 'il rebase' from within an iloom worktree created by 'il start'."
			)
		}

		// Step 3: Check if this path is a registered git worktree
		const worktrees = await this.gitWorktreeManager.listWorktrees()
		const currentWorktree = worktrees.find(wt => wt.path === worktreeRoot)

		if (!currentWorktree) {
			throw new WorktreeValidationError(
				'This directory is not an iloom worktree.',
				"Run 'il rebase' from within a worktree created by 'il start <issue>'. Use 'il list' to see available worktrees."
			)
		}

		// Step 4: Check if this is the main worktree (we shouldn't rebase from main)
		const isMain = await this.gitWorktreeManager.isMainWorktree(currentWorktree, this.settingsManager)
		if (isMain) {
			throw new WorktreeValidationError(
				'Cannot rebase from the main worktree.',
				"Navigate to a feature worktree created by 'il start <issue>' and run 'il rebase' from there."
			)
		}

		return worktreeRoot
	}

	async execute(options: RebaseOptions = {}): Promise<RebaseResult | void> {
		// Set ILOOM=1 so hooks know this is an iloom session
		process.env.ILOOM = '1'

		// Step 1: Validate we're in a valid iloom worktree
		let worktreePath: string
		try {
			worktreePath = await this.validateWorktreeContext()
		} catch (error) {
			if (error instanceof WorktreeValidationError) {
				logger.error(error.message)
				logger.info(error.suggestion)
				throw error
			}
			throw error
		}

		const mergeOptions: MergeOptions = {
			dryRun: options.dryRun ?? false,
			force: options.force ?? false,
			jsonStream: options.jsonStream ?? false,
		}

		// MergeManager.rebaseOnMain() handles:
		// - Checking main branch exists
		// - Detecting uncommitted changes (throws if found)
		// - Checking if already up-to-date
		// - Executing rebase
		// - Claude-assisted conflict resolution
		const outcome = await this.mergeManager.rebaseOnMain(worktreePath, mergeOptions)

		// Install dependencies after successful rebase
		if (!options.dryRun) {
			logger.info('Installing dependencies...')
			try {
				await installDependencies(worktreePath, true, true) // frozen=true, quiet=true
			} catch (error) {
				// Log warning but don't fail - rebase succeeded, user can fix deps manually
				const message = error instanceof Error ? error.message : 'Unknown error'
				logger.warn(`Dependency installation failed: ${message}`)
				logger.warn('Please run your package manager install command manually')
			}
		} else {
			logger.info('[DRY RUN] Would install dependencies')
		}

		// Run build for CLI projects after successful rebase
		await this.runPostRebaseBuild(worktreePath, options)

		// Return result if jsonStream mode
		if (options.jsonStream) {
			return {
				success: true,
				conflictsDetected: outcome.conflictsDetected,
				claudeLaunched: outcome.claudeLaunched,
				conflictsResolved: outcome.conflictsResolved,
			}
		}
	}

	/**
	 * Run post-rebase build for CLI projects
	 * Non-blocking: build failures are logged as warnings but don't fail the rebase
	 */
	private async runPostRebaseBuild(worktreePath: string, options: RebaseOptions): Promise<void> {
		if (options.dryRun) {
			logger.info('[DRY RUN] Would run post-rebase build for CLI projects')
			return
		}

		try {
			const buildResult = await this.buildRunner.runBuild(worktreePath, {
				dryRun: options.dryRun ?? false,
			})

			if (buildResult.skipped) {
				logger.debug(`Build skipped: ${buildResult.reason}`)
			} else {
				logger.success('Post-rebase build completed successfully')
			}
		} catch (error) {
			// Log warning but don't fail - rebase succeeded, user can fix build manually
			const message = error instanceof Error ? error.message : 'Unknown error'
			logger.warn(`Post-rebase build failed: ${message}`)
			logger.warn('Please run the build command manually')
		}
	}
}
