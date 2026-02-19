/**
 * Linear implementation of Issue Management Provider
 * Uses @linear/sdk for all operations
 */

import type {
	IssueManagementProvider,
	GetIssueInput,
	GetPRInput,
	GetCommentInput,
	CreateCommentInput,
	UpdateCommentInput,
	CreateIssueInput,
	CreateChildIssueInput,
	CreateDependencyInput,
	GetDependenciesInput,
	RemoveDependencyInput,
	GetChildIssuesInput,
	CloseIssueInput,
	ReopenIssueInput,
	EditIssueInput,
	CreateIssueResult,
	IssueResult,
	PRResult,
	CommentDetailResult,
	CommentResult,
	DependenciesResult,
	ChildIssueResult,
} from './types.js'
import {
	fetchLinearIssue,
	createLinearComment,
	getLinearComment,
	updateLinearComment,
	fetchLinearIssueComments,
	createLinearIssue,
	createLinearChildIssue,
	createLinearIssueRelation,
	getLinearIssueDependencies,
	findLinearIssueRelation,
	deleteLinearIssueRelation,
	getLinearChildIssues,
	updateLinearIssueState,
	editLinearIssue,
} from '../utils/linear.js'
import { LinearMarkupConverter } from '../utils/linear-markup-converter.js'
import { processMarkdownImages } from '../utils/image-processor.js'

/**
 * Linear-specific implementation of IssueManagementProvider
 */
export class LinearIssueManagementProvider implements IssueManagementProvider {
	readonly providerName = 'linear'
	readonly issuePrefix = ''

	/**
	 * Cached team key extracted from issue identifiers (e.g., "ENG-123" -> "ENG")
	 * Used as fallback when teamKey is not explicitly provided to createIssue()
	 */
	private cachedTeamKey: string | undefined = undefined

	/**
	 * Fetch issue details using Linear SDK
	 */
	async getIssue(input: GetIssueInput): Promise<IssueResult> {
		const { number, includeComments = true } = input

		// Extract and cache team key from identifier (e.g., "ENG-123" -> "ENG")
		// This enables createIssue() to use the team key as a fallback
		const match = number.match(/^([A-Z]{2,})-\d+$/i)
		if (match?.[1]) {
			this.cachedTeamKey = match[1].toUpperCase()
		}

		// Fetch issue - Linear uses alphanumeric identifiers like "ENG-123"
		const raw = await fetchLinearIssue(number)

		// Map Linear state name to open/closed
		const state = raw.state && (raw.state.toLowerCase().includes('done') || raw.state.toLowerCase().includes('completed') || raw.state.toLowerCase().includes('canceled'))
			? 'closed'
			: 'open'

		// Build result
		const result: IssueResult = {
			id: raw.identifier,
			title: raw.title,
			body: raw.description ?? '',
			state,
			url: raw.url,
			provider: 'linear',
			author: null, // Linear SDK doesn't return author in basic fetch

			// Linear-specific fields
			linearState: raw.state,
			createdAt: raw.createdAt,
			updatedAt: raw.updatedAt,
		}

		// Fetch comments if requested
		if (includeComments) {
			try {
				const comments = await this.fetchIssueComments(number)
				if (comments) {
					result.comments = comments
				}
			} catch {
				// If comments fail, continue without them
			}
		}

		// Process images in body and comments to make them accessible
		result.body = await processMarkdownImages(result.body, 'linear')
		if (result.comments) {
			for (const comment of result.comments) {
				comment.body = await processMarkdownImages(comment.body, 'linear')
			}
		}

		return result
	}

	/**
	 * Fetch pull request details
	 * Linear does not support PRs - this throws an error directing to use GitHub
	 */
	async getPR(_input: GetPRInput): Promise<PRResult> {
		throw new Error('Linear does not support pull requests. PRs exist only on GitHub. Use the GitHub provider for PR operations.')
	}

	/**
	 * Fetch comments for an issue
	 */
	private async fetchIssueComments(identifier: string): Promise<IssueResult['comments']> {
		try {
			const comments = await fetchLinearIssueComments(identifier)

			return comments.map(comment => ({
				id: comment.id,
				body: comment.body,
				createdAt: comment.createdAt,
				author: null, // Linear SDK doesn't return comment author info in basic fetch
				...(comment.updatedAt && { updatedAt: comment.updatedAt }),
			}))
		} catch {
			return []
		}
	}

	/**
	 * Fetch a specific comment by ID
	 */
	async getComment(input: GetCommentInput): Promise<CommentDetailResult> {
		const { commentId } = input

		const raw = await getLinearComment(commentId)

		// Process images to make them accessible
		const processedBody = await processMarkdownImages(raw.body, 'linear')

		return {
			id: raw.id,
			body: processedBody,
			author: null, // Linear SDK doesn't return comment author info in basic fetch
			created_at: raw.createdAt,
		}
	}

	/**
	 * Create a new comment on an issue
	 */
	async createComment(input: CreateCommentInput): Promise<CommentResult> {
		const { number, body } = input
		// Note: Linear doesn't distinguish between issue and PR comments
		// (Linear doesn't have PRs - that's GitHub-specific)

		// Convert HTML details/summary blocks to Linear's collapsible format
		const convertedBody = LinearMarkupConverter.convertToLinear(body)

		const result = await createLinearComment(number, convertedBody)

		return {
			id: result.id,
			url: result.url,
			created_at: result.createdAt,
		}
	}

