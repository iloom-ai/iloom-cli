/**
 * Factory for creating issue management providers
 */

import type { IssueManagementProvider, IssueProvider } from './types.js'
import { GitHubIssueManagementProvider } from './GitHubIssueManagementProvider.js'
import { LinearIssueManagementProvider } from './LinearIssueManagementProvider.js'
import { JiraIssueManagementProvider } from './JiraIssueManagementProvider.js'
import type { IloomSettings } from '../lib/SettingsManager.js'

/**
 * Factory class for creating issue management providers
 */
export class IssueManagementProviderFactory {
	/**
	 * Create an issue management provider based on the provider type
	 * @param provider - The provider type (github, linear, jira)
	 * @param settings - Required for Jira provider, optional for others
	 */
	static create(provider: IssueProvider, settings?: IloomSettings): IssueManagementProvider {
		switch (provider) {
			case 'github':
				return new GitHubIssueManagementProvider()
			case 'linear':
				return new LinearIssueManagementProvider()
			case 'jira':
				if (!settings) {
					throw new Error('Settings required for Jira provider')
				}
				return new JiraIssueManagementProvider(settings)
			default:
				throw new Error(`Unsupported issue management provider: ${provider}`)
		}
	}
}
