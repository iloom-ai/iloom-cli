import { logger } from '../utils/logger.js'
import { GitHubService } from '../lib/GitHubService.js'
import { LoomManager } from '../lib/LoomManager.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { EnvironmentManager } from '../lib/EnvironmentManager.js'
import { ClaudeContextManager } from '../lib/ClaudeContextManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { CLIIsolationManager } from '../lib/CLIIsolationManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { AgentManager } from '../lib/AgentManager.js'
import { DatabaseManager } from '../lib/DatabaseManager.js'
import { IssueEnhancementService } from '../lib/IssueEnhancementService.js'
import { branchExists, findMainWorktreePathWithSettings } from '../utils/git.js'
import { loadEnvIntoProcess } from '../utils/env.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import { createNeonProviderFromSettings } from '../utils/neon-helpers.js'
import type { StartOptions } from '../types/index.js'

export interface StartCommandInput {
	identifier: string
	options: StartOptions
}

export interface ParsedInput {
	type: 'issue' | 'pr' | 'branch' | 'description'
	number?: number
	branchName?: string
	originalInput: string
}

export class StartCommand {
	private gitHubService: GitHubService
	private loomManager: LoomManager | null = null
	private agentManager: AgentManager
	private settingsManager: SettingsManager
	private enhancementService: IssueEnhancementService
	private providedLoomManager: LoomManager | undefined

