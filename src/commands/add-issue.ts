import type { AddIssueOptions, AddIssueResult } from '../types/index.js'
import { IssueEnhancementService } from '../lib/IssueEnhancementService.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'
import { launchFirstRunSetup, needsFirstRunSetup } from '../utils/first-run-setup.js'
import { getLogger } from '../utils/logger-context.js'
import { capitalizeFirstLetter } from '../utils/text.js'

/**
 * Input structure for AddIssueCommand
 */
export interface AddIssueCommandInput {
	description: string
	options: AddIssueOptions
}

/**
 * Command to create and enhance GitHub issues without creating workspaces.
 * This separates the "document the work" step from the "start the work" step.
 */
export class AddIssueCommand {
	private enhancementService: IssueEnhancementService
	private settingsManager: SettingsManager

	constructor(enhancementService: IssueEnhancementService, settingsManager?: SettingsManager) {
		this.enhancementService = enhancementService
		this.settingsManager = settingsManager ?? new SettingsManager()
	}

	/**
	 * Execute the add-issue command workflow:
	 * 1. Validate description format
	 * 2. Skip enhancement if body provided, otherwise enhance description with Claude Code
	 * 3. Create GitHub issue
	 * 4. Wait for keypress and open browser for review (unless --json mode)
	 * 5. Return issue number or full result object (when --json)
	 */
	public async execute(input: AddIssueCommandInput): Promise<AddIssueResult | string | number> {
		// Apply first-letter capitalization to title (description) and body
		const description = capitalizeFirstLetter(input.description)
		const body = input.options.body ? capitalizeFirstLetter(input.options.body) : undefined
		const isJsonMode = input.options.json === true

		// Step 0: Check for first-run setup (skip in JSON mode - non-interactive)
		if (!isJsonMode && (process.env.FORCE_FIRST_TIME_SETUP === "true" || await needsFirstRunSetup())) {
			await launchFirstRunSetup()
		}

		// Step 0.5: Load settings and get configured repo for GitHub operations
		const settings = await this.settingsManager.loadSettings()

		let repo: string | undefined

		if (this.enhancementService.issueTracker.providerName === 'github' && await hasMultipleRemotes()) {
			// Only relevant for GitHub - Linear doesn't use repo info
			repo = await getConfiguredRepoFromSettings(settings)
			if (!isJsonMode) {
				getLogger().info(`Using GitHub repository: ${repo}`)
			}
		}

		// Step 1: Validate description format
		// When --body is provided, only require non-empty description (skip strict validation)
		const hasBody = !!body
		if (!description || !this.enhancementService.validateDescription(description, hasBody)) {
			if (hasBody) {
				throw new Error('Description is required and cannot be empty')
			}
			throw new Error('Description is required and must be more than 30 characters with at least 3 words')
		}

		// Step 2: Enhance the content - pass title + body together for full context,
		// or just the description if no body provided.
		// The enhancer agent will skip enhancement if the content is already well-structured.
		const enhancementInput = body ? `${description}\n\n${body}` : description
		const issueBody = await this.enhancementService.enhanceDescription(enhancementInput)

		// Step 3: Create GitHub issue with original as title, body as body
		const result = await this.enhancementService.createEnhancedIssue(
			description,
			issueBody,
			repo
		)

		// Step 4: Prepare result data for JSON mode
		if (isJsonMode) {
			const resultData: AddIssueResult = {
				url: result.url,
				id: typeof result.number === 'string' ? parseInt(result.number, 10) : result.number,
				title: description,
				created_at: new Date().toISOString()
			}
			return resultData
		}

		// Step 5: Wait for keypress and open issue in browser for review (non-JSON mode)
		await this.enhancementService.waitForReviewAndOpen(result.number)

		// Step 6: Return issue number for reference
		return result.number
	}
}
