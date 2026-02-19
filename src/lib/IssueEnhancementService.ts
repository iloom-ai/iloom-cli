import type { IssueTracker } from './IssueTracker.js'
import type { AgentManager } from './AgentManager.js'
import type { SettingsManager } from './SettingsManager.js'
import type { TemplateVariables } from './PromptTemplateManager.js'
import { launchClaude } from '../utils/claude.js'
import { openBrowser } from '../utils/browser.js'
import { waitForKeypress } from '../utils/prompt.js'
import { getLogger } from '../utils/logger-context.js'
import { generateIssueManagementMcpConfig } from '../utils/mcp.js'

/**
 * Options for enhancing an existing issue
 */
export interface EnhanceExistingIssueOptions {
	/** GitHub username of issue author for tagging in questions */
	author?: string
	/** Repository in "owner/repo" format */
	repo?: string
}

/**
 * Result of enhancing an existing issue
 */
export interface EnhanceExistingIssueResult {
	/** Whether the issue was enhanced */
	enhanced: boolean
	/** URL of the comment if enhancement occurred */
	url?: string
}

/**
 * Service for enhancing and creating issues with AI assistance.
 * Extracts reusable issue enhancement logic from StartCommand.
 */
export class IssueEnhancementService {
	constructor(
		private issueTrackerService: IssueTracker,
		private agentManager: AgentManager,
		private settingsManager: SettingsManager
	) {
		// No-op - logger now uses AsyncLocalStorage context
	}

	/**
	 * Expose issue tracker for provider checks
	 */
	public get issueTracker(): IssueTracker {
		return this.issueTrackerService
	}

	/**
	 * Validates that a description meets minimum requirements.
	 *
	 * When hasBody is false (default): Strict validation - >30 characters AND >2 spaces
	 * When hasBody is true: Relaxed validation - only requires non-empty description
	 *
	 * @param description - The description text to validate
	 * @param hasBody - If true, skip strict validation (only require non-empty)
	 */
	public validateDescription(description: string, hasBody = false): boolean {
		const trimmedDescription = description.trim()

		// When --body is provided, only require non-empty description
		if (hasBody) {
			return trimmedDescription.length > 0
		}

		// Standard validation: >30 chars AND >2 spaces
		const spaceCount = (trimmedDescription.match(/ /g) ?? []).length
		return trimmedDescription.length > 30 && spaceCount > 2
	}

	/**
	 * Enhances a description using Claude Code in headless mode.
	 * Falls back to original description if enhancement fails.
	 */
	public async enhanceDescription(description: string): Promise<string> {
		try {
			getLogger().info('Enhancing description with Claude Code. This may take a moment...')

			// Load only the enhancer agent with template variables so Handlebars expressions resolve
			const settings = await this.settingsManager.loadSettings()
			const templateVariables: TemplateVariables = {
				STANDARD_ISSUE_MODE: true,
				DIRECT_PROMPT_MODE: true,
			}
			const loadedAgents = await this.agentManager.loadAgents(
				settings,
				templateVariables,
				['iloom-issue-enhancer.md']
			)
			const agents = this.agentManager.formatForCli(loadedAgents)

			// Call Claude in headless mode with issue enhancer agent
			const prompt = `@agent-iloom-issue-enhancer

TASK: Enhance the following issue description for the issue tracker.

INPUT:
${description}

OUTPUT REQUIREMENTS:
- Return ONLY the enhanced description markdown text
- Use GitHub-Flavored Markdown syntax ONLY
- NEVER use Jira Wiki format (e.g., {code}, h1., *bold*, {quote}, [link|url])
- NO meta-commentary (no "Here is...", "The enhanced...", "I have...", etc)
- NO code block markers (\`\`\`)
- NO conversational framing or acknowledgments
- NO explanations of your work
- Start your response immediately with the enhanced content

Your response should be the raw markdown that will become the issue body.`

			const enhanced = await launchClaude(prompt, {
				headless: true,
				model: 'sonnet',
				agents,
				noSessionPersistence: true, // Utility operation - don't persist session
			})

			if (enhanced && typeof enhanced === 'string') {
				getLogger().success('Description enhanced successfully')
				return enhanced
			}

			// Fallback to original description
			getLogger().warn('Claude enhancement returned empty result, using original description')
			return description
		} catch (error) {
			getLogger().warn(`Failed to enhance description: ${error instanceof Error ? error.message : 'Unknown error'}`)
			return description
		}
	}

	/**
	 * Creates a GitHub issue with title and enhanced body.
	 * @param originalDescription - Used as the issue title
	 * @param enhancedDescription - Used as the issue body
	 * @param repository - Optional repository override (format: "owner/repo")
	 * @param labels - Optional array of label names to add to the issue
	 * @returns Issue number and URL
	 */
	public async createEnhancedIssue(
		originalDescription: string,
		enhancedDescription: string,
		repository?: string,
		labels?: string[]
	): Promise<{ number: string | number; url: string }> {
		getLogger().info('Creating GitHub issue from description...')

		const result = await this.issueTrackerService.createIssue(
			originalDescription,  // Use original description as title
			enhancedDescription,  // Use enhanced description as body
			repository,
			labels
		)

		return result
	}

