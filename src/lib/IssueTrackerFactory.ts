// IssueTrackerFactory - creates appropriate IssueTracker based on settings
// Follows pattern from database provider instantiation

import type { IssueTracker } from './IssueTracker.js'
import { GitHubService } from './GitHubService.js'
import { LinearService, type LinearServiceConfig } from './LinearService.js'
import { JiraIssueTracker, type JiraTrackerConfig } from './providers/jira/index.js'
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
			case 'jira': {
				const jiraSettings = settings.issueManagement?.jira
				
				if (!jiraSettings?.host) {
					throw new Error('Jira host is required. Configure issueManagement.jira.host in .iloom/settings.json')
				}
				if (!jiraSettings?.username) {
					throw new Error('Jira username is required. Configure issueManagement.jira.username in .iloom/settings.json')
				}
				if (!jiraSettings?.apiToken) {
					throw new Error('Jira API token is required. Configure issueManagement.jira.apiToken in .iloom/settings.local.json')
				}
				if (!jiraSettings?.projectKey) {
					throw new Error('Jira project key is required. Configure issueManagement.jira.projectKey in .iloom/settings.json')
				}

				const jiraConfig: JiraTrackerConfig = {
					host: jiraSettings.host,
					username: jiraSettings.username,
					apiToken: jiraSettings.apiToken,
					projectKey: jiraSettings.projectKey,
				}

				if (jiraSettings.transitionMappings) {
					jiraConfig.transitionMappings = jiraSettings.transitionMappings
				}

				getLogger().debug(`IssueTrackerFactory: Creating JiraIssueTracker for host: ${jiraSettings.host}`)
				return new JiraIssueTracker(jiraConfig)
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