	constructor(
		gitHubService?: GitHubService,
		loomManager?: LoomManager,
		agentManager?: AgentManager,
		settingsManager?: SettingsManager
	) {
		this.gitHubService = gitHubService ?? new GitHubService()
		this.agentManager = agentManager ?? new AgentManager()
		this.settingsManager = settingsManager ?? new SettingsManager()
		this.enhancementService = new IssueEnhancementService(
			this.gitHubService,
			this.agentManager,
			this.settingsManager
		)
		// Store provided LoomManager for testing, but don't initialize yet
		this.providedLoomManager = loomManager

		// Load environment variables first
		const envResult = loadEnvIntoProcess()
		if (envResult.error) {
			logger.debug(`Environment loading warning: ${envResult.error.message}`)
		}
		if (envResult.parsed) {
			logger.debug(`Loaded ${Object.keys(envResult.parsed).length} environment variables`)
		}
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

		this.loomManager = new LoomManager(
			new GitWorktreeManager(mainWorktreePath),
			this.gitHubService,
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
	public async execute(input: StartCommandInput): Promise<void> {
		try {
			// Step 0: Initialize LoomManager with main worktree path
			const loomManager = await this.initializeLoomManager()

			// Step 1: Parse and validate input
			const parsed = await this.parseInput(input.identifier)

			// Step 2: Validate based on type
			await this.validateInput(parsed)

			// Step 2.5: Handle description input - create GitHub issue
			if (parsed.type === 'description') {
				const issueNumber = await this.enhanceAndCreateIssue(parsed.originalInput)
				// Update parsed to be an issue type with the new number
				parsed.type = 'issue'
				parsed.number = issueNumber
			}

			// Step 2.7: Confirm bypassPermissions mode if applicable
			if (input.options.oneShot === 'bypassPermissions') {
				const { promptConfirmation } = await import('../utils/prompt.js')
				const confirmed = await promptConfirmation(
					'⚠️  WARNING: bypassPermissions mode will allow Claude to execute all tool calls without confirmation. ' +
					'This can be dangerous. Do you want to proceed?'
				)
				if (!confirmed) {
					logger.info('Operation cancelled by user')
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
			logger.info(`✅ Validated input: ${this.formatParsedInput(parsed)}`)

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

			logger.debug('Final workflow config values:', {
				enableClaude,
				enableCode,
				enableDevServer,
				enableTerminal,
			})

			const loom = await loomManager.createIloom({
				type: parsed.type,
				identifier,
				originalInput: parsed.originalInput,
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

			logger.success(`✅ Created loom: ${loom.id} at ${loom.path}`)
			logger.info(`   Branch: ${loom.branch}`)
			// Only show port for web projects
			if (loom.capabilities?.includes('web')) {
				logger.info(`   Port: ${loom.port}`)
			}
			if (loom.githubData?.title) {
				logger.info(`   Title: ${loom.githubData.title}`)
			}
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`❌ ${error.message}`)
			} else {
				logger.error('❌ An unknown error occurred')
			}
			throw error
		}
	}

	/**
	 * Parse input to determine type and extract relevant data
	 */
	private async parseInput(identifier: string): Promise<ParsedInput> {
		// Handle empty input
		const trimmedIdentifier = identifier.trim()
		if (!trimmedIdentifier) {
			throw new Error('Missing required argument: identifier')
		}

		// Check for description: >25 chars AND >2 spaces
		const spaceCount = (trimmedIdentifier.match(/ /g) ?? []).length
		if (trimmedIdentifier.length > 25 && spaceCount > 2) {
			return {
				type: 'description',
				originalInput: trimmedIdentifier,
			}
		}

		// Check for PR-specific formats: pr/123, PR-123, PR/123
		const prPattern = /^(?:pr|PR)[/-](\d+)$/
		const prMatch = trimmedIdentifier.match(prPattern)
		if (prMatch?.[1]) {
			return {
				type: 'pr',
				number: parseInt(prMatch[1], 10),
				originalInput: trimmedIdentifier,
			}
		}

		// Check for numeric pattern (could be issue or PR)
		const numericPattern = /^#?(\d+)$/
		const numericMatch = trimmedIdentifier.match(numericPattern)
		if (numericMatch?.[1]) {
			const number = parseInt(numericMatch[1], 10)

			// Use GitHubService to detect if it's a PR or issue
			const detection = await this.gitHubService.detectInputType(
				trimmedIdentifier
			)

			if (detection.type === 'pr') {
				return {
					type: 'pr',
					number: detection.number ?? number,
					originalInput: trimmedIdentifier,
				}
			} else if (detection.type === 'issue') {
				return {
					type: 'issue',
					number: detection.number ?? number,
					originalInput: trimmedIdentifier,
				}
			} else {
				throw new Error(`Could not find issue or PR #${number}`)
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
	private async validateInput(parsed: ParsedInput): Promise<void> {
		switch (parsed.type) {
			case 'pr': {
				if (!parsed.number) {
					throw new Error('Invalid PR number')
				}
				// Fetch and validate PR state
				const pr = await this.gitHubService.fetchPR(parsed.number)
				await this.gitHubService.validatePRState(pr)
				logger.debug(`Validated PR #${parsed.number}`)
				break
			}

			case 'issue': {
				if (!parsed.number) {
					throw new Error('Invalid issue number')
				}
				// Fetch and validate issue state
				const issue = await this.gitHubService.fetchIssue(parsed.number)
				await this.gitHubService.validateIssueState(issue)
				logger.debug(`Validated issue #${parsed.number}`)
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
				// Check if branch already exists
				const exists = await branchExists(parsed.branchName)
				if (exists) {
					throw new Error(`Branch '${parsed.branchName}' already exists`)
				}
				logger.debug(`Validated branch name: ${parsed.branchName}`)
				break
			}

			case 'description': {
				// Description inputs are valid - they will be converted to issues
				logger.debug('Detected description input', {
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
	 * Enhance description using Claude AI and create GitHub issue
	 * Returns the new issue number
	 */
	private async enhanceAndCreateIssue(description: string): Promise<number> {
		// Use IssueEnhancementService for the workflow
		const enhancedDescription = await this.enhancementService.enhanceDescription(description)
		const result = await this.enhancementService.createEnhancedIssue(description, enhancedDescription)
		await this.enhancementService.waitForReviewAndOpen(result.number, true)

		return result.number
	}

}
