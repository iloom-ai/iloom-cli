import { logger, createStderrLogger } from '../utils/logger.js'
import { withLogger } from '../utils/logger-context.js'
import chalk from 'chalk'
import { detectClaudeCli, launchClaude } from '../utils/claude.js'
import { PromptTemplateManager, type TemplateVariables } from '../lib/PromptTemplateManager.js'
import { generateIssueManagementMcpConfig } from '../utils/mcp.js'
import { SettingsManager, PlanCommandSettingsSchema } from '../lib/SettingsManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { matchIssueIdentifier } from '../utils/IdentifierParser.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { needsFirstRunSetup, launchFirstRunSetup } from '../utils/first-run-setup.js'
import type { IssueProvider, ChildIssueResult, DependenciesResult } from '../mcp/types.js'
import { promptConfirmation, isInteractiveEnvironment } from '../utils/prompt.js'
import { TelemetryService } from '../lib/TelemetryService.js'

// Define provider arrays for validation and dynamic flag generation
const PLANNER_PROVIDERS = ['claude', 'gemini', 'codex'] as const
const REVIEWER_PROVIDERS = ['claude', 'gemini', 'codex', 'none'] as const

type PlannerProvider = (typeof PLANNER_PROVIDERS)[number]
type ReviewerProvider = (typeof REVIEWER_PROVIDERS)[number]

/**
 * Format child issues as a markdown list for inclusion in the prompt
 */
function formatChildIssues(children: ChildIssueResult[], issuePrefix: string): string {
	if (children.length === 0) return 'None'
	return children
		.map(child => `- ${issuePrefix}${child.id}: ${child.title} (${child.state})`)
		.join('\n')
}

/**
 * Format dependencies as a markdown list for inclusion in the prompt
 */
function formatDependencies(dependencies: DependenciesResult, issuePrefix: string): string {
	const lines: string[] = []

	if (dependencies.blockedBy.length > 0) {
		lines.push('**Blocked by:**')
		for (const dep of dependencies.blockedBy) {
			lines.push(`- ${issuePrefix}${dep.id}: ${dep.title} (${dep.state})`)
		}
	}

	if (dependencies.blocking.length > 0) {
		if (lines.length > 0) lines.push('')
		lines.push('**Blocking:**')
		for (const dep of dependencies.blocking) {
			lines.push(`- ${issuePrefix}${dep.id}: ${dep.title} (${dep.state})`)
		}
	}

	return lines.length > 0 ? lines.join('\n') : 'None'
}

/**
 * Launch interactive planning session with Architect persona
 * Implements the `il plan` command requested in issue #471
 *
 * The Architect persona helps users:
 * - Break epics down into child issues following "1 issue = 1 loom = 1 PR" pattern
 * - Think through implementation approaches
 * - Create issues at the end of the planning session using MCP tools
 */
export class PlanCommand {
	private readonly templateManager: PromptTemplateManager

