import path from 'path'
import { getLogger } from '../utils/logger-context.js'
import type { IssueTracker } from '../lib/IssueTracker.js'
import { GitHubService } from '../lib/GitHubService.js'
import { LoomManager } from '../lib/LoomManager.js'
import { DefaultBranchNamingService } from '../lib/BranchNamingService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { EnvironmentManager } from '../lib/EnvironmentManager.js'
import { ClaudeContextManager } from '../lib/ClaudeContextManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { CLIIsolationManager } from '../lib/CLIIsolationManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { AgentManager } from '../lib/AgentManager.js'
import { DatabaseManager } from '../lib/DatabaseManager.js'
import { findMainWorktreePathWithSettings } from '../utils/git.js'
import { matchIssueIdentifier } from '../utils/IdentifierParser.js'
import { loadEnvIntoProcess } from '../utils/env.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import { createNeonProviderFromSettings } from '../utils/neon-helpers.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'
import { capitalizeFirstLetter } from '../utils/text.js'
import type { StartOptions, StartResult } from '../types/index.js'
import { launchFirstRunSetup, needsFirstRunSetup } from '../utils/first-run-setup.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'

export interface StartCommandInput {
	identifier: string
	options: StartOptions
}

export interface ParsedInput {
	type: 'issue' | 'pr' | 'branch' | 'description'
	number?: string | number
	branchName?: string
	originalInput: string
}

export class StartCommand {
	private issueTracker: IssueTracker
	private loomManager: LoomManager | null = null
	private settingsManager: SettingsManager
	private providedLoomManager: LoomManager | undefined
	private githubService: GitHubService | null = null

	constructor(
		issueTracker: IssueTracker,
		loomManager?: LoomManager,
		_agentManager?: AgentManager,  // Kept for API compatibility
		settingsManager?: SettingsManager
	) {
		this.issueTracker = issueTracker
		this.settingsManager = settingsManager ?? new SettingsManager()
		// Store provided LoomManager for testing, but don't initialize yet
		this.providedLoomManager = loomManager

		// Load environment variables first
		const envResult = loadEnvIntoProcess()
		if (envResult.error) {
			getLogger().debug(`Environment loading warning: ${envResult.error.message}`)
		}
		if (envResult.parsed) {
			getLogger().debug(`Loaded ${Object.keys(envResult.parsed).length} environment variables`)
		}
	}

	/**
	 * Get or create a GitHubService instance for PR operations
	 * Used when the configured issue tracker doesn't support PRs (e.g., Linear)
	 */
	private getGitHubService(): GitHubService {
		this.githubService ??= new GitHubService()
		return this.githubService
	}

	/**
	 * Initialize LoomManager with the main worktree path
	 * Uses lazy initialization to ensure we have the correct path
	 */
	private async initializeLoomManager(): Promise<LoomManager> {
		if (this.loomManager) {
			return this.loomManager
		}

		if (this.providedLoomManager) {
			this.loomManager = this.providedLoomManager
			return this.loomManager
		}

		// Find main worktree path
		const mainWorktreePath = await findMainWorktreePathWithSettings()

		// Load settings to get database configuration
		const settings = await this.settingsManager.loadSettings()

		// Create DatabaseManager with NeonProvider and EnvironmentManager
		const environmentManager = new EnvironmentManager()
		const neonProvider = createNeonProviderFromSettings(settings)
		const databaseUrlEnvVarName = settings.capabilities?.database?.databaseUrlEnvVarName ?? 'DATABASE_URL'

		const databaseManager = new DatabaseManager(neonProvider, environmentManager, databaseUrlEnvVarName)

		// Create BranchNamingService (defaults to Claude-based strategy)
		const branchNaming = new DefaultBranchNamingService({ useClaude: true })

		this.loomManager = new LoomManager(
			new GitWorktreeManager(mainWorktreePath),
			this.issueTracker,
			branchNaming,  // Add branch naming service
			environmentManager,  // Reuse same instance
			new ClaudeContextManager(),
			new ProjectCapabilityDetector(),
			new CLIIsolationManager(),
			this.settingsManager,  // Use same instance with CLI overrides
			databaseManager  // Add database manager
		)

		return this.loomManager
	}

