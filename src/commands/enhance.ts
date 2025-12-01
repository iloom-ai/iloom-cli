import type { IssueTracker } from '../lib/IssueTracker.js'
import type { AgentManager } from '../lib/AgentManager.js'
import type { SettingsManager } from '../lib/SettingsManager.js'
import { launchClaude } from '../utils/claude.js'
import { openBrowser } from '../utils/browser.js'
import { waitForKeypress } from '../utils/prompt.js'
import { logger } from '../utils/logger.js'
import { generateIssueManagementMcpConfig } from '../utils/mcp.js'
import { AgentManager as DefaultAgentManager } from '../lib/AgentManager.js'
import { SettingsManager as DefaultSettingsManager } from '../lib/SettingsManager.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'

export interface EnhanceCommandInput {
	issueNumber: string | number
	options: EnhanceOptions
}

export interface EnhanceOptions {
	noBrowser?: boolean // Skip browser opening prompt
	author?: string // GitHub username of issue author for tagging
}

/**
 * Command to enhance existing GitHub issues with AI assistance.
 * Applies the issue enhancer agent to an existing issue, respecting idempotency checks.
 */
export class EnhanceCommand {
	private issueTracker: IssueTracker
	private agentManager: AgentManager
	private settingsManager: SettingsManager

	constructor(
		issueTracker: IssueTracker,
		agentManager?: AgentManager,
		settingsManager?: SettingsManager
	) {
		this.issueTracker = issueTracker
		this.agentManager = agentManager ?? new DefaultAgentManager()
		this.settingsManager = settingsManager ?? new DefaultSettingsManager()
	}

	/**
	 * Execute the enhance command workflow:
	 * 1. Validate issue number
	 * 2. Fetch issue to verify it exists
	 * 3. Load agent configurations
	 * 4. Invoke Claude CLI with enhancer agent
	 * 5. Parse response to determine outcome
	 * 6. Handle browser interaction based on outcome
	 */
	public async execute(input: EnhanceCommandInput): Promise<void> {
		const { issueNumber, options } = input
		const { author } = options

		// Step 0: Load settings and get configured repo for GitHub operations
		const settings = await this.settingsManager.loadSettings()

		let repo: string | undefined

		const multipleRemotes = await hasMultipleRemotes()
		if (multipleRemotes) {
			repo = await getConfiguredRepoFromSettings(settings)
			logger.info(`Using GitHub repository: ${repo}`)
		}

		// Step 1: Validate issue number
		this.validateIssueNumber(issueNumber)

		// Step 2: Fetch issue to verify it exists
		logger.info(`Fetching issue #${issueNumber}...`)
		const issue = await this.issueTracker.fetchIssue(issueNumber, repo)
		logger.debug('Issue fetched successfully', { number: issue.number, title: issue.title })

		// Step 3: Load agent configurations
		logger.debug('Loading agent configurations...')
		const loadedAgents = await this.agentManager.loadAgents(settings)
		const agents = this.agentManager.formatForCli(loadedAgents)

		// Step 3.5: Generate MCP config and tool filtering for issue management
		let mcpConfig: Record<string, unknown>[] | undefined
		let allowedTools: string[] | undefined
		let disallowedTools: string[] | undefined

		try {
			mcpConfig = await generateIssueManagementMcpConfig('issue', repo)
			logger.debug('Generated MCP configuration for issue management')

			// Configure tool filtering for issue workflows
			allowedTools = [
				'mcp__issue_management__get_issue',
				'mcp__issue_management__get_comment',
				'mcp__issue_management__create_comment',
				'mcp__issue_management__update_comment',
			]
			disallowedTools = ['Bash(gh api:*)']

			logger.debug('Configured tool filtering for issue workflow', { allowedTools, disallowedTools })
		} catch (error) {
			// Log warning but continue without MCP
			logger.warn(`Failed to generate MCP config: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Step 4: Invoke Claude CLI with enhancer agent
		logger.info('Invoking enhancer agent. This may take a moment...')
		const prompt = this.constructPrompt(issueNumber, author)
		const response = await launchClaude(prompt, {
			headless: true,
			model: 'sonnet',
			agents,
			...(mcpConfig && { mcpConfig }),
			...(allowedTools && { allowedTools }),
			...(disallowedTools && { disallowedTools }),
		})

		// Step 5: Parse response to determine outcome
		const result = this.parseEnhancerResponse(response)

		// Step 6: Handle browser interaction based on outcome
		if (!result.enhanced) {
			logger.success('Issue already has thorough description. No enhancement needed.')
			return
		}

		logger.success(`Issue #${issueNumber} enhanced successfully!`)
		logger.info(`Enhanced specification available at: ${result.url}`)

		// Prompt to open browser (unless --no-browser flag is set)
		if (!options.noBrowser && result.url) {
			await this.promptAndOpenBrowser(result.url)
		}
	}

	/**
	 * Validate that issue number is a valid positive integer
	 */
	private validateIssueNumber(issueNumber: string | number): void {
		if (issueNumber === undefined || issueNumber === null) {
			throw new Error('Issue number is required')
		}

		// For numeric types, validate as before
		if (typeof issueNumber === 'number') {
			if (Number.isNaN(issueNumber) || issueNumber <= 0 || !Number.isInteger(issueNumber)) {
				throw new Error('Issue number must be a valid positive integer')
			}
		}
		// For string types, validate non-empty
		if (typeof issueNumber === 'string' && issueNumber.trim().length === 0) {
			throw new Error('Issue identifier cannot be empty')
		}
	}

	/**
	 * Construct the prompt for the orchestrating Claude instance.
	 * This prompt is very clear about expected output format to ensure reliable parsing.
	 */
	private constructPrompt(issueNumber: string | number, author?: string): string {
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
	private parseEnhancerResponse(response: string | void): { enhanced: boolean; url?: string } {
		// Handle empty or void response
		if (!response || typeof response !== 'string') {
			throw new Error('No response from enhancer agent')
		}

		const trimmed = response.trim()
	
		logger.debug(`RESPONSE FROM ENHANCER AGENT: '${trimmed}'`)

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

	/**
	 * Prompt user and open browser to view enhanced issue.
	 * Matches the pattern from the issue specification.
	 */
	private async promptAndOpenBrowser(commentUrl: string): Promise<void> {
		try {
			// Prompt user with custom message
			const key = await waitForKeypress(
				'Press q to quit or any other key to view the enhanced issue in a web browser...'
			)

			// Check if user pressed 'q' to quit
			if (key.toLowerCase() === 'q') {
				logger.info('Skipping browser opening')
				return
			}

			// Open browser with comment URL
			await openBrowser(commentUrl)
		} catch (error) {
			// Browser opening failures should not be fatal
			logger.warn(`Failed to open browser: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

}
