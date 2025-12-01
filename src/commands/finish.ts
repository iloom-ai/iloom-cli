import { logger } from '../utils/logger.js'
import type { IssueTracker } from '../lib/IssueTracker.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { ValidationRunner } from '../lib/ValidationRunner.js'
import { CommitManager } from '../lib/CommitManager.js'
import { MergeManager } from '../lib/MergeManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { ResourceCleanup } from '../lib/ResourceCleanup.js'
import { ProcessManager } from '../lib/process/ProcessManager.js'
import { BuildRunner } from '../lib/BuildRunner.js'
import { DatabaseManager } from '../lib/DatabaseManager.js'
import { EnvironmentManager } from '../lib/EnvironmentManager.js'
import { CLIIsolationManager } from '../lib/CLIIsolationManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { PRManager } from '../lib/PRManager.js'
import { LoomManager } from '../lib/LoomManager.js'
import { ClaudeContextManager } from '../lib/ClaudeContextManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { findMainWorktreePathWithSettings, pushBranchToRemote } from '../utils/git.js'
import { loadEnvIntoProcess } from '../utils/env.js'
import { installDependencies } from '../utils/package-manager.js'
import { createNeonProviderFromSettings } from '../utils/neon-helpers.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'
import { promptConfirmation } from '../utils/prompt.js'
import type { FinishOptions, GitWorktree, CommitOptions, MergeOptions, PullRequest } from '../types/index.js'
import type { ResourceCleanupOptions, CleanupResult } from '../types/cleanup.js'
import type { ParsedInput } from './start.js'
import path from 'path'

export interface FinishCommandInput {
	identifier?: string | undefined // Optional - can be auto-detected
	options: FinishOptions
}

export interface ParsedFinishInput {
	type: 'issue' | 'pr' | 'branch'
	number?: string | number // For issues and PRs
	branchName?: string // For branch inputs
	originalInput: string // Raw input for error messages
	autoDetected?: boolean // True if detected from current directory
}

export class FinishCommand {
	private issueTracker: IssueTracker
	private gitWorktreeManager: GitWorktreeManager
	private validationRunner: ValidationRunner
	private commitManager: CommitManager
	private mergeManager: MergeManager
	private identifierParser: IdentifierParser
	private resourceCleanup?: ResourceCleanup
	private buildRunner: BuildRunner
	private settingsManager: SettingsManager
	private loomManager?: LoomManager

	constructor(
		issueTracker: IssueTracker,
		gitWorktreeManager?: GitWorktreeManager,
		validationRunner?: ValidationRunner,
		commitManager?: CommitManager,
		mergeManager?: MergeManager,
		identifierParser?: IdentifierParser,
		resourceCleanup?: ResourceCleanup,
		buildRunner?: BuildRunner,
		settingsManager?: SettingsManager,
		loomManager?: LoomManager
	) {
		// Load environment variables first
		const envResult = loadEnvIntoProcess()
		if (envResult.error) {
			logger.debug(`Environment loading warning: ${envResult.error.message}`)
		}
		if (envResult.parsed) {
			logger.debug(`Loaded ${Object.keys(envResult.parsed).length} environment variables`)
		}

		this.issueTracker = issueTracker
		this.gitWorktreeManager = gitWorktreeManager ?? new GitWorktreeManager()
		this.validationRunner = validationRunner ?? new ValidationRunner()
		this.commitManager = commitManager ?? new CommitManager()
		this.mergeManager = mergeManager ?? new MergeManager()
		this.identifierParser = identifierParser ?? new IdentifierParser(this.gitWorktreeManager)

		// Initialize settingsManager first (needed for ResourceCleanup)
		this.settingsManager = settingsManager ?? new SettingsManager()

		// ResourceCleanup will be initialized lazily with proper configuration
		if (resourceCleanup) {
			this.resourceCleanup = resourceCleanup
		}

		this.buildRunner = buildRunner ?? new BuildRunner()
		// LoomManager will be initialized lazily if not provided
		if (loomManager) {
			this.loomManager = loomManager
		}
	}