	/**
	 * Update an existing comment
	 */
	async updateComment(input: UpdateCommentInput): Promise<CommentResult> {
		const { commentId, body } = input

		// Convert HTML details/summary blocks to Linear's collapsible format
		const convertedBody = LinearMarkupConverter.convertToLinear(body)

		const result = await updateLinearComment(commentId, convertedBody)

		return {
			id: result.id,
			url: result.url,
			updated_at: result.updatedAt,
		}
	}

	/**
	 * Create a new issue
	 */
	async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
		const { title, body, labels, teamKey } = input

		// Fallback chain: explicit param > settings (via env) > cached key from getIssue()
		const effectiveTeamKey = teamKey ?? process.env.LINEAR_TEAM_KEY ?? this.cachedTeamKey

		if (!effectiveTeamKey) {
			throw new Error('teamKey is required for Linear issue creation. Configure issueManagement.linear.teamId in settings, or call getIssue first to extract the team from an issue identifier.')
		}

		const result = await createLinearIssue(title, body, effectiveTeamKey, labels)

		return {
			id: result.identifier,
			url: result.url,
		}
	}

	/**
	 * Create a child issue linked to a parent issue
	 * Linear supports atomic creation with parentId field
	 */
	async createChildIssue(input: CreateChildIssueInput): Promise<CreateIssueResult> {
		const { parentId, title, body, labels, teamKey } = input

		// Fetch parent issue to get UUID (parentId in input is identifier like "ENG-123")
		const parentIssue = await fetchLinearIssue(parentId)

		// Extract team key from parent identifier if not provided
		const match = parentId.match(/^([A-Z]{2,})-\d+$/i)
		const effectiveTeamKey = teamKey ?? match?.[1]?.toUpperCase() ?? process.env.LINEAR_TEAM_KEY ?? this.cachedTeamKey

		if (!effectiveTeamKey) {
			throw new Error('teamKey is required for Linear child issue creation. Provide teamKey parameter or use a parent identifier with team prefix.')
		}

		// Create child issue with parent's UUID
		const result = await createLinearChildIssue(
			title,
			body,
			effectiveTeamKey,
			parentIssue.id, // UUID, not identifier
			labels
		)

		return {
			id: result.identifier,
			url: result.url,
		}
	}

	/**
	 * Create a blocking dependency between two issues
	 */
	async createDependency(input: CreateDependencyInput): Promise<void> {
		const { blockingIssue, blockedIssue } = input

		// Fetch both issues to get their UUIDs
		const [blockingIssueData, blockedIssueData] = await Promise.all([
			fetchLinearIssue(blockingIssue),
			fetchLinearIssue(blockedIssue),
		])

		// Create the blocking relation (blockingIssue blocks blockedIssue)
		await createLinearIssueRelation(blockingIssueData.id, blockedIssueData.id)
	}

	/**
	 * Get dependencies for an issue
	 */
	async getDependencies(input: GetDependenciesInput): Promise<DependenciesResult> {
		const { number, direction } = input

		return await getLinearIssueDependencies(number, direction)
	}

	/**
	 * Remove a blocking dependency between two issues
	 */
	async removeDependency(input: RemoveDependencyInput): Promise<void> {
		const { blockingIssue, blockedIssue } = input

		// Find the relation ID
		const relationId = await findLinearIssueRelation(blockingIssue, blockedIssue)

		if (!relationId) {
			throw new Error(`No blocking dependency found from ${blockingIssue} to ${blockedIssue}`)
		}

		// Delete the relation
		await deleteLinearIssueRelation(relationId)
	}

	/**
	 * Get child issues of a parent issue
	 */
	async getChildIssues(input: GetChildIssuesInput): Promise<ChildIssueResult[]> {
		const { number } = input
		// repo is ignored for Linear
		return await getLinearChildIssues(number)
	}

	/**
	 * Close an issue by transitioning to "Done" state
	 */
	async closeIssue(input: CloseIssueInput): Promise<void> {
		const { number } = input
		// repo is ignored for Linear
		await updateLinearIssueState(number, 'Done')
	}

	/**
	 * Reopen a closed issue by transitioning to "Todo" state
	 */
	async reopenIssue(input: ReopenIssueInput): Promise<void> {
		const { number } = input
		// repo is ignored for Linear
		await updateLinearIssueState(number, 'Todo')
	}

	/**
	 * Edit an issue's properties
	 * State changes are delegated to closeIssue/reopenIssue
	 */
	async editIssue(input: EditIssueInput): Promise<void> {
		const { number, title, body, state } = input
		// repo and labels are ignored for Linear

		// Handle state changes via close/reopen
		if (state === 'closed') {
			await this.closeIssue({ number })
		} else if (state === 'open') {
			await this.reopenIssue({ number })
		}

		// Handle title/body updates
		if (title !== undefined || body !== undefined) {
			await editLinearIssue(number, {
				...(title !== undefined && { title }),
				...(body !== undefined && { description: body }),
			})
		}
	}
}
