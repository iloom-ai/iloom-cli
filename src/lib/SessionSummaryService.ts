/**
 * SessionSummaryService: Generates and posts Claude session summaries
 *
 * This service orchestrates:
 * 1. Reading session metadata to get session ID
 * 2. Loading and processing the session-summary prompt template
 * 3. Invoking Claude headless to generate the summary
 * 4. Posting the summary as a comment to the issue/PR
 */

import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { logger } from '../utils/logger.js'
import { launchClaude, generateDeterministicSessionId } from '../utils/claude.js'
import { readSessionContext } from '../utils/claude-transcript.js'
import { PromptTemplateManager } from './PromptTemplateManager.js'
import { MetadataManager } from './MetadataManager.js'
import { SettingsManager, type IloomSettings } from './SettingsManager.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import type { IssueProvider } from '../mcp/types.js'
import { hasMultipleRemotes } from '../utils/remote.js'
import type { RecapFile, RecapOutput } from '../mcp/recap-types.js'
import { formatRecapMarkdown } from '../utils/recap-formatter.js'

const RECAPS_DIR = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')

/**
 * Slugify path to recap filename (matches MetadataManager/RecapCommand algorithm)
 *
 * Algorithm:
 * 1. Trim trailing slashes
 * 2. Replace all path separators (/ or \) with ___ (triple underscore)
 * 3. Replace any other non-alphanumeric characters (except _ and -) with -
 * 4. Append .json
 */
