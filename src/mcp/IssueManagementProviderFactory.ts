/**
 * Factory for creating issue management providers
 */

import type { IssueManagementProvider, IssueProvider } from './types.js'
import { GitHubIssueManagementProvider } from './GitHubIssueManagementProvider.js'
import { LinearIssueManagementProvider } from './LinearIssueManagementProvider.js'

/**
 * Factory class for creating issue management providers
 */
export class IssueManagementProviderFactory {
	/**
	 * Create an issue management provider based on the provider type
	 */
	static create(provider: IssueProvider): IssueManagementProvider {
		switch (provider) {
			case 'github':
				return new GitHubIssueManagementProvider()
			case 'linear':
				return new LinearIssueManagementProvider()
			default:
				throw new Error(`Unsupported issue management provider: ${provider}`)
		}
	}
}
