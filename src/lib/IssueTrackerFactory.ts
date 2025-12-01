// IssueTrackerFactory - creates appropriate IssueTracker based on settings
// Follows pattern from database provider instantiation

import type { IssueTracker } from './IssueTracker.js'
import { GitHubService } from './GitHubService.js'
import type { IloomSettings } from './SettingsManager.js'

export type IssueTrackerProviderType = 'github' // Extensible: | 'linear' | 'jira'

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

		switch (provider) {
			case 'github':
				return new GitHubService()
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
