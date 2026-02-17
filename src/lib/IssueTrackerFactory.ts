// IssueTrackerFactory - creates appropriate IssueTracker based on settings
// Follows pattern from database provider instantiation

import type { IssueTracker } from './IssueTracker.js'
import { GitHubService } from './GitHubService.js'
import { LinearService, type LinearServiceConfig } from './LinearService.js'
import { JiraIssueTracker } from './providers/jira/index.js'
import { type IloomSettings, redactSensitiveFields } from './SettingsManager.js'
import { getLogger } from '../utils/logger-context.js'

export type IssueTrackerProviderType = 'github' | 'linear' | 'jira'

/**
 * Factory for creating IssueTracker instances based on settings
 * Provides a single point of provider instantiation
 *
 * Usage:
 *   const tracker = IssueTrackerFactory.create(settings, { useClaude: true })
 *   const issue = await tracker.fetchIssue(123)
 */
export class IssueTrackerFactory {
	/**
	 * Create an IssueTracker instance based on settings configuration
	 * Defaults to GitHub if no provider specified
	 *
	 * @param settings - iloom settings containing issueManagement.provider
	 * @returns IssueTracker instance configured for the specified provider
	 * @throws Error if provider type is not supported
	 */
	static create(settings: IloomSettings): IssueTracker {
		const provider = settings.issueManagement?.provider ?? 'github'

		getLogger().debug(`IssueTrackerFactory: Creating tracker for provider "${provider}"`)
		getLogger().debug(`IssueTrackerFactory: issueManagement settings:`, JSON.stringify(redactSensitiveFields(settings.issueManagement), null, 2))

		switch (provider) {
			case 'github':
				getLogger().debug('IssueTrackerFactory: Creating GitHubService')
				return new GitHubService()
			case 'linear': {
				const linearSettings = settings.issueManagement?.linear
				const linearConfig: LinearServiceConfig = {}

				if (linearSettings?.teamId) {
					linearConfig.teamId = linearSettings.teamId
				}
				if (linearSettings?.branchFormat) {
					linearConfig.branchFormat = linearSettings.branchFormat
				}
				if (linearSettings?.apiToken) {
					linearConfig.apiToken = linearSettings.apiToken
				}

				getLogger().debug(`IssueTrackerFactory: Creating LinearService with config:`, JSON.stringify(redactSensitiveFields(linearConfig), null, 2))
				return new LinearService(linearConfig)
			}
			case 'jira': {
				getLogger().debug(`IssueTrackerFactory: Creating JiraIssueTracker from settings`)
				return JiraIssueTracker.fromSettings(settings)
			}
			default:
				throw new Error(`Unsupported issue tracker provider: ${provider}`)
		}
	}

	/**
	 * Get the configured provider name from settings
	 * Defaults to 'github' if not configured
	 *
	 * @param settings - iloom settings
	 * @returns Provider type string
	 */
	static getProviderName(settings: IloomSettings): IssueTrackerProviderType {
		return (settings.issueManagement?.provider ?? 'github') as IssueTrackerProviderType
	}
}
