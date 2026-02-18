import path from 'path'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { CommitManager } from '../lib/CommitManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { ValidationRunner } from '../lib/ValidationRunner.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { getLogger } from '../utils/logger-context.js'
import { extractIssueNumber, isValidGitRepo, getWorktreeRoot } from '../utils/git.js'
import type { CommitOptions } from '../types/index.js'

/**
 * Input options for the commit command
 */
export interface CommitCommandInput {
	message?: string | undefined        // Custom commit message (skip Claude generation)
	fixes?: boolean | undefined         // Use "Fixes #N" trailer instead of "Refs #N"
	noReview?: boolean | undefined      // Skip commit message review prompt
	json?: boolean | undefined          // Output result as JSON
	wipCommit?: boolean | undefined     // Quick WIP commit: skip validations and pre-commit hooks
}

/**
 * Result of commit operation (returned in JSON mode)
 */
export interface CommitResult {
	success: boolean
	commitHash?: string | undefined
	message?: string | undefined
	filesChanged?: number | undefined
	issueNumber?: string | number | undefined
	trailerType: 'Refs' | 'Fixes'
}

/**
 * Error thrown when the commit command is run from an invalid location
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
 * CommitCommand: Commit all uncommitted files with issue reference
 *
 * This command:
 * 1. Validates the current directory is an iloom-managed worktree
 * 2. Auto-detects the issue number from the worktree path/branch
 * 3. Commits all uncommitted changes with a Claude-generated or fallback message
 * 4. Uses "Refs #N" trailer by default (keeps issue open)
 * 5. Uses "Fixes #N" trailer with --fixes flag (closes issue)
 */
export class CommitCommand {
	constructor(
		private gitWorktreeManager = new GitWorktreeManager(),
		private commitManager = new CommitManager(),
		private settingsManager = new SettingsManager(),
		private metadataManager = new MetadataManager(),
		private validationRunner = new ValidationRunner()
	) {}

