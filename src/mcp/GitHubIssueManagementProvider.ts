/**
 * GitHub implementation of Issue Management Provider
 * Uses GitHub CLI for all operations
 * Normalizes GitHub-specific fields (login) to provider-agnostic core fields (id, displayName)
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
	executeGhCommand,
	createIssueComment,
	updateIssueComment,
	createPRComment,
} from '../utils/github.js'

/**
 * GitHub-specific author structure from API
 */
interface GitHubAuthor {
	login: string
	id?: number
	avatarUrl?: string
	url?: string
}

/**
 * Normalize GitHub author to FlexibleAuthor format
 */
function normalizeAuthor(author: GitHubAuthor | null | undefined): FlexibleAuthor | null {
	if (!author) return null

	return {
		id: author.id ? String(author.id) : author.login,
		displayName: author.login, // GitHub uses login as primary identifier
		login: author.login, // Preserve original GitHub field
		...(author.avatarUrl && { avatarUrl: author.avatarUrl }),
		...(author.url && { url: author.url }),
	}
}

/**
 * GitHub-specific implementation of IssueManagementProvider
 */
export class GitHubIssueManagementProvider implements IssueManagementProvider {
	readonly providerName = 'github'

	/**
	 * Fetch issue details using gh CLI
	 * Normalizes GitHub-specific fields to provider-agnostic format
	 */
	async getIssue(input: GetIssueInput): Promise<IssueResult> {
		const { number, includeComments = true } = input

		// Convert string ID to number for GitHub CLI
		const issueNumber = parseInt(number, 10)
		if (isNaN(issueNumber)) {
			throw new Error(`Invalid GitHub issue number: ${number}. GitHub issue IDs must be numeric.`)
		}

		// Build fields list based on whether we need comments
		const fields = includeComments
			? 'body,title,comments,labels,assignees,milestone,author,state,number,url'
			: 'body,title,labels,assignees,milestone,author,state,number,url'

		// Use gh issue view to fetch issue details
		interface GitHubIssueResponse {
			number: number
			title: string
			body: string
			state: string
			url: string
			author?: GitHubAuthor
			labels?: Array<{ name: string; color?: string; description?: string }>
			assignees?: Array<GitHubAuthor>
			milestone?: { title: string; number?: number; state?: string }
			comments?: Array<{
				id: number
				author: GitHubAuthor
				body: string
				createdAt: string
				updatedAt?: string
			}>
		}

		const raw = await executeGhCommand<GitHubIssueResponse>([
			'issue',
			'view',
			String(issueNumber),
			'--json',
			fields,
		])

		// Normalize to IssueResult with core fields + passthrough
		const result: IssueResult = {
			// Core fields
			id: String(raw.number),
			title: raw.title,
			body: raw.body,
			state: raw.state,
			url: raw.url,
			provider: 'github',

			// Normalized author
			author: normalizeAuthor(raw.author),

			// Optional flexible fields
			...(raw.assignees && {
				assignees: raw.assignees.map(a => normalizeAuthor(a)).filter((a): a is FlexibleAuthor => a !== null),
			}),
			...(raw.labels && {
				labels: raw.labels,
			}),

			// GitHub-specific passthrough fields
			...(raw.milestone && {
				milestone: raw.milestone,
			}),
		}

		// Handle comments with normalized authors
		if (raw.comments !== undefined) {
			result.comments = raw.comments.map(comment => ({
				id: String(comment.id),
				body: comment.body,
				createdAt: comment.createdAt,
				author: normalizeAuthor(comment.author),
				...(comment.updatedAt && { updatedAt: comment.updatedAt }),
			}))
		}

		return result
	}

	/**
	 * Fetch a specific comment by ID using gh API
	 * Normalizes author to FlexibleAuthor format
	 */
	async getComment(input: GetCommentInput): Promise<CommentDetailResult> {
		const { commentId } = input
		// Note: GitHub doesn't need the issue number parameter - comment IDs are globally unique
		// But we accept it for interface compatibility with other providers

		// Convert string ID to number for GitHub API
		const numericCommentId = parseInt(commentId, 10)
		if (isNaN(numericCommentId)) {
			throw new Error(`Invalid GitHub comment ID: ${commentId}. GitHub comment IDs must be numeric.`)
		}

		// GitHub API response structure
		interface GitHubCommentResponse {
			id: number
			body: string
			user: GitHubAuthor
			created_at: string
			updated_at?: string
			html_url?: string
			reactions?: Record<string, unknown>
		}

		// Use gh api to fetch specific comment
		const raw = await executeGhCommand<GitHubCommentResponse>([
			'api',
			`repos/:owner/:repo/issues/comments/${numericCommentId}`,
			'--jq',
			'{id: .id, body: .body, user: .user, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, reactions: .reactions}',
		])

		// Normalize to CommentDetailResult
		return {
			id: String(raw.id),
			body: raw.body,
			author: normalizeAuthor(raw.user),
			created_at: raw.created_at,
			...(raw.updated_at && { updated_at: raw.updated_at }),
			// Passthrough GitHub-specific fields
			...(raw.html_url && { html_url: raw.html_url }),
			...(raw.reactions && { reactions: raw.reactions }),
		}
	}

	/**
	 * Create a new comment on an issue or PR
	 */
	async createComment(input: CreateCommentInput): Promise<CommentResult> {
		const { number, body, type } = input

		// Convert string ID to number for GitHub utilities
		const numericId = parseInt(number, 10)
		if (isNaN(numericId)) {
			throw new Error(`Invalid GitHub ${type} number: ${number}. GitHub IDs must be numeric.`)
		}

		// Delegate to existing GitHub utilities
		const result =
			type === 'issue'
				? await createIssueComment(numericId, body)
				: await createPRComment(numericId, body)

		// Convert numeric ID to string for the interface
		return {
			...result,
			id: String(result.id),
		}
	}

	/**
	 * Update an existing comment
	 */
	async updateComment(input: UpdateCommentInput): Promise<CommentResult> {
		const { commentId, body } = input
		// Note: GitHub doesn't need the issue number parameter - comment IDs are globally unique
		// But we accept it for interface compatibility with other providers

		// Convert string ID to number for GitHub utility
		const numericCommentId = parseInt(commentId, 10)
		if (isNaN(numericCommentId)) {
			throw new Error(`Invalid GitHub comment ID: ${commentId}. GitHub comment IDs must be numeric.`)
		}

		// Delegate to existing GitHub utility
		const result = await updateIssueComment(numericCommentId, body)

		// Convert numeric ID to string for the interface
		return {
			...result,
			id: String(result.id),
		}
	}
}