	/**
	 * Main entry point for the start command
	 */
	public async execute(input: StartCommandInput): Promise<StartResult | void> {
		const isJsonMode = input.options.json === true

		try {
			// Step 0: Load settings and get configured repo for GitHub operations
			const initialSettings = await this.settingsManager.loadSettings()

			// Skip first-run setup in JSON mode
			if (!isJsonMode && (process.env.FORCE_FIRST_TIME_SETUP === "true" || await needsFirstRunSetup())) {
				await launchFirstRunSetup()
				// Reload settings and recreate issueTracker if provider changed during setup
				const newSettings = await this.settingsManager.loadSettings()
				const newProvider = newSettings.issueManagement?.provider ?? 'github'
				if (newProvider !== this.issueTracker.providerName) {
					getLogger().debug(`Reinitializing issue tracker: provider changed to "${newProvider}"`)
					this.issueTracker = IssueTrackerFactory.create(newSettings)
				}
			}

			let repo: string | undefined

			// Only get repo if we have multiple remotes (prehook already validated config)
			if (this.issueTracker.providerName === 'github' && (await hasMultipleRemotes())) {
				// Only relevant for GitHub - Linear doesn't use repo info
				repo = await getConfiguredRepoFromSettings(initialSettings)
				getLogger().info(`Using GitHub repository: ${repo}`)
			}

			// Step 0.5: Initialize LoomManager with main worktree path
			const loomManager = await this.initializeLoomManager()

			// Step 0.6: Detect if running from inside an existing loom (for nested loom support)
			let parentLoom = await this.detectParentLoom(loomManager)

			// Step 1: Parse and validate input (pass repo to methods)
			const parsed = await this.parseInput(input.identifier, repo)

			// Step 2: Validate based on type
			await this.validateInput(parsed, repo)

			// Step 2.4: Handle child loom decision
			if (parentLoom) {
				const { isInteractiveEnvironment, promptConfirmation } = await import('../utils/prompt.js')

				// Format display message based on parent type
				const parentDisplay = parentLoom.type === 'issue'
					? `issue #${parentLoom.identifier}`
					: parentLoom.type === 'pr'
					? `PR #${parentLoom.identifier}`
					: `branch ${parentLoom.identifier}`

				// Check for explicit flag first
				if (input.options.childLoom === true) {
					// --child-loom flag: force child loom (no prompt)
					getLogger().info(`Creating as child loom of ${parentDisplay} (--child-loom flag)`)
				} else if (input.options.childLoom === false) {
					// --no-child-loom flag: force independent (no prompt)
					parentLoom = null
					getLogger().info('Creating as independent loom (--no-child-loom flag)')
				} else {
					// No flag: use existing behavior (prompt or error if non-interactive)
					// JSON mode requires explicit flag
					if (isJsonMode) {
						throw new Error('JSON mode requires explicit --child-loom or --no-child-loom flag when running from inside a loom')
					}
					let createAsChild = true // Default for non-interactive
					if (isInteractiveEnvironment()) {
						createAsChild = await promptConfirmation(
							`You are not in your main worktree. Create as a child loom of ${parentDisplay}?`,
							true // Default yes
						)
					} else {
						getLogger().error(`Non-interactive environment detected, use either --child-loom or --no-child-loom to specify behavior`)
						process.exit(1)
					}

					if (!createAsChild) {
						parentLoom = null // User declined, proceed as normal loom
						getLogger().info('Creating as independent loom')
					}
				}
			} else if (input.options.childLoom === true) {
				// --child-loom flag but not in a parent loom - ignore silently (per requirements)
				getLogger().debug('--child-loom flag provided but not running from inside an existing loom (ignored)')
			}
			// Note: --no-child-loom when no parent is a no-op (already independent)

			// Step 2.5: Handle description input - create issue
			if (parsed.type === 'description') {
				getLogger().info('Creating issue from description...')
				// Apply first-letter capitalization to title and body
				const title = capitalizeFirstLetter(parsed.originalInput)
				const body = input.options.body ? capitalizeFirstLetter(input.options.body) : ""
				const result = await this.issueTracker.createIssue(
					title,  // Use capitalized description as title
					body    // Use capitalized body or empty
				)
				getLogger().success(`Created issue #${result.number}: ${result.url}`)
				// Update parsed to be an issue type with the new number
				parsed.type = 'issue'
				parsed.number = result.number
			}

			// Step 2.7: Confirm bypassPermissions mode if applicable
			// Only prompt in interactive mode when Claude is enabled.
			// Skip when: --no-claude (Claude won't launch now), JSON mode (non-interactive).
			// The explicit --one-shot=bypassPermissions flag is sufficient intent.
			// The warning is shown again when Claude launches via 'il spin'.
			if (input.options.oneShot === 'bypassPermissions' && input.options.claude !== false && !isJsonMode) {
				const { promptConfirmation } = await import('../utils/prompt.js')
				const confirmed = await promptConfirmation(
					'WARNING: bypassPermissions mode will allow Claude to execute all tool calls without confirmation. ' +
					'This can be dangerous. Do you want to proceed?'
				)
				if (!confirmed) {
					getLogger().info('Operation cancelled by user')
					process.exit(0)
				}
			}

			// Step 2.8: Load workflow-specific settings with CLI overrides
			const cliOverrides = extractSettingsOverrides()
			const settings = await this.settingsManager.loadSettings(undefined, cliOverrides)
			const workflowType = parsed.type === 'branch' ? 'regular' : parsed.type
			const workflowConfig = settings.workflows?.[workflowType]

			// Step 2.9: Extract raw --set arguments and executable path for forwarding to spin
			const { extractRawSetArguments, getExecutablePath } = await import('../utils/cli-overrides.js')
			const setArguments = extractRawSetArguments()
			const executablePath = getExecutablePath()

			// Step 3: Log success and create loom
			getLogger().info(`Validated input: ${this.formatParsedInput(parsed)}`)

			// Step 4: Create loom using LoomManager
			const identifier =
				parsed.type === 'branch'
					? parsed.branchName ?? ''
					: parsed.number ?? 0

			// Apply configuration precedence: CLI flags > workflow config > defaults (true)
			const enableClaude = input.options.claude ?? workflowConfig?.startAiAgent ?? true
			const enableCode = input.options.code ?? workflowConfig?.startIde ?? true
			const enableDevServer = input.options.devServer ?? workflowConfig?.startDevServer ?? true
			const enableTerminal = input.options.terminal ?? workflowConfig?.startTerminal ?? false

			getLogger().debug('Final workflow config values:', {
				enableClaude,
				enableCode,
				enableDevServer,
				enableTerminal,
			})

			const loom = await loomManager.createIloom({
				type: parsed.type,
				identifier,
				originalInput: parsed.originalInput,
				...(parentLoom && { parentLoom }),
				options: {
					enableClaude,
					enableCode,
					enableDevServer,
					enableTerminal,
					...(input.options.oneShot && { oneShot: input.options.oneShot }),
					...(setArguments.length > 0 && { setArguments }),
					...(executablePath && { executablePath }),
				},
			})

			getLogger().success(`Created loom: ${loom.id} at ${loom.path}`)
			getLogger().info(`   Branch: ${loom.branch}`)
			// Only show port for web projects
			if (loom.capabilities?.includes('web')) {
				getLogger().info(`   Port: ${loom.port}`)
			}
			if (loom.issueData?.title) {
				getLogger().info(`   Title: ${loom.issueData.title}`)
			}

			// Return StartResult in JSON mode
			if (isJsonMode) {
				return {
					id: loom.id,
					path: loom.path,
					branch: loom.branch,
					type: parsed.type,
					identifier: loom.identifier,
					...(loom.port !== undefined && { port: loom.port }),
					...(loom.issueData?.title && { title: loom.issueData.title }),
					...(loom.capabilities && { capabilities: loom.capabilities }),
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				getLogger().error(`${error.message}`)
			} else {
				getLogger().error('An unknown error occurred')
			}
			throw error
		}
	}

	/**
	 * Parse input to determine type and extract relevant data
	 */
	private async parseInput(identifier: string, repo?: string): Promise<ParsedInput> {
		// Check if user wants to skip capitalization by prefixing with space
		// We preserve this for description types so capitalizeFirstLetter() can handle it
		const hasLeadingSpace = identifier.startsWith(' ')

		// Handle empty input
		const trimmedIdentifier = identifier.trim()
		if (!trimmedIdentifier) {
			throw new Error('Missing required argument: identifier')
		}

		// Check for description: >15 chars AND has spaces (likely a natural language description)
		// Short inputs with spaces are rejected later as invalid branch names
		const spaceCount = (trimmedIdentifier.match(/ /g) ?? []).length
		if (trimmedIdentifier.length > 15 && spaceCount >= 1) {
			// Preserve leading space if present so capitalizeFirstLetter() can detect the override
			return {
				type: 'description',
				originalInput: hasLeadingSpace ? ' ' + trimmedIdentifier : trimmedIdentifier,
			}
		}

		// Check for PR-specific formats: pr/123, PR-123, PR/123, Pr-123 (case-insensitive)
		const prPattern = /^pr[/-](\d+)$/i
		const prMatch = trimmedIdentifier.match(prPattern)
		if (prMatch?.[1]) {
			return {
				type: 'pr',
				number: parseInt(prMatch[1], 10),
				originalInput: trimmedIdentifier,
			}
		}

		// Check for issue identifier patterns using shared utility
		// - Project key pattern: ENG-123 (requires at least 2 letters before dash)
		// - Numeric pattern: #123 or 123 (GitHub format)
		const identifierMatch = matchIssueIdentifier(trimmedIdentifier)

		if (identifierMatch.type === 'project-key' && identifierMatch.identifier) {
			// Use IssueTracker to validate it exists
			const detection = await this.issueTracker.detectInputType(
				trimmedIdentifier,
				repo
			)

			if (detection.type === 'issue' && detection.identifier) {
				return {
					type: 'issue',
					number: detection.identifier, // Keep as string for project key identifiers
					originalInput: trimmedIdentifier,
				}
			}

			// Project key identifier format matched but not found
			throw new Error(
				`Could not find issue matching identifier ${identifierMatch.identifier}`
			)
		}

		// Check for numeric pattern (could be issue or PR)
		if (identifierMatch.type === 'numeric' && identifierMatch.identifier) {
			const number = parseInt(identifierMatch.identifier, 10)

			// If issue tracker supports PRs, use it for detection
			if (this.issueTracker.supportsPullRequests) {
				const detection = await this.issueTracker.detectInputType(
					trimmedIdentifier,
					repo
				)

				if (detection.type === 'pr') {
					return {
						type: 'pr',
						number: detection.identifier ? parseInt(detection.identifier, 10) : number,
						originalInput: trimmedIdentifier,
					}
				} else if (detection.type === 'issue') {
					return {
						type: 'issue',
						number: detection.identifier ? parseInt(detection.identifier, 10) : number,
						originalInput: trimmedIdentifier,
					}
				} else {
					throw new Error(`Could not find issue or PR #${number}`)
				}
			} else {
				// Issue tracker doesn't support PRs (e.g., Linear, Jira)
				// Check GitHub first for PR, then fall back to issue tracker for issues
				const githubService = this.getGitHubService()
				const detection = await githubService.detectInputType(trimmedIdentifier, repo)

				if (detection.type === 'pr') {
					return {
						type: 'pr',
						number: detection.identifier ? parseInt(detection.identifier, 10) : number,
						originalInput: trimmedIdentifier,
					}
				} else {
					// Not a GitHub PR - try the configured issue tracker
					// This allows future trackers with numeric IDs to work naturally
					return {
						type: 'issue',
						number,
						originalInput: trimmedIdentifier,
					}
				}
			}
		}

		// Treat as branch name
		return {
			type: 'branch',
			branchName: trimmedIdentifier,
			originalInput: trimmedIdentifier,
		}
	}

	/**
	 * Validate the parsed input based on its type
	 */
	private async validateInput(parsed: ParsedInput, repo?: string): Promise<void> {
		switch (parsed.type) {
			case 'pr': {
				if (!parsed.number) {
					throw new Error('Invalid PR number')
				}

				// Determine which service to use for PR operations
				if (this.issueTracker.supportsPullRequests && this.issueTracker.fetchPR && this.issueTracker.validatePRState) {
					// Use issue tracker for PR operations (e.g., GitHub)
					const pr = await this.issueTracker.fetchPR(parsed.number, repo)
					await this.issueTracker.validatePRState(pr)
				} else {
					// Use GitHubService for PR operations when issue tracker doesn't support PRs (e.g., Linear)
					const githubService = this.getGitHubService()
					const pr = await githubService.fetchPR(parsed.number as number, repo)
					await githubService.validatePRState(pr)
				}
				getLogger().debug(`Validated PR #${parsed.number}`)
				break
			}

			case 'issue': {
				if (!parsed.number) {
					throw new Error('Invalid issue number')
				}
				// Fetch and validate issue state
				const issue = await this.issueTracker.fetchIssue(parsed.number, repo)
				await this.issueTracker.validateIssueState(issue)
				getLogger().debug(`Validated issue #${parsed.number}`)
				break
			}

			case 'branch': {
				if (!parsed.branchName) {
					throw new Error('Invalid branch name')
				}
				// Validate branch name characters (from bash script line 586)
				if (!this.isValidBranchName(parsed.branchName)) {
					throw new Error(
						'Invalid branch name. Use only letters, numbers, hyphens, underscores, and slashes'
					)
				}
				getLogger().debug(`Validated branch name: ${parsed.branchName}`)
				break
			}

			case 'description': {
				// Description inputs are valid - they will be converted to issues
				getLogger().debug('Detected description input', {
					length: parsed.originalInput.length
				})
				break
			}

			default: {
				const unknownType = parsed as { type: string }
				throw new Error(`Unknown input type: ${unknownType.type}`)
			}
		}
	}

	/**
	 * Validate branch name format
	 */
	private isValidBranchName(branch: string): boolean {
		// Pattern from bash script line 586
		return /^[a-zA-Z0-9/_-]+$/.test(branch)
	}

	/**
	 * Format parsed input for display
	 */
	private formatParsedInput(parsed: ParsedInput): string {
		switch (parsed.type) {
			case 'pr':
				return `PR #${parsed.number}`
			case 'issue':
				return `Issue #${parsed.number}`
			case 'branch':
				return `Branch '${parsed.branchName}'`
			case 'description':
				return `Description: ${parsed.originalInput.slice(0, 50)}...`
			default:
				return 'Unknown input'
		}
	}

	/**
	 * Detect if running from inside an existing loom worktree
	 * Returns parent loom info if detected, null otherwise
	 */
	private async detectParentLoom(loomManager: LoomManager): Promise<{
		type: 'issue' | 'pr' | 'branch'
		identifier: string | number
		branchName: string
		worktreePath: string
		databaseBranch?: string
	} | null> {
		try {
			const cwd = process.cwd()
			const looms = await loomManager.listLooms()

			if (!looms) {
				return null
			}

			// Get main worktree path to exclude it from valid parents
			const mainWorktreePath = await findMainWorktreePathWithSettings()

			// Find loom containing current directory
			// Fix #2: Add path.sep check to prevent false positives (e.g., issue-123 vs issue-1234)
			// Exclude main worktree from being a valid parent
			const parentLoom = looms.find(loom => {
				// Skip main worktree - it shouldn't be a parent for child looms
				if (loom.path === mainWorktreePath) {
					return false
				}
				// Either exact match OR cwd starts with loom.path followed by path separator
				return cwd === loom.path || cwd.startsWith(loom.path + path.sep)
			})
			if (!parentLoom) {
				return null
			}

			getLogger().debug(`Detected parent loom: ${parentLoom.type} ${parentLoom.identifier} at ${parentLoom.path}`)

			const result: {
				type: 'issue' | 'pr' | 'branch'
				identifier: string | number
				branchName: string
				worktreePath: string
				databaseBranch?: string
			} = {
				type: parentLoom.type,
				identifier: parentLoom.identifier,
				branchName: parentLoom.branch,
				worktreePath: parentLoom.path,
			}

			// Only include databaseBranch if it exists (exactOptionalPropertyTypes compatibility)
			if (parentLoom.databaseBranch) {
				result.databaseBranch = parentLoom.databaseBranch
			}

			// Try to get database branch from parent's .env file via reverse lookup
			if (!result.databaseBranch) {
				const databaseBranch = await loomManager.getDatabaseBranchForLoom(parentLoom.path)
				if (databaseBranch) {
					result.databaseBranch = databaseBranch
					getLogger().debug(`Detected parent database branch: ${databaseBranch}`)
				}
			}

			return result
		} catch (error) {
			// If detection fails for any reason, just return null (don't break the start workflow)
			getLogger().debug(`Failed to detect parent loom: ${error instanceof Error ? error.message : 'Unknown error'}`)
			return null
		}
	}

}
