import path from 'path'
import fs from 'fs-extra'
import { logger, createStderrLogger } from '../utils/logger.js'
import { withLogger } from '../utils/logger-context.js'
import { ClaudeWorkflowOptions } from '../lib/ClaudeService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { launchClaude, ClaudeCliOptions } from '../utils/claude.js'
import { PromptTemplateManager, TemplateVariables, buildReviewTemplateVariables } from '../lib/PromptTemplateManager.js'
import { generateIssueManagementMcpConfig, generateRecapMcpConfig, generateAndWriteMcpConfigFile } from '../utils/mcp.js'
import { AgentManager } from '../lib/AgentManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { SettingsManager, type IloomSettings } from '../lib/SettingsManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import { FirstRunManager } from '../utils/FirstRunManager.js'
import { extractIssueNumber, isValidGitRepo, getWorktreeRoot, findMainWorktreePathWithSettings } from '../utils/git.js'
import { getWorkspacePort } from '../utils/port.js'
import { readFile } from 'fs/promises'
import { ClaudeHookManager } from '../lib/ClaudeHookManager.js'
import type { OneShotMode } from '../types/index.js'
import { fetchChildIssueDetails } from '../utils/list-children.js'
import { buildDependencyMap } from '../utils/dependency-map.js'
import { SwarmSetupService } from '../lib/SwarmSetupService.js'
import type { LoomMetadata } from '../lib/MetadataManager.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import { detectProjectLanguage } from '../utils/language-detector.js'

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
	 * @param workspacePath - Optional explicit workspace path; defaults to process.cwd()
	 * @throws WorktreeValidationError if running from main worktree
	 */
	private async validateNotMainWorktree(workspacePath?: string): Promise<void> {
		const currentDir = workspacePath ?? process.cwd()

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
	 * @param skipCleanup - Skip cleanup after execution
	 * @param workspacePath - Optional explicit workspace path for programmatic invocation (avoids process.chdir())
	 */
	async execute(oneShot?: OneShotMode, printOptions?: {
		print?: boolean
		outputFormat?: 'json' | 'stream-json' | 'text'
		verbose?: boolean
		json?: boolean
		jsonStream?: boolean
	}, skipCleanup?: boolean, workspacePath?: string): Promise<void> {
		this.printOptions = printOptions

		// Wrap execution in stderr logger for JSON modes to keep stdout clean
		const isJsonMode = (this.printOptions?.json ?? false) || (this.printOptions?.jsonStream ?? false)
		if (isJsonMode) {
			const jsonLogger = createStderrLogger()
			return withLogger(jsonLogger, () => this.executeInternal(oneShot, skipCleanup, workspacePath))
		}

		return this.executeInternal(oneShot, skipCleanup, workspacePath)
	}

	/**
	 * Internal execution method (separated for withLogger wrapping)
	 */
	private async executeInternal(oneShot?: OneShotMode, skipCleanup?: boolean, workspacePath?: string): Promise<void> {
		// Set ILOOM=1 so hooks know this is an iloom session
		// This is inherited by the Claude child process
		process.env.ILOOM = '1'

		// Validate we're not in the main worktree first
		try {
			await this.validateNotMainWorktree(workspacePath)
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
			const context = await this.detectWorkspaceContext(workspacePath)

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

			// Step 2.0.5.1: Track session.started telemetry
			try {
				const hasNeon = !!this.settings?.databaseProviders?.neon
				const language = await detectProjectLanguage(context.workspacePath)
				TelemetryService.getInstance().track('session.started', {
					has_neon: hasNeon,
					language,
				})
			} catch (error) {
				logger.debug(`Telemetry session.started tracking failed: ${error instanceof Error ? error.message : error}`)
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

			// Step 2.1: Fetch and persist epic child data if this is an epic loom
			// Detection: check for childIssues already stored (re-spin of an epic)
			// or check for 'epic' issueType once issue #624 adds it
			const isEpicLoom = metadata && metadata.issue_numbers.length > 0
				&& ((metadata.childIssues?.length ?? 0) > 0 || metadata.issueType === 'epic')
			if (isEpicLoom && this.settings) {
				await this.fetchAndStoreEpicChildData(metadataManager, metadata, context.workspacePath, this.settings)
			}

			// Step 2.1.1: If this is an epic loom, enter swarm mode
			if (isEpicLoom && this.settings) {
				// Re-read metadata to get freshly persisted child data
				const freshMetadata = await metadataManager.readMetadata(context.workspacePath)
				if (freshMetadata && freshMetadata.childIssues.length > 0) {
					await this.executeSwarmMode(
						freshMetadata,
						context.workspacePath,
						context.branchName ?? '',
						metadataManager,
						skipCleanup,
					)
					return
				}
			}

			// Step 2.2: Get prompt template with variable substitution
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
						'mcp__issue_management__close_issue',
						'mcp__issue_management__reopen_issue',
						'mcp__issue_management__edit_issue',
						'mcp__recap__add_entry',
						'mcp__recap__get_recap',
						'mcp__recap__add_artifact',
						'mcp__recap__set_complexity',
						'mcp__recap__set_loom_state',
						'mcp__recap__get_loom_state'
					]
					allowedTools = context.type === 'pr'
						? [...baseTools, 'mcp__issue_management__get_pr', 'mcp__issue_management__get_review_comments', 'mcp__recap__set_goal']
						: baseTools
					disallowedTools = ['Bash(gh api:*), Bash(gh issue comment:*)']

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
					'mcp__recap__set_loom_state',
					'mcp__recap__get_loom_state',
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

		// Set review configuration variables (code reviewer + artifact reviewer + per-agent flags)
		Object.assign(variables, buildReviewTemplateVariables(this.settings?.agents))

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

		// Detect VS Code mode
		const isVscodeMode = process.env.ILOOM_VSCODE === '1'
		variables.IS_VSCODE_MODE = isVscodeMode

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
	private async detectWorkspaceContext(workspacePath?: string): Promise<ClaudeWorkflowOptions> {
		const workspacePath_ = workspacePath ?? process.cwd()
		const currentDir = path.basename(workspacePath_)

		// Check for PR worktree pattern: _pr_N suffix
		// Pattern: /.*_pr_(\d+)$/
		const prPattern = /_pr_(\d+)$/
		const prMatch = currentDir.match(prPattern)

		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			logger.debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)

			return this.buildContextForPR(prNumber, workspacePath_)
		}

		// Check for issue pattern in directory name
		const issueNumber = extractIssueNumber(currentDir)

		if (issueNumber !== null) {
			logger.debug(`Auto-detected issue #${issueNumber} from directory: ${currentDir}`)

			return this.buildContextForIssue(issueNumber, workspacePath_)
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

					return this.buildContextForIssue(branchIssueNumber, workspacePath_, currentBranch)
				}
			}
		} catch (error) {
			// Git command failed - not a git repo or other git error
			logger.debug('Could not detect from git branch', { error })
		}

		// Last resort: use regular workflow
		logger.debug('No specific context detected, using regular workflow')
		return this.buildContextForRegular(workspacePath_)
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
	 * Fetch and store epic child issue data and dependency map in metadata
	 *
	 * Called during spin setup for epic looms. Fetches child issue details
	 * and dependency relationships from the issue tracker, then persists
	 * them in the loom metadata for use by the orchestrator.
	 */
	private async fetchAndStoreEpicChildData(
		metadataManager: MetadataManager,
		metadata: import('../lib/MetadataManager.js').LoomMetadata,
		worktreePath: string,
		settings: import('../lib/SettingsManager.js').IloomSettings,
	): Promise<void> {
		const parentIssueNumber = metadata.issue_numbers[0]
		if (!parentIssueNumber) return

		logger.info('Fetching child issue data for epic...')

		try {
			const issueTracker = IssueTrackerFactory.create(settings)

			// Fetch child issue details and build dependency map in parallel
			const childIssueDetails = await fetchChildIssueDetails(
				parentIssueNumber, issueTracker
			)

			if (childIssueDetails.length === 0) {
				logger.debug('No child issues found for epic')
				return
			}

			// Extract raw IDs for dependency map building (strip prefixes)
			const childIds = childIssueDetails.map((child) => child.number.replace(/^#/, ''))

			const dependencyMap = await buildDependencyMap(childIds, settings)

			// Persist to metadata
			await metadataManager.updateMetadata(worktreePath, {
				childIssues: childIssueDetails,
				dependencyMap,
			})

			logger.info(`Stored ${childIssueDetails.length} child issues and dependency map in metadata`)
		} catch (error) {
			// Non-fatal: epic can still spin without child data
			logger.warn(`Failed to fetch epic child data: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Execute swarm mode for an epic loom.
	 *
	 * Creates child worktrees, renders swarm agents/skill, builds the
	 * orchestrator prompt, and launches Claude with agent teams enabled.
	 */
	private async executeSwarmMode(
		metadata: LoomMetadata,
		epicWorktreePath: string,
		epicBranch: string,
		metadataManager: MetadataManager,
		skipCleanup?: boolean,
	): Promise<void> {
		if (!this.settings) {
			throw new Error('Settings not loaded. Cannot enter swarm mode.')
		}
		const settings = this.settings
		const epicIssueNumber = metadata.issue_numbers[0]
		if (!epicIssueNumber) {
			throw new Error('Epic loom has no issue number in metadata')
		}

		logger.info('Epic loom detected - entering swarm mode...')

		// Determine main worktree path and issue tracker provider
		const mainWorktreePath = await findMainWorktreePathWithSettings()
		const providerName = IssueTrackerFactory.getProviderName(settings)

		// Create SwarmSetupService
		const swarmSetup = new SwarmSetupService(
			this.gitWorktreeManager,
			metadataManager,
			this.agentManager,
			this.settingsManager,
			this.templateManager,
		)

		// Generate and write per-loom MCP config file for the epic worktree
		try {
			const epicMcpConfigPath = await generateAndWriteMcpConfigFile(
				epicWorktreePath,
				metadata,
				providerName as 'github' | 'linear' | 'jira',
				settings,
			)
			await metadataManager.updateMetadata(epicWorktreePath, { mcpConfigPath: epicMcpConfigPath })

			// Write MCP config path to .claude/iloom-swarm-mcp-config-path for worker discovery
			const epicClaudeDir = path.join(epicWorktreePath, '.claude')
			await fs.ensureDir(epicClaudeDir)
			await fs.writeFile(
				path.join(epicClaudeDir, 'iloom-swarm-mcp-config-path'),
				epicMcpConfigPath,
				'utf-8',
			)

			logger.debug('Wrote MCP config for epic loom', { epicMcpConfigPath })
		} catch (error) {
			logger.warn(`Failed to write MCP config for epic loom: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Build MCP configs for the orchestrator's own launchClaude call
		const mcpConfigs: Record<string, unknown>[] = []

		// Issue management MCP
		try {
			const issueMcpConfigs = await generateIssueManagementMcpConfig(
				'issue',
				undefined,
				providerName as 'github' | 'linear' | 'jira',
				settings,
			)
			mcpConfigs.push(...issueMcpConfigs)
		} catch (error) {
			logger.warn(`Failed to generate issue management MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Recap MCP for the epic loom
		try {
			const recapMcpConfigs = generateRecapMcpConfig(epicWorktreePath, metadata)
			mcpConfigs.push(...recapMcpConfigs)
		} catch (error) {
			logger.warn(`Failed to generate recap MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Run swarm setup: child worktrees, agents, worker agent
		const swarmResult = await swarmSetup.setupSwarm(
			epicIssueNumber,
			epicBranch,
			epicWorktreePath,
			metadata.childIssues,
			mainWorktreePath,
			providerName,
			settings,
		)

		// Build template variables for orchestrator prompt
		const successfulWorktrees = swarmResult.childWorktrees.filter((c) => c.success)
		const worktreeMap = new Map(successfulWorktrees.map((cw) => [cw.issueId, cw]))

		const childIssuesData = metadata.childIssues
			.filter((ci) => worktreeMap.has(ci.number.replace(/^#/, '')))
			.map((ci) => {
				const rawId = ci.number.replace(/^#/, '')
				const wt = worktreeMap.get(rawId)
				return {
					number: rawId,
					title: ci.title,
					body: ci.body,
					worktreePath: wt?.worktreePath ?? '',
					branchName: wt?.branch ?? '',
				}
			})

		// Get metadata file path for the orchestrator prompt template
		const epicMetadataPath = metadataManager.getMetadataFilePath(epicWorktreePath)

		// Determine issue prefix for commit message trailers
		const issuePrefix = providerName === 'github' ? '#' : ''

		const variables: TemplateVariables = {
			EPIC_ISSUE_NUMBER: epicIssueNumber,
			EPIC_WORKTREE_PATH: epicWorktreePath,
			EPIC_METADATA_PATH: epicMetadataPath,
			CHILD_ISSUES: JSON.stringify(childIssuesData, null, 2),
			DEPENDENCY_MAP: JSON.stringify(metadata.dependencyMap, null, 2),
			ISSUE_PREFIX: issuePrefix,
			...(skipCleanup && { NO_CLEANUP: true }),
		}

		// Set draft PR mode flags for swarm orchestrator (same logic as buildTemplateVariables)
		const draftPrNumber = metadata.draftPrNumber ?? undefined
		if (draftPrNumber !== undefined) {
			variables.DRAFT_PR_MODE = true
			variables.DRAFT_PR_NUMBER = draftPrNumber
			const draftPrUrl = metadata.prUrls?.[String(draftPrNumber)]
			if (draftPrUrl) {
				variables.DRAFT_PR_URL = draftPrUrl
			}
			const autoCommitPushEnabled = settings.mergeBehavior?.autoCommitPush !== false
			variables.AUTO_COMMIT_PUSH = autoCommitPushEnabled
			const remote = settings.mergeBehavior?.remote ?? 'origin'
			if (!/^[a-zA-Z0-9_-]+$/.test(remote)) {
				throw new Error(`Invalid git remote name: "${remote}". Remote names can only contain alphanumeric characters, underscores, and hyphens.`)
			}
			variables.GIT_REMOTE = remote
		}

		const orchestratorPrompt = await this.templateManager.getPrompt('swarm-orchestrator', variables)

		// Build allowed tools
		const allowedTools = [
			'mcp__issue_management__get_issue',
			'mcp__issue_management__get_comment',
			'mcp__issue_management__create_comment',
			'mcp__issue_management__update_comment',
			'mcp__issue_management__create_issue',
			'mcp__issue_management__close_issue',
			'mcp__issue_management__reopen_issue',
			'mcp__issue_management__edit_issue',
			'mcp__recap__add_entry',
			'mcp__recap__get_recap',
			'mcp__recap__add_artifact',
			'mcp__recap__set_complexity',
			'mcp__recap__set_loom_state',
			'mcp__recap__get_loom_state',
		]

		// Launch Claude with agent teams enabled
		const model = this.settingsManager.getSpinModel(settings, 'swarm')

		logger.info('Launching swarm orchestrator...')
		logger.info(`   Model: ${model ?? 'default'}`)
		logger.info(`   Permission mode: bypassPermissions`)
		logger.info(`   Agent teams: enabled`)
		logger.info(`   Child worktrees: ${successfulWorktrees.length}`)

		// Load agents for the orchestrator
		let agents: Record<string, unknown> | undefined
		try {
			const loadedAgents = await this.agentManager.loadAgents(
				settings,
				variables,
				['*.md', '!iloom-framework-detector.md']
			)
			agents = this.agentManager.formatForCli(loadedAgents)
		} catch (error) {
			logger.warn(`Failed to load agents: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Track swarm.started before launching orchestrator
		const swarmStartTime = Date.now()
		try {
			TelemetryService.getInstance().track('swarm.started', {
				child_count: successfulWorktrees.length,
				tracker: providerName,
			})
		} catch (error) {
			logger.debug(`Telemetry swarm.started tracking failed: ${error instanceof Error ? error.message : error}`)
		}

		await launchClaude(
			`You are the swarm orchestrator for epic #${epicIssueNumber}. Begin by reading your system prompt instructions and executing the workflow.`,
			{
				model,
				permissionMode: 'bypassPermissions',
				addDir: epicWorktreePath,
				headless: false,
				...(metadata.sessionId && { sessionId: metadata.sessionId }),
				appendSystemPrompt: orchestratorPrompt,
				mcpConfig: mcpConfigs,
				allowedTools,
				...(agents && { agents }),
				env: {
					CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
					ILOOM_SWARM: '1',
					ENABLE_TOOL_SEARCH: 'auto:30',
				},
			},
		)

		// Track swarm child completions and overall completion
		try {
			const swarmEndTime = Date.now()
			let succeeded = 0
			let failed = 0

			for (const child of successfulWorktrees) {
				const childMeta = await metadataManager.readMetadata(child.worktreePath)
				const isSuccess = childMeta?.state === 'done'
				if (isSuccess) {
					succeeded++
				} else {
					failed++
				}

				const parsed = childMeta?.created_at ? Date.parse(childMeta.created_at) : NaN
				const childCreatedAt = Number.isNaN(parsed) ? swarmStartTime : parsed
				const childDuration = Math.max(0, Math.round((swarmEndTime - childCreatedAt) / 60000))

				TelemetryService.getInstance().track('swarm.child_completed', {
					success: isSuccess,
					duration_minutes: childDuration,
				})
			}

			TelemetryService.getInstance().track('swarm.completed', {
				total_children: successfulWorktrees.length,
				succeeded,
				failed,
				duration_minutes: Math.round((swarmEndTime - swarmStartTime) / 60000),
			})
		} catch (error) {
			logger.debug(`Telemetry swarm completion tracking failed: ${error instanceof Error ? error.message : error}`)
		}
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
