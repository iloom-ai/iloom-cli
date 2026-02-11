// ProviderCoordinator - Orchestrates workflows between IssueTracker and VersionControlProvider
// Manages the interaction between issue tracking and version control systems

import type { IssueTracker } from './IssueTracker.js'
import type { VersionControlProvider } from './VersionControlProvider.js'
import { getLogger } from '../utils/logger-context.js'

/**
 * Options for posting agent output
 */
export interface PostAgentOutputOptions {
	issueNumber?: string | number
	prNumber?: number
	body: string
	cwd?: string
}

/**
 * Options for finish workflow
 */
export interface FinishWorkflowOptions {
	branchName: string
	title: string
	body: string
	baseBranch: string
	issueNumber?: string | number
	transitionState?: string
	cwd?: string
}

/**
 * Result of finish workflow
 */
export interface FinishWorkflowResult {
	prUrl: string
	prNumber: number
	issueTransitioned: boolean
}

/**
 * ProviderCoordinator orchestrates workflows across issue tracking and version control providers.
 * 
 * Key responsibilities:
 * - Route agent output to the correct destination (issue vs PR)
 * - Coordinate PR creation with issue state transitions
 * - Provide a unified interface for start/finish workflows
 * 
 * Design pattern:
 * - Uses composition over inheritance
 * - Delegates provider-specific operations to injected providers
 * - Handles cross-provider coordination logic
 */
export class ProviderCoordinator {
	constructor(
		private issueTracker: IssueTracker,
		private vcsProvider: VersionControlProvider
	) {}

	/**
	 * Post agent output to the appropriate destination
	 * - If PR number provided, post to PR
	 * - Otherwise, post to issue
	 */
	async postAgentOutput(options: PostAgentOutputOptions): Promise<void> {
		const { issueNumber, prNumber, body, cwd } = options

		if (prNumber) {
			// Post to PR via VCS provider
			getLogger().debug('Posting agent output to PR', { prNumber })
			await this.vcsProvider.createPRComment(prNumber, body, cwd)
		} else if (issueNumber) {
			// Post to issue via issue tracker
			getLogger().debug('Posting agent output to issue', { issueNumber })
			// Note: This will need the MCP server-based approach or direct API call
			// For now, we'll throw since this needs to be integrated with the MCP system
			throw new Error('Issue comment posting not yet implemented in coordinator')
		} else {
			throw new Error('Either issueNumber or prNumber must be provided')
		}
	}

	/**
	 * Execute finish workflow:
	 * 1. Create PR via VCS provider
	 * 2. Post session summary to PR
	 * 3. Transition issue to target state (e.g., "In Review")
	 */
	async executeFinishWorkflow(options: FinishWorkflowOptions): Promise<FinishWorkflowResult> {
		const { branchName, title, body, baseBranch, issueNumber, transitionState, cwd } = options

		// Step 1: Create PR
		getLogger().debug('Creating PR via VCS provider', { branchName, title })
		const prUrl = await this.vcsProvider.createPR(branchName, title, body, baseBranch, cwd)
		
		// Extract PR number from URL
		const prNumber = this.extractPRNumberFromUrl(prUrl)
		
		getLogger().info('PR created successfully', { prUrl, prNumber })

		// Step 2: Post session summary to PR (if provided in body)
		// The body already contains the session summary, so this is handled by createPR

		// Step 3: Transition issue if requested
		let issueTransitioned = false
		if (issueNumber && transitionState) {
			try {
				// Check if issue tracker supports state transitions
				if (this.issueTracker.moveIssueToInProgress) {
					getLogger().debug('Transitioning issue state', { issueNumber, transitionState })
					// Note: This is a placeholder - actual transition logic will vary by provider
					// For now, we only support moveIssueToInProgress
					// TODO: Add more flexible transition support
					await this.issueTracker.moveIssueToInProgress(issueNumber)
					issueTransitioned = true
					getLogger().info('Issue transitioned successfully', { issueNumber, transitionState })
				} else {
					getLogger().warn('Issue tracker does not support state transitions', { 
						provider: this.issueTracker.providerName 
					})
				}
			} catch (error) {
				// Don't fail the whole workflow if transition fails
				getLogger().error('Failed to transition issue', { error, issueNumber })
			}
		}

		return {
			prUrl,
			prNumber,
			issueTransitioned,
		}
	}

	/**
	 * Extract PR number from PR URL
	 * Handles various VCS provider URL formats
	 */
	private extractPRNumberFromUrl(url: string): number {
		// GitHub: https://github.com/owner/repo/pull/123
		// BitBucket: https://bitbucket.org/workspace/repo/pull-requests/123
		const githubMatch = url.match(/\/pull\/(\d+)/)
		const bitbucketMatch = url.match(/\/pull-requests\/(\d+)/)
		
		const match = githubMatch ?? bitbucketMatch
		if (match?.[1]) {
			return parseInt(match[1], 10)
		}
		
		throw new Error(`Failed to extract PR number from URL: ${url}`)
	}

	/**
	 * Get issue tracker instance
	 */
	getIssueTracker(): IssueTracker {
		return this.issueTracker
	}

	/**
	 * Get VCS provider instance
	 */
	getVCSProvider(): VersionControlProvider {
		return this.vcsProvider
	}
}
