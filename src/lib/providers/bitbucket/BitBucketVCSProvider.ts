// BitBucketVCSProvider - Implements VersionControlProvider for BitBucket
// Provides PR/VCS operations via BitBucket REST API

import type { VersionControlProvider, ExistingPR } from '../../VersionControlProvider.js'
import type { PullRequest } from '../../../types/index.js'
import { BitBucketApiClient, type BitBucketConfig, type BitBucketPullRequest } from './BitBucketApiClient.js'
import type { IloomSettings } from '../../SettingsManager.js'
import { getLogger } from '../../../utils/logger-context.js'
import { parseGitRemotes } from '../../../utils/remote.js'

/**
 * BitBucket-specific configuration
 * Extends BitBucketConfig with username, appPassword, workspace, and repoSlug
 */
export interface BitBucketVCSConfig extends BitBucketConfig {
	reviewers?: string[] // Usernames of reviewers to add to PRs
}

/**
 * BitBucketVCSProvider implements VersionControlProvider for BitBucket
 * 
 * Key differences from GitHub:
 * - Uses workspace/repository slug instead of owner/repo
 * - PR states are different (OPEN, MERGED, DECLINED, SUPERSEDED)
 * - No native draft PR support
 */
export class BitBucketVCSProvider implements VersionControlProvider {
	readonly providerName = 'bitbucket'
	readonly supportsForks = true
	readonly supportsDraftPRs = false // BitBucket doesn't have draft PRs

	private readonly client: BitBucketApiClient
	private readonly reviewerUsernames?: string[]

	/**
	 * Create a BitBucketVCSProvider from IloomSettings
	 * Extracts and validates BitBucket config from settings
	 */
	static fromSettings(settings: IloomSettings): BitBucketVCSProvider {
		const bbSettings = settings.versionControl?.bitbucket

		if (!bbSettings?.username) {
			throw new Error('BitBucket username is required. Configure versionControl.bitbucket.username in .iloom/settings.json')
		}
		if (!bbSettings?.apiToken) {
			throw new Error('BitBucket API token is required. Configure versionControl.bitbucket.apiToken in .iloom/settings.local.json')
		}

		const config: BitBucketVCSConfig = {
			username: bbSettings.username,
			apiToken: bbSettings.apiToken,
		}

		if (bbSettings.workspace) {
			config.workspace = bbSettings.workspace
		}
		if (bbSettings.repoSlug) {
			config.repoSlug = bbSettings.repoSlug
		}
		if (bbSettings.reviewers) {
			config.reviewers = bbSettings.reviewers
		}

		return new BitBucketVCSProvider(config)
	}

	constructor(config: BitBucketVCSConfig) {
		this.client = new BitBucketApiClient(config)
		if (config.reviewers) {
			this.reviewerUsernames = config.reviewers
		}
	}

	/**
	 * Check if a PR already exists for the given branch
	 */
	async checkForExistingPR(branchName: string, cwd?: string): Promise<ExistingPR | null> {
		try {
			// Get workspace and repo slug from config or detect from git remote
			const { workspace, repoSlug } = await this.getWorkspaceAndRepo(cwd)

			const prs = await this.client.listPullRequests(workspace, repoSlug, branchName)
			
			if (prs.length > 0 && prs[0]) {
				const pr = prs[0]
				return {
					number: pr.id,
					url: pr.links.html.href,
				}
			}

			return null
		} catch (error) {
			getLogger().debug('Error checking for existing PR', { error })
			return null
		}
	}

	/**
	 * Create a pull request
	 */
	async createPR(
		branchName: string,
		title: string,
		body: string,
		baseBranch: string,
		cwd?: string
	): Promise<string> {
		const { workspace, repoSlug } = await this.getWorkspaceAndRepo(cwd)

		// Log the target repository so users can verify it's correct
		getLogger().info(`Creating BitBucket PR in ${workspace}/${repoSlug}`)
		getLogger().debug('PR details', { branchName, title, baseBranch })

		// Resolve reviewer usernames to account IDs if configured
		let reviewerIds: string[] | undefined
		if (this.reviewerUsernames && this.reviewerUsernames.length > 0) {
			reviewerIds = await this.resolveReviewerUsernames(workspace, this.reviewerUsernames)

			// Filter out the current user from reviewers (BitBucket doesn't allow PR author as reviewer)
			if (reviewerIds.length > 0) {
				const currentUser = await this.client.getCurrentUser()
				const originalCount = reviewerIds.length
				reviewerIds = reviewerIds.filter(id => id !== currentUser.account_id)

				if (reviewerIds.length < originalCount) {
					getLogger().debug(
						`Removed current user (${currentUser.display_name}) from reviewers list - PR author cannot be a reviewer`
					)
				}
			}
		}

		const pr = await this.client.createPullRequest(
			workspace,
			repoSlug,
			title,
			body,
			branchName,
			baseBranch,
			reviewerIds
		)

		// Validate the response structure
		if (!pr?.id || !pr?.links?.html?.href) {
			getLogger().error('Invalid BitBucket API response', { pr })
			throw new Error(
				`BitBucket API returned invalid PR response. ` +
				`Expected PR with id and links.html.href, got: ${JSON.stringify(pr)}`
			)
		}

		getLogger().info(`BitBucket PR #${pr.id} created successfully`)
		return pr.links.html.href
	}

