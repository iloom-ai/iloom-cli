import path from 'path'
import { logger } from '../utils/logger.js'
import type { IssueTracker } from '../lib/IssueTracker.js'
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
import { loadEnvIntoProcess } from '../utils/env.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import { createNeonProviderFromSettings } from '../utils/neon-helpers.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'
import type { StartOptions } from '../types/index.js'

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
	public async execute(input: StartCommandInput): Promise<void> {
		try {
			// Step 0: Load settings and get configured repo for GitHub operations
			const initialSettings = await this.settingsManager.loadSettings()

			// Step 0.1: Check for first-run setup need and launch if necessary
			const { needsFirstRunSetup, launchFirstRunSetup } = await import(
				'../utils/first-run-setup.js'
			)
			if (await needsFirstRunSetup()) {
				await launchFirstRunSetup()
				// Reload settings after setup completes
				await this.settingsManager.loadSettings()
			}

			let repo: string | undefined

			// Only get repo if we have multiple remotes (prehook already validated config)
			const multipleRemotes = await hasMultipleRemotes()
			if (multipleRemotes) {
				repo = await getConfiguredRepoFromSettings(initialSettings)
				logger.info(`Using GitHub repository: ${repo}`)
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
					logger.info(`Creating as child loom of ${parentDisplay} (--child-loom flag)`)
				} else if (input.options.childLoom === false) {
					// --no-child-loom flag: force independent (no prompt)
					parentLoom = null
					logger.info('Creating as independent loom (--no-child-loom flag)')
				} else {
					// No flag: use existing behavior (prompt or error if non-interactive)
					let createAsChild = true // Default for non-interactive
					if (isInteractiveEnvironment()) {
						createAsChild = await promptConfirmation(
							`Create as child loom of ${parentDisplay}?`,
							true // Default yes
						)
					} else {
						logger.error(`Non-interactive environment detected, use either --child-loom or --no-child-loom to specify behavior`)
						process.exit(1)
					}

					if (!createAsChild) {
						parentLoom = null // User declined, proceed as normal loom
						logger.info('Creating as independent loom')
					}
				}
			} else if (input.options.childLoom === true) {
				// --child-loom flag but not in a parent loom - ignore silently (per requirements)
				logger.debug('--child-loom flag provided but not running from inside an existing loom (ignored)')
			}
			// Note: --no-child-loom when no parent is a no-op (already independent)

			// Step 2.5: Handle description input - create GitHub issue
			if (parsed.type === 'description') {
				logger.info('Creating GitHub issue from description...')
				const body = input.options.body ?? ""  // Use provided body or empty string
				const result = await this.issueTracker.createIssue(
					parsed.originalInput,  // Use description as title
					body                   // Use provided body or empty
				)
				logger.success(`Created issue #${result.number}: ${result.url}`)
				// Update parsed to be an issue type with the new number
				parsed.type = 'issue'
				parsed.number = result.number
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

			logger.success(`✅ Created loom: ${loom.id} at ${loom.path}`)
			logger.info(`   Branch: ${loom.branch}`)
			// Only show port for web projects
			if (loom.capabilities?.includes('web')) {
				logger.info(`   Port: ${loom.port}`)
			}
			if (loom.issueData?.title) {
				logger.info(`   Title: ${loom.issueData.title}`)
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
	private async parseInput(identifier: string, repo?: string): Promise<ParsedInput> {
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

			// Use IssueTracker to detect if it's a PR or issue
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
				// Check if provider supports PRs before calling PR methods
				if (!this.issueTracker.supportsPullRequests || !this.issueTracker.fetchPR || !this.issueTracker.validatePRState) {
					throw new Error('Issue tracker does not support pull requests')
				}
				// Fetch and validate PR state
				const pr = await this.issueTracker.fetchPR(parsed.number, repo)
				await this.issueTracker.validatePRState(pr)
				logger.debug(`Validated PR #${parsed.number}`)
				break
			}

			case 'issue': {
				if (!parsed.number) {
					throw new Error('Invalid issue number')
				}
				// Fetch and validate issue state
				const issue = await this.issueTracker.fetchIssue(parsed.number, repo)
				await this.issueTracker.validateIssueState(issue)
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

			logger.debug(`Detected parent loom: ${parentLoom.type} ${parentLoom.identifier} at ${parentLoom.path}`)

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
					logger.debug(`Detected parent database branch: ${databaseBranch}`)
				}
			}

			return result
		} catch (error) {
			// If detection fails for any reason, just return null (don't break the start workflow)
			logger.debug(`Failed to detect parent loom: ${error instanceof Error ? error.message : 'Unknown error'}`)
			return null
		}
	}

}
