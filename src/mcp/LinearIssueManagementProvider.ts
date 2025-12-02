/**
 * Linear implementation of Issue Management Provider
 * Uses linearis CLI for all operations
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
	fetchLinearIssue,
	createLinearComment,
	getLinearComment,
	updateLinearComment,
	executeLinearisCommand,
	buildLinearIssueUrl,
} from '../utils/linear.js'

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

	/**
	 * Fetch issue details using linearis CLI
	 */
	async getIssue(input: GetIssueInput): Promise<IssueResult> {
		const { number, includeComments = true } = input

		// Fetch issue - Linear uses alphanumeric identifiers like "ENG-123"
		const raw = await fetchLinearIssue(number)

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
				const comments = await this.fetchIssueComments(number)
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
	 * Fetch comments for an issue
	 */
	private async fetchIssueComments(identifier: string): Promise<IssueResult['comments']> {
		// Use linearis CLI to get comments for an issue
		interface LinearCommentResponse {
			id: string
			body: string
			createdAt: string
			updatedAt?: string
			user: LinearAuthor
		}

		try {
			const comments = await executeLinearisCommand<LinearCommentResponse[]>([
				'comments',
				'list',
				identifier,
			])

			return comments.map(comment => ({
				id: comment.id,
				body: comment.body,
				createdAt: comment.createdAt,
				author: normalizeAuthor(comment.user),
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

		return {
			id: raw.id,
			body: raw.body,
			author: normalizeAuthor(raw.user),
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

		const result = await createLinearComment(number, body)

		return {
			id: result.id,
			url: '', // Linear comments don't have direct URLs in the API response
			created_at: result.createdAt,
		}
	}

	/**
	 * Update an existing comment
	 */
	async updateComment(input: UpdateCommentInput): Promise<CommentResult> {
		const { commentId, body } = input

		const result = await updateLinearComment(commentId, body)

		return {
			id: result.id,
			url: '',
			updated_at: result.createdAt, // Use createdAt as proxy if no updatedAt
		}
	}
}