	/**
	 * Waits for user keypress and opens issue in browser for review.
	 * @param issueNumber - Issue number to open for review
	 * @param confirm - If true, wait for additional keypress after opening browser before returning
	 * @param repository - Optional repository to fetch issue from (format: "owner/repo")
	 */
	public async waitForReviewAndOpen(issueNumber: string | number, confirm = false, repository?: string): Promise<void> {
		// Check if running in non-interactive environment (CI or no TTY)
		const isCI = process.env.CI === 'true'
		const isNonInteractive = isCI || !process.stdin.isTTY

		if (isNonInteractive) {
			// In non-interactive environment: Skip all interactive operations
			getLogger().info(`Running in non-interactive environment - skipping interactive prompts for issue #${issueNumber}`)
			return
		}

		// Get issue URL
		const issueUrl = await this.issueTrackerService.getIssueUrl(issueNumber, repository)

		// Display message and wait for first keypress
		const message = `Created issue #${issueNumber}.
Review and edit the issue in your browser if needed.
Press any key to open issue for editing...`
		await waitForKeypress(message)

		// Open issue in browser
		await openBrowser(issueUrl)

		// If confirmation required, wait for second keypress
		if (confirm) {
			await waitForKeypress('Press any key to continue with loom creation...')
		}
	}

	/**
	 * Enhances an existing issue using the issue enhancer agent.
	 * This method encapsulates the Claude invocation, MCP config generation,
	 * and response parsing for enhancing existing issues.
	 *
	 * @param issueNumber - The issue number to enhance
	 * @param options - Optional enhancement options (author, repo)
	 * @returns Result indicating whether enhancement occurred and the comment URL if so
	 */
	public async enhanceExistingIssue(
		issueNumber: string | number,
		options?: EnhanceExistingIssueOptions
	): Promise<EnhanceExistingIssueResult> {
		const { author, repo } = options ?? {}

		// Load only the enhancer agent with template variables so Handlebars expressions resolve
		const settings = await this.settingsManager.loadSettings()
		const templateVariables: TemplateVariables = {
			ISSUE_NUMBER: issueNumber,
			STANDARD_ISSUE_MODE: true,
		}
		const loadedAgents = await this.agentManager.loadAgents(
			settings,
			templateVariables,
			['iloom-issue-enhancer.md']
		)
		const agents = this.agentManager.formatForCli(loadedAgents)

		// Generate MCP config and tool filtering for issue management
		let mcpConfig: Record<string, unknown>[] | undefined
		let allowedTools: string[] | undefined
		let disallowedTools: string[] | undefined

		try {
			const provider = this.issueTrackerService.providerName as 'github' | 'linear'
			mcpConfig = await generateIssueManagementMcpConfig('issue', repo, provider, settings)
			getLogger().debug('Generated MCP configuration for issue management:', { mcpConfig })

			// Configure tool filtering for issue workflows
			allowedTools = [
				'mcp__issue_management__get_issue',
				'mcp__issue_management__get_comment',
				'mcp__issue_management__create_comment',
				'mcp__issue_management__update_comment',
				'mcp__issue_management__create_issue',
			]
			disallowedTools = ['Bash(gh api:*)']

			getLogger().debug('Configured tool filtering for issue workflow', { allowedTools, disallowedTools })
		} catch (error) {
			// Log warning but continue without MCP
			getLogger().warn(`Failed to generate MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Construct prompt for the orchestrating Claude instance
		const prompt = this.constructEnhancerPrompt(issueNumber, author)

		// Invoke Claude CLI with enhancer agent
		const response = await launchClaude(prompt, {
			headless: true,
			model: 'sonnet',
			agents,
			noSessionPersistence: true, // Headless operation - no session persistence needed
			...(mcpConfig && { mcpConfig }),
			...(allowedTools && { allowedTools }),
			...(disallowedTools && { disallowedTools }),
		})

		// Parse response to determine outcome
		return this.parseEnhancerResponse(response)
	}

	/**
	 * Construct the prompt for the orchestrating Claude instance.
	 * This prompt is very clear about expected output format to ensure reliable parsing.
	 */
	private constructEnhancerPrompt(issueNumber: string | number, author?: string): string {
		const authorInstruction = author
			? `\nIMPORTANT: When you create your analysis comment, tag @${author} in the "Questions for Reporter" section if you have questions.\n`
			: ''

		return `Execute @agent-iloom-issue-enhancer ${issueNumber}${authorInstruction}

## OUTPUT REQUIREMENTS
* If the issue was not enhanced, return ONLY: "No enhancement needed"
* If the issue WAS enhanced, return ONLY: <FULL URL OF THE COMMENT INCLUDING COMMENT ID>
* If you encounter permission/authentication/access errors, return ONLY: "Permission denied: <specific error description>"
* IMPORTANT: Return ONLY one of the above - DO NOT include commentary such as "I created a comment at <URL>" or "I examined the issue and found no enhancement was necessary"
* CONTEXT: Your output is going to be parsed programmatically, so adherence to the output requirements is CRITICAL.`
	}

	/**
	 * Parse the response from the enhancer agent.
	 * Returns either { enhanced: false } or { enhanced: true, url: "..." }
	 * Throws specific errors for permission issues.
	 */
	private parseEnhancerResponse(response: string | void): EnhanceExistingIssueResult {
		// Handle empty or void response
		if (!response || typeof response !== 'string') {
			throw new Error('No response from enhancer agent')
		}

		const trimmed = response.trim()

		getLogger().debug(`RESPONSE FROM ENHANCER AGENT: '${trimmed}'`)

		// Check for permission denied errors (case-insensitive)
		if (trimmed.toLowerCase().startsWith('permission denied:')) {
			const errorMessage = trimmed.substring('permission denied:'.length).trim()
			throw new Error(`Permission denied: ${errorMessage}`)
		}

		// Check for "No enhancement needed" (case-insensitive)
		if (trimmed.toLowerCase().includes('no enhancement needed')) {
			return { enhanced: false }
		}

		// Check if response looks like a GitHub comment URL
		const urlPattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+#issuecomment-\d+/
		const match = trimmed.match(urlPattern)

		if (match) {
			return { enhanced: true, url: match[0] }
		}

		// Unexpected response format
		throw new Error(`Unexpected response from enhancer agent: ${trimmed}`)
	}
}
