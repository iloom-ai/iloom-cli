import { getLogger } from '../utils/logger-context.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
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
import { SessionSummaryService } from '../lib/SessionSummaryService.js'
import { findMainWorktreePathWithSettings, pushBranchToRemote, extractIssueNumber, getMergeTargetBranch, isPlaceholderCommit, findPlaceholderCommitSha, removePlaceholderCommitFromHead, removePlaceholderCommitFromHistory, executeGitCommand } from '../utils/git.js'
import { loadEnvIntoProcess } from '../utils/env.js'
import { installDependencies } from '../utils/package-manager.js'
import { createNeonProviderFromSettings } from '../utils/neon-helpers.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'
import { promptConfirmation } from '../utils/prompt.js'
import { UserAbortedCommitError, type FinishResult } from '../types/index.js'
import type { FinishOptions, GitWorktree, CommitOptions, MergeOptions, PullRequest } from '../types/index.js'
import type { ResourceCleanupOptions, CleanupResult } from '../types/cleanup.js'
import type { ParsedInput } from './start.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import path from 'path'

export interface FinishCommandInput {
	identifier?: string | undefined // Optional - can be auto-detected
	options: FinishOptions
}

export interface ParsedFinishInput {
	type: 'issue' | 'pr' | 'branch' | 'epic'
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
	private sessionSummaryService?: SessionSummaryService

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
			getLogger().debug(`Environment loading warning: ${envResult.error.message}`)
		}
		if (envResult.parsed) {
			getLogger().debug(`Loaded ${Object.keys(envResult.parsed).length} environment variables`)
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
			getLogger().debug(`Cannot determine target branch for child loom check`)
			return
		}

		// Check if the TARGET loom has any child looms
		const hasChildLooms = await this.loomManager.checkAndWarnChildLooms(targetBranch)
		if (hasChildLooms) {
			getLogger().error('Cannot finish loom while child looms exist. Please \'finish\' or \'cleanup\' child looms first.')
			process.exit(1)
		}
	}

	/**
	 * Main entry point for finish command
	 */
	public async execute(input: FinishCommandInput): Promise<FinishResult | void> {
		// Set ILOOM=1 so hooks know this is an iloom session
		process.env.ILOOM = '1'

		const isJsonMode = input.options.json === true

		// Initialize result object for JSON mode
		const result: FinishResult = {
			success: false,
			type: 'issue',
			identifier: '',
			dryRun: input.options.dryRun ?? false,
			operations: [],
		}

		// JSON mode validation - require explicit flags for interactive prompts
		if (isJsonMode) {
			const settings = await this.settingsManager.loadSettings()
			// In github-pr mode, require explicit --cleanup or --no-cleanup
			if ((settings.mergeBehavior?.mode === 'github-pr' || settings.mergeBehavior?.mode === 'github-draft-pr') && input.options.cleanup === undefined) {
				throw new Error('JSON mode with "github-pr"/"github-draft-pr" workflow requires --cleanup or --no-cleanup flag. Use: il finish --json --cleanup <identifier>')
			}
		}

		// Step 1: Load settings and get configured repo for GitHub operations
		const settings = await this.settingsManager.loadSettings()

		let repo: string | undefined

		// We need repo info if:
		// 1. Merge mode is github-pr (for creating PRs on GitHub, even with Linear issues)
		// 2. Provider is GitHub (for GitHub issue operations)
		// Note: bitbucket-pr mode handles repo detection internally via BitBucketVCSProvider
		const needsRepo =
			settings.mergeBehavior?.mode === 'github-pr' || settings.mergeBehavior?.mode === 'github-draft-pr' || this.issueTracker.providerName === 'github'
		if (needsRepo && (await hasMultipleRemotes())) {
			repo = await getConfiguredRepoFromSettings(settings)
			getLogger().info(`Using GitHub repository: ${repo}`)
		}

		// Step 2: Parse input (or auto-detect from current directory)
		const parsed = await this.parseInput(input.identifier, input.options)

		// Update result with parsed type and identifier
		result.type = parsed.type
		result.identifier = parsed.number ?? parsed.branchName ?? ''

		// Step 2.5: Check for child looms AFTER parsing input
		// This ensures we only block when finishing the CURRENT loom (parent), not a child
		await this.checkForChildLooms(parsed)

		// Step 2: Validate based on type and get worktrees
		const worktrees = await this.validateInput(parsed, input.options, repo)

		// Step 3: Log success
		getLogger().info(`Validated input: ${this.formatParsedInput(parsed)}`)

		// Get worktree for workflow execution
		const worktree = worktrees[0]
		if (!worktree) {
			throw new Error('No worktree found')
		}

		// Read metadata BEFORE workflow execution (cleanup may delete the worktree)
		let preFinishCreatedAt: string | undefined
		try {
			const metadataManager = new MetadataManager()
			const metadata = await metadataManager.readMetadata(worktree.path)
			preFinishCreatedAt = metadata?.created_at ?? undefined
		} catch (error: unknown) {
			getLogger().debug(`Failed to read metadata for telemetry: ${error instanceof Error ? error.message : String(error)}`)
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
			await this.executePRWorkflow(parsed, input.options, worktree, pr, result)
		} else {
			// Execute traditional issue/branch workflow
			await this.executeIssueWorkflow(parsed, input.options, worktree, result)
		}

		// Mark overall success if we got here without throwing
		result.success = true

		// Track loom.finished telemetry event
		try {
			const durationMinutes = preFinishCreatedAt
				? Math.round((Date.now() - new Date(preFinishCreatedAt).getTime()) / 60000)
				: 0
			TelemetryService.getInstance().track('loom.finished', {
				merge_behavior: (settings.mergeBehavior?.mode as 'local' | 'github-pr' | 'github-draft-pr') ?? 'local',
				duration_minutes: isNaN(durationMinutes) ? 0 : durationMinutes,
			})
		} catch (error: unknown) {
			getLogger().debug(`Failed to track loom.finished telemetry: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Return result in JSON mode
		if (isJsonMode) {
			return result
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

		// For issue types, get original issue key from metadata (preserves case for Jira/Linear IDs)
		if (result.type === 'issue' && result.number !== undefined) {
			const worktree = await this.gitWorktreeManager.findWorktreeForIssue(result.number)
			if (worktree) {
				const { MetadataManager } = await import('../lib/MetadataManager.js')
				const metadataManager = new MetadataManager()
				const metadata = await metadataManager.readMetadata(worktree.path)
				const canonicalKey = metadata?.issueKey ?? metadata?.issue_numbers?.[0]
				if (canonicalKey) {
					result.number = canonicalKey
				}
			}
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
			getLogger().debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)
			return {
				type: 'pr',
				number: prNumber,
				originalInput: currentDir,
				autoDetected: true,
			}
		}

		// Read metadata to get original issue key (preserves case for Jira/Linear IDs)
		// process.cwd() is the worktree path when auto-detecting
		const { MetadataManager } = await import('../lib/MetadataManager.js')
		const metadataManager = new MetadataManager()
		const metadata = await metadataManager.readMetadata(process.cwd())

		// Check for issue pattern in directory or branch name
		const issueNumber = extractIssueNumber(currentDir)

		if (issueNumber !== null) {
			// Use issueKey from metadata (canonical case), then issue_numbers, then extracted (lowercase)
			const originalIssueKey = metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? issueNumber
			getLogger().debug(
				`Auto-detected issue #${originalIssueKey} from directory: ${currentDir}`
			)
			return {
				type: 'issue',
				number: originalIssueKey,
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
		const branchIssueNumber = extractIssueNumber(currentBranch)
		if (branchIssueNumber !== null) {
			// Use issueKey from metadata (canonical case), then issue_numbers, then extracted (lowercase)
			const originalIssueKey = metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? branchIssueNumber
			getLogger().debug(
				`Auto-detected issue #${originalIssueKey} from branch: ${currentBranch}`
			)
			return {
				type: 'issue',
				number: originalIssueKey,
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
				getLogger().debug(`Validated PR #${parsed.number} (state: ${pr.state})`)

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

				getLogger().debug(`Validated issue #${parsed.number} (state: ${issue.state})`)

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

				getLogger().debug(`Validated branch name: ${parsed.branchName}`)

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

		getLogger().debug(`Found worktree: ${worktree.path}`)

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
	 * This is the workflow: rebase → validate → commit → merge → cleanup
	 */
	private async executeIssueWorkflow(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree,
		result: FinishResult
	): Promise<void> {
		// Define merge options early so they're available for all code paths
		const mergeOptions: MergeOptions = {
			dryRun: options.dryRun ?? false,
			force: options.force ?? false,
		}

		// Skip rebase/validation/commit steps if --skip-to-pr flag is set (debug mode)
		if (options.skipToPr) {
			getLogger().info('Skipping rebase/validation/commit (--skip-to-pr flag)')
		} else {
			// Step 1: Rebase branch on main FIRST (Issue #344)
			// This ensures validation runs against the rebased code (with latest main changes)
			getLogger().info('Rebasing branch on main...')

			await this.mergeManager.rebaseOnMain(worktree.path, mergeOptions)
			getLogger().success('Branch rebased successfully')
			result.operations.push({
				type: 'rebase',
				message: 'Branch rebased on main',
				success: true,
			})

			// Step 2: Run pre-merge validations AFTER rebase (Issue #344)
			// Validates code with latest main changes integrated
			if (!options.dryRun) {
				getLogger().info('Running pre-merge validations...')

				await this.validationRunner.runValidations(worktree.path, {
					dryRun: options.dryRun ?? false,
				})
				getLogger().success('All validations passed')
				result.operations.push({
					type: 'validation',
					message: 'Pre-merge validations passed',
					success: true,
				})
			} else {
				getLogger().info('[DRY RUN] Would run pre-merge validations')
				result.operations.push({
					type: 'validation',
					message: 'Would run pre-merge validations (dry-run)',
					success: true,
				})
			}

			// Step 3: Detect uncommitted changes AFTER validation passes
			const gitStatus = await this.commitManager.detectUncommittedChanges(worktree.path)

			// Step 4: Commit changes only if validation passed AND changes exist
			if (gitStatus.hasUncommittedChanges) {
				if (options.dryRun) {
					getLogger().info('[DRY RUN] Would auto-commit uncommitted changes (validation passed)')
					result.operations.push({
						type: 'commit',
						message: 'Would auto-commit uncommitted changes (dry-run)',
						success: true,
					})
				} else {
					getLogger().info('Validation passed, auto-committing uncommitted changes...')

					// Load settings to get skipVerify configuration and issuePrefix
					const settings = await this.settingsManager.loadSettings(worktree.path)
					const skipVerify = settings.workflows?.issue?.noVerify ?? false
					const providerType = settings.issueManagement?.provider ?? 'github'
					const issuePrefix = IssueManagementProviderFactory.create(providerType, settings).issuePrefix

					const commitOptions: CommitOptions = {
						dryRun: options.dryRun ?? false,
						skipVerify,
						issuePrefix,
						timeout: settings.git?.commitTimeout,
					}

					// Only add issueNumber if it's an issue
					// Note: parsed.number already has correct case from parseInput() metadata lookup
					if (parsed.type === 'issue' && parsed.number) {
						commitOptions.issueNumber = parsed.number
					}

					try {
						await this.commitManager.commitChanges(worktree.path, commitOptions)
						getLogger().success('Changes committed successfully')
						result.operations.push({
							type: 'commit',
							message: 'Changes committed successfully',
							success: true,
						})
					} catch (error) {
						if (error instanceof UserAbortedCommitError) {
							getLogger().info('Commit aborted by user')
							result.operations.push({
								type: 'commit',
								message: 'Commit aborted by user',
								success: false,
							})
							throw error  // Propagate to CLI for non-zero exit
						}
						throw error  // Re-throw other errors
					}
				}
			} else {
				getLogger().debug('No uncommitted changes found')
			}
		}

		// Step 5: Check merge mode from settings and branch workflow
		const settings = await this.settingsManager.loadSettings(worktree.path)
		const mergeBehavior = settings.mergeBehavior ?? { mode: 'local' }

		if (mergeBehavior.mode === 'github-pr') {
			// Execute github-pr workflow instead of local merge
			await this.executeGitHubPRWorkflow(parsed, options, worktree, settings, result)
			return
		}

		if (mergeBehavior.mode === 'github-draft-pr') {
			// Read metadata to get draft PR number
			const { MetadataManager } = await import('../lib/MetadataManager.js')
			const metadataManager = new MetadataManager()
			const metadata = await metadataManager.readMetadata(worktree.path)

			getLogger().debug(`Draft PR mode: worktree=${worktree.path}, draftPrNumber=${metadata?.draftPrNumber ?? 'none'}`)

			if (!metadata?.draftPrNumber) {
				// Fallback: no draft PR exists, treat like github-pr mode
				getLogger().warn('No draft PR found in metadata, creating new PR...')
				await this.executeGitHubPRWorkflow(parsed, options, worktree, settings, result)
				return
			}

			// Check for and remove placeholder commit before push
			// The placeholder was created during `il start` to enable draft PR creation
			const isHeadPlaceholder = await isPlaceholderCommit(worktree.path)
			const placeholderSha = await findPlaceholderCommitSha(worktree.path)

			getLogger().debug(`Placeholder detection: isHead=${isHeadPlaceholder}, sha=${placeholderSha ?? 'none'}`)

			if (isHeadPlaceholder) {
				// Case 1: Placeholder is HEAD (no user commits made)
				// Check if there are any other commits
				const commitCount = await executeGitCommand(
					['rev-list', '--count', 'HEAD'],
					{ cwd: worktree.path }
				)

				if (parseInt(commitCount.trim(), 10) <= 1) {
					throw new Error(
						'Cannot finish draft PR: no changes have been committed.\n' +
						'Please make at least one commit before finishing.'
					)
				}

				// Reset to remove placeholder (user commits exist behind it - unusual case)
				if (!options.dryRun) {
					getLogger().info('Removing placeholder commit from HEAD...')
					await removePlaceholderCommitFromHead(worktree.path)
				} else {
					getLogger().info('[DRY RUN] Would remove placeholder commit from HEAD')
				}
			} else if (placeholderSha) {
				// Case 2: Placeholder is in history (user made commits on top)
				// Verify there are actually commits AFTER the placeholder before rebasing
				const commitsAfterPlaceholder = await executeGitCommand(
					['rev-list', '--count', `${placeholderSha}..HEAD`],
					{ cwd: worktree.path }
				)

				if (parseInt(commitsAfterPlaceholder.trim(), 10) === 0) {
					// No commits after placeholder - something is wrong
					// Either placeholder IS HEAD (isPlaceholderCommit check failed) or history is corrupt
					throw new Error(
						'Cannot finish draft PR: no changes have been committed after the placeholder.\n' +
						'Please make at least one commit before finishing.'
					)
				}

				if (!options.dryRun) {
					getLogger().info('Removing placeholder commit from history...')
					await removePlaceholderCommitFromHistory(worktree.path, placeholderSha)
				} else {
					getLogger().info('[DRY RUN] Would remove placeholder commit from history')
				}
			}

			// Push final commits - always use force-with-lease in draft PR mode
			// Rebase onto main (line 611) changes commit SHAs, causing local history to diverge from remote
			// Even if placeholder wasn't removed, the rebased commits need force push
			if (!options.dryRun) {
				getLogger().info('Pushing final commits to remote...')
				await executeGitCommand(['push', '--force-with-lease', 'origin', worktree.branch], { cwd: worktree.path })
			} else {
				getLogger().info('[DRY RUN] Would force push final commits to remote (rebased history)')
			}

			// Mark draft PR as ready
			const prManager = new PRManager(settings)
			if (!options.dryRun) {
				await prManager.markPRReady(metadata.draftPrNumber, worktree.path)
				getLogger().success(`PR #${metadata.draftPrNumber} marked as ready for review`)
			} else {
				getLogger().info(`[DRY RUN] Would mark PR #${metadata.draftPrNumber} as ready for review`)
			}

			// Set PR URL in result
			const prUrl = metadata.prUrls?.[String(metadata.draftPrNumber)]
			if (prUrl) {
				result.prUrl = prUrl
			}

			// Open PR in browser if configured and not suppressed
			const shouldOpenBrowser = !options.dryRun
				&& !options.noBrowser
				&& !options.json
				&& settings.mergeBehavior?.openBrowserOnFinish !== false
			if (shouldOpenBrowser && prUrl) {
				await prManager.openPRInBrowser(prUrl)
			}

			result.operations.push({
				type: 'pr-ready',
				message: `PR #${metadata.draftPrNumber} marked as ready for review`,
				success: true,
			})

			// Generate session summary if configured - post to PR, not issue
			await this.generateSessionSummaryIfConfigured(parsed, worktree, options, metadata.draftPrNumber)

			// Handle cleanup prompt (reuse existing logic)
			await this.handlePRCleanupPrompt(parsed, options, worktree, result)
			return
		}

		// Step 6: Perform fast-forward merge
		getLogger().info('Performing fast-forward merge...')
		await this.mergeManager.performFastForwardMerge(worktree.branch, worktree.path, mergeOptions)
		getLogger().success('Fast-forward merge completed successfully')
		result.operations.push({
			type: 'merge',
			message: 'Fast-forward merge completed',
			success: true,
		})

		// Step 5.5: Install dependencies in main worktree
		if (options.dryRun) {
			getLogger().info('[DRY RUN] Would install dependencies in main worktree')
		} else {
			getLogger().info('Installing dependencies in main worktree...')
			const mainWorktreePath = await findMainWorktreePathWithSettings(worktree.path, this.settingsManager)
			await installDependencies(mainWorktreePath, true, true)
		}

		// Step 5.6: Run post-merge build verification (CLI projects only)
		if (!options.skipBuild) {
			await this.runPostMergeBuild(worktree.path, options, result)
		} else {
			getLogger().debug('Skipping build verification (--skip-build flag provided)')
		}

		// Step 5.7: Generate session summary (non-blocking, preview-only in dry-run)
		await this.generateSessionSummaryIfConfigured(parsed, worktree, options)

		// Step 5.8: Archive metadata BEFORE cleanup decision (ensures it runs even with --no-cleanup)
		const { MetadataManager } = await import('../lib/MetadataManager.js')
		const metadataManager = new MetadataManager()
		if (!options.dryRun) {
			await metadataManager.archiveMetadata(worktree.path)
		}

		// Step 6: Post-merge cleanup (respects --cleanup / --no-cleanup flags)
		if (options.cleanup === false) {
			// Explicit --no-cleanup flag: keep worktree
			getLogger().info('Worktree kept active (--no-cleanup flag)')
			getLogger().info(`To cleanup later: il cleanup ${parsed.originalInput}`)
		} else {
			// Default behavior (cleanup=true or undefined): perform cleanup
			await this.performPostMergeCleanup(parsed, options, worktree, result)
		}
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
		pr: PullRequest,
		result: FinishResult
	): Promise<void> {
		// Branch based on PR state
		if (pr.state === 'closed' || pr.state === 'merged') {
			// Closed/Merged PR workflow
			getLogger().info(`PR #${parsed.number} is ${pr.state.toUpperCase()} - skipping to cleanup`)

			// Check for uncommitted changes and warn (unless --force)
			const gitStatus = await this.commitManager.detectUncommittedChanges(worktree.path)
			if (gitStatus.hasUncommittedChanges && !options.force) {
				getLogger().warn('PR has uncommitted changes')
				throw new Error(
					'Cannot cleanup PR with uncommitted changes. ' +
					'Commit or stash changes, then run again with --force to cleanup anyway.'
				)
			}

			// Archive metadata BEFORE cleanup (ensures it runs regardless of cleanup flags)
			const { MetadataManager } = await import('../lib/MetadataManager.js')
			const metadataManager = new MetadataManager()
			if (!options.dryRun) {
				await metadataManager.archiveMetadata(worktree.path)
			}

			// Call cleanup directly with deleteBranch: true
			// Pass PR state to enable appropriate safety checks:
			// - merged: skip checks (work is in main)
			// - closed: enable checks (may have unpushed commits)
			await this.performPRCleanup(parsed, options, worktree, pr.state as 'closed' | 'merged', result)

			getLogger().success(`PR #${parsed.number} cleanup completed`)
			result.operations.push({
				type: 'cleanup',
				message: `PR #${parsed.number} cleanup completed`,
				success: true,
			})
		} else {
			// Open PR workflow
			getLogger().info(`PR #${parsed.number} is OPEN - will push changes and keep worktree active`)

			// Step 1: Detect uncommitted changes
			const gitStatus = await this.commitManager.detectUncommittedChanges(worktree.path)

			// Step 2: Commit changes if any exist
			if (gitStatus.hasUncommittedChanges) {
				if (options.dryRun) {
					getLogger().info('[DRY RUN] Would commit uncommitted changes')
					result.operations.push({
						type: 'commit',
						message: 'Would commit uncommitted changes (dry-run)',
						success: true,
					})
				} else {
					getLogger().info('Committing uncommitted changes...')

					// Load settings to get skipVerify configuration and issuePrefix
					const settings = await this.settingsManager.loadSettings(worktree.path)
					const skipVerify = settings.workflows?.pr?.noVerify ?? false
					const providerType = settings.issueManagement?.provider ?? 'github'
					const issuePrefix = IssueManagementProviderFactory.create(providerType, settings).issuePrefix

					try {
						await this.commitManager.commitChanges(worktree.path, {
							dryRun: false,
							skipVerify,
							issuePrefix,
							timeout: settings.git?.commitTimeout,
							// Do NOT pass issueNumber for PRs - no "Fixes #" trailer needed
						})
						getLogger().success('Changes committed')
						result.operations.push({
							type: 'commit',
							message: 'Changes committed successfully',
							success: true,
						})
					} catch (error) {
						if (error instanceof UserAbortedCommitError) {
							getLogger().info('Commit aborted by user')
							result.operations.push({
								type: 'commit',
								message: 'Commit aborted by user',
								success: false,
							})
							throw error  // Propagate to CLI for non-zero exit
						}
						throw error  // Re-throw other errors
					}
				}
			} else {
				getLogger().debug('No uncommitted changes found')
			}

			// Step 3: Push to remote
			if (options.dryRun) {
				getLogger().info(`[DRY RUN] Would push changes to origin/${pr.branch}`)
			} else {
				getLogger().info('Pushing changes to remote...')
				await pushBranchToRemote(pr.branch, worktree.path, {
					dryRun: false
				})
				getLogger().success(`Changes pushed to PR #${parsed.number}`)
			}

			// Step 4: Log success and guidance
			getLogger().success(`PR #${parsed.number} updated successfully`)
			getLogger().info('Worktree remains active for continued work')
			getLogger().info(`To cleanup when done: il cleanup ${parsed.number}`)

			// Set PR URL in result
			result.prUrl = pr.url
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
		settings: import('../lib/SettingsManager.js').IloomSettings,
		finishResult: FinishResult
	): Promise<void> {
		// Step 1: Push branch to origin
		if (options.dryRun) {
			getLogger().info('[DRY RUN] Would push branch to origin')
		} else {
			getLogger().info('Pushing branch to origin...')
			await pushBranchToRemote(worktree.branch, worktree.path, { dryRun: false })
			getLogger().success('Branch pushed successfully')
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
				getLogger().debug('Could not fetch issue title, using branch name', { error })
			}
		}

		// Step 4: Get base branch (respects parent loom metadata for child looms)
		const baseBranch = await getMergeTargetBranch(worktree.path)

		// Step 5: Create or open PR
		if (options.dryRun) {
			getLogger().info('[DRY RUN] Would create GitHub PR')
			getLogger().info(`  Title: ${prTitle}`)
			getLogger().info(`  Base: ${baseBranch}`)
			finishResult.operations.push({
				type: 'pr-creation',
				message: 'Would create GitHub PR (dry-run)',
				success: true,
			})
		} else {
			const openInBrowser = !options.noBrowser
				&& !options.json
				&& settings.mergeBehavior?.openBrowserOnFinish !== false

			const prResult = await prManager.createOrOpenPR(
				worktree.branch,
				prTitle,
				parsed.type === 'issue' ? parsed.number : undefined,
				baseBranch,
				worktree.path,
				openInBrowser
			)

			if (prResult.wasExisting) {
				getLogger().success(`Existing pull request: ${prResult.url}`)
				finishResult.operations.push({
					type: 'pr-creation',
					message: `Found existing pull request`,
					success: true,
				})
			} else {
				getLogger().success(`Pull request created: ${prResult.url}`)
				finishResult.operations.push({
					type: 'pr-creation',
					message: `Pull request created`,
					success: true,
				})

				// Move issue to Ready for Review state
				if (parsed.type === 'issue' && parsed.number) {
					try {
						if (this.issueTracker.moveIssueToReadyForReview) {
							await this.issueTracker.moveIssueToReadyForReview(parsed.number)
							getLogger().info('Issue moved to Ready for Review')
						}
					} catch (error) {
						getLogger().warn(
							`Failed to move issue to Ready for Review: ${error instanceof Error ? error.message : 'Unknown error'}`,
							error
						)
					}
				}
			}

			// Set PR URL in result
			finishResult.prUrl = prResult.url

			// Step 4.5: Generate session summary (non-blocking, preview-only in dry-run)
			// Post to the PR instead of the original issue
			await this.generateSessionSummaryIfConfigured(parsed, worktree, options, prResult.number)

			// Step 4.6: Archive metadata BEFORE cleanup prompt (ensures it runs even with --no-cleanup)
			const { MetadataManager } = await import('../lib/MetadataManager.js')
			const metadataManager = new MetadataManager()
			if (!options.dryRun) {
				await metadataManager.archiveMetadata(worktree.path)
			}

			// Step 5: Interactive cleanup prompt (unless flags override)
			await this.handlePRCleanupPrompt(parsed, options, worktree, finishResult)
		}
	}

	/**
	 * Handle cleanup prompt after PR creation
	 * Respects --cleanup and --no-cleanup flags, otherwise prompts user
	 */
	private async handlePRCleanupPrompt(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree,
		finishResult: FinishResult
	): Promise<void> {
		if (options.cleanup === true) {
			// Explicit --cleanup flag: perform cleanup
			getLogger().info('Cleaning up worktree (--cleanup flag)...')
			await this.performWorktreeCleanup(parsed, options, worktree, finishResult)
		} else if (options.cleanup === false) {
			// Explicit --no-cleanup flag: keep worktree
			getLogger().info('Worktree kept active for continued work (--no-cleanup flag)')
			getLogger().info(`To cleanup later: il cleanup ${parsed.originalInput}`)
		} else {
			// No flag: prompt user for decision
			getLogger().info('')
			getLogger().info('PR created successfully. Would you like to clean up the worktree?')
			getLogger().info(`  Worktree: ${worktree.path}`)
			getLogger().info(`  Branch: ${worktree.branch}`)
			getLogger().info('')

			const shouldCleanup = await promptConfirmation(
				'Clean up worktree now?',
				true // Default to keeping worktree - won't delete if unmerged changes
			)

			if (shouldCleanup) {
				await this.performWorktreeCleanup(parsed, options, worktree, finishResult)
			} else {
				getLogger().info('Worktree kept active. Run `il cleanup` when ready.')
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
		worktree: GitWorktree,
		finishResult: FinishResult
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
			worktree: { path: worktree.path, branch: worktree.branch },
		}

		try {
			getLogger().info('Starting worktree cleanup...')

			await this.ensureResourceCleanup()
			if (!this.resourceCleanup) {
				throw new Error('Failed to initialize ResourceCleanup')
			}

			const cleanupResult = await this.resourceCleanup.cleanupWorktree(cleanupInput, cleanupOptions)

			// Report cleanup results
			this.reportCleanupResults(cleanupResult)

			// Add cleanup result to finish result
			finishResult.cleanupResult = cleanupResult

			if (!cleanupResult.success) {
				getLogger().warn('Some cleanup operations failed - manual cleanup may be required')
				this.showManualCleanupInstructions(worktree)
				finishResult.operations.push({
					type: 'cleanup',
					message: 'Worktree cleanup partially failed',
					success: false,
				})
			} else {
				getLogger().success('Worktree cleanup completed successfully')
				finishResult.operations.push({
					type: 'cleanup',
					message: 'Worktree cleanup completed',
					success: true,
				})
			}

			// Warn if running from within the worktree being finished
			if (this.isRunningFromWithinWorktree(worktree.path)) {
				this.showTerminalCloseWarning(worktree)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			getLogger().warn(`Cleanup failed: ${errorMessage}`)
			getLogger().warn('Manual cleanup may be required')
			this.showManualCleanupInstructions(worktree)
			finishResult.operations.push({
				type: 'cleanup',
				message: 'Worktree cleanup failed',
				success: false,
				error: errorMessage,
			})
		}
	}

	/**
	 * Perform cleanup for closed/merged PRs
	 * Similar to performPostMergeCleanup but with different messaging
	 *
	 * Safety check behavior differs based on PR state:
	 * - MERGED: Skip safety checks - work is safely in main branch
	 * - CLOSED (not merged): Enable safety checks - PR was rejected/abandoned,
	 *   local commits may not exist anywhere else
	 *
	 * @param parsed - Parsed input identifying the PR
	 * @param options - Finish options
	 * @param worktree - The worktree to clean up
	 * @param prState - The PR state ('closed' or 'merged')
	 * @param finishResult - Result object to populate
	 */
	private async performPRCleanup(
		parsed: ParsedFinishInput,
		options: FinishOptions,
		worktree: GitWorktree,
		prState: 'closed' | 'merged',
		finishResult: FinishResult
	): Promise<void> {
		// Convert to ParsedInput format
		const cleanupInput: ParsedInput = {
			type: parsed.type,
			originalInput: parsed.originalInput,
			...(parsed.number !== undefined && { number: parsed.number }),
			...(parsed.branchName !== undefined && { branchName: parsed.branchName }),
		}

		// Safety checks depend on PR state:
		// - MERGED PR: Work is safely in main - skip all safety checks
		// - CLOSED PR: Work may NOT be on GitHub (PR was rejected/abandoned) - check for unpushed commits
		const isMerged = prState === 'merged'

		const cleanupOptions: ResourceCleanupOptions = {
			dryRun: options.dryRun ?? false,
			deleteBranch: true, // Delete branch for closed/merged PRs
			keepDatabase: false,
			force: options.force ?? false,
			// For merged PRs: skip merge check (work is in main)
			// For closed PRs: enable merge check (may have unpushed local commits)
			checkMergeSafety: !isMerged,
			// Skip remote branch check for MERGED PRs because:
			// 1. The PR is merged - the work is safely in main
			// 2. GitHub may have auto-deleted the branch after merge
			// 3. The user may have manually deleted the remote branch post-merge
			//
			// For CLOSED PRs, we rely on checkMergeSafety to verify no unpushed commits
			// rather than checkRemoteBranch, since the remote branch may still exist
			// but local may have additional commits
			checkRemoteBranch: false,
			worktree: { path: worktree.path, branch: worktree.branch },
		}

		try {
			await this.ensureResourceCleanup()
			if (!this.resourceCleanup) {
				throw new Error('Failed to initialize ResourceCleanup')
			}
			const cleanupResult = await this.resourceCleanup.cleanupWorktree(cleanupInput, cleanupOptions)

			this.reportCleanupResults(cleanupResult)
			finishResult.cleanupResult = cleanupResult

			if (!cleanupResult.success) {
				getLogger().warn('Some cleanup operations failed - manual cleanup may be required')
				this.showManualCleanupInstructions(worktree)
			} else {
				// Warn if running from within the worktree being finished (only on successful cleanup)
				if (this.isRunningFromWithinWorktree(worktree.path)) {
					this.showTerminalCloseWarning(worktree)
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			getLogger().warn(`Cleanup failed: ${errorMessage}`)
			this.showManualCleanupInstructions(worktree)
			throw error // Re-throw to fail the command
		}
	}

	/**
	 * Generate and post session summary if configured
	 *
	 * Non-blocking: Catches all errors and logs warnings instead of throwing
	 * This ensures the finish workflow continues even if summary generation fails
	 *
	 * In dry-run mode: generates summary and shows preview, but doesn't post
	 *
	 * @param parsed - The parsed input identifying the issue/PR being finished
	 * @param worktree - The worktree being finished
	 * @param options - Finish options (including dryRun flag)
	 * @param prNumber - Optional PR number - when provided, summary is posted to the PR instead of the issue
	 */
	private async generateSessionSummaryIfConfigured(
		parsed: ParsedFinishInput,
		worktree: GitWorktree,
		options: FinishOptions,
		prNumber?: number
	): Promise<void> {
		// Skip for branch type (no issue to comment on)
		if (parsed.type === 'branch') {
			return
		}

		// Initialize SessionSummaryService lazily
		this.sessionSummaryService ??= new SessionSummaryService(
			undefined, // Use default PromptTemplateManager
			undefined, // Use default MetadataManager
			this.settingsManager
		)

		if (options.dryRun) {
			// In dry-run mode: generate but don't post, show preview
			try {
				const result = await this.sessionSummaryService.generateSummary(
					worktree.path,
					worktree.branch,
					parsed.type,
					parsed.number
				)
				const preview = result.summary.slice(0, 100).replace(/\n/g, ' ')
				getLogger().info(`[DRY RUN] Would post session summary: "${preview}..."`)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				getLogger().warn(`[DRY RUN] Session summary generation failed: ${errorMessage}`)
			}
			return
		}

		// Generate and post summary (non-blocking)
		// When prNumber is provided, summary is posted to the PR instead of the issue
		await this.sessionSummaryService.generateAndPostSummary({
			worktreePath: worktree.path,
			issueNumber: parsed.number ?? 0,
			branchName: worktree.branch,
			loomType: parsed.type,
			...(prNumber !== undefined && { prNumber }),
		})
	}

	/**
	 * Run post-merge build verification for CLI projects
	 * Runs in main worktree to verify merged code builds successfully
	 */
	private async runPostMergeBuild(
		worktreePath: string,
		options: FinishOptions,
		finishResult: FinishResult
	): Promise<void> {
		// Find main worktree path
		const mainWorktreePath = await findMainWorktreePathWithSettings(worktreePath, this.settingsManager)

		// Check if dry-run
		if (options.dryRun) {
			getLogger().info('[DRY RUN] Would run post-merge build')
			finishResult.operations.push({
				type: 'build',
				message: 'Would run post-merge build (dry-run)',
				success: true,
			})
			return
		}

		getLogger().info('Running post-merge build...')

		const buildResult = await this.buildRunner.runBuild(mainWorktreePath, {
			dryRun: options.dryRun ?? false,
		})

		if (buildResult.skipped) {
			getLogger().debug(`Build skipped: ${buildResult.reason}`)
			finishResult.operations.push({
				type: 'build',
				message: `Build skipped: ${buildResult.reason}`,
				success: true,
			})
		} else {
			getLogger().success('Post-merge build completed successfully')
			finishResult.operations.push({
				type: 'build',
				message: 'Post-merge build completed',
				success: true,
			})
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
		worktree: GitWorktree,
		finishResult: FinishResult
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
			worktree: { path: worktree.path, branch: worktree.branch },
		}

		try {
			getLogger().info('Starting post-merge cleanup...')

			if (!this.resourceCleanup) {
				throw new Error('Failed to initialize ResourceCleanup')
			}
			const cleanupResult = await this.resourceCleanup.cleanupWorktree(cleanupInput, cleanupOptions)

			// Report cleanup results
			this.reportCleanupResults(cleanupResult)
			finishResult.cleanupResult = cleanupResult

			if (!cleanupResult.success) {
				getLogger().warn('Some cleanup operations failed - manual cleanup may be required')
				// Show helpful recovery message
				this.showManualCleanupInstructions(worktree)
				finishResult.operations.push({
					type: 'cleanup',
					message: 'Post-merge cleanup partially failed',
					success: false,
				})
			} else {
				getLogger().success('Post-merge cleanup completed successfully')
				finishResult.operations.push({
					type: 'cleanup',
					message: 'Post-merge cleanup completed',
					success: true,
				})
			}

			// Warn if running from within the worktree being finished
			if (this.isRunningFromWithinWorktree(worktree.path)) {
				this.showTerminalCloseWarning(worktree)
			}
		} catch (error) {
			// Catch cleanup errors to prevent finish command from failing
			// (merge already succeeded - cleanup failures are non-fatal)
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			getLogger().warn(`Cleanup failed: ${errorMessage}`)
			getLogger().warn('Merge completed successfully, but manual cleanup is required')
			this.showManualCleanupInstructions(worktree)
			finishResult.operations.push({
				type: 'cleanup',
				message: 'Post-merge cleanup failed',
				success: false,
				error: errorMessage,
			})
		}
	}

	/**
	 * Report cleanup operation results to user
	 */
	private reportCleanupResults(result: CleanupResult): void {
		if (result.operations.length === 0) {
			return
		}

		getLogger().info('Cleanup operations:')
		for (const op of result.operations) {
			const status = op.success ? '✓' : '✗'
			const message = op.error ? `${op.message}: ${op.error}` : op.message

			if (op.success) {
				getLogger().info(`  ${status} ${message}`)
			} else {
				getLogger().warn(`  ${status} ${message}`)
			}
		}
	}

	/**
	 * Show manual cleanup instructions when cleanup fails
	 */
	private showManualCleanupInstructions(worktree: GitWorktree): void {
		getLogger().info('\nManual cleanup commands:')
		getLogger().info(`  1. Remove worktree: git worktree remove ${worktree.path}`)
		getLogger().info(`  2. Delete branch: git branch -d ${worktree.branch}`)
		getLogger().info(`  3. Check dev servers: lsof -i :PORT (and kill if needed)`)
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
		getLogger().info('')
		getLogger().info('You are currently in the directory of the loom that was just finished.')
		getLogger().info('Please close this terminal and any IDE/terminal windows using this directory.')
		getLogger().info(`Directory: ${worktree.path}`)
	}
}