	/**
	 * Lazy initialization of ResourceCleanup with properly configured DatabaseManager
	 */
	private async ensureResourceCleanup(): Promise<void> {
		// Early return only if both are initialized
		if (this.resourceCleanup && this.loomManager) {
			return
		}

		const settings = await this.settingsManager.loadSettings()
		const databaseUrlEnvVarName = settings.capabilities?.database?.databaseUrlEnvVarName ?? 'DATABASE_URL'

		const environmentManager = new EnvironmentManager()
		const neonProvider = createNeonProviderFromSettings(settings)
		const databaseManager = new DatabaseManager(neonProvider, environmentManager, databaseUrlEnvVarName)
		const cliIsolationManager = new CLIIsolationManager()

		// Initialize LoomManager if not provided
		const { DefaultBranchNamingService } = await import('../lib/BranchNamingService.js')
		this.loomManager ??= new LoomManager(
			this.gitWorktreeManager,
			this.issueTracker,
			new DefaultBranchNamingService({ useClaude: true }),
			environmentManager,
			new ClaudeContextManager(),
			new ProjectCapabilityDetector(),
			cliIsolationManager,
			this.settingsManager,
			databaseManager
		)

		this.resourceCleanup ??= new ResourceCleanup(
			this.gitWorktreeManager,
			new ProcessManager(),
			databaseManager,
			cliIsolationManager
		)
	}

	/**
	 * Check for child looms and exit gracefully if any exist
	 * Always checks the TARGET loom (the one being finished), not the current directory's loom
	 *
	 * @param parsed - The parsed input identifying the loom being finished
	 */
	private async checkForChildLooms(parsed: ParsedFinishInput): Promise<void> {
		await this.ensureResourceCleanup()
		if (!this.loomManager) {
			throw new Error('Failed to initialize LoomManager')
		}

		// Determine which branch is being finished based on parsed input
		let targetBranch: string | undefined

		if (parsed.branchName) {
			targetBranch = parsed.branchName
		} else if (parsed.type === 'issue' && parsed.number !== undefined) {
			// For issues, try to find the worktree by issue number to get the branch name
			const worktree = await this.gitWorktreeManager.findWorktreeForIssue(parsed.number)
			targetBranch = worktree?.branch
		} else if (parsed.type === 'pr' && parsed.number !== undefined) {
			// For PRs, ensure the number is numeric (PRs are always numeric per GitHub)
			const prNumber = typeof parsed.number === 'number' ? parsed.number : Number(parsed.number)
			if (isNaN(prNumber) || !isFinite(prNumber)) {
				throw new Error(`Invalid PR number: ${parsed.number}. PR numbers must be numeric.`)
			}
			// For PRs, try to find the worktree by PR number to get the branch name
			const worktree = await this.gitWorktreeManager.findWorktreeForPR(prNumber, '')
			targetBranch = worktree?.branch
		}

		// If we can't determine the target branch, skip the check
		if (!targetBranch) {
			logger.debug(`Cannot determine target branch for child loom check`)
			return
		}

		// Check if the TARGET loom has any child looms
		const hasChildLooms = await this.loomManager.checkAndWarnChildLooms(targetBranch)
		if (hasChildLooms) {
			logger.error('Cannot finish loom while child looms exist. Please finish child looms first.')
			process.exit(1)
		}
	}

