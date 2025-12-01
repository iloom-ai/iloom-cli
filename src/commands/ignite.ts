import path from 'path'
import { logger } from '../utils/logger.js'
import { ClaudeWorkflowOptions } from '../lib/ClaudeService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { launchClaude, ClaudeCliOptions } from '../utils/claude.js'
import { PromptTemplateManager, TemplateVariables } from '../lib/PromptTemplateManager.js'
import { generateIssueManagementMcpConfig } from '../utils/mcp.js'
import { AgentManager } from '../lib/AgentManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import { FirstRunManager } from '../utils/FirstRunManager.js'
import { readFile } from 'fs/promises'

/**
 * IgniteCommand: Auto-detect workspace context and launch Claude
 *
 * This command:
 * 1. Auto-detects context from current directory and git branch
 * 2. Loads appropriate prompt template with variable substitution
 * 3. Launches Claude with existing agent system (NO changes to agent loading)
 * 4. Executes in current terminal (not opening a new window)
 *
 * CRITICAL: This command works with agents exactly as they currently function.
 * NO modifications to agent loading mechanisms.
 */
export class IgniteCommand {
	private templateManager: PromptTemplateManager
	private gitWorktreeManager: GitWorktreeManager
	private agentManager: AgentManager
	private settingsManager: SettingsManager
	private firstRunManager: FirstRunManager
	private settings?: import('../lib/SettingsManager.js').IloomSettings

