import path from 'path'
import { logger, createStderrLogger } from '../utils/logger.js'
import { withLogger } from '../utils/logger-context.js'
import { ClaudeWorkflowOptions } from '../lib/ClaudeService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { launchClaude, ClaudeCliOptions } from '../utils/claude.js'
import { PromptTemplateManager, TemplateVariables } from '../lib/PromptTemplateManager.js'
import { generateIssueManagementMcpConfig, generateRecapMcpConfig } from '../utils/mcp.js'
import { AgentManager } from '../lib/AgentManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { SettingsManager, type IloomSettings } from '../lib/SettingsManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import { FirstRunManager } from '../utils/FirstRunManager.js'
import { extractIssueNumber, isValidGitRepo, getWorktreeRoot } from '../utils/git.js'
import { getWorkspacePort } from '../utils/port.js'
import { readFile } from 'fs/promises'
import { ClaudeHookManager } from '../lib/ClaudeHookManager.js'
import type { OneShotMode } from '../types/index.js'

/**
 * Error thrown when the spin command is run from an invalid location
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
	private hookManager: ClaudeHookManager
	private settings?: IloomSettings

	constructor(
		templateManager?: PromptTemplateManager,
		gitWorktreeManager?: GitWorktreeManager,
		agentManager?: AgentManager,
		settingsManager?: SettingsManager,
		firstRunManager?: FirstRunManager,
		hookManager?: ClaudeHookManager
	) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
		this.gitWorktreeManager = gitWorktreeManager ?? new GitWorktreeManager()
		this.agentManager = agentManager ?? new AgentManager()
		this.settingsManager = settingsManager ?? new SettingsManager()
		this.firstRunManager = firstRunManager ?? new FirstRunManager('spin')
		this.hookManager = hookManager ?? new ClaudeHookManager()
	}

	/**
	 * Validate that we're not running from the main worktree
	 * @throws WorktreeValidationError if running from main worktree
	 */
	private async validateNotMainWorktree(): Promise<void> {
		const currentDir = process.cwd()

		// Step 1: Check if we're in a git repository at all
		const isGitRepo = await isValidGitRepo(currentDir)
		if (!isGitRepo) {
			// Not a git repo - let detectWorkspaceContext handle this gracefully
			return
		}

		// Step 2: Get the worktree root (handles subdirectories)
		const worktreeRoot = await getWorktreeRoot(currentDir)
		if (!worktreeRoot) {
			// Could not determine root - let detectWorkspaceContext handle this
			return
		}

		// Step 3: Check if this path is a registered git worktree
		const worktrees = await this.gitWorktreeManager.listWorktrees()
		const currentWorktree = worktrees.find(wt => wt.path === worktreeRoot)

		if (!currentWorktree) {
			// Not a registered worktree - let detectWorkspaceContext handle this
			return
		}

		// Step 4: Check if this is the main worktree
		const isMain = await this.gitWorktreeManager.isMainWorktree(currentWorktree, this.settingsManager)
		if (isMain) {
			throw new WorktreeValidationError(
				'You cannot run the command from the main worktree.',
				"Navigate to a feature worktree created by 'il start <issue>' and run 'il spin' from there."
			)
		}
	}

	/**
	 * Print mode options for headless/CI execution
	 */
	public printOptions: {
		print?: boolean
		outputFormat?: 'json' | 'stream-json' | 'text'
		verbose?: boolean
		json?: boolean      // --json flag: output final JSON object
		jsonStream?: boolean // --json-stream flag: stream JSONL to stdout
	} | undefined

	/**
	 * Main entry point for spin command
	 * @param oneShot - One-shot automation mode
	 * @param printOptions - Print mode options for headless/CI execution
	 */
	async execute(oneShot?: OneShotMode, printOptions?: {
		print?: boolean
		outputFormat?: 'json' | 'stream-json' | 'text'
		verbose?: boolean
		json?: boolean
		jsonStream?: boolean
	}): Promise<void> {
		this.printOptions = printOptions

		// Wrap execution in stderr logger for JSON modes to keep stdout clean
		const isJsonMode = (this.printOptions?.json ?? false) || (this.printOptions?.jsonStream ?? false)
		if (isJsonMode) {
			const jsonLogger = createStderrLogger()
			return withLogger(jsonLogger, () => this.executeInternal(oneShot))
		}

		return this.executeInternal(oneShot)
	}

	/**
	 * Internal execution method (separated for withLogger wrapping)
	 */
	private async executeInternal(oneShot?: OneShotMode): Promise<void> {
		// Set ILOOM=1 so hooks know this is an iloom session
		// This is inherited by the Claude child process
		process.env.ILOOM = '1'

		// Validate we're not in the main worktree first
		try {
			await this.validateNotMainWorktree()
		} catch (error) {
			if (error instanceof WorktreeValidationError) {
				logger.error(error.message)
				logger.info(error.suggestion)
				throw error
			}
			throw error
		}

		try {
			logger.info('🚀 Your loom is spinning up, please wait...')

			// Step 0.5: Check if this is first-time user
			const isFirstRun = await this.firstRunManager.isFirstRun()
			if (isFirstRun) {
				logger.success('Welcome to iloom! Preparing first-time experience...')
			}

			// Step 0.6: Install Claude hooks for VSCode integration (idempotent, quick)
			await this.hookManager.installHooks()

			// Step 1: Auto-detect workspace context
			const context = await this.detectWorkspaceContext()

			logger.debug('Auto-detected workspace context', { context })

			// Inform user what context was detected
			this.logDetectedContext(context)

			logger.info('📝 Loading prompt template and preparing Claude...')

			// Step 2: Read metadata early to get draftPrNumber and draftPrUrl for templates and MCP config
			const metadataManager = new MetadataManager()
			const metadata = await metadataManager.readMetadata(context.workspacePath)
			const draftPrNumber = metadata?.draftPrNumber ?? undefined
			// Extract draft PR URL from prUrls map if available
			const draftPrUrl = draftPrNumber && metadata?.prUrls?.[String(draftPrNumber)]
				? metadata.prUrls[String(draftPrNumber)]
				: undefined

			// Step 2.0.4: Determine effective oneShot mode
			// If print mode is enabled, force noReview to skip interactive reviews
			// If oneShot is provided (any value including 'default'), use it
			// If oneShot is undefined (not passed), use metadata or fallback to 'default'
			// Note: metadata?.oneShot can be null (for legacy looms), so we need double nullish coalescing
			const storedOneShot = metadata?.oneShot ?? 'default'
			const isHeadlessForOneShot = this.printOptions?.print ?? false
			const effectiveOneShot: OneShotMode = isHeadlessForOneShot ? 'noReview' : (oneShot ?? storedOneShot)

			// Step 2.0.5: Load settings early if not cached (needed for port calculation)
			if (!this.settings) {
				const cliOverrides = extractSettingsOverrides()
				this.settings = await this.settingsManager.loadSettings(undefined, cliOverrides)
			}

			// Step 2.0.6: Calculate port for web-capable looms
			if (metadata?.capabilities?.includes('web') && context.branchName) {
				const basePort = this.settings?.capabilities?.web?.basePort ?? 3000
				context.port = await getWorkspacePort({
					basePort,
					worktreePath: context.workspacePath,
					worktreeBranch: context.branchName,
				})
				logger.info(`🌐 Development server port: ${context.port}`)
			}

			// Step 2.1: Get prompt template with variable substitution
			const variables = this.buildTemplateVariables(context, effectiveOneShot, draftPrNumber, draftPrUrl)

			// Step 2.5: Add first-time user context if needed
			if (isFirstRun) {
				variables.FIRST_TIME_USER = true
				variables.README_CONTENT = await this.loadReadmeContent()
				variables.SETTINGS_SCHEMA_CONTENT = await this.loadSettingsSchemaContent()
			}

			const systemInstructions = await this.templateManager.getPrompt(context.type, variables)

			// User prompt to trigger the workflow (includes one-shot bypass instructions if needed)
			const userPrompt = this.buildUserPrompt(effectiveOneShot)

			// Step 3: Determine model and permission mode based on workflow type
			const model = this.settingsManager.getSpinModel(this.settings)
			let permissionMode = this.getPermissionModeForWorkflow(context.type)

			// Override permission mode if bypassPermissions oneShot mode
			if (effectiveOneShot === 'bypassPermissions') {
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
			// Session ID must come from loom metadata - no fallback generation
			const sessionId = metadata?.sessionId
			if (!sessionId) {
				throw new Error('No session ID found in loom metadata. This loom may need to be recreated with `il start`.')
			}
			logger.debug('Using session ID from metadata', { sessionId })

			// Determine if we're in print/headless mode
			const isHeadless = this.printOptions?.print ?? false

			const claudeOptions: ClaudeCliOptions = {
				headless: isHeadless,
				addDir: context.workspacePath,
				sessionId, // Enable Claude Code session resume
			}

			// Add optional model if present
			if (model !== undefined) {
				claudeOptions.model = model
			}

			// Add permission mode if not default
			// When print mode is enabled, force bypassPermissions for autonomous execution
			if (isHeadless) {
				permissionMode = 'bypassPermissions'
			}
			if (permissionMode !== undefined && permissionMode !== 'default') {
				claudeOptions.permissionMode = permissionMode
			}

			// Add output format and verbose options if provided (print mode only)
			if (this.printOptions?.outputFormat !== undefined) {
				claudeOptions.outputFormat = this.printOptions.outputFormat
			}
			if (this.printOptions?.verbose !== undefined) {
				claudeOptions.verbose = this.printOptions.verbose
			}

			// Add JSON mode if specified (requires print mode)
			if (this.printOptions?.json) {
				claudeOptions.jsonMode = 'json'
				claudeOptions.outputFormat = 'stream-json' // Force stream-json for parsing
			} else if (this.printOptions?.jsonStream) {
				claudeOptions.jsonMode = 'stream'
				claudeOptions.outputFormat = 'stream-json' // Force stream-json for streaming
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
					const provider = this.settings ? IssueTrackerFactory.getProviderName(this.settings) : 'github'
					// Pass draftPrNumber to route comments to PR when in github-draft-pr mode
					mcpConfig = await generateIssueManagementMcpConfig(context.type, undefined, provider, this.settings, draftPrNumber)
					logger.debug('Generated MCP configuration for issue management', { provider, draftPrNumber })

					// Configure tool filtering for issue/PR workflows
					// Note: set_goal is only allowed for PR workflow (user's purpose unclear)
					// For issue workflow, the issue title provides context so set_goal is not needed
					const baseTools = [
						'mcp__issue_management__get_issue',
						'mcp__issue_management__get_comment',
						'mcp__issue_management__create_comment',
						'mcp__issue_management__update_comment',
						'mcp__issue_management__create_issue',
						'mcp__recap__add_entry',
						'mcp__recap__get_recap',
						'mcp__recap__add_artifact',
						'mcp__recap__set_complexity'
					]
					allowedTools = context.type === 'pr'
						? [...baseTools, 'mcp__issue_management__get_pr', 'mcp__recap__set_goal']
						: baseTools
					disallowedTools = ['Bash(gh api:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh issue comment:*)']

					logger.debug('Configured tool filtering for issue/PR workflow', { allowedTools, disallowedTools })
				} catch (error) {
					// Log warning but continue without MCP
					logger.warn(`Failed to generate MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
				}
			} else {
				// Regular/branch workflow - allow recap tools (including set_goal since no issue/PR context)
				allowedTools = [
					'mcp__recap__set_goal',
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__set_complexity',
				]
				logger.debug('Configured tool filtering for regular workflow', { allowedTools })
			}

			// Step 4.5.1: Generate recap MCP config (always added for all workflow types)
			// Reuses metadata already read in Step 2
			try {
				if (!metadata) {
					throw new Error('No loom metadata found for this workspace')
				}
				const recapMcpConfig = generateRecapMcpConfig(context.workspacePath, metadata)
				if (mcpConfig) {
					mcpConfig.push(...recapMcpConfig)
				} else {
					mcpConfig = recapMcpConfig
				}
				logger.debug('Generated MCP configuration for recap server')
			} catch (error) {
				// Log warning but continue without recap MCP
				logger.warn(`Failed to generate recap MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
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

				// Load agents with settings overrides and template variables for substitution
				// Exclude init-only agents (e.g., framework-detector which is only for il init)
				const loadedAgents = await this.agentManager.loadAgents(
					this.settings,
					variables,
					['*.md', '!iloom-framework-detector.md']
				)
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

			logger.info(isHeadless ? '✨ Launching Claude in headless mode...' : '✨ Launching Claude in current terminal...')

			// Step 5: Launch Claude with system instructions appended and user prompt
			const claudeResult = await launchClaude(userPrompt, {
				...claudeOptions,
				appendSystemPrompt: systemInstructions,
				...(mcpConfig && { mcpConfig }),
				...(allowedTools && { allowedTools }),
				...(disallowedTools && { disallowedTools }),
				...(agents && { agents }),
			})

			// Output final JSON for --json mode (--json-stream already streamed to stdout)
			if (this.printOptions?.json) {
				// eslint-disable-next-line no-console
				console.log(JSON.stringify({
					success: true,
					output: claudeResult ?? ''
				}))
			}

			// Step 6: Mark as run after successful launch
			if (isFirstRun) {
				await this.firstRunManager.markAsRun()
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			// Output error as JSON for --json mode
			if (this.printOptions?.json) {
				// eslint-disable-next-line no-console
				console.log(JSON.stringify({
					success: false,
					error: errorMessage
				}))
			} else {
				logger.error(`Failed to launch Claude: ${errorMessage}`)
			}
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
	private buildTemplateVariables(
		context: ClaudeWorkflowOptions,
		oneShot: OneShotMode,
		draftPrNumber?: number,
		draftPrUrl?: string
	): TemplateVariables {
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

		// Set ONE_SHOT_MODE or INTERACTIVE_MODE flag for template conditional sections
		if (oneShot === 'noReview' || oneShot === 'bypassPermissions') {
			variables.ONE_SHOT_MODE = true
		} else {
			variables.INTERACTIVE_MODE = true
		}

		// Set review configuration variables (same logic as AgentManager)
		const reviewerSettings = this.settings?.agents?.['iloom-code-reviewer']
		const reviewEnabled = reviewerSettings?.enabled !== false // Default to true
		variables.REVIEW_ENABLED = reviewEnabled

		if (reviewEnabled) {
			const providers = reviewerSettings?.providers ?? {}
			// Default to Claude if no providers specified
			const hasAnyProvider = Object.keys(providers).length > 0

			// Determine Claude model: use configured, or default to 'sonnet' if no providers specified
			const claudeModel = providers.claude ?? (hasAnyProvider ? undefined : 'sonnet')
			if (claudeModel) {
				variables.REVIEW_CLAUDE_MODEL = claudeModel
			}
			if (providers.gemini) {
				variables.REVIEW_GEMINI_MODEL = providers.gemini
			}
			if (providers.codex) {
				variables.REVIEW_CODEX_MODEL = providers.codex
			}
			variables.HAS_REVIEW_CLAUDE = !!claudeModel
			variables.HAS_REVIEW_GEMINI = !!providers.gemini
			variables.HAS_REVIEW_CODEX = !!providers.codex
		}

		// Set draft PR mode flags (mutually exclusive)
		// When draftPrNumber is set, we're in github-draft-pr mode
		if (draftPrNumber !== undefined) {
			variables.DRAFT_PR_MODE = true
			variables.DRAFT_PR_NUMBER = draftPrNumber
			if (draftPrUrl) {
				variables.DRAFT_PR_URL = draftPrUrl
			}
			// Set AUTO_COMMIT_PUSH when in draft PR mode and not explicitly disabled
			// Default is true (enabled) for draft PR mode
			const autoCommitPushEnabled = this.settings?.mergeBehavior?.autoCommitPush !== false
			variables.AUTO_COMMIT_PUSH = autoCommitPushEnabled
			// Set GIT_REMOTE from settings or default to 'origin'
			const remote = this.settings?.mergeBehavior?.remote ?? 'origin'
			if (!/^[a-zA-Z0-9_-]+$/.test(remote)) {
				throw new Error(`Invalid git remote name: "${remote}". Remote names can only contain alphanumeric characters, underscores, and hyphens.`)
			}
			variables.GIT_REMOTE = remote
		} else if (context.type === 'regular') {
			// Branch mode without draft PR
			variables.STANDARD_BRANCH_MODE = true
		} else {
			// Issue/PR mode without draft PR
			variables.STANDARD_ISSUE_MODE = true
		}

		return variables
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
		const issueNumber = extractIssueNumber(currentDir)

		if (issueNumber !== null) {
			logger.debug(`Auto-detected issue #${issueNumber} from directory: ${currentDir}`)

			return this.buildContextForIssue(issueNumber, workspacePath)
		}

		// Fallback: Try to extract from git branch name
		try {
			const repoInfo = await this.gitWorktreeManager.getRepoInfo()
			const currentBranch = repoInfo.currentBranch

			if (currentBranch) {
				// Try to extract issue from branch name
				const branchIssueNumber = extractIssueNumber(currentBranch)
				if (branchIssueNumber !== null) {
					logger.debug(`Auto-detected issue #${branchIssueNumber} from branch: ${currentBranch}`)

					return this.buildContextForIssue(branchIssueNumber, workspacePath, currentBranch)
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

		const context: ClaudeWorkflowOptions = {
			type: 'issue',
			issueNumber,
			workspacePath,
			headless: false, // Interactive mode
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

		const context: ClaudeWorkflowOptions = {
			type: 'pr',
			prNumber,
			workspacePath,
			headless: false, // Interactive mode
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

		const context: ClaudeWorkflowOptions = {
			type: 'regular',
			workspacePath,
			headless: false, // Interactive mode
		}

		if (branchName !== undefined) {
			context.branchName = branchName
		}

		return context
	}


	/**
	 * Build user prompt based on one-shot mode
	 */
	private buildUserPrompt(oneShot: OneShotMode = 'default'): string {
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
