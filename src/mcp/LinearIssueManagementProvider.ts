/**
 * Linear implementation of Issue Management Provider
 * Uses direct GraphQL API calls to Linear
 */

import type {
	IssueManagementProvider,
	GetIssueInput,
	GetCommentInput,
	CreateCommentInput,
	UpdateCommentInput,
	IssueResult,
	CommentDetailResult,
	CommentResult,
	FlexibleAuthor,
} from './types.js'
import {
	fetchLinearIssueByIdentifier,
	getLinearCommentGraphQL,
	createLinearCommentGraphQL,
	updateLinearCommentGraphQL,
	fetchIssueCommentsGraphQL,
} from '../utils/linear-graphql.js'
import { buildLinearIssueUrl } from '../utils/linear.js'

/**
 * Linear-specific author structure
 */
interface LinearAuthor {
	name: string
	displayName?: string
	id?: string
}

/**
 * Normalize Linear author to FlexibleAuthor format
 */
function normalizeAuthor(author: LinearAuthor | null | undefined): FlexibleAuthor | null {
	if (!author) return null

	return {
		id: author.id ?? author.name,
		displayName: author.displayName ?? author.name,
		name: author.name, // Preserve original Linear field
	}
}

/**
 * Linear-specific implementation of IssueManagementProvider
 */
export class LinearIssueManagementProvider implements IssueManagementProvider {
	readonly providerName = 'linear'
	private apiToken: string

	constructor(config?: { apiToken?: string }) {
		if (!config?.apiToken) {
			throw new Error('LINEAR_API_TOKEN is required for LinearIssueManagementProvider')
		}
		this.apiToken = config.apiToken
	}

	/**
	 * Fetch issue details using GraphQL
	 */
	async getIssue(input: GetIssueInput): Promise<IssueResult> {
		const { number, includeComments = true } = input

		// Fetch issue - Linear uses alphanumeric identifiers like "ENG-123"
		const raw = await fetchLinearIssueByIdentifier(number, this.apiToken)

		// Map Linear state type to open/closed
		const state = raw.state.type === 'completed' || raw.state.type === 'canceled'
			? 'closed'
			: 'open'

		// Construct URL if not provided by linearis CLI
		const url = raw.url ?? buildLinearIssueUrl(raw.identifier, raw.title)

		// Build result
		const result: IssueResult = {
			id: raw.identifier,
			title: raw.title,
			body: raw.description ?? '',
			state,
			url,
			provider: 'linear',
			author: null, // Linear issues don't return author in basic fetch

			// Labels
			...(raw.labels && raw.labels.length > 0 && {
				labels: raw.labels,
			}),

			// Assignee as single-item array for consistency
			...(raw.assignee && {
				assignees: [normalizeAuthor(raw.assignee)].filter((a): a is FlexibleAuthor => a !== null),
			}),

			// Linear-specific fields
			team: raw.team,
			linearState: raw.state,
			createdAt: raw.createdAt,
			updatedAt: raw.updatedAt,
		}

		// Fetch comments if requested
		if (includeComments) {
			try {
				const comments = await this.fetchIssueComments(raw.id)
				if (comments) {
					result.comments = comments
				}
			} catch {
				// If comments fail, continue without them
			}
		}

		return result
	}

	/**
	 * Fetch comments for an issue using GraphQL
	 */
	private async fetchIssueComments(issueId: string): Promise<IssueResult['comments']> {
		try {
			const comments = await fetchIssueCommentsGraphQL(issueId, this.apiToken)

			return comments.map(comment => ({
				id: comment.id,
				body: comment.body,
				createdAt: comment.createdAt,
				author: normalizeAuthor(comment.user),
			}))
		} catch {
			return []
		}
	}

	/**
	 * Fetch a specific comment by ID using GraphQL
	 */
	async getComment(input: GetCommentInput): Promise<CommentDetailResult> {
		const { commentId } = input

		const raw = await getLinearCommentGraphQL(commentId, this.apiToken)

		return {
			id: raw.id,
			body: raw.body,
			author: normalizeAuthor(raw.user),
			created_at: raw.createdAt,
		}
	}

	/**
	 * Create a new comment on an issue using GraphQL
	 */
	async createComment(input: CreateCommentInput): Promise<CommentResult> {
		const { number, body } = input
		// Note: Linear doesn't distinguish between issue and PR comments
		// (Linear doesn't have PRs - that's GitHub-specific)

		// First fetch the issue to get its UUID
		const issue = await fetchLinearIssueByIdentifier(number, this.apiToken)
		const result = await createLinearCommentGraphQL(issue.id, body, this.apiToken)

		return {
			id: result.id,
			url: '', // Linear comments don't have direct URLs in the API response
			created_at: result.createdAt,
		}
	}

	/**
	 * Update an existing comment using GraphQL
	 */
	async updateComment(input: UpdateCommentInput): Promise<CommentResult> {
		const { commentId, body } = input

		const result = await updateLinearCommentGraphQL(commentId, body, this.apiToken)

		return {
			id: result.id,
			url: '',
			updated_at: result.createdAt, // Use createdAt as proxy if no updatedAt
		}
	}
}
