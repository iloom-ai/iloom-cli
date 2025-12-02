import type { FeedbackOptions } from '../types/index.js'
import { IssueEnhancementService } from '../lib/IssueEnhancementService.js'
import { GitHubService } from '../lib/GitHubService.js'
import { AgentManager } from '../lib/AgentManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { gatherDiagnosticInfo, formatDiagnosticsAsMarkdown } from '../utils/diagnostics.js'

// Hardcoded target repository for feedback
const FEEDBACK_REPOSITORY = 'iloom-ai/iloom-cli'

/**
 * Input structure for FeedbackCommand
 */
export interface FeedbackCommandInput {
	description: string
	options: FeedbackOptions
}

/**
 * Command to submit feedback/bug reports to the iloom-cli repository.
 * Mirrors add-issue command but targets iloom-ai/iloom-cli repo.
 */
export class FeedbackCommand {
	private enhancementService: IssueEnhancementService

	constructor(enhancementService?: IssueEnhancementService) {
		// Use provided service or create default
		this.enhancementService = enhancementService ?? new IssueEnhancementService(
			new GitHubService(),
			new AgentManager(),
			new SettingsManager()
		)
	}

	/**
	 * Execute the feedback command workflow:
	 * 1. Validate description format
	 * 2. Gather diagnostic information
	 * 3. Create GitHub issue in iloom-ai/iloom-cli with CLI marker and diagnostics
	 * 4. Wait for keypress and open browser for review
	 * 5. Return issue number
	 */
	public async execute(input: FeedbackCommandInput): Promise<string | number> {
		const { description } = input

		// Step 1: Validate description format
		if (!description || !this.enhancementService.validateDescription(description)) {
			throw new Error('Description is required and must be more than 30 characters with at least 3 words')
		}

		// Step 2: Gather diagnostic information
		const diagnostics = await gatherDiagnosticInfo()
		const diagnosticsMarkdown = formatDiagnosticsAsMarkdown(diagnostics)

		// Step 3: Create enhanced issue body with marker and diagnostics
		const userBody = input.options.body ?? description
		const enhancedBody = `${diagnosticsMarkdown}

${userBody}`

		// Step 4: Create GitHub issue in iloom-cli repo (no label needed)
		// The GitHub Action workflow will detect the CLI marker and enhance the issue
		const result = await this.enhancementService.createEnhancedIssue(
			description,
			enhancedBody,
			FEEDBACK_REPOSITORY,
			undefined // No labels needed
		)

		// Step 5: Wait for keypress and open issue in browser for review
		await this.enhancementService.waitForReviewAndOpen(result.number, false, FEEDBACK_REPOSITORY)

		// Step 6: Return issue number for reference
		return result.number
	}
}