	constructor(
		templateManager?: PromptTemplateManager,
		gitWorktreeManager?: GitWorktreeManager,
		agentManager?: AgentManager,
		settingsManager?: SettingsManager,
		firstRunManager?: FirstRunManager
	) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
		this.gitWorktreeManager = gitWorktreeManager ?? new GitWorktreeManager()
		this.agentManager = agentManager ?? new AgentManager()
		this.settingsManager = settingsManager ?? new SettingsManager()
		this.firstRunManager = firstRunManager ?? new FirstRunManager('spin')
	}

	/**
	 * Main entry point for spin command
	 */
	async execute(oneShot: import('../types/index.js').OneShotMode = 'default'): Promise<void> {
		try {
			logger.info('🚀 Your loom is spinning up, please wait...')

			// Step 0.5: Check if this is first-time user
			const isFirstRun = await this.firstRunManager.isFirstRun()
			if (isFirstRun) {
				logger.success('Welcome to iloom! Preparing first-time experience...')
			}

			// Step 1: Auto-detect workspace context
			const context = await this.detectWorkspaceContext()

			logger.debug('Auto-detected workspace context', { context })

			// Inform user what context was detected
			this.logDetectedContext(context)

			logger.info('📝 Loading prompt template and preparing Claude...')

			// Step 2: Get prompt template with variable substitution
			const variables = this.buildTemplateVariables(context, oneShot)

			// Step 2.5: Add first-time user context if needed
			if (isFirstRun) {
				variables.FIRST_TIME_USER = true
				variables.README_CONTENT = await this.loadReadmeContent()
				variables.SETTINGS_SCHEMA_CONTENT = await this.loadSettingsSchemaContent()
			}

			const systemInstructions = await this.templateManager.getPrompt(context.type, variables)

			// User prompt to trigger the workflow (includes one-shot bypass instructions if needed)
			const userPrompt = this.buildUserPrompt(oneShot)

			// Step 2.5: Load settings if not cached with CLI overrides
			// Settings are pre-validated at CLI startup, so no error handling needed here
			if (!this.settings) {
				const cliOverrides = extractSettingsOverrides()
				this.settings = await this.settingsManager.loadSettings(undefined, cliOverrides)
			}

			// Step 3: Determine model and permission mode based on workflow type
			const model = this.getModelForWorkflow(context.type)
			let permissionMode = this.getPermissionModeForWorkflow(context.type)

			// Override permission mode if bypassPermissions oneShot mode
			if (oneShot === 'bypassPermissions') {
				permissionMode = 'bypassPermissions'
			}

			// Display warning if bypassPermissions is used
			if (permissionMode === 'bypassPermissions') {
				logger.warn(
					'⚠️  WARNING: Using bypassPermissions mode - Claude will execute all tool calls without confirmation. ' +
						'This can be dangerous. Use with caution.'
				)
			}

			// Step 4: Build Claude CLI options
			const claudeOptions: ClaudeCliOptions = {
				headless: false, // Enable stdio: 'inherit' for current terminal
				addDir: context.workspacePath,
			}

			// Add optional model if present
			if (model !== undefined) {
				claudeOptions.model = model
			}

			// Add permission mode if not default
			if (permissionMode !== undefined && permissionMode !== 'default') {
				claudeOptions.permissionMode = permissionMode
			}

			// Add optional branch name for context
			if (context.branchName !== undefined) {
				claudeOptions.branchName = context.branchName
			}

			// Step 4.5: Generate MCP config and tool filtering for issue/PR workflows
			let mcpConfig: Record<string, unknown>[] | undefined
			let allowedTools: string[] | undefined
			let disallowedTools: string[] | undefined

			if (context.type === 'issue' || context.type === 'pr') {
				try {
					mcpConfig = await generateIssueManagementMcpConfig(context.type)
					logger.debug('Generated MCP configuration for issue management')

					// Configure tool filtering for issue/PR workflows
					allowedTools = [
						'mcp__issue_management__get_issue',
						'mcp__issue_management__get_comment',
						'mcp__issue_management__create_comment',
						'mcp__issue_management__update_comment',
					]
					disallowedTools = ['Bash(gh api:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh issue comment:*)']

					logger.debug('Configured tool filtering for issue/PR workflow', { allowedTools, disallowedTools })
				} catch (error) {
					// Log warning but continue without MCP
					logger.warn(`Failed to generate MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
				}
			}

			// Step 4.6: Load agent configurations using cached settings
			let agents: Record<string, unknown> | undefined
			try {
				// Use cached settings from Step 2.5
				if (this.settings?.agents && Object.keys(this.settings.agents).length > 0) {
					logger.debug('Loaded project settings', {
						agentOverrides: Object.keys(this.settings.agents),
					})
				}

				// Load agents with settings overrides
				const loadedAgents = await this.agentManager.loadAgents(this.settings)
				agents = this.agentManager.formatForCli(loadedAgents)
				logger.debug('Loaded agent configurations', {
					agentCount: Object.keys(agents).length,
					agentNames: Object.keys(agents),
				})
			} catch (error) {
				// Log warning but continue without agents
				logger.warn(`Failed to load agents: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}

			logger.debug('Launching Claude in current terminal', {
				type: context.type,
				model,
				permissionMode,
				workspacePath: context.workspacePath,
				hasMcpConfig: !!mcpConfig,
			})

			logger.info('✨ Launching Claude in current terminal...')

			// Step 5: Launch Claude with system instructions appended and user prompt
			await launchClaude(userPrompt, {
				...claudeOptions,
				appendSystemPrompt: systemInstructions,
				...(mcpConfig && { mcpConfig }),
				...(allowedTools && { allowedTools }),
				...(disallowedTools && { disallowedTools }),
				...(agents && { agents }),
			})

			// Step 6: Mark as run after successful launch
			if (isFirstRun) {
				await this.firstRunManager.markAsRun()
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			logger.error(`Failed to launch Claude: ${errorMessage}`)
			throw error
		}
	}

	/**
	 * Log user-friendly information about detected context
	 */
	private logDetectedContext(context: ClaudeWorkflowOptions): void {
		if (context.type === 'issue') {
			logger.info(`🎯 Detected issue workflow: Issue #${context.issueNumber}`)
		} else if (context.type === 'pr') {
			logger.info(`🔄 Detected PR workflow: PR #${context.prNumber}`)
		} else {
			logger.info('🌟 Detected regular workflow')
		}

		if (context.branchName) {
			logger.info(`🌿 Working on branch: ${context.branchName}`)
		}

		if (context.port) {
			logger.info(`🌐 Development server port: ${context.port}`)
		}
	}

	/**
	 * Build template variables from context
	 */
	private buildTemplateVariables(context: ClaudeWorkflowOptions, oneShot: import('../types/index.js').OneShotMode): TemplateVariables {
		const variables: TemplateVariables = {
			WORKSPACE_PATH: context.workspacePath,
		}

		if (context.issueNumber !== undefined) {
			variables.ISSUE_NUMBER = context.issueNumber
		}

		if (context.prNumber !== undefined) {
			variables.PR_NUMBER = context.prNumber
		}

		if (context.title !== undefined) {
			if (context.type === 'issue') {
				variables.ISSUE_TITLE = context.title
			} else if (context.type === 'pr') {
				variables.PR_TITLE = context.title
			}
		}

		if (context.port !== undefined) {
			variables.PORT = context.port
		}

		// Set ONE_SHOT_MODE flag for template conditional sections
		if (oneShot === 'noReview' || oneShot === 'bypassPermissions') {
			variables.ONE_SHOT_MODE = true
		}

		return variables
	}

	/**
	 * Get the appropriate model for a workflow type
	 * Same logic as ClaudeService.getModelForWorkflow()
	 */
	private getModelForWorkflow(type: 'issue' | 'pr' | 'regular'): string | undefined {
		// Issue workflows use claude-sonnet-4-20250514
		if (type === 'issue') {
			return 'claude-sonnet-4-20250514'
		}
		// For PR and regular workflows, use Claude's default model
		return undefined
	}

	/**
	 * Get the appropriate permission mode for a workflow type
	 * Same logic as ClaudeService.getPermissionModeForWorkflow()
	 */
	private getPermissionModeForWorkflow(
		type: 'issue' | 'pr' | 'regular'
	): ClaudeCliOptions['permissionMode'] {
		// Check settings for configured permission mode
		if (this.settings?.workflows) {
			const workflowConfig =
				type === 'issue'
					? this.settings.workflows.issue
					: type === 'pr'
						? this.settings.workflows.pr
						: this.settings.workflows.regular

			if (workflowConfig?.permissionMode) {
				return workflowConfig.permissionMode
			}
		}

		// Fall back to current defaults
		if (type === 'issue') {
			return 'acceptEdits'
		}
		// For PR and regular workflows, use default permissions
		return 'default'
	}

	/**
	 * Auto-detect workspace context from current directory and git branch
	 *
	 * Detection priority:
	 * 1. Directory name patterns (_pr_N, issue-N)
	 * 2. Git branch name patterns
	 * 3. Fallback to 'regular' workflow
	 *
	 * This leverages the same logic as FinishCommand.autoDetectFromCurrentDirectory()
	 */
	private async detectWorkspaceContext(): Promise<ClaudeWorkflowOptions> {
		const workspacePath = process.cwd()
		const currentDir = path.basename(workspacePath)

		// Check for PR worktree pattern: _pr_N suffix
		// Pattern: /.*_pr_(\d+)$/
		const prPattern = /_pr_(\d+)$/
		const prMatch = currentDir.match(prPattern)

		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			logger.debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)

			return this.buildContextForPR(prNumber, workspacePath)
		}

		// Check for issue pattern in directory name
		// Pattern: /issue-(\d+)/
		const issuePattern = /issue-(\d+)/
		const issueMatch = currentDir.match(issuePattern)

		if (issueMatch?.[1]) {
			const issueNumber = parseInt(issueMatch[1], 10)
			logger.debug(`Auto-detected issue #${issueNumber} from directory: ${currentDir}`)

			return this.buildContextForIssue(issueNumber, workspacePath)
		}

		// Fallback: Try to extract from git branch name
		try {
			const repoInfo = await this.gitWorktreeManager.getRepoInfo()
			const currentBranch = repoInfo.currentBranch

			if (currentBranch) {
				// Try to extract issue from branch name
				const branchIssueMatch = currentBranch.match(issuePattern)
				if (branchIssueMatch?.[1]) {
					const issueNumber = parseInt(branchIssueMatch[1], 10)
					logger.debug(`Auto-detected issue #${issueNumber} from branch: ${currentBranch}`)

					return this.buildContextForIssue(issueNumber, workspacePath, currentBranch)
				}
			}
		} catch (error) {
			// Git command failed - not a git repo or other git error
			logger.debug('Could not detect from git branch', { error })
		}

		// Last resort: use regular workflow
		logger.debug('No specific context detected, using regular workflow')
		return this.buildContextForRegular(workspacePath)
	}

	/**
	 * Build context for issue workflow
	 */
	private async buildContextForIssue(
		issueNumber: string | number,
		workspacePath: string,
		branchName?: string
	): Promise<ClaudeWorkflowOptions> {
		// Get branch name if not provided
		if (!branchName) {
			try {
				const repoInfo = await this.gitWorktreeManager.getRepoInfo()
				branchName = repoInfo.currentBranch ?? undefined
			} catch {
				// Ignore git errors
			}
		}

		const port = this.getPortFromEnv()
		const context: ClaudeWorkflowOptions = {
			type: 'issue',
			issueNumber,
			workspacePath,
			headless: false, // Interactive mode
		}

		if (port !== undefined) {
			context.port = port
		}

		if (branchName !== undefined) {
			context.branchName = branchName
		}

		return context
	}

	/**
	 * Build context for PR workflow
	 */
	private async buildContextForPR(
		prNumber: number,
		workspacePath: string
	): Promise<ClaudeWorkflowOptions> {
		// Get branch name
		let branchName: string | undefined
		try {
			const repoInfo = await this.gitWorktreeManager.getRepoInfo()
			branchName = repoInfo.currentBranch ?? undefined
		} catch {
			// Ignore git errors
		}

		const port = this.getPortFromEnv()
		const context: ClaudeWorkflowOptions = {
			type: 'pr',
			prNumber,
			workspacePath,
			headless: false, // Interactive mode
		}

		if (port !== undefined) {
			context.port = port
		}

		if (branchName !== undefined) {
			context.branchName = branchName
		}

		return context
	}

	/**
	 * Build context for regular workflow
	 */
	private async buildContextForRegular(workspacePath: string): Promise<ClaudeWorkflowOptions> {
		// Get branch name
		let branchName: string | undefined
		try {
			const repoInfo = await this.gitWorktreeManager.getRepoInfo()
			branchName = repoInfo.currentBranch ?? undefined
		} catch {
			// Ignore git errors
		}

		const port = this.getPortFromEnv()
		const context: ClaudeWorkflowOptions = {
			type: 'regular',
			workspacePath,
			headless: false, // Interactive mode
		}

		if (port !== undefined) {
			context.port = port
		}

		if (branchName !== undefined) {
			context.branchName = branchName
		}

		return context
	}

	/**
	 * Get PORT from environment variables
	 * Returns undefined if PORT is not set or invalid
	 */
	private getPortFromEnv(): number | undefined {
		const portStr = process.env.PORT
		if (!portStr) {
			return undefined
		}

		const port = parseInt(portStr, 10)
		if (isNaN(port)) {
			logger.warn(`Invalid PORT environment variable: ${portStr}`)
			return undefined
		}

		return port
	}


	/**
	 * Build user prompt based on one-shot mode
	 */
	private buildUserPrompt(oneShot: import('../types/index.js').OneShotMode = 'default'): string {
		// For one-shot modes, add bypass instructions to override template approval requirements
		if (oneShot === 'noReview' || oneShot === 'bypassPermissions') {
			return 'Guide the user through the iloom workflow! The user has requested you move through the workflow without awaiting confirmation. This supersedes any other guidance.'
		}

		// Default mode: simple "Go!" prompt
		return 'Guide the user through the iloom workflow!'
	}

	/**
	 * Load README.md content for first-time users
	 * Walks up from dist directory to find README.md in project root
	 */
	private async loadReadmeContent(): Promise<string> {
		try {
			// Walk up from current file location to find README.md
			// Use same pattern as PromptTemplateManager for finding files
			let currentDir = path.dirname(new URL(import.meta.url).pathname)

			// Walk up to find README.md
			while (currentDir !== path.dirname(currentDir)) {
				const readmePath = path.join(currentDir, 'README.md')
				try {
					const content = await readFile(readmePath, 'utf-8')
					logger.debug('Loaded README.md for first-time user', { readmePath })
					return content
				} catch {
					currentDir = path.dirname(currentDir)
				}
			}

			logger.debug('README.md not found, returning empty string')
			return ''
		} catch (error) {
			// Graceful degradation - return empty string on error
			logger.debug(`Failed to load README.md: ${error}`)
			return ''
		}
	}

	/**
	 * Load settings schema content for first-time users
	 * Walks up from dist directory to find .iloom/README.md
	 */
	private async loadSettingsSchemaContent(): Promise<string> {
		try {
			// Walk up from current file location to find .iloom/README.md
			let currentDir = path.dirname(new URL(import.meta.url).pathname)

			// Walk up to find .iloom/README.md
			while (currentDir !== path.dirname(currentDir)) {
				const schemaPath = path.join(currentDir, '.iloom', 'README.md')
				try {
					const content = await readFile(schemaPath, 'utf-8')
					logger.debug('Loaded .iloom/README.md for first-time user', { schemaPath })
					return content
				} catch {
					currentDir = path.dirname(currentDir)
				}
			}

			logger.debug('.iloom/README.md not found, returning empty string')
			return ''
		} catch (error) {
			// Graceful degradation - return empty string on error
			logger.debug(`Failed to load .iloom/README.md: ${error}`)
			return ''
		}
	}
}
