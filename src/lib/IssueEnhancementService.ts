import type { IssueTracker } from './IssueTracker.js'
import type { AgentManager } from './AgentManager.js'
import type { SettingsManager } from './SettingsManager.js'
import { launchClaude } from '../utils/claude.js'
import { openBrowser } from '../utils/browser.js'
import { waitForKeypress } from '../utils/prompt.js'
import { logger } from '../utils/logger.js'

/**
 * Service for enhancing and creating GitHub issues with AI assistance.
 * Extracts reusable issue enhancement logic from StartCommand.
 */
export class IssueEnhancementService {
	constructor(
		private gitHubService: IssueTracker,
		private agentManager: AgentManager,
		private settingsManager: SettingsManager
	) {}

	/**
	 * Validates that a description meets minimum requirements.
	 * Requirements: >30 characters AND >2 spaces
	 */
	public validateDescription(description: string): boolean {
		const trimmedDescription = description.trim()
		const spaceCount = (trimmedDescription.match(/ /g) ?? []).length

		return trimmedDescription.length > 30 && spaceCount > 2
	}

	/**
	 * Enhances a description using Claude AI in headless mode.
	 * Falls back to original description if enhancement fails.
	 */
	public async enhanceDescription(description: string): Promise<string> {
		try {
			logger.info('Enhancing description with Claude AI. This may take a moment...')

			// Load agent configurations
			const settings = await this.settingsManager.loadSettings()
			const loadedAgents = await this.agentManager.loadAgents(settings)
			const agents = this.agentManager.formatForCli(loadedAgents)

			// Call Claude in headless mode with issue enhancer agent
			const prompt = `@agent-iloom-issue-enhancer

TASK: Enhance the following issue description for GitHub.

INPUT:
${description}

OUTPUT REQUIREMENTS:
- Return ONLY the enhanced description markdown text
- NO meta-commentary (no "Here is...", "The enhanced...", "I have...", etc)
- NO code block markers (\`\`\`)
- NO conversational framing or acknowledgments
- NO explanations of your work
- Start your response immediately with the enhanced content

Your response should be the raw markdown that will become the GitHub issue body.`

			const enhanced = await launchClaude(prompt, {
				headless: true,
				model: 'sonnet',
				agents,
			})

			if (enhanced && typeof enhanced === 'string') {
				logger.success('Description enhanced successfully')
				return enhanced
			}

			// Fallback to original description
			logger.warn('Claude enhancement returned empty result, using original description')
			return description
		} catch (error) {
			logger.warn(`Failed to enhance description: ${error instanceof Error ? error.message : 'Unknown error'}`)
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
		logger.info('Creating GitHub issue from description...')

		const result = await this.gitHubService.createIssue(
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
		// Check if running in CI environment
		const isCI = process.env.CI === 'true'

		if (isCI) {
			// In CI: Skip all interactive operations
			logger.info(`Running in CI environment - skipping interactive prompts for issue #${issueNumber}`)
			return
		}

		// Get issue URL
		const issueUrl = await this.gitHubService.getIssueUrl(issueNumber, repository)

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
}