	constructor(templateManager?: PromptTemplateManager) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
	}

	/**
	 * Main entry point for the plan command
	 * @param prompt - Optional initial planning prompt or topic
	 * @param model - Optional model to use (defaults to 'opus')
	 * @param yolo - Optional flag to enable autonomous mode (skip permission prompts)
	 * @param planner - Optional planner provider (defaults to 'claude')
	 * @param reviewer - Optional reviewer provider (defaults to 'none')
	 * @param printOptions - Print mode options for headless/CI execution
	 */
	public async execute(
		prompt?: string,
		model?: string,
		yolo?: boolean,
		planner?: string,
		reviewer?: string,
		printOptions?: {
			print?: boolean
			outputFormat?: 'json' | 'stream-json' | 'text'
			verbose?: boolean
			json?: boolean
			jsonStream?: boolean
		}
	): Promise<void> {
		// Wrap execution in stderr logger for JSON modes to keep stdout clean
		const isJsonMode = (printOptions?.json ?? false) || (printOptions?.jsonStream ?? false)
		if (isJsonMode) {
			const jsonLogger = createStderrLogger()
			return withLogger(jsonLogger, () => this.executeInternal(prompt, model, yolo, planner, reviewer, printOptions))
		}

		return this.executeInternal(prompt, model, yolo, planner, reviewer, printOptions)
	}

	/**
	 * Internal execution method (separated for withLogger wrapping)
	 */
	private async executeInternal(
		prompt?: string,
		model?: string,
		yolo?: boolean,
		planner?: string,
		reviewer?: string,
		printOptions?: {
			print?: boolean
			outputFormat?: 'json' | 'stream-json' | 'text'
			verbose?: boolean
			json?: boolean
			jsonStream?: boolean
		}
	): Promise<void> {
		// Validate and normalize planner CLI argument
		let normalizedPlanner: PlannerProvider | undefined
		if (planner) {
			const normalized = planner.toLowerCase()
			const result = PlanCommandSettingsSchema.shape.planner.safeParse(normalized)
			if (!result.success) {
				throw new Error(`Invalid planner: "${planner}". Allowed values: ${PLANNER_PROVIDERS.join(', ')}`)
			}
			normalizedPlanner = normalized as PlannerProvider
		}

		// Validate and normalize reviewer CLI argument
		let normalizedReviewer: ReviewerProvider | undefined
		if (reviewer) {
			const normalized = reviewer.toLowerCase()
			const result = PlanCommandSettingsSchema.shape.reviewer.safeParse(normalized)
			if (!result.success) {
				throw new Error(`Invalid reviewer: "${reviewer}". Allowed values: ${REVIEWER_PROVIDERS.join(', ')}`)
			}
			normalizedReviewer = normalized as ReviewerProvider
		}

		logger.debug('PlanCommand.execute() starting', {
			cwd: process.cwd(),
			hasPrompt: !!prompt,
			yolo,
			planner: normalizedPlanner ?? planner,
			reviewer: normalizedReviewer ?? reviewer,
		})

		// Check for first-run setup (same check as StartCommand)
		if (process.env.FORCE_FIRST_TIME_SETUP === "true" || await needsFirstRunSetup()) {
			await launchFirstRunSetup()
		}

		logger.info(chalk.bold('Starting interactive planning session...'))

		// Check if Claude CLI is available
		logger.debug('Checking Claude CLI availability')
		const claudeAvailable = await detectClaudeCli()
		logger.debug('Claude CLI availability check result', { claudeAvailable })

		if (!claudeAvailable) {
			logger.error(
				"Claude Code not detected. Please install it: npm install -g @anthropic-ai/claude-code"
			)
			throw new Error('Claude Code CLI is required for planning sessions')
		}

		// Load settings to detect configured issue provider and model
		const settingsManager = new SettingsManager()
		const settings = await settingsManager.loadSettings()

		// Detect if prompt is an issue number for decomposition mode
		// Uses shared matchIssueIdentifier() utility to identify issue identifiers:
		// - Numeric pattern: #123 or 123 (GitHub format)
		// - Project key pattern: ENG-123, PROJ-456 (requires at least 2 letters before dash)
		const identifierMatch = prompt ? matchIssueIdentifier(prompt) : { isIssueIdentifier: false }
		const looksLikeIssueIdentifier = identifierMatch.isIssueIdentifier
		let decompositionContext: {
			identifier: string
			title: string
			body: string
			children?: ChildIssueResult[]
			dependencies?: DependenciesResult
		} | null = null

		const provider = settings ? IssueTrackerFactory.getProviderName(settings) : 'github'
		const issuePrefix = provider === 'github' ? '#' : ''

		if (prompt && looksLikeIssueIdentifier) {
			// Validate and fetch issue using issueTracker.detectInputType() pattern from StartCommand
			const issueTracker = IssueTrackerFactory.create(settings)

			logger.debug('Detected potential issue identifier, validating via issueTracker', { identifier: prompt })

			// Use detectInputType to validate the identifier exists (same pattern as StartCommand)
			const detection = await issueTracker.detectInputType(prompt)

			if (detection.type === 'issue' && detection.identifier) {
				// Valid issue found - fetch full details for decomposition context
				const issue = await issueTracker.fetchIssue(detection.identifier)
				decompositionContext = {
					identifier: String(issue.number),
					title: issue.title,
					body: issue.body
				}
				logger.info(chalk.dim(`Preparing to create a detailed plan for issue #${decompositionContext.identifier}: ${decompositionContext.title}`))

				// Fetch existing children and dependencies using MCP provider
				// This allows users to resume planning where they left off
				try {
					const mcpProvider = IssueManagementProviderFactory.create(provider as IssueProvider, settings ?? undefined)

					// Fetch child issues
					logger.debug('Fetching child issues for decomposition context', { identifier: decompositionContext.identifier })
					const children = await mcpProvider.getChildIssues({ number: decompositionContext.identifier })
					if (children.length > 0) {
						decompositionContext.children = children
						logger.debug('Found existing child issues', { count: children.length })
					}

					// Fetch dependencies (both directions)
					logger.debug('Fetching dependencies for decomposition context', { identifier: decompositionContext.identifier })
					const dependencies = await mcpProvider.getDependencies({
						number: decompositionContext.identifier,
						direction: 'both'
					})
					if (dependencies.blocking.length > 0 || dependencies.blockedBy.length > 0) {
						decompositionContext.dependencies = dependencies
						logger.debug('Found existing dependencies', {
							blocking: dependencies.blocking.length,
							blockedBy: dependencies.blockedBy.length
						})
					}
				} catch (error) {
					// Log but don't fail - children/dependencies are optional context
					logger.debug('Failed to fetch children/dependencies, continuing without them', {
						error: error instanceof Error ? error.message : 'Unknown error'
					})
				}
			} else {
				// Input matched issue pattern but issue not found - treat as regular prompt
				logger.debug('Input matched issue pattern but issue not found, treating as planning topic', {
					identifier: prompt,
					detectionType: detection.type
				})
			}
		}

		// Use CLI model if provided, otherwise use settings (plan.model), defaults to opus
		const effectiveModel = model ?? settingsManager.getPlanModel(settings ?? undefined)

		// Get effective planner/reviewer (CLI > settings > default)
		const effectivePlanner = normalizedPlanner ?? settingsManager.getPlanPlanner(settings ?? undefined)
		const effectiveReviewer = normalizedReviewer ?? settingsManager.getPlanReviewer(settings ?? undefined)

		logger.debug('Detected issue provider, model, planner, and reviewer', {
			provider,
			effectiveModel,
			effectivePlanner,
			effectiveReviewer,
		})

		// Generate MCP config for issue management tools
		// This will throw if no git remote is configured - offer to run 'il init' as fallback
		logger.debug('Generating MCP config for issue management')
		let mcpConfig: Record<string, unknown>[]
		try {
			mcpConfig = await generateIssueManagementMcpConfig(undefined, undefined, provider, settings ?? undefined)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'

			// Check if running in interactive mode - offer to run init
			if (isInteractiveEnvironment()) {
				const shouldRunInit = await promptConfirmation(
					"No git repository or remote found. Would you like to run 'il init' to set up?",
					true
				)
				if (shouldRunInit) {
					// Dynamically import and run InitCommand
					logger.info(chalk.bold('Launching iloom init...'))
					const { InitCommand } = await import('./init.js')
					const initCommand = new InitCommand()
					await initCommand.execute(
						'Help the user set up a GitHub repository or Linear project for this project so they can use issue management features. When complete tell the user they can exit to continue the planning session.'
					)

					// Retry MCP config generation after init
					logger.info(chalk.bold('Retrying planning session setup...'))
					try {
						mcpConfig = await generateIssueManagementMcpConfig(undefined, undefined, provider, settings ?? undefined)
					} catch (retryError) {
						const retryMessage = retryError instanceof Error ? retryError.message : 'Unknown error'
						logger.error(`Failed to generate MCP config: ${retryMessage}`)
						if (provider === 'github') {
							logger.error(
								'GitHub issue management requires a git repository with a GitHub remote configured.'
							)
							throw new Error(
								`Cannot start planning session after init: ${retryMessage}. Ensure you are in a git repository with a GitHub remote configured.`
							)
						} else {
							logger.error(
								'Linear issue management requires LINEAR_API_TOKEN to be configured.'
							)
							throw new Error(
								`Cannot start planning session after init: ${retryMessage}. Ensure LINEAR_API_TOKEN is configured in settings or environment.`
							)
						}
					}
				} else {
					// User declined init prompt - show provider-specific error messages
					logger.error(`Failed to generate MCP config: ${message}`)
					if (provider === 'github') {
						logger.error(
							'GitHub issue management requires a git repository with a GitHub remote configured.'
						)
						throw new Error(
							`Cannot start planning session: ${message}. Ensure you are in a git repository with a GitHub remote configured.`
						)
					} else {
						logger.error(
							'Linear issue management requires LINEAR_API_TOKEN to be configured.'
						)
						throw new Error(
							`Cannot start planning session: ${message}. Ensure LINEAR_API_TOKEN is configured in settings or environment.`
						)
					}
				}
			} else {
				// Non-interactive mode - show provider-specific error messages
				logger.error(`Failed to generate MCP config: ${message}`)
				if (provider === 'github') {
					logger.error(
						'GitHub issue management requires a git repository with a GitHub remote configured.'
					)
					throw new Error(
						`Cannot start planning session: ${message}. Ensure you are in a git repository with a GitHub remote configured.`
					)
				} else {
					logger.error(
						'Linear issue management requires LINEAR_API_TOKEN to be configured.'
					)
					throw new Error(
						`Cannot start planning session: ${message}. Ensure LINEAR_API_TOKEN is configured in settings or environment.`
					)
				}
			}
		}

		logger.debug('MCP config generated', {
			serverCount: mcpConfig.length,
		})

		// Detect VS Code mode
		const isVscodeMode = process.env.ILOOM_VSCODE === '1'
		logger.debug('VS Code mode detection', { isVscodeMode })

		// Compute template variables for multi-AI provider support
		// Generate USE_*_PLANNER and USE_*_REVIEWER flags dynamically
		const providerFlags = PLANNER_PROVIDERS.reduce((acc, p) => ({
			...acc,
			[`USE_${p.toUpperCase()}_PLANNER`]: effectivePlanner === p,
		}), {} as Record<string, boolean>)

		// Add reviewer flags (excluding 'none')
		;(['claude', 'gemini', 'codex'] as const).forEach(p => {
			providerFlags[`USE_${p.toUpperCase()}_REVIEWER`] = effectiveReviewer === p
		})

		// Load plan prompt template with mode-specific variables
		logger.debug('Loading plan prompt template')
		const templateVariables: TemplateVariables = {
			IS_VSCODE_MODE: isVscodeMode,
			EXISTING_ISSUE_MODE: !!decompositionContext,
			FRESH_PLANNING_MODE: !decompositionContext,
			PARENT_ISSUE_NUMBER: decompositionContext?.identifier,
			PARENT_ISSUE_TITLE: decompositionContext?.title,
			PARENT_ISSUE_BODY: decompositionContext?.body,
			PARENT_ISSUE_CHILDREN: decompositionContext?.children
				? formatChildIssues(decompositionContext.children, issuePrefix)
				: undefined,
			PARENT_ISSUE_DEPENDENCIES: decompositionContext?.dependencies
				? formatDependencies(decompositionContext.dependencies, issuePrefix)
				: undefined,
			PLANNER: effectivePlanner,
			REVIEWER: effectiveReviewer,
			HAS_REVIEWER: effectiveReviewer !== 'none',
			...providerFlags,
		}
		const architectPrompt = await this.templateManager.getPrompt('plan', templateVariables)
		logger.debug('Plan prompt loaded', {
			promptLength: architectPrompt.length,
			mode: decompositionContext ? 'decomposition' : 'fresh',
		})

		// Define allowed tools for the Architect persona
		const allowedTools = [
			// Issue management tools
			'mcp__issue_management__create_issue',
			'mcp__issue_management__create_child_issue',
			'mcp__issue_management__get_issue',
			'mcp__issue_management__get_child_issues',
			'mcp__issue_management__get_comment',
			'mcp__issue_management__create_comment',
			// Dependency management tools
			'mcp__issue_management__create_dependency',
			'mcp__issue_management__get_dependencies',
			'mcp__issue_management__remove_dependency',
			// Codebase exploration tools (read-only)
			'Read',
			'Glob',
			'Grep',
			'Task',
			// Web research tools
			'WebFetch',
			'WebSearch',
			// Git commands for understanding repo state
			'Bash(git status:*)',
			'Bash(git log:*)',
			'Bash(git branch:*)',
			'Bash(git remote:*)',
			'Bash(git diff:*)',
			'Bash(git show:*)',
		]

		// Determine if we're in print/headless mode
		const isHeadless = printOptions?.print ?? false

		// Build Claude options
		const claudeOptions: Parameters<typeof launchClaude>[1] = {
			model: effectiveModel,
			headless: isHeadless,
			appendSystemPrompt: architectPrompt,
			mcpConfig,
			addDir: process.cwd(),
			allowedTools,
		}

		// Add output format and verbose options if provided (print mode only)
		if (printOptions?.outputFormat !== undefined) {
			claudeOptions.outputFormat = printOptions.outputFormat
		}
		if (printOptions?.verbose !== undefined) {
			claudeOptions.verbose = printOptions.verbose
		}

		// Add JSON mode if specified (requires print mode)
		if (printOptions?.json) {
			claudeOptions.jsonMode = 'json'
			claudeOptions.outputFormat = 'stream-json' // Force stream-json for parsing
		} else if (printOptions?.jsonStream) {
			claudeOptions.jsonMode = 'stream'
			claudeOptions.outputFormat = 'stream-json' // Force stream-json for streaming
		}

		// Force yolo mode when print mode is enabled (headless execution requires autonomous mode)
		const effectiveYolo = (yolo ?? false) || isHeadless

		// Handle --yolo mode
		if (effectiveYolo) {
			// Only require prompt for explicit --yolo flag, not for print mode auto-yolo
			if (yolo && !prompt) {
				throw new Error('--yolo requires a prompt or issue identifier (e.g., il plan --yolo "add gitlab support" or il plan --yolo 42)')
			}
			logger.warn(
				'YOLO mode enabled - Claude will skip permission prompts and proceed autonomously. This could destroy important data or make irreversible changes. Proceeding means you accept this risk.'
			)
		}

		logger.debug('Launching Claude with options', {
			optionKeys: Object.keys(claudeOptions),
			headless: claudeOptions.headless,
			hasSystemPrompt: !!claudeOptions.appendSystemPrompt,
			addDir: claudeOptions.addDir,
			yolo,
			print: isHeadless,
		})

		// Launch Claude in interactive mode
		// Construct initial message based on mode
		let initialMessage: string
		if (decompositionContext) {
			// Issue decomposition mode - provide context about what to decompose
			initialMessage = `Break down issue #${decompositionContext.identifier} into child issues.`
		} else if (prompt) {
			// Fresh planning with user-provided topic
			initialMessage = prompt
		} else {
			// Interactive mode - no topic provided
			initialMessage = 'Help me plan a feature or decompose work into issues.'
		}

		// Apply yolo mode wrapper if enabled (includes print mode)
		if (effectiveYolo) {
			initialMessage = `[AUTONOMOUS MODE]
Proceed through the flow without requiring user interaction. Make and document your assumptions and proceed to create the epic and child issues and dependencies if necessary. This guidance supersedes all previous guidance.

[TOPIC]
${initialMessage}`
		}

		const claudeResult = await launchClaude(initialMessage, {
			...claudeOptions,
			...(effectiveYolo && { permissionMode: 'bypassPermissions' as const }),
		})

		// Track epic.planned telemetry for decomposition sessions
		if (decompositionContext) {
			try {
				const mcpProv = IssueManagementProviderFactory.create(provider as IssueProvider, settings ?? undefined)
				const children = await mcpProv.getChildIssues({ number: decompositionContext.identifier })
				TelemetryService.getInstance().track('epic.planned', {
					child_count: children.length,
					tracker: provider,
				})
			} catch (error) {
				logger.debug(`Telemetry epic.planned tracking failed: ${error instanceof Error ? error.message : error}`)
			}
		}

		// Output final JSON for --json mode (--json-stream already streamed to stdout)
		if (printOptions?.json) {
			// eslint-disable-next-line no-console
			console.log(JSON.stringify({
				success: true,
				output: claudeResult ?? ''
			}))
		}

		logger.debug('Claude session completed')
		logger.info(chalk.green('Planning session ended.'))
	}
}
