// IssueTrackerFactory - creates appropriate IssueTracker based on settings
// Follows pattern from database provider instantiation

import type { IssueTracker } from './IssueTracker.js'
import { GitHubService } from './GitHubService.js'
import { LinearService, type LinearServiceConfig } from './LinearService.js'
import type { IloomSettings } from './SettingsManager.js'
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
		getLogger().debug(`IssueTrackerFactory: issueManagement settings:`, JSON.stringify(settings.issueManagement, null, 2))

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

				getLogger().debug(`IssueTrackerFactory: Creating LinearService with config:`, JSON.stringify(linearConfig, null, 2))
				return new LinearService(linearConfig)
			}
			default:
				throw new Error(`Unsupported issue tracker provider: ${provider}`)
		}
	}

	/**
	 * Format an issue identifier for display without needing a provider instance.
	 * GitHub issues get a "#" prefix, Linear/Jira identifiers are uppercased.
	 *
	 * @param providerType - The issue tracker provider type
	 * @param identifier - The issue identifier (number or string)
	 * @returns Formatted issue ID string
	 */
	static formatIssueId(providerType: IssueTrackerProviderType, identifier: string | number): string {
		switch (providerType) {
			case 'github':
				return `#${identifier}`
			case 'linear':
			case 'jira':
				return String(identifier).toUpperCase()
			default:
				return `#${identifier}`
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

	/**
	 * Get the issue ID prefix for a given provider type.
	 * GitHub uses '#' (e.g., #123), Linear and Jira use '' (identifiers are self-contained).
	 *
	 * @param providerType - The issue tracker provider type
	 * @returns Prefix string to prepend before issue identifiers in display text
	 */
	static getIssuePrefix(providerType: IssueTrackerProviderType): string {
		switch (providerType) {
			case 'github':
				return '#'
			case 'linear':
			case 'jira':
				return ''
			default:
				return '#'
		}
	}
}
