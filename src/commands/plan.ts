/* global AbortController, setImmediate */
import { logger, createStderrLogger } from '../utils/logger.js'
import { withLogger } from '../utils/logger-context.js'
import chalk from 'chalk'
import { detectClaudeCli, launchClaude } from '../utils/claude.js'
import { preAcceptClaudeTrust } from '../utils/claude-trust.js'
import { prepareSystemPromptForPlatform } from '../utils/system-prompt-writer.js'
import { PromptTemplateManager, type TemplateVariables } from '../lib/PromptTemplateManager.js'
import { AgentManager } from '../lib/AgentManager.js'
import { generateIssueManagementMcpConfig, generateHarnessMcpConfig } from '../utils/mcp.js'
import { HarnessServer } from '../lib/HarnessServer.js'
import { SettingsManager, PlanCommandSettingsSchema } from '../lib/SettingsManager.js'
import type { EffortLevel } from '../types/index.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { matchIssueIdentifier } from '../utils/IdentifierParser.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { needsFirstRunSetup, launchFirstRunSetup } from '../utils/first-run-setup.js'
import type { IssueProvider, ChildIssueResult, DependenciesResult } from '../mcp/types.js'
import { promptConfirmation, isInteractiveEnvironment } from '../utils/prompt.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import { processMarkdownImages } from '../utils/image-processor.js'
import { StartCommand } from './start.js'
import { IgniteCommand } from './ignite.js'

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
	private readonly agentManager: AgentManager

	constructor(templateManager?: PromptTemplateManager, agentManager?: AgentManager) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
		this.agentManager = agentManager ?? new AgentManager()
	}

	/**
	 * Main entry point for the plan command
	 * @param prompt - Optional initial planning prompt or topic
	 * @param model - Optional model to use (defaults to 'opus[1m]')
	 * @param flags - Optional flags object controlling permissions and auto-swarm
	 * @param planner - Optional planner provider (defaults to 'claude')
	 * @param reviewer - Optional reviewer provider (defaults to 'none')
	 * @param printOptions - Print mode options for headless/CI execution
	 */
	public async execute(
		prompt?: string,
		model?: string,
		flags?: {
			oneShot?: 'default' | 'noReview' | 'bypassPermissions'
			dangerouslySkipPermissions?: boolean
			autoSwarm?: boolean
		},
		planner?: string,
		reviewer?: string,
		printOptions?: {
			print?: boolean
			outputFormat?: 'json' | 'stream-json' | 'text'
			verbose?: boolean
			json?: boolean
			jsonStream?: boolean
		},
		effort?: EffortLevel
	): Promise<void> {
		// Wrap execution in stderr logger for JSON modes to keep stdout clean
		const isJsonMode = (printOptions?.json ?? false) || (printOptions?.jsonStream ?? false)
		if (isJsonMode) {
			const jsonLogger = createStderrLogger()
			return withLogger(jsonLogger, () => this.executeInternal(prompt, model, flags, planner, reviewer, printOptions, effort))
		}

		return this.executeInternal(prompt, model, flags, planner, reviewer, printOptions, effort)
	}

	/**
	 * Internal execution method (separated for withLogger wrapping)
	 */
	private async executeInternal(
		prompt?: string,
		model?: string,
		flags?: {
			oneShot?: 'default' | 'noReview' | 'bypassPermissions'
			dangerouslySkipPermissions?: boolean
			autoSwarm?: boolean
		},
		planner?: string,
		reviewer?: string,
		printOptions?: {
			print?: boolean
			outputFormat?: 'json' | 'stream-json' | 'text'
			verbose?: boolean
			json?: boolean
			jsonStream?: boolean
		},
		effort?: EffortLevel
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

		const resolvedFlags = flags ?? {}
		const autoSwarm = resolvedFlags.autoSwarm ?? false

		logger.debug('PlanCommand.execute() starting', {
			cwd: process.cwd(),
			hasPrompt: !!prompt,
			flags: resolvedFlags,
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

				// Construct the MCP provider once and reuse for body+comments and
				// children/dependencies. If construction fails, all MCP fetches are
				// skipped and the planning session falls back to issueTracker.fetchIssue's
				// body, with image-processing run on it explicitly below.
				let mcpProvider: ReturnType<typeof IssueManagementProviderFactory.create> | null = null
				try {
					mcpProvider = IssueManagementProviderFactory.create(provider as IssueProvider, settings ?? undefined)
				} catch (error) {
					if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
						throw error
					}
					logger.debug(`Failed to construct MCP provider, continuing without comments/children/dependencies: ${error instanceof Error ? error.message : String(error)}`)
				}

				// The MCP provider's getIssue is the source of truth for body content:
				// it already runs processMarkdownImages AND appends provider-specific extras
				// (e.g. Linear paperclip attachments). Discarding its body would silently drop
				// attachments from the planning context.
				let bodyForPlan = issue.body
				let bodyFromMcp = false
				let commentsSection = ''
				if (mcpProvider) {
					try {
						const mcpIssue = await mcpProvider.getIssue({ number: detection.identifier, includeComments: true })
						if (mcpIssue.body) {
							bodyForPlan = mcpIssue.body
							bodyFromMcp = true
						}
						if (mcpIssue.comments && mcpIssue.comments.length > 0) {
							const commentBlocks = mcpIssue.comments.map(c => {
								const displayName = c.author?.displayName
								const login = c.author && typeof c.author.login === 'string' ? c.author.login : undefined
								const author = displayName ?? login ?? 'unknown'
								const body = c.body || ''
								return `### Comment by ${author}\n\n${body}`
							})
							commentsSection = `\n\n## Comments\n\n${commentBlocks.join('\n\n---\n\n')}`
						}
					} catch (error) {
						if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
							throw error
						}
						logger.debug(`MCP getIssue failed for plan context, falling back to issueTracker body: ${error instanceof Error ? error.message : String(error)}`)
					}
				}

				// Fallback: if MCP didn't supply a body (provider construction failed or
				// getIssue threw), run image processing directly on the raw fetchIssue body
				// so authenticated image URLs are still rewritten to local paths.
				if (!bodyFromMcp) {
					try {
						bodyForPlan = await processMarkdownImages(issue.body, provider as IssueProvider)
					} catch (error) {
						if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
							throw error
						}
						logger.debug(`processMarkdownImages fallback failed, using raw body: ${error instanceof Error ? error.message : String(error)}`)
						bodyForPlan = issue.body
					}
				}

				decompositionContext = {
					identifier: String(issue.number),
					title: issue.title,
					body: bodyForPlan + commentsSection
				}
				logger.info(chalk.dim(`Preparing to create a detailed plan for issue #${decompositionContext.identifier}: ${decompositionContext.title}`))

				// Fetch existing children and dependencies using MCP provider
				// This allows users to resume planning where they left off
				if (mcpProvider) {
					try {
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
				}
			} else {
				// Input matched issue pattern but issue not found - treat as regular prompt
				logger.debug('Input matched issue pattern but issue not found, treating as planning topic', {
					identifier: prompt,
					detectionType: detection.type
				})
			}
		}

		// Use CLI model if provided, otherwise use settings (plan.model), defaults to opus[1m]
		const effectiveModel = model ?? settingsManager.getPlanModel(settings ?? undefined)

		// Get effective effort level (CLI > settings > undefined/defer to Claude Code)
		const effectiveEffort = effort ?? settingsManager.getPlanEffort(settings ?? undefined)

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

		// --- Auto-swarm harness lifecycle ---
		let harness: HarnessServer | null = null
		let externalHarness = false
		let epicData: { epicIssueNumber: string; childIssues: number[] } | null = null
		const controller = autoSwarm ? new AbortController() : null
		const autoSwarmStartTime = autoSwarm ? Date.now() : null
		let autoSwarmSuccess = false
		let autoSwarmPhaseReached: 'plan' | 'start' | 'spin' = 'plan'
		let autoSwarmFallbackToNormal = false

		if (autoSwarm) {
			const autoSwarmSource = decompositionContext ? 'decomposition' : 'fresh'
			try {
				TelemetryService.getInstance().track('auto_swarm.started', {
					source: autoSwarmSource,
					planner: effectivePlanner,
				})
			} catch (error) {
				logger.debug(`Telemetry auto_swarm.started tracking failed: ${error instanceof Error ? error.message : error}`)
			}

			// 1. Check for external harness (e.g., VS Code extension provides its own socket)
			const externalSocket = process.env.ILOOM_HARNESS_SOCKET
			externalHarness = !!externalSocket

			if (!externalSocket) {
				// 2. Create and start harness server
				harness = new HarnessServer()
				await harness.start()
			}

			const socketPath = externalSocket ?? harness?.path
			if (!socketPath) {
				throw new Error('Unexpected: no harness socket path available')
			}

			// 3. Register "done" handler (only when we own the harness server)
			if (harness) {
				harness.registerHandler('done', (data) => {
					epicData = data as typeof epicData
					setImmediate(() => { controller?.abort() })
					return {
						type: 'instruction' as const,
						content: 'Planning complete. The auto-swarm pipeline will now create the epic workspace and launch swarm mode automatically.',
					}
				}, { idempotent: true })
			}

			// 4. Merge harness MCP config
			const harnessMcpConfig = generateHarnessMcpConfig(socketPath)
			mcpConfig = [...mcpConfig, ...harnessMcpConfig]
		}

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

		// Get wave verification setting (default true)
		const waveVerification = settingsManager.getPlanWaveVerification(settings ?? undefined)

		// Determine if we're in print/headless mode (needed early for template variables)
		const isHeadless = printOptions?.print ?? false

		// Resolve effective flag values once, early, so they can be reused for both
		// template variables and runtime logic (autonomous-mode gating, permission bypass, etc.).
		// - oneShot='noReview' or 'bypassPermissions' enables AUTONOMOUS_MODE (skips confirmation gates)
		// - oneShot='bypassPermissions' also sets permissionMode=bypassPermissions
		// - dangerouslySkipPermissions sets permissionMode=bypassPermissions without AUTONOMOUS_MODE
		// - Print/headless mode implies both autonomous and skip-permissions
		const effectiveOneShot = isHeadless ? 'bypassPermissions' as const : (resolvedFlags.oneShot ?? 'default')
		const effectiveAutonomous = effectiveOneShot === 'noReview' || effectiveOneShot === 'bypassPermissions'
		const skipPermissions = effectiveOneShot === 'bypassPermissions' || (resolvedFlags.dangerouslySkipPermissions ?? false)

		// Load plan prompt template with mode-specific variables
		logger.debug('Loading plan prompt template')
		const templateVariables: TemplateVariables = {
			IS_VSCODE_MODE: isVscodeMode,
			WAVE_VERIFICATION: waveVerification,
			ISSUE_TRACKER: provider,
			IS_GITHUB_TRACKER: provider === 'github',
			VCS_PROVIDER: settings?.versionControl?.provider ?? 'github',
			IS_GITHUB_VCS: (settings?.versionControl?.provider ?? 'github') === 'github',
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
			AUTO_SWARM_MODE: autoSwarm,
			AUTONOMOUS_MODE: effectiveAutonomous,
			...providerFlags,
		}
		const architectPrompt = await this.templateManager.getPrompt('plan', templateVariables)
		logger.debug('Plan prompt loaded', {
			promptLength: architectPrompt.length,
			mode: decompositionContext ? 'decomposition' : 'fresh',
		})

		// Load analyzer agent for research delegation
		let agents: Record<string, unknown> | undefined
		try {
			agents = await this.agentManager.loadAndPrepare(
				settings ?? undefined,
				templateVariables,
				['iloom-issue-analyzer.md']
			)
		} catch (error) {
			logger.warn(`Failed to load agents: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Pre-approve issue management tools so the plan agent can use them without prompting
		const allowedTools = [
			'mcp__issue_management__get_issue',
			'mcp__issue_management__get_child_issues',
			'mcp__issue_management__create_issue',
			'mcp__issue_management__create_child_issue',
			'mcp__issue_management__create_comment',
			'mcp__issue_management__create_dependency',
			'mcp__issue_management__get_dependencies',
			'mcp__issue_management__remove_dependency',
			...(autoSwarm ? ['mcp__harness__signal'] : []),
		]

		// Write the architect prompt to a file to keep the claude argv under the
		// OS arg-list limit — inlining via --append-system-prompt can push large
		// prompts past ARG_MAX and fail with E2BIG (spawn error -8) on macOS.
		const systemPromptConfig = await prepareSystemPromptForPlatform(
			architectPrompt,
			process.cwd(),
		)

		// Build Claude options
		const claudeOptions: Parameters<typeof launchClaude>[1] = {
			model: effectiveModel,
			headless: isHeadless,
			appendSystemPromptFile: systemPromptConfig.appendSystemPromptFile,
			mcpConfig,
			addDir: process.cwd(),
			allowedTools,
			...(agents && { agents }),
			...(effectiveEffort && { effort: effectiveEffort }),
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

		// Handle one-shot mode validation: require prompt when running autonomously
		if (effectiveAutonomous && !isHeadless) {
			if (!prompt) {
				throw new Error('Autonomous mode (--one-shot=noReview, --one-shot=bypassPermissions, --autonomous, or --yolo) requires a prompt or issue identifier (e.g., il plan --autonomous "add gitlab support" or il plan --yolo 42)')
			}
		}

		// Warn when skip-permissions is active
		if (skipPermissions) {
			if (effectiveAutonomous) {
				logger.warn(
					'Autonomous mode enabled - Claude will skip permission prompts and proceed without user interaction. This could destroy important data or make irreversible changes. Proceeding means you accept this risk.'
				)
			} else {
				logger.warn(
					'Permission bypass enabled - Claude will skip permission prompts. This could destroy important data or make irreversible changes. Proceeding means you accept this risk.'
				)
			}
		}

		logger.debug('Launching Claude with options', {
			optionKeys: Object.keys(claudeOptions),
			headless: claudeOptions.headless,
			hasSystemPrompt: !!claudeOptions.appendSystemPromptFile,
			addDir: claudeOptions.addDir,
			effectiveAutonomous,
			effectiveOneShot,
			autoSwarm,
			print: isHeadless,
		})

		// Pre-accept Claude Code trust for the working directory
		try {
			await preAcceptClaudeTrust(process.cwd())
		} catch (error) {
			logger.warn(`Failed to pre-accept Claude trust: ${error instanceof Error ? error.message : String(error)}`)
		}

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

		// Apply autonomous mode wrapper if enabled (includes print mode)
		if (effectiveAutonomous) {
			initialMessage = `[AUTONOMOUS MODE]
Proceed through the flow without requiring user interaction. Make and document your assumptions and proceed to create the epic and child issues and dependencies if necessary. This guidance supersedes all previous guidance.

[TOPIC]
${initialMessage}`
		}

		try {
			const claudeResult = await launchClaude(initialMessage, {
				...claudeOptions,
				...(skipPermissions && { permissionMode: 'bypassPermissions' as const }),
				...(controller && { signal: controller.signal }),
			})

			// Check auto-swarm outcome
			if (autoSwarm) {
				// When an external harness (e.g., VS Code) owns the socket, it handles
				// the "done" signal and manages the start/spin pipeline itself.
				// The CLI just exits cleanly after the plan phase.
				if (externalHarness) {
					logger.info(chalk.green('Planning session ended. External harness will manage the pipeline.'))
					autoSwarmSuccess = true
					autoSwarmPhaseReached = 'plan'
				} else if (!epicData) {
					throw new Error('Plan phase exited without completing. The Architect did not signal done.')
				} else {
					// Cast required because TypeScript cannot narrow let variables mutated in closures.
					// Defensively default childIssues — the data comes from AI-generated signal payloads.
					const resolvedEpicData = epicData as { epicIssueNumber: string; childIssues?: number[] }
					const epicIssueNumber = resolvedEpicData.epicIssueNumber
					const childIssues = resolvedEpicData.childIssues ?? []
					logger.info(chalk.green(`Planning complete. Epic issue: #${epicIssueNumber}`))
					autoSwarmFallbackToNormal = childIssues.length === 0

					const startCommand = new StartCommand(IssueTrackerFactory.create(settings ?? {}))

					if (childIssues.length === 0) {
						// Zero-children fallback: normal (non-epic) autonomous loom
						logger.info('No child issues created. Starting as a normal autonomous loom.')
						let startResult
						try {
							startResult = await startCommand.execute({
								identifier: String(epicIssueNumber),
								options: { oneShot: 'bypassPermissions', json: true, claude: false, code: false, devServer: false, terminal: false },
							})
						} catch (startError) {
							throw new Error(
								`Auto-swarm: failed to create epic workspace. ${startError instanceof Error ? startError.message : String(startError)}`
							)
						}

						const epicWorktreePath = startResult?.path
						if (!epicWorktreePath) {
							throw new Error('Auto-swarm: StartCommand did not return a workspace path.')
						}

						const igniteCommand = new IgniteCommand()
						await igniteCommand.execute('bypassPermissions', undefined, undefined, epicWorktreePath)
					} else {
						// Epic mode: start + spin with swarm
						let startResult
						try {
							startResult = await startCommand.execute({
								identifier: String(epicIssueNumber),
								options: { epic: true, json: true, oneShot: 'bypassPermissions', claude: false, code: false, devServer: false, terminal: false },
							})
						} catch (startError) {
							throw new Error(
								`Auto-swarm: failed to create epic workspace. ${startError instanceof Error ? startError.message : String(startError)}`
							)
						}

						const epicWorktreePath = startResult?.path
						if (!epicWorktreePath) {
							throw new Error('Auto-swarm: StartCommand did not return a workspace path.')
						}

						const igniteCommand = new IgniteCommand()
						await igniteCommand.execute('bypassPermissions', undefined, undefined, epicWorktreePath)
					}

					autoSwarmSuccess = true
					autoSwarmPhaseReached = 'spin'
				}
			}

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
		} finally {
			if (harness) {
				await harness.stop()
			}

			if (autoSwarm && autoSwarmStartTime !== null) {
				const durationMinutes = (Date.now() - autoSwarmStartTime) / 60000
				const autoSwarmSource = decompositionContext ? 'decomposition' : 'fresh'
				const resolvedEpicData = epicData as { epicIssueNumber: string; childIssues: number[] } | null
				try {
					TelemetryService.getInstance().track('auto_swarm.completed', {
						source: autoSwarmSource,
						success: autoSwarmSuccess,
						child_count: resolvedEpicData?.childIssues.length ?? 0,
						duration_minutes: Math.round(durationMinutes * 10) / 10,
						phase_reached: autoSwarmPhaseReached,
						fallback_to_normal: autoSwarmFallbackToNormal,
					})
				} catch (error) {
					logger.debug(`Telemetry auto_swarm.completed tracking failed: ${error instanceof Error ? error.message : error}`)
				}
			}
		}
	}
}
