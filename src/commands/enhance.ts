import type { IssueTracker } from '../lib/IssueTracker.js'
import type { SettingsManager } from '../lib/SettingsManager.js'
import type { EnhanceResult } from '../types/index.js'
import type { IssueEnhancementService } from '../lib/IssueEnhancementService.js'
import type { IssueProvider } from '../mcp/types.js'
import { openBrowser } from '../utils/browser.js'
import { waitForKeypress } from '../utils/prompt.js'
import { getLogger } from '../utils/logger-context.js'
import { SettingsManager as DefaultSettingsManager } from '../lib/SettingsManager.js'
import { getConfiguredRepoFromSettings, hasMultipleRemotes } from '../utils/remote.js'
import { launchFirstRunSetup, needsFirstRunSetup } from '../utils/first-run-setup.js'
import { processMarkdownImages } from '../utils/image-processor.js'

export interface EnhanceCommandInput {
	issueNumber: string | number
	options: EnhanceOptions
}

export interface EnhanceOptions {
	noBrowser?: boolean // Skip browser opening prompt
	author?: string // GitHub username of issue author for tagging
	json?: boolean // Output result as JSON
}

/**
 * Command to enhance existing GitHub issues with AI assistance.
 * Applies the issue enhancer agent to an existing issue, respecting idempotency checks.
 */
export class EnhanceCommand {
	private issueTracker: IssueTracker
	private enhancementService: IssueEnhancementService
	private settingsManager: SettingsManager

	constructor(
		issueTracker: IssueTracker,
		enhancementService: IssueEnhancementService,
		settingsManager?: SettingsManager
	) {
		this.issueTracker = issueTracker
		this.enhancementService = enhancementService
		this.settingsManager = settingsManager ?? new DefaultSettingsManager()
	}

	/**
	 * Execute the enhance command workflow:
	 * 1. Validate issue number
	 * 2. Fetch issue to verify it exists
	 * 3. Invoke enhancement service
	 * 4. Handle browser interaction based on outcome (unless --json mode)
	 * 5. Return result object when --json mode
	 */
	public async execute(input: EnhanceCommandInput): Promise<EnhanceResult | void> {
		const { issueNumber, options } = input
		const { author } = options
		const isJsonMode = options.json === true

		// Step 0: Check for first-run setup (skip in JSON mode - non-interactive)
		if (!isJsonMode && (process.env.FORCE_FIRST_TIME_SETUP === "true" || await needsFirstRunSetup())) {
			await launchFirstRunSetup()
		}

		// Step 0.5: Load settings and get configured repo for GitHub operations
		const settings = await this.settingsManager.loadSettings()

		let repo: string | undefined

		if (this.issueTracker.providerName === 'github' && (await hasMultipleRemotes())) {
			// Only relevant for GitHub - Linear doesn't use repo info
			repo = await getConfiguredRepoFromSettings(settings)
			if (!isJsonMode) {
				getLogger().info(`Using GitHub repository: ${repo}`)
			}
		}

		// Step 1: Validate issue number
		this.validateIssueNumber(issueNumber)

		// Step 2: Fetch issue to verify it exists
		if (!isJsonMode) {
			getLogger().info(`Fetching issue #${issueNumber}...`)
		}
		const issue = await this.issueTracker.fetchIssue(issueNumber, repo)
		getLogger().debug('Issue fetched successfully', { number: issue.number, title: issue.title })

		// Process authenticated image URLs in issue body to local cached file paths
		// before the body is consumed downstream (e.g. by the enhancer Claude prompt).
		// Only Linear/GitHub providers are supported by processMarkdownImages.
		const providerName = this.issueTracker.providerName
		if (issue.body && (providerName === 'linear' || providerName === 'github')) {
			try {
				issue.body = await processMarkdownImages(issue.body, providerName as IssueProvider)
			} catch (error) {
				if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
					throw error
				}
				getLogger().debug(
					`Failed to process markdown images, falling back to original body: ${error instanceof Error ? error.message : String(error)}`
				)
			}
		}

		// Step 3: Invoke enhancement service
		if (!isJsonMode) {
			getLogger().info('Invoking enhancer agent. This may take a moment...')
		}
		// Build options object conditionally to satisfy exactOptionalPropertyTypes
		const enhanceOptions: { author?: string; repo?: string } = {}
		if (author !== undefined) enhanceOptions.author = author
		if (repo !== undefined) enhanceOptions.repo = repo
		const result = await this.enhancementService.enhanceExistingIssue(issueNumber, enhanceOptions)

		// Step 4: Handle JSON mode - return structured result
		if (isJsonMode) {
			const commentId = result.url ? this.extractCommentId(result.url) : 0
			const resultData: EnhanceResult = {
				url: result.url ?? issue.url,
				id: commentId,
				title: issue.title,
				created_at: new Date().toISOString(),
				enhanced: result.enhanced
			}
			return resultData
		}

		// Step 5: Handle non-JSON mode - browser interaction based on outcome
		if (!result.enhanced) {
			getLogger().success('Issue already has thorough description. No enhancement needed.')
			return
		}

		getLogger().success(`Issue #${issueNumber} enhanced successfully!`)
		getLogger().info(`Enhanced specification available at: ${result.url}`)

		// Prompt to open browser (unless --no-browser flag is set)
		if (!options.noBrowser && result.url) {
			await this.promptAndOpenBrowser(result.url)
		}
	}

	/**
	 * Extract comment ID from GitHub comment URL
	 * @param url - GitHub comment URL (e.g., https://github.com/owner/repo/issues/123#issuecomment-456789)
	 * @returns Comment ID as number, or 0 if not found
	 */
	private extractCommentId(url: string): number {
		const match = url.match(/issuecomment-(\d+)/)
		return match?.[1] ? parseInt(match[1], 10) : 0
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
				getLogger().info('Skipping browser opening')
				return
			}

			// Open browser with comment URL
			await openBrowser(commentUrl)
		} catch (error) {
			// Browser opening failures should not be fatal
			getLogger().warn(`Failed to open browser: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

}