	/**
	 * Execute the commit command
	 *
	 * @param input - Command input containing options
	 * @returns CommitResult when in JSON mode, void otherwise
	 */
	async execute(input: CommitCommandInput): Promise<CommitResult | void> {
		const logger = getLogger()

		// Set ILOOM=1 so hooks know this is an iloom session
		process.env.ILOOM = '1'

		// Step 1: Validate worktree context
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

		// Step 2: Auto-detect issue from current directory
		const detected = await this.autoDetectIssue(worktreePath)

		// Step 3: Determine trailer type
		let trailerType: 'Refs' | 'Fixes' = 'Refs' // Default to Refs
		if (input.fixes) {
			if (detected.loomType === 'branch') {
				// Warn and ignore --fixes for branch looms (no issue to close)
				logger.warn('--fixes flag ignored: not in an issue or PR worktree')
			} else {
				trailerType = 'Fixes'
			}
		}

		// Step 4: Check for uncommitted changes
		const status = await this.commitManager.detectUncommittedChanges(worktreePath)
		if (!status.hasUncommittedChanges) {
			logger.info('No uncommitted changes to commit')
			if (input.json) {
				return {
					success: true,
					trailerType,
					issueNumber: detected.issueNumber,
				}
			}
			return
		}

		// Step 5: Run validations unless --wip-commit is specified
		let validationPassed = false
		if (!input.wipCommit) {
			logger.info('Running pre-commit validations...')
			const validationResult = await this.validationRunner.runValidations(worktreePath, {
				dryRun: false,
			})
			if (!validationResult.success) {
				throw new Error('Validation failed. Fix errors before committing.')
			}
			logger.success('All validations passed')
			validationPassed = true
		}

		// Step 6: Load settings to get issue prefix
		const settings = await this.settingsManager.loadSettings(worktreePath)
		const providerType = settings.issueManagement?.provider ?? 'github'
		const issuePrefix = IssueManagementProviderFactory.create(providerType, settings).issuePrefix

		// Determine whether to skip pre-commit hooks:
		// - With --wip-commit: always skip hooks (quick WIP commit)
		// - Otherwise: skip hooks only if validation passed AND noVerify setting is enabled
		const shouldSkipVerify = input.wipCommit === true || (validationPassed && (settings.workflows?.issue?.noVerify ?? false))

		// Step 7: Determine commit message
		// For --wip-commit without a custom message, use a hardcoded WIP message to skip Claude generation
		let commitMessage: string | undefined = input.message
		if (input.wipCommit && !input.message) {
			if (detected.issueNumber !== undefined) {
				commitMessage = `WIP commit for Issue ${issuePrefix}${detected.issueNumber}`
			} else {
				commitMessage = 'WIP commit'
			}
			logger.debug(`Using hardcoded WIP message: ${commitMessage}`)
		}

		// Step 8: Build commit options
		const commitOptions: CommitOptions = {
			issuePrefix,
			skipVerify: shouldSkipVerify,
			skipVerifySilent: input.wipCommit === true,  // Don't warn for --wip-commit
			noReview: input.noReview ?? false,
			trailerType,
			timeout: settings.git?.commitTimeout,
			...(commitMessage && { message: commitMessage }),
			...(detected.issueNumber !== undefined && { issueNumber: detected.issueNumber }),
		}

		// Step 9: Commit changes
		const commitResult = await this.commitManager.commitChanges(worktreePath, commitOptions)
		logger.success('Changes committed successfully')

		// Step 10: Return result in JSON mode
		if (input.json) {
			return {
				success: true,
				trailerType,
				issueNumber: detected.issueNumber,
				message: commitResult?.message,
			}
		}
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
				"Run 'il commit' from within an iloom worktree created by 'il start'."
			)
		}

		// Step 2: Get the worktree root (handles subdirectories)
		const worktreeRoot = await getWorktreeRoot(currentDir)
		if (!worktreeRoot) {
			throw new WorktreeValidationError(
				'Could not determine repository root.',
				"Run 'il commit' from within an iloom worktree created by 'il start'."
			)
		}

		// Step 3: Check if this path is a registered git worktree
		const worktrees = await this.gitWorktreeManager.listWorktrees()
		const currentWorktree = worktrees.find(wt => wt.path === worktreeRoot)

		if (!currentWorktree) {
			throw new WorktreeValidationError(
				'This directory is not an iloom worktree.',
				"Run 'il commit' from within a worktree created by 'il start <issue>'. Use 'il list' to see available worktrees."
			)
		}

		// Step 4: Check if this is the main worktree (we shouldn't commit from main with issue trailers)
		const isMain = await this.gitWorktreeManager.isMainWorktree(currentWorktree, this.settingsManager)
		if (isMain) {
			throw new WorktreeValidationError(
				'Cannot use il commit from the main worktree.',
				"Navigate to a feature worktree created by 'il start <issue>' and run 'il commit' from there."
			)
		}

		return worktreeRoot
	}

	/**
	 * Auto-detect issue from current directory
	 * Similar to SummaryCommand.autoDetectFromCurrentDirectory()
	 */
	private async autoDetectIssue(worktreePath: string): Promise<{
		issueNumber: string | number | undefined
		loomType: 'issue' | 'pr' | 'branch' | 'epic'
	}> {
		const logger = getLogger()
		const currentDir = path.basename(worktreePath)

		// Check for PR worktree pattern: _pr_N suffix
		const prPattern = /_pr_(\d+)$/
		const prMatch = currentDir.match(prPattern)

		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			logger.debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)

			// Try to get issue number from metadata
			const metadata = await this.metadataManager.readMetadata(worktreePath)
			return {
				issueNumber: metadata?.pr_numbers?.[0] ?? prNumber,
				loomType: 'pr',
			}
		}

		// Check for issue pattern in directory name
		const issueNumber = extractIssueNumber(currentDir)

		if (issueNumber !== null) {
			logger.debug(`Auto-detected issue #${issueNumber} from directory: ${currentDir}`)

			// Try to get issue key from metadata for more accuracy (canonical case)
			const metadata = await this.metadataManager.readMetadata(worktreePath)
			return {
				issueNumber: metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? issueNumber,
				loomType: metadata?.issueType ?? 'issue',
			}
		}

		// Fallback: get current branch name and try to extract issue
		const repoInfo = await this.gitWorktreeManager.getRepoInfo()
		const currentBranch = repoInfo.currentBranch

		if (currentBranch) {
			const branchIssueNumber = extractIssueNumber(currentBranch)
			if (branchIssueNumber !== null) {
				logger.debug(`Auto-detected issue #${branchIssueNumber} from branch: ${currentBranch}`)

				const metadata = await this.metadataManager.readMetadata(worktreePath)
				return {
					issueNumber: metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? branchIssueNumber,
					loomType: metadata?.issueType ?? 'issue',
				}
			}
		}

		// No issue detected - treat as branch loom
		logger.debug('No issue number detected, treating as branch loom')
		const metadata = await this.metadataManager.readMetadata(worktreePath)

		// For branch looms, try to get issue number from metadata
		let resolvedIssueNumber: string | number | undefined
		const loomType = metadata?.issueType ?? 'branch'

		if (loomType === 'issue' && (metadata?.issueKey || metadata?.issue_numbers?.[0])) {
			resolvedIssueNumber = metadata?.issueKey ?? metadata?.issue_numbers?.[0]
		} else if (loomType === 'pr' && metadata?.pr_numbers?.[0]) {
			resolvedIssueNumber = metadata.pr_numbers[0]
		}

		return {
			issueNumber: resolvedIssueNumber,
			loomType,
		}
	}
}