	/**
	 * Main entry point for finish command
	 */
	public async execute(input: FinishCommandInput): Promise<void> {
		try {
			// Step 1: Load settings and get configured repo for GitHub operations
			const settings = await this.settingsManager.loadSettings()

			let repo: string | undefined

			const multipleRemotes = await hasMultipleRemotes()
			if (multipleRemotes) {
				repo = await getConfiguredRepoFromSettings(settings)
				logger.info(`Using GitHub repository: ${repo}`)
			}

			// Step 2: Parse input (or auto-detect from current directory)
			const parsed = await this.parseInput(input.identifier, input.options)

			// Step 2.5: Check for child looms AFTER parsing input
			// This ensures we only block when finishing the CURRENT loom (parent), not a child
			await this.checkForChildLooms(parsed)

			// Step 2: Validate based on type and get worktrees
			const worktrees = await this.validateInput(parsed, input.options, repo)

			// Step 3: Log success
			logger.info(`Validated input: ${this.formatParsedInput(parsed)}`)

			// Get worktree for workflow execution
			const worktree = worktrees[0]
			if (!worktree) {
				throw new Error('No worktree found')
			}

			// Step 4: Branch based on input type
			if (parsed.type === 'pr') {
				// Fetch PR to get current state
				if (!parsed.number) {
					throw new Error('Invalid PR number')
				}
				// Check if provider supports PRs before calling PR methods
				if (!this.issueTracker.supportsPullRequests || !this.issueTracker.fetchPR) {
					throw new Error('Issue tracker does not support pull requests')
				}
				const pr = await this.issueTracker.fetchPR(parsed.number, repo)
				await this.executePRWorkflow(parsed, input.options, worktree, pr)
			} else {
				// Execute traditional issue/branch workflow
				await this.executeIssueWorkflow(parsed, input.options, worktree)
			}
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`${error.message}`)
			} else {
				logger.error('An unknown error occurred')
			}
			throw error
		}
	}

	/**
	 * Parse input to determine type and extract relevant data
	 * Supports auto-detection from current directory when identifier is undefined
	 */
	private async parseInput(
		identifier: string | undefined,
		options: FinishOptions
	): Promise<ParsedFinishInput> {
		// Priority 1: --pr flag overrides everything
		if (options.pr !== undefined) {
			return {
				type: 'pr',
				number: options.pr,
				originalInput: `--pr ${options.pr}`,
				autoDetected: false,
			}
		}

		// Priority 2: Explicit identifier provided
		if (identifier?.trim()) {
			return await this.parseExplicitInput(identifier.trim())
		}

		// Priority 3: Auto-detect from current directory
		return await this.autoDetectFromCurrentDirectory()
	}

	/**
	 * Parse explicit identifier input using pattern-based detection
	 * (No GitHub API calls - uses IdentifierParser)
	 */
	private async parseExplicitInput(
		identifier: string
	): Promise<ParsedFinishInput> {
		// Check for PR-specific formats: pr/123, PR-123, PR/123
		const prPattern = /^(?:pr|PR)[/-](\d+)$/
		const prMatch = identifier.match(prPattern)
		if (prMatch?.[1]) {
			return {
				type: 'pr',
				number: parseInt(prMatch[1], 10),
				originalInput: identifier,
				autoDetected: false,
			}
		}

		// Use IdentifierParser for pattern-based detection
		// (checks existing worktrees, no GitHub API calls)
		const parsed = await this.identifierParser.parseForPatternDetection(identifier)

		// Description type should never reach finish command (converted in start)
		if (parsed.type === 'description') {
			throw new Error('Description input type is not supported in finish command')
		}

		// Convert ParsedInput to ParsedFinishInput (add autoDetected field)
		const result: ParsedFinishInput = {
			type: parsed.type,
			originalInput: parsed.originalInput,
			autoDetected: false,
		}

		// Add number or branchName based on type
		if (parsed.number !== undefined) {
			result.number = parsed.number
		}
		if (parsed.branchName !== undefined) {
			result.branchName = parsed.branchName
		}

		return result
	}

	/**
	 * Auto-detect PR or issue from current directory
	 * Ports logic from merge-current-issue.sh lines 30-52
	 */
	private async autoDetectFromCurrentDirectory(): Promise<ParsedFinishInput> {
		const currentDir = path.basename(process.cwd())

		// Check for PR worktree pattern: _pr_N suffix
		// Pattern: /.*_pr_(\d+)$/
		const prPattern = /_pr_(\d+)$/
		const prMatch = currentDir.match(prPattern)

		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			logger.debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)
			return {
				type: 'pr',
				number: prNumber,
				originalInput: currentDir,
				autoDetected: true,
			}
		}

		// Check for issue pattern in directory or branch name
		// Pattern: /issue-(\d+)/
		const issuePattern = /issue-(\d+)/
		const issueMatch = currentDir.match(issuePattern)

		if (issueMatch?.[1]) {
			const issueNumber = parseInt(issueMatch[1], 10)
			logger.debug(
				`Auto-detected issue #${issueNumber} from directory: ${currentDir}`
			)
			return {
				type: 'issue',
				number: issueNumber,
				originalInput: currentDir,
				autoDetected: true,
			}
		}

		// Fallback: get current branch name
		const repoInfo = await this.gitWorktreeManager.getRepoInfo()
		const currentBranch = repoInfo.currentBranch

		if (!currentBranch) {
			throw new Error(
				'Could not auto-detect identifier. Please provide an issue number, PR number, or branch name.\n' +
					'Expected directory pattern: feat/issue-XX-description OR worktree with _pr_N suffix'
			)
		}

		// Try to extract issue from branch name
		const branchIssueMatch = currentBranch.match(issuePattern)
		if (branchIssueMatch?.[1]) {
			const issueNumber = parseInt(branchIssueMatch[1], 10)
			logger.debug(
				`Auto-detected issue #${issueNumber} from branch: ${currentBranch}`
			)
			return {
				type: 'issue',
				number: issueNumber,
				originalInput: currentBranch,
				autoDetected: true,
			}
		}

		// Last resort: use branch name
		return {
			type: 'branch',
			branchName: currentBranch,
			originalInput: currentBranch,
			autoDetected: true,
		}
	}

	/**
	 * Validate the parsed input based on its type
	 */
	private async validateInput(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		repo?: string
	): Promise<GitWorktree[]> {
		switch (parsed.type) {
			case 'pr': {
				if (!parsed.number) {
					throw new Error('Invalid PR number')
				}

				// Check if provider supports PRs before calling PR methods
				if (!this.issueTracker.supportsPullRequests || !this.issueTracker.fetchPR) {
					throw new Error('Issue tracker does not support pull requests')
				}

				// Fetch PR from GitHub
				const pr = await this.issueTracker.fetchPR(parsed.number)

				// For PRs, we allow closed/merged state (cleanup-only mode)
				// But we still validate it exists
				logger.debug(`Validated PR #${parsed.number} (state: ${pr.state})`)

				// Find associated worktree
				return await this.findWorktreeForIdentifier(parsed)
			}

			case 'issue': {
				if (!parsed.number) {
					throw new Error('Invalid issue number')
				}

				// Fetch issue from GitHub
				const issue = await this.issueTracker.fetchIssue(parsed.number, repo)

				// Validate issue state (warn if closed unless --force)
				if (issue.state === 'closed' && !options.force) {
					throw new Error(
						`Issue #${parsed.number} is closed. Use --force to finish anyway.`
					)
				}

				logger.debug(`Validated issue #${parsed.number} (state: ${issue.state})`)

				// Find associated worktree
				return await this.findWorktreeForIdentifier(parsed)
			}

			case 'branch': {
				if (!parsed.branchName) {
					throw new Error('Invalid branch name')
				}

				// Validate branch name format
				if (!this.isValidBranchName(parsed.branchName)) {
					throw new Error(
						'Invalid branch name. Use only letters, numbers, hyphens, underscores, and slashes'
					)
				}

				logger.debug(`Validated branch name: ${parsed.branchName}`)

				// Find associated worktree
				return await this.findWorktreeForIdentifier(parsed)
			}

			default: {
				const unknownType = parsed as { type: string }
				throw new Error(`Unknown input type: ${unknownType.type}`)
			}
		}
	}

	/**
	 * Find worktree for the given identifier using specific methods based on type
	 * (uses precise pattern matching instead of broad substring matching)
	 * Throws error if not found
	 */
	private async findWorktreeForIdentifier(
		parsed: ParsedFinishInput
	): Promise<GitWorktree[]> {
		let worktree: GitWorktree | null = null

		// Use specific finding methods based on parsed type
		switch (parsed.type) {
			case 'pr': {
				if (!parsed.number) {
					throw new Error('Invalid PR number')
				}
				// For PRs, ensure the number is numeric (PRs are always numeric per GitHub)
				const prNumber = typeof parsed.number === 'number' ? parsed.number : Number(parsed.number)
				if (isNaN(prNumber) || !isFinite(prNumber)) {
					throw new Error(`Invalid PR number: ${parsed.number}. PR numbers must be numeric.`)
				}
				// Pass empty string for branch name since we don't know it yet
				worktree = await this.gitWorktreeManager.findWorktreeForPR(
					prNumber,
					''
				)
				break
			}

			case 'issue': {
				if (!parsed.number) {
					throw new Error('Invalid issue number')
				}
				worktree = await this.gitWorktreeManager.findWorktreeForIssue(
					parsed.number
				)
				break
			}

			case 'branch': {
				if (!parsed.branchName) {
					throw new Error('Invalid branch name')
				}
				worktree = await this.gitWorktreeManager.findWorktreeForBranch(
					parsed.branchName
				)
				break
			}

			default: {
				const unknownType = parsed as { type: string }
				throw new Error(`Unknown input type: ${unknownType.type}`)
			}
		}

		if (!worktree) {
			throw new Error(
				`No worktree found for ${this.formatParsedInput(parsed)}. ` +
					`Use 'il list' to see available worktrees.`
			)
		}

		logger.debug(`Found worktree: ${worktree.path}`)

		return [worktree]
	}

	/**
	 * Validate branch name format
	 */
	private isValidBranchName(branch: string): boolean {
		// Pattern from bash script and StartCommand
		return /^[a-zA-Z0-9/_-]+$/.test(branch)
	}

	/**
	 * Format parsed input for display
	 */
	private formatParsedInput(parsed: ParsedFinishInput): string {
		const autoLabel = parsed.autoDetected ? ' (auto-detected)' : ''

		switch (parsed.type) {
			case 'pr':
				return `PR #${parsed.number}${autoLabel}`
			case 'issue':
				return `Issue #${parsed.number}${autoLabel}`
			case 'branch':
				return `Branch '${parsed.branchName}'${autoLabel}`
			default:
				return 'Unknown input'
		}
	}

	/**
	 * Execute workflow for issues and branches (merge into main)
	 * This is the traditional workflow: validate → commit → rebase → merge → cleanup
	 */
	private async executeIssueWorkflow(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree
	): Promise<void> {
		// Step 1: Run pre-merge validations FIRST (Sub-Issue #47)
		if (!options.dryRun) {
			logger.info('Running pre-merge validations...')

			await this.validationRunner.runValidations(worktree.path, {
				dryRun: options.dryRun ?? false,
			})
			logger.success('All validations passed')
		} else {
			logger.info('[DRY RUN] Would run pre-merge validations')
		}

		// Step 2: Detect uncommitted changes AFTER validation passes
		const gitStatus = await this.commitManager.detectUncommittedChanges(worktree.path)

		// Step 3: Commit changes only if validation passed AND changes exist
		if (gitStatus.hasUncommittedChanges) {
			if (options.dryRun) {
				logger.info('[DRY RUN] Would auto-commit uncommitted changes (validation passed)')
			} else {
				logger.info('Validation passed, auto-committing uncommitted changes...')

				// Load settings to get skipVerify configuration
				const settings = await this.settingsManager.loadSettings(worktree.path)
				const skipVerify = settings.workflows?.issue?.noVerify ?? false

				const commitOptions: CommitOptions = {
					dryRun: options.dryRun ?? false,
					skipVerify,
				}

				// Only add issueNumber if it's an issue
				if (parsed.type === 'issue' && parsed.number) {
					commitOptions.issueNumber = parsed.number
				}

				await this.commitManager.commitChanges(worktree.path, commitOptions)

				logger.success('Changes committed successfully')
			}
		} else {
			logger.debug('No uncommitted changes found')
		}

		// Step 3.5: Check merge mode from settings and branch workflow
		const settings = await this.settingsManager.loadSettings(worktree.path)
		const mergeBehavior = settings.mergeBehavior ?? { mode: 'local' }

		if (mergeBehavior.mode === 'github-pr') {
			// Execute github-pr workflow instead of local merge
			await this.executeGitHubPRWorkflow(parsed, options, worktree, settings)
			return
		}

		// Step 4: Rebase branch on main
		logger.info('Rebasing branch on main...')

		const mergeOptions: MergeOptions = {
			dryRun: options.dryRun ?? false,
			force: options.force ?? false,
		}

		await this.mergeManager.rebaseOnMain(worktree.path, mergeOptions)
		logger.success('Branch rebased successfully')

		// Step 5: Perform fast-forward merge
		logger.info('Performing fast-forward merge...')
		await this.mergeManager.performFastForwardMerge(worktree.branch, worktree.path, mergeOptions)
		logger.success('Fast-forward merge completed successfully')

		// Step 5.5: Install dependencies in main worktree
		if (options.dryRun) {
			logger.info('[DRY RUN] Would install dependencies in main worktree')
		} else {
			logger.info('Installing dependencies in main worktree...')
			const mainWorktreePath = await findMainWorktreePathWithSettings(worktree.path, this.settingsManager)
			await installDependencies(mainWorktreePath, true)
		}

		// Step 5.6: Run post-merge build verification (CLI projects only)
		if (!options.skipBuild) {
			await this.runPostMergeBuild(worktree.path, options)
		} else {
			logger.debug('Skipping build verification (--skip-build flag provided)')
		}

		// Step 6: Post-merge cleanup
		await this.performPostMergeCleanup(parsed, options, worktree)
	}

	/**
	 * Execute workflow for Pull Requests
	 * Behavior depends on PR state:
	 * - OPEN: Commit changes, push to remote, keep worktree active
	 * - CLOSED/MERGED: Skip to cleanup
	 */
	private async executePRWorkflow(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree,
		pr: PullRequest
	): Promise<void> {
		// Branch based on PR state
		if (pr.state === 'closed' || pr.state === 'merged') {
			// Closed/Merged PR workflow
			logger.info(`PR #${parsed.number} is ${pr.state.toUpperCase()} - skipping to cleanup`)

			// Check for uncommitted changes and warn (unless --force)
			const gitStatus = await this.commitManager.detectUncommittedChanges(worktree.path)
			if (gitStatus.hasUncommittedChanges && !options.force) {
				logger.warn('PR has uncommitted changes')
				throw new Error(
					'Cannot cleanup PR with uncommitted changes. ' +
					'Commit or stash changes, then run again with --force to cleanup anyway.'
				)
			}

			// Call cleanup directly with deleteBranch: true
			await this.performPRCleanup(parsed, options, worktree)

			logger.success(`PR #${parsed.number} cleanup completed`)
		} else {
			// Open PR workflow
			logger.info(`PR #${parsed.number} is OPEN - will push changes and keep worktree active`)

			// Step 1: Detect uncommitted changes
			const gitStatus = await this.commitManager.detectUncommittedChanges(worktree.path)

			// Step 2: Commit changes if any exist
			if (gitStatus.hasUncommittedChanges) {
				if (options.dryRun) {
					logger.info('[DRY RUN] Would commit uncommitted changes')
				} else {
					logger.info('Committing uncommitted changes...')

					// Load settings to get skipVerify configuration
					const settings = await this.settingsManager.loadSettings(worktree.path)
					const skipVerify = settings.workflows?.pr?.noVerify ?? false

					await this.commitManager.commitChanges(worktree.path, {
						dryRun: false,
						skipVerify,
						// Do NOT pass issueNumber for PRs - no "Fixes #" trailer needed
					})
					logger.success('Changes committed')
				}
			} else {
				logger.debug('No uncommitted changes found')
			}

			// Step 3: Push to remote
			if (options.dryRun) {
				logger.info(`[DRY RUN] Would push changes to origin/${pr.branch}`)
			} else {
				logger.info('Pushing changes to remote...')
				await pushBranchToRemote(pr.branch, worktree.path, {
					dryRun: false
				})
				logger.success(`Changes pushed to PR #${parsed.number}`)
			}

			// Step 4: Log success and guidance
			logger.success(`PR #${parsed.number} updated successfully`)
			logger.info('Worktree remains active for continued work')
			logger.info(`To cleanup when done: il cleanup ${parsed.number}`)
		}
	}

	/**
	 * Execute workflow for GitHub PR creation (github-pr merge mode)
	 * Validates → Commits → Pushes → Creates PR → Prompts for cleanup
	 */
	private async executeGitHubPRWorkflow(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree,
		settings: import('../lib/SettingsManager.js').IloomSettings
	): Promise<void> {
		// Step 1: Push branch to origin
		if (options.dryRun) {
			logger.info('[DRY RUN] Would push branch to origin')
		} else {
			logger.info('Pushing branch to origin...')
			await pushBranchToRemote(worktree.branch, worktree.path, { dryRun: false })
			logger.success('Branch pushed successfully')
		}

		// Step 2: Initialize PRManager with settings
		const prManager = new PRManager(settings)

		// Step 3: Generate PR title from issue if available
		let prTitle = `Work from ${worktree.branch}`
		if (parsed.type === 'issue' && parsed.number) {
			// Try to fetch issue title for better PR title
			try {
				const issue = await this.issueTracker.fetchIssue(parsed.number)
				prTitle = issue.title
			} catch (error) {
				logger.debug('Could not fetch issue title, using branch name', { error })
			}
		}

		// Step 4: Create or open PR
		if (options.dryRun) {
			logger.info('[DRY RUN] Would create GitHub PR')
			logger.info(`  Title: ${prTitle}`)
			logger.info(`  Base: ${settings.mainBranch ?? 'main'}`)
		} else {
			const baseBranch = settings.mainBranch ?? 'main'
			const openInBrowser = options.noBrowser !== true

			const result = await prManager.createOrOpenPR(
				worktree.branch,
				prTitle,
				parsed.type === 'issue' ? parsed.number : undefined,
				baseBranch,
				worktree.path,
				openInBrowser
			)

			if (result.wasExisting) {
				logger.success(`Existing pull request: ${result.url}`)
			} else {
				logger.success(`Pull request created: ${result.url}`)
			}

			// Step 5: Interactive cleanup prompt (unless flags override)
			await this.handlePRCleanupPrompt(parsed, options, worktree)
		}
	}

	/**
	 * Handle cleanup prompt after PR creation
	 * Respects --cleanup and --no-cleanup flags, otherwise prompts user
	 */
	private async handlePRCleanupPrompt(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree
	): Promise<void> {
		if (options.cleanup === true) {
			// Explicit --cleanup flag: perform cleanup
			logger.info('Cleaning up worktree (--cleanup flag)...')
			await this.performWorktreeCleanup(parsed, options, worktree)
		} else if (options.cleanup === false) {
			// Explicit --no-cleanup flag: keep worktree
			logger.info('Worktree kept active for continued work (--no-cleanup flag)')
			logger.info(`To cleanup later: il cleanup ${parsed.originalInput}`)
		} else {
			// No flag: prompt user for decision
			logger.info('')
			logger.info('PR created successfully. Would you like to clean up the worktree?')
			logger.info(`  Worktree: ${worktree.path}`)
			logger.info(`  Branch: ${worktree.branch}`)
			logger.info('')

			const shouldCleanup = await promptConfirmation(
				'Clean up worktree now?',
				false // Default to keeping worktree (safer option)
			)

			if (shouldCleanup) {
				await this.performWorktreeCleanup(parsed, options, worktree)
			} else {
				logger.info('Worktree kept active. Run `il cleanup` when ready.')
			}
		}
	}

	/**
	 * Perform worktree cleanup (used by GitHub PR workflow)
	 * Similar to performPostMergeCleanup but for PR workflow
	 */
	private async performWorktreeCleanup(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree
	): Promise<void> {
		// Convert ParsedFinishInput to ParsedInput
		const cleanupInput: ParsedInput = {
			type: parsed.type,
			originalInput: parsed.originalInput,
			...(parsed.number !== undefined && { number: parsed.number }),
			...(parsed.branchName !== undefined && { branchName: parsed.branchName }),
		}

		const cleanupOptions: ResourceCleanupOptions = {
			dryRun: options.dryRun ?? false,
			deleteBranch: false, // Don't delete branch - PR still needs it
			keepDatabase: false, // Clean up database
			force: options.force ?? false,
		}

		try {
			logger.info('Starting worktree cleanup...')

			await this.ensureResourceCleanup()
			if (!this.resourceCleanup) {
				throw new Error('Failed to initialize ResourceCleanup')
			}

			const result = await this.resourceCleanup.cleanupWorktree(cleanupInput, cleanupOptions)

			// Report cleanup results
			this.reportCleanupResults(result)

			if (!result.success) {
				logger.warn('Some cleanup operations failed - manual cleanup may be required')
				this.showManualCleanupInstructions(worktree)
			} else {
				logger.success('Worktree cleanup completed successfully')
			}

			// Warn if running from within the worktree being finished
			if (this.isRunningFromWithinWorktree(worktree.path)) {
				this.showTerminalCloseWarning(worktree)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			logger.warn(`Cleanup failed: ${errorMessage}`)
			logger.warn('Manual cleanup may be required')
			this.showManualCleanupInstructions(worktree)
		}
	}

	/**
	 * Perform cleanup for closed/merged PRs
	 * Similar to performPostMergeCleanup but with different messaging
	 */
	private async performPRCleanup(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree
	): Promise<void> {
		// Convert to ParsedInput format
		const cleanupInput: ParsedInput = {
			type: parsed.type,
			originalInput: parsed.originalInput,
			...(parsed.number !== undefined && { number: parsed.number }),
			...(parsed.branchName !== undefined && { branchName: parsed.branchName }),
		}

		const cleanupOptions: ResourceCleanupOptions = {
			dryRun: options.dryRun ?? false,
			deleteBranch: true, // Delete branch for closed/merged PRs
			keepDatabase: false,
			force: options.force ?? false,
		}

		try {
			await this.ensureResourceCleanup()
			if (!this.resourceCleanup) {
				throw new Error('Failed to initialize ResourceCleanup')
			}
			const result = await this.resourceCleanup.cleanupWorktree(cleanupInput, cleanupOptions)

			this.reportCleanupResults(result)

			if (!result.success) {
				logger.warn('Some cleanup operations failed - manual cleanup may be required')
				this.showManualCleanupInstructions(worktree)
			} else {
				// Warn if running from within the worktree being finished (only on successful cleanup)
				if (this.isRunningFromWithinWorktree(worktree.path)) {
					this.showTerminalCloseWarning(worktree)
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			logger.warn(`Cleanup failed: ${errorMessage}`)
			this.showManualCleanupInstructions(worktree)
			throw error // Re-throw to fail the command
		}
	}

	/**
	 * Run post-merge build verification for CLI projects
	 * Runs in main worktree to verify merged code builds successfully
	 */
	private async runPostMergeBuild(
		worktreePath: string,
		options: FinishOptions
	): Promise<void> {
		// Find main worktree path
		const mainWorktreePath = await findMainWorktreePathWithSettings(worktreePath, this.settingsManager)

		// Check if dry-run
		if (options.dryRun) {
			logger.info('[DRY RUN] Would run post-merge build')
			return
		}

		logger.info('Running post-merge build...')

		const result = await this.buildRunner.runBuild(mainWorktreePath, {
			dryRun: options.dryRun ?? false,
		})

		if (result.skipped) {
			logger.debug(`Build skipped: ${result.reason}`)
		} else {
			logger.success('Post-merge build completed successfully')
		}
	}

	/**
	 * Perform post-merge cleanup operations
	 * Converts ParsedFinishInput to ParsedInput and calls ResourceCleanup
	 * Handles failures gracefully without throwing
	 */
	private async performPostMergeCleanup(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree
	): Promise<void> {
		// Ensure loomManager is initialized first
		await this.ensureResourceCleanup()
		if (!this.loomManager) {
			throw new Error('Failed to initialize LoomManager')
		}

		// Check for child looms again (second check - first was at start of execute)
		// This is a no-op if child looms were already checked and cleaned up
		await this.checkForChildLooms(parsed)

		// Convert ParsedFinishInput to ParsedInput (drop autoDetected field)
		const cleanupInput: ParsedInput = {
			type: parsed.type,
			originalInput: parsed.originalInput,
			...(parsed.number !== undefined && { number: parsed.number }),
			...(parsed.branchName !== undefined && { branchName: parsed.branchName }),
		}

		const cleanupOptions: ResourceCleanupOptions = {
			dryRun: options.dryRun ?? false,
			deleteBranch: true, // Delete branch after successful merge
			keepDatabase: false, // Clean up database after merge
			force: options.force ?? false,
		}

		try {
			logger.info('Starting post-merge cleanup...')

			if (!this.resourceCleanup) {
				throw new Error('Failed to initialize ResourceCleanup')
			}
			const result = await this.resourceCleanup.cleanupWorktree(cleanupInput, cleanupOptions)

			// Report cleanup results
			this.reportCleanupResults(result)

			if (!result.success) {
				logger.warn('Some cleanup operations failed - manual cleanup may be required')
				// Show helpful recovery message
				this.showManualCleanupInstructions(worktree)
			} else {
				logger.success('Post-merge cleanup completed successfully')
			}

			// Warn if running from within the worktree being finished
			if (this.isRunningFromWithinWorktree(worktree.path)) {
				this.showTerminalCloseWarning(worktree)
			}
		} catch (error) {
			// Catch cleanup errors to prevent finish command from failing
			// (merge already succeeded - cleanup failures are non-fatal)
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			logger.warn(`Cleanup failed: ${errorMessage}`)
			logger.warn('Merge completed successfully, but manual cleanup is required')
			this.showManualCleanupInstructions(worktree)
		}
	}

	/**
	 * Report cleanup operation results to user
	 */
	private reportCleanupResults(result: CleanupResult): void {
		if (result.operations.length === 0) {
			return
		}

		logger.info('Cleanup operations:')
		for (const op of result.operations) {
			const status = op.success ? '✓' : '✗'
			const message = op.error ? `${op.message}: ${op.error}` : op.message

			if (op.success) {
				logger.info(`  ${status} ${message}`)
			} else {
				logger.warn(`  ${status} ${message}`)
			}
		}
	}

	/**
	 * Show manual cleanup instructions when cleanup fails
	 */
	private showManualCleanupInstructions(worktree: GitWorktree): void {
		logger.info('\nManual cleanup commands:')
		logger.info(`  1. Remove worktree: git worktree remove ${worktree.path}`)
		logger.info(`  2. Delete branch: git branch -d ${worktree.branch}`)
		logger.info(`  3. Check dev servers: lsof -i :PORT (and kill if needed)`)
	}

	/**
	 * Check if current working directory is within the target worktree
	 */
	private isRunningFromWithinWorktree(worktreePath: string): boolean {
		const normalizedCwd = path.normalize(process.cwd())
		const normalizedWorktree = path.normalize(worktreePath)
		return normalizedCwd.startsWith(normalizedWorktree)
	}

	/**
	 * Display warning to close terminal/IDE when running from within finished loom
	 */
	private showTerminalCloseWarning(worktree: GitWorktree): void {
		logger.info('')
		logger.info('You are currently in the directory of the loom that was just finished.')
		logger.info('Please close this terminal and any IDE/terminal windows using this directory.')
		logger.info(`Directory: ${worktree.path}`)
	}
}
