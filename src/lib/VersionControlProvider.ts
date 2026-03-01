/**
 * VersionControlProvider interface
 *
 * Abstraction for VCS providers that handle PR creation outside of GitHub's
 * legacy PRManager path. Providers implementing this interface are returned
 * by VCSProviderFactory.create() for non-GitHub integrations (e.g., BitBucket).
 *
 * GitHub uses the legacy PRManager path (VCSProviderFactory.create() returns null).
 */
export interface VersionControlProvider {
	/** Human-readable provider name (e.g., 'BitBucket') */
	readonly providerName: string

	/** Whether the provider supports draft/work-in-progress PRs */
	readonly supportsDraftPRs: boolean

	/**
	 * Create or open an existing pull request.
	 * @returns The PR URL, number, and whether it was pre-existing.
	 */
	createPR(params: {
		branch: string
		title: string
		baseBranch: string
		issueNumber?: string | number
		worktreePath: string
		openInBrowser: boolean
	}): Promise<{ url: string; number: number; wasExisting: boolean }>
}