	/**
	 * Fetch PR details
	 */
	async fetchPR(prNumber: number, cwd?: string): Promise<PullRequest> {
		const { workspace, repoSlug } = await this.getWorkspaceAndRepo(cwd)

		const bbPR = await this.client.getPullRequest(workspace, repoSlug, prNumber)
		return this.mapBitBucketPRToPullRequest(bbPR)
	}

	/**
	 * Get PR URL
	 */
	async getPRUrl(prNumber: number, cwd?: string): Promise<string> {
		const { workspace, repoSlug } = await this.getWorkspaceAndRepo(cwd)

		const bbPR = await this.client.getPullRequest(workspace, repoSlug, prNumber)
		return bbPR.links.html.href
	}

	/**
	 * Create a comment on a PR
	 */
	async createPRComment(prNumber: number, body: string, cwd?: string): Promise<void> {
		const { workspace, repoSlug } = await this.getWorkspaceAndRepo(cwd)

		getLogger().debug('Creating BitBucket PR comment', { workspace, repoSlug, prNumber })

		await this.client.addPRComment(workspace, repoSlug, prNumber, body)
	}

	/**
	 * List open pull requests for the repository
	 * Uses getWorkspaceAndRepo for auto-detection from git remotes
	 */
	async listPullRequests(cwd?: string): Promise<BitBucketPullRequest[]> {
		const { workspace, repoSlug } = await this.getWorkspaceAndRepo(cwd)
		return this.client.listPullRequests(workspace, repoSlug)
	}

	/**
	 * Detect repository from git remote
	 */
	async detectRepository(cwd?: string): Promise<{ owner: string; repo: string } | null> {
		try {
			const remotes = await parseGitRemotes(cwd)
			
			// Look for bitbucket.org remote
			const bbRemote = remotes.find(r => 
				r.url.includes('bitbucket.org')
			)

			if (!bbRemote) {
				return null
			}

			// BitBucket URLs: https://bitbucket.org/workspace/repo.git
			// or git@bitbucket.org:workspace/repo.git
			return {
				owner: bbRemote.owner, // workspace
				repo: bbRemote.repo,
			}
		} catch (error) {
			getLogger().error('Failed to detect BitBucket repository', { error })
			return null
		}
	}

	/**
	 * Get target remote for PR operations
	 */
	async getTargetRemote(_cwd?: string): Promise<string> {
		// For BitBucket, we typically use 'origin'
		// Fork workflows are less common in BitBucket
		return 'origin'
	}

	/**
	 * Get workspace and repository slug from config or git remote
	 */
	private async getWorkspaceAndRepo(cwd?: string): Promise<{ workspace: string; repoSlug: string }> {
		let workspace = this.client.getWorkspace()
		let repoSlug = this.client.getRepoSlug()

		// If not configured, try to detect from git remote
		if (!workspace || !repoSlug) {
			const detected = await this.detectRepository(cwd)
			if (!detected) {
				throw new Error(
					'Could not determine BitBucket workspace/repository. ' +
					'Either configure them in settings or ensure git remote points to bitbucket.org'
				)
			}

			workspace = workspace ?? detected.owner
			repoSlug = repoSlug ?? detected.repo
		}

		return { workspace, repoSlug }
	}

	/**
	 * Resolve reviewer usernames to BitBucket account IDs
	 * Warns for any usernames that cannot be resolved but continues with partial list
	 */
	private async resolveReviewerUsernames(workspace: string, usernames: string[]): Promise<string[]> {
		getLogger().debug(`Resolving ${usernames.length} reviewer username(s) to BitBucket account IDs`)

		const usernameToAccountId = await this.client.findUsersByUsername(workspace, usernames)

		const resolvedIds: string[] = []
		const unresolvedUsernames: string[] = []

		for (const username of usernames) {
			const accountId = usernameToAccountId.get(username)
			if (accountId) {
				resolvedIds.push(accountId)
			} else {
				unresolvedUsernames.push(username)
			}
		}

		if (unresolvedUsernames.length > 0) {
			getLogger().warn(
				`Could not resolve ${unresolvedUsernames.length} reviewer username(s) to BitBucket account IDs: ${unresolvedUsernames.join(', ')}. ` +
				`These reviewers will not be added to the PR.`
			)
		}

		if (resolvedIds.length > 0) {
			getLogger().info(`Resolved ${resolvedIds.length} reviewer(s) for PR`)
		}

		return resolvedIds
	}

	/**
	 * Map BitBucket PR to generic PullRequest type
	 */
	private mapBitBucketPRToPullRequest(bbPR: BitBucketPullRequest): PullRequest {
		// Map BitBucket states to generic states
		let state: 'open' | 'closed' | 'merged'
		if (bbPR.state === 'OPEN') {
			state = 'open'
		} else if (bbPR.state === 'MERGED') {
			state = 'merged'
		} else {
			state = 'closed' // DECLINED or SUPERSEDED
		}

		return {
			number: bbPR.id,
			title: bbPR.title,
			body: bbPR.description,
			state,
			branch: bbPR.source.branch.name,
			baseBranch: bbPR.destination.branch.name,
			url: bbPR.links.html.href,
			isDraft: false, // BitBucket doesn't have draft PRs
		}
	}
}
