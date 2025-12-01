import { detectClaudeCli, launchClaude, launchClaudeInNewTerminalWindow, ClaudeCliOptions } from '../utils/claude.js'
import { PromptTemplateManager, TemplateVariables } from './PromptTemplateManager.js'
import { SettingsManager, IloomSettings } from './SettingsManager.js'
import { logger } from '../utils/logger.js'

export interface ClaudeWorkflowOptions {
	type: 'issue' | 'pr' | 'regular'
	issueNumber?: number
	prNumber?: number
	title?: string
	workspacePath: string
	port?: number
	headless?: boolean
	branchName?: string
	oneShot?: import('../types/index.js').OneShotMode
	setArguments?: string[] // Raw --set arguments to forward
	executablePath?: string // Executable path to use for spin command
}

export class ClaudeService {
	private templateManager: PromptTemplateManager
	private settingsManager: SettingsManager
	private settings?: IloomSettings

	constructor(templateManager?: PromptTemplateManager, settingsManager?: SettingsManager) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
		this.settingsManager = settingsManager ?? new SettingsManager()
	}

	/**
	 * Check if Claude CLI is available
	 */
	async isAvailable(): Promise<boolean> {
		return detectClaudeCli()
	}

	/**
	 * Get the appropriate model for a workflow type
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
	 * Launch Claude for a specific workflow
	 */
	async launchForWorkflow(options: ClaudeWorkflowOptions): Promise<string | void> {
		const { type, issueNumber, prNumber, title, workspacePath, port, headless = false, branchName, oneShot = 'default', setArguments, executablePath } = options

		try {
			// Load settings if not already cached
			// Settings are pre-validated at CLI startup, so no error handling needed here
			this.settings ??= await this.settingsManager.loadSettings()

			// Build template variables
			const variables: TemplateVariables = {
				WORKSPACE_PATH: workspacePath,
			}

			if (issueNumber !== undefined) {
				variables.ISSUE_NUMBER = issueNumber
			}

			if (prNumber !== undefined) {
				variables.PR_NUMBER = prNumber
			}

			if (title !== undefined) {
				if (type === 'issue') {
					variables.ISSUE_TITLE = title
				} else if (type === 'pr') {
					variables.PR_TITLE = title
				}
			}

			if (port !== undefined) {
				variables.PORT = port
			}

			// Get the prompt from template manager
			const prompt = await this.templateManager.getPrompt(type, variables)

			// Determine model and permission mode
			const model = this.getModelForWorkflow(type)
			const permissionMode = this.getPermissionModeForWorkflow(type)

			// Display warning if bypassPermissions mode is used
			if (permissionMode === 'bypassPermissions') {
				logger.warn(
					'⚠️  WARNING: Using bypassPermissions mode - Claude will execute all tool calls without confirmation. ' +
						'This can be dangerous. Use with caution.'
				)
			}

			// Build Claude CLI options
			const claudeOptions: ClaudeCliOptions = {
				addDir: workspacePath,
				headless,
			}

			// Add optional model if present
			if (model !== undefined) {
				claudeOptions.model = model
			}

			// Add permission mode if not default
			if (permissionMode !== undefined && permissionMode !== 'default') {
				claudeOptions.permissionMode = permissionMode
			}

			// Add optional branch name for terminal coloring
			if (branchName !== undefined) {
				claudeOptions.branchName = branchName
			}

			// Add optional port for terminal window export
			if (port !== undefined) {
				claudeOptions.port = port
			}

			// Add optional setArguments for forwarding
			if (setArguments !== undefined) {
				claudeOptions.setArguments = setArguments
			}

			// Add optional executablePath for spin command
			if (executablePath !== undefined) {
				claudeOptions.executablePath = executablePath
			}

			logger.debug('Launching Claude for workflow', {
				type,
				model,
				permissionMode,
				headless,
				workspacePath,
			})

			// Launch Claude
			if (headless) {
				// Headless mode: use simple launchClaude
				return await launchClaude(prompt, claudeOptions)
			} else {
				// Interactive workflow mode: use terminal window launcher
				// This is the "end of il start" behavior
				if (!claudeOptions.addDir) {
					throw new Error('workspacePath required for interactive workflow launch')
				}

				return await launchClaudeInNewTerminalWindow(prompt, {
					...claudeOptions,
					workspacePath: claudeOptions.addDir,
					oneShot,
				})
			}
		} catch (error) {
			logger.error('Failed to launch Claude for workflow', { error, options })
			throw error
		}
	}

}
