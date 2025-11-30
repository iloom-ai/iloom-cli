// IssueTrackerFactory - creates appropriate IssueTracker based on settings
// Follows pattern from database provider instantiation

import type { IssueTracker } from './IssueTracker.js'
import { GitHubService } from './GitHubService.js'
import type { IloomSettings } from './SettingsManager.js'

export type IssueTrackerProviderType = 'github' // Extensible: | 'linear' | 'jira'

export interface IssueTrackerFactoryOptions {
	useClaude?: boolean
	claudeModel?: string
}

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
	 * @param options - optional configuration for provider initialization
	 * @returns IssueTracker instance configured for the specified provider
	 * @throws Error if provider type is not supported
	 */
	static create(settings: IloomSettings, options?: IssueTrackerFactoryOptions): IssueTracker {
		const provider = settings.issueManagement?.provider ?? 'github'

		switch (provider) {
			case 'github': {
				// Only pass defined options to avoid TypeScript strict optional property errors
				const githubOptions: {
					useClaude?: boolean
					claudeModel?: string
				} = {}

				if (options?.useClaude !== undefined) {
					githubOptions.useClaude = options.useClaude
				}
				if (options?.claudeModel !== undefined) {
					githubOptions.claudeModel = options.claudeModel
				}

				return new GitHubService(githubOptions)
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