function slugifyPath(loomPath: string): string {
	let slug = loomPath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

/**
 * Read recap file for a worktree path with graceful degradation
 * Returns formatted recap string or null if not found/error
 */
async function readRecapFile(worktreePath: string): Promise<string | null> {
	try {
		const filePath = path.join(RECAPS_DIR, slugifyPath(worktreePath))
		if (await fs.pathExists(filePath)) {
			const content = await fs.readFile(filePath, 'utf8')
			const recap = JSON.parse(content) as RecapFile

			// Check if recap has any meaningful content
			const hasGoal = recap.goal !== null && recap.goal !== undefined
			const hasComplexity = recap.complexity !== null && recap.complexity !== undefined
			const hasEntries = Array.isArray(recap.entries) && recap.entries.length > 0
			const hasArtifacts = Array.isArray(recap.artifacts) && recap.artifacts.length > 0
			const hasContent = hasGoal || hasComplexity || hasEntries || hasArtifacts

			if (hasContent) {
				// Convert RecapFile (optional fields) to RecapOutput (required fields)
				// Same pattern as RecapCommand.ts:61-66
				const recapOutput: RecapOutput = {
					filePath,
					goal: recap.goal ?? null,
					complexity: recap.complexity ?? null,
					entries: recap.entries ?? [],
					artifacts: recap.artifacts ?? [],
				}
				return formatRecapMarkdown(recapOutput)
			}
		}
		return null
	} catch {
		// Graceful degradation - return null on any error
		return null
	}
}

/**
 * Input for generating and posting a session summary
 */
export interface SessionSummaryInput {
	worktreePath: string
	issueNumber: string | number
	branchName: string
	loomType: 'issue' | 'pr' | 'branch' | 'epic'
	/** Optional PR number - when provided, summary is posted to the PR instead of the issue */
	prNumber?: number
}

/**
 * Result from generating a session summary
 */
export interface SessionSummaryResult {
	summary: string
	sessionId: string
}

/**
 * Service that generates and posts Claude session summaries to issues
 */
export class SessionSummaryService {
	private templateManager: PromptTemplateManager
	private metadataManager: MetadataManager
	private settingsManager: SettingsManager

	constructor(
		templateManager?: PromptTemplateManager,
		metadataManager?: MetadataManager,
		settingsManager?: SettingsManager
	) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
		this.metadataManager = metadataManager ?? new MetadataManager()
		this.settingsManager = settingsManager ?? new SettingsManager()
	}

	/**
	 * Generate and post a session summary to the issue
	 *
	 * Non-blocking: Catches all errors and logs warnings instead of throwing
	 * This ensures the finish workflow continues even if summary generation fails
	 */
	async generateAndPostSummary(input: SessionSummaryInput): Promise<void> {
		try {
			// 1. Skip for branch type (no issue to comment on)
			if (input.loomType === 'branch') {
				logger.debug('Skipping session summary: branch type has no associated issue')
				return
			}

			// 2. Read metadata to get sessionId, or generate deterministically
			const metadata = await this.metadataManager.readMetadata(input.worktreePath)
			const sessionId = metadata?.sessionId ?? generateDeterministicSessionId(input.worktreePath)

			// 3. Load settings to check generateSummary config
			const settings = await this.settingsManager.loadSettings(input.worktreePath)
			if (!this.shouldGenerateSummary(input.loomType, settings)) {
				logger.debug(`Skipping session summary: generateSummary is disabled for ${input.loomType} workflow`)
				return
			}

			logger.info('Generating session summary...')

			// 4. Try to read compact summaries from session transcript for additional context
			logger.debug(`Looking for session transcript with sessionId: ${sessionId}`)
			const compactSummaries = await readSessionContext(input.worktreePath, sessionId)
			if (compactSummaries) {
				logger.debug(`Found compact summaries (${compactSummaries.length} chars)`)
			} else {
				logger.debug('No compact summaries found in session transcript')
			}

			// 5. Try to read recap data for high-signal context
			const recapData = await readRecapFile(input.worktreePath)
			if (recapData) {
				logger.debug(`Found recap data (${recapData.length} chars)`)
			} else {
				logger.debug('No recap data found')
			}

			// 6. Load and process the session-summary template
			const prompt = await this.templateManager.getPrompt('session-summary', {
				ISSUE_NUMBER: String(input.issueNumber),
				BRANCH_NAME: input.branchName,
				LOOM_TYPE: input.loomType,
				COMPACT_SUMMARIES: compactSummaries ?? '',
				RECAP_DATA: recapData ?? '',
			})

			logger.debug('Session summary prompt:\n' + prompt)

			// 7. Invoke Claude headless to generate summary
			// Use --resume with session ID so Claude knows which conversation to summarize
			const summaryModel = this.settingsManager.getSummaryModel(settings)
			const summaryResult = await launchClaude(prompt, {
				headless: true,
				model: summaryModel,
				sessionId: sessionId, // Resume this session so Claude has conversation context
				noSessionPersistence: true, // Don't persist new data after generating summary
			})

			if (!summaryResult || typeof summaryResult !== 'string' || summaryResult.trim() === '') {
				logger.warn('Session summary generation returned empty result')
				return
			}

			const summary = summaryResult.trim()

			// 8. Skip posting if summary is too short (likely failed generation)
			if (summary.length < 100) {
				logger.warn('Session summary too short, skipping post')
				return
			}

			// 9. Post summary to issue or PR (PR takes priority when prNumber is provided)
			await this.postSummaryToIssue(input.issueNumber, summary, settings, input.worktreePath, input.prNumber)

			const targetDescription = input.prNumber ? `PR #${input.prNumber}` : 'issue'
			logger.success(`Session summary posted to ${targetDescription}`)
		} catch (error) {
			// Non-blocking: Log warning but don't throw
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.warn(`Failed to generate session summary: ${errorMessage}`)
			logger.debug('Session summary generation error details:', { error })
		}
	}

	/**
	 * Generate a session summary without posting it
	 *
	 * This method is useful for previewing the summary or for use by CLI commands
	 * that want to display the summary before optionally posting it.
	 *
	 * @param worktreePath - Path to the worktree
	 * @param branchName - Name of the branch
	 * @param loomType - Type of loom ('issue' | 'pr' | 'branch')
	 * @param issueNumber - Issue or PR number (optional, for template variables)
	 * @returns The generated summary and session ID
	 * @throws Error if Claude invocation fails
	 */
	async generateSummary(
		worktreePath: string,
		branchName: string,
		loomType: 'issue' | 'pr' | 'branch' | 'epic',
		issueNumber?: string | number
	): Promise<SessionSummaryResult> {
		// 1. Read metadata or generate deterministic session ID
		const metadata = await this.metadataManager.readMetadata(worktreePath)
		const sessionId = metadata?.sessionId ?? generateDeterministicSessionId(worktreePath)

		// 2. Load settings for model configuration
		const settings = await this.settingsManager.loadSettings(worktreePath)

		logger.info('Generating session summary...')

		// 3. Try to read compact summaries from session transcript for additional context
		logger.debug(`Looking for session transcript with sessionId: ${sessionId}`)
		const compactSummaries = await readSessionContext(worktreePath, sessionId)
		if (compactSummaries) {
			logger.debug(`Found compact summaries (${compactSummaries.length} chars)`)
		} else {
			logger.debug('No compact summaries found in session transcript')
		}

		// 4. Try to read recap data for high-signal context
		const recapData = await readRecapFile(worktreePath)
		if (recapData) {
			logger.debug(`Found recap data (${recapData.length} chars)`)
		} else {
			logger.debug('No recap data found')
		}

		// 5. Load and process the session-summary template
		const prompt = await this.templateManager.getPrompt('session-summary', {
			ISSUE_NUMBER: issueNumber !== undefined ? String(issueNumber) : '',
			BRANCH_NAME: branchName,
			LOOM_TYPE: loomType,
			COMPACT_SUMMARIES: compactSummaries ?? '',
			RECAP_DATA: recapData ?? '',
		})

		logger.debug('Session summary prompt:\n' + prompt)

		// 6. Invoke Claude headless to generate summary
		const summaryModel = this.settingsManager.getSummaryModel(settings)
		const summaryResult = await launchClaude(prompt, {
			headless: true,
			model: summaryModel,
			sessionId: sessionId,
			noSessionPersistence: true, // Don't persist new data after generating summary
		})

		if (!summaryResult || typeof summaryResult !== 'string' || summaryResult.trim() === '') {
			throw new Error('Session summary generation returned empty result')
		}

		const summary = summaryResult.trim()

		// 7. Check if summary is too short (likely failed generation)
		if (summary.length < 100) {
			throw new Error('Session summary too short - generation may have failed')
		}

		return {
			summary,
			sessionId: sessionId,
		}
	}

	/**
	 * Post a summary to an issue (used by both generateAndPostSummary and CLI commands)
	 *
	 * @param issueNumber - Issue or PR number to post to
	 * @param summary - The summary text to post
	 * @param worktreePath - Path to worktree for loading settings (optional)
	 */
	async postSummary(
		issueNumber: string | number,
		summary: string,
		worktreePath?: string,
		prNumber?: number
	): Promise<void> {
		const settings = await this.settingsManager.loadSettings(worktreePath)
		await this.postSummaryToIssue(issueNumber, summary, settings, worktreePath ?? process.cwd(), prNumber)
		const target = prNumber ? `PR #${prNumber}` : 'issue'
		logger.success(`Session summary posted to ${target}`)
	}

	/**
	 * Determine if summary should be generated based on loom type and settings
	 *
	 * @param loomType - The type of loom being finished
	 * @param settings - The loaded iloom settings
	 * @returns true if summary should be generated
	 */
	shouldGenerateSummary(
		loomType: 'issue' | 'pr' | 'branch' | 'epic',
		settings: IloomSettings
	): boolean {
		// Branch type never generates summaries (no issue to comment on)
		if (loomType === 'branch') {
			return false
		}

		// Get workflow-specific config
		const workflowConfig =
			loomType === 'issue'
				? settings.workflows?.issue
				: settings.workflows?.pr

		// Default to true if not explicitly set (for issue and pr types)
		return workflowConfig?.generateSummary ?? true
	}

	/**
	 * Apply attribution footer to summary based on settings
	 *
	 * @param summary - The summary text
	 * @param worktreePath - Path to worktree for loading settings and detecting remotes
	 * @returns Summary with attribution footer if applicable
	 */
	async applyAttribution(summary: string, worktreePath: string): Promise<string> {
		const settings = await this.settingsManager.loadSettings(worktreePath)
		return this.applyAttributionWithSettings(summary, settings, worktreePath)
	}

	/**
	 * Apply attribution footer to summary based on provided settings
	 *
	 * @param summary - The summary text
	 * @param settings - The loaded iloom settings
	 * @param worktreePath - Path to worktree for detecting remotes
	 * @returns Summary with attribution footer if applicable
	 */
	async applyAttributionWithSettings(
		summary: string,
		settings: IloomSettings,
		worktreePath: string
	): Promise<string> {
		const attributionSetting = settings.attribution ?? 'upstreamOnly'
		logger.debug(`Attribution setting from config: ${settings.attribution}`)
		logger.debug(`Attribution setting (with default): ${attributionSetting}`)

		let shouldShowAttribution = false
		if (attributionSetting === 'on') {
			shouldShowAttribution = true
			logger.debug('Attribution: always on')
		} else if (attributionSetting === 'upstreamOnly') {
			// Only show attribution when contributing to external repos (multiple remotes)
			shouldShowAttribution = await hasMultipleRemotes(worktreePath)
			logger.debug(`Attribution: upstreamOnly, hasMultipleRemotes=${shouldShowAttribution}`)
		} else {
			logger.debug('Attribution: off')
		}
		// 'off' keeps shouldShowAttribution = false

		logger.debug(`Should show attribution: ${shouldShowAttribution}`)
		if (shouldShowAttribution) {
			logger.debug('Attribution footer appended to summary')
			return `${summary}\n\n---\n*Generated with 🤖❤️ by [iloom.ai](https://iloom.ai)*`
		}

		return summary
	}

	/**
	 * Post the summary as a comment to the issue or PR
	 *
	 * @param issueNumber - The issue number (used when prNumber is not provided)
	 * @param summary - The summary text to post
	 * @param settings - The loaded iloom settings
	 * @param worktreePath - Path to worktree for attribution detection
	 * @param prNumber - Optional PR number - when provided, posts to the PR instead
	 */
	private async postSummaryToIssue(
		issueNumber: string | number,
		summary: string,
		settings: IloomSettings,
		worktreePath: string,
		prNumber?: number
	): Promise<void> {
		// Get the issue management provider from settings
		// PRs only exist on GitHub, so always use 'github' provider when prNumber is provided
		// (see types.ts:32-33 and LinearIssueManagementProvider.getPR())
		const providerType = prNumber !== undefined
			? 'github'
			: (settings.issueManagement?.provider ?? 'github') as IssueProvider
		const provider = IssueManagementProviderFactory.create(providerType, settings)

		// Apply attribution if configured
		const finalSummary = await this.applyAttributionWithSettings(summary, settings, worktreePath)

		// When prNumber is provided, post to the PR instead of the issue
		const targetNumber = prNumber ?? issueNumber
		const targetType = prNumber !== undefined ? 'pr' : 'issue'

		// Create the comment
		await provider.createComment({
			number: String(targetNumber),
			body: finalSummary,
			type: targetType,
		})
	}
}
