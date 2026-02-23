/**
 * GitHub implementation of Issue Management Provider
 * Uses GitHub CLI for all operations
 * Normalizes GitHub-specific fields (login) to provider-agnostic core fields (id, displayName)
 */

import type {
	IssueManagementProvider,
	GetIssueInput,
	GetPRInput,
	GetReviewCommentsInput,
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
	ReviewCommentResult,
	CommentDetailResult,
	CommentResult,
	DependenciesResult,
	ChildIssueResult,
	FlexibleAuthor,
} from './types.js'
import {
	executeGhCommand,
	createIssueComment,
	updateIssueComment,
	createPRComment,
	createIssue,
	getIssueNodeId,
	addSubIssue,
	getIssueDatabaseId,
	getIssueDependencies,
	createIssueDependency,
	removeIssueDependency,
	getSubIssues,
	closeGhIssue,
	reopenGhIssue,
	editGhIssue,
} from '../utils/github.js'
import { processMarkdownImages } from '../utils/image-processor.js'

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
 * Extract numeric comment ID from GitHub comment URL
 * URL format: https://github.com/owner/repo/issues/123#issuecomment-3615239386
 */
export function extractNumericIdFromUrl(url: string): string {
	const match = url.match(/#issuecomment-(\d+)$/)
	if (!match?.[1]) {
		throw new Error(`Cannot extract comment ID from URL: ${url}`)
	}
	return match[1]
}

/**
 * GitHub-specific implementation of IssueManagementProvider
 */
export class GitHubIssueManagementProvider implements IssueManagementProvider {
	readonly providerName = 'github'
	readonly issuePrefix = '#'

	/**
	 * Fetch issue details using gh CLI
	 * Normalizes GitHub-specific fields to provider-agnostic format
	 */
	async getIssue(input: GetIssueInput): Promise<IssueResult> {
		const { number, includeComments = true, repo } = input

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
				url: string
			}>
		}

		const args = [
			'issue',
			'view',
			String(issueNumber),
			'--json',
			fields,
		]

		// Add --repo flag if repo is provided (gh CLI handles both owner/repo and URL formats)
		if (repo) {
			args.push('--repo', repo)
		}

		const raw = await executeGhCommand<GitHubIssueResponse>(args)

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
		// Use extractNumericIdFromUrl to get REST API-compatible numeric IDs from comment URLs
		// (GitHub CLI returns GraphQL node IDs in the id field, but REST API expects numeric IDs)
		if (raw.comments !== undefined) {
			result.comments = raw.comments.map(comment => ({
				id: extractNumericIdFromUrl(comment.url),
				body: comment.body,
				createdAt: comment.createdAt,
				author: normalizeAuthor(comment.author),
				...(comment.updatedAt && { updatedAt: comment.updatedAt }),
			}))
		}

		// Process authenticated images in body and comments
		result.body = await processMarkdownImages(result.body, 'github')
		if (result.comments) {
			for (const comment of result.comments) {
				comment.body = await processMarkdownImages(comment.body, 'github')
			}
		}

		return result
	}

	/**
	 * Fetch pull request details using gh CLI
	 * Normalizes GitHub-specific fields to provider-agnostic format
	 */
	async getPR(input: GetPRInput): Promise<PRResult> {
		const { number, includeComments = true, repo } = input

		// Convert string ID to number for GitHub CLI
		const prNumber = parseInt(number, 10)
		if (isNaN(prNumber)) {
			throw new Error(`Invalid GitHub PR number: ${number}. GitHub PR IDs must be numeric.`)
		}

		// Build fields list based on whether we need comments
		const baseFields = 'number,title,body,state,url,author,headRefName,baseRefName,files,commits'
		const fields = includeComments
			? `${baseFields},comments`
			: baseFields

		// GitHub PR response structure
		interface GitHubPRResponse {
			number: number
			title: string
			body: string
			state: string
			url: string
			author?: GitHubAuthor
			headRefName: string
			baseRefName: string
			files?: Array<{
				path: string
				additions: number
				deletions: number
			}>
			commits?: Array<{
				oid: string
				messageHeadline: string
				authors: Array<{ name: string; email: string }>
			}>
			comments?: Array<{
				id: number
				author: GitHubAuthor
				body: string
				createdAt: string
				updatedAt?: string
				url: string
			}>
		}

		const args = [
			'pr',
			'view',
			String(prNumber),
			'--json',
			fields,
		]

		// Add --repo flag if repo is provided
		if (repo) {
			args.push('--repo', repo)
		}

		const raw = await executeGhCommand<GitHubPRResponse>(args)

		// Normalize to PRResult with core fields + passthrough
		const result: PRResult = {
			// Core fields
			id: String(raw.number),
			number: raw.number,
			title: raw.title,
			body: raw.body,
			state: raw.state,
			url: raw.url,

			// Normalized author
			author: normalizeAuthor(raw.author),

			// PR-specific fields
			headRefName: raw.headRefName,
			baseRefName: raw.baseRefName,

			// Optional files
			...(raw.files && {
				files: raw.files,
			}),

			// Optional commits - normalize author
			...(raw.commits && {
				commits: raw.commits.map(commit => ({
					oid: commit.oid,
					messageHeadline: commit.messageHeadline,
					author: commit.authors?.[0]
						? {
							id: commit.authors[0].email,
							displayName: commit.authors[0].name,
							name: commit.authors[0].name,
							email: commit.authors[0].email,
						}
						: null,
				})),
			}),
		}

		// Handle comments with normalized authors
		// Use extractNumericIdFromUrl to get REST API-compatible numeric IDs from comment URLs
		if (raw.comments !== undefined) {
			result.comments = raw.comments.map(comment => ({
				id: extractNumericIdFromUrl(comment.url),
				body: comment.body,
				createdAt: comment.createdAt,
				author: normalizeAuthor(comment.author),
				...(comment.updatedAt && { updatedAt: comment.updatedAt }),
			}))
		}

		// Process authenticated images in body and comments
		result.body = await processMarkdownImages(result.body, 'github')
		if (result.comments) {
			for (const comment of result.comments) {
				comment.body = await processMarkdownImages(comment.body, 'github')
			}
		}

		return result
	}

	/**
	 * Fetch PR review comments (inline code comments on specific files/lines)
	 * Uses gh api with --paginate to handle PRs with many review comments
	 * Optionally filters by review ID
	 */
	async getReviewComments(input: GetReviewCommentsInput): Promise<ReviewCommentResult[]> {
		const { number, reviewId, repo } = input

		// Convert string ID to number for GitHub API
		const prNumber = parseInt(number, 10)
		if (isNaN(prNumber)) {
			throw new Error(`Invalid GitHub PR number: ${number}. GitHub PR IDs must be numeric.`)
		}

		// Validate reviewId early to avoid unnecessary API call
		let numericReviewId: number | undefined
		if (reviewId) {
			numericReviewId = parseInt(reviewId, 10)
			if (isNaN(numericReviewId)) {
				throw new Error(`Invalid review ID: ${reviewId}. Review IDs must be numeric.`)
			}
		}

		// GitHub API response structure for review comments
		interface GitHubReviewComment {
			id: number
			body: string
			path: string
			line: number | null
			side: string | null
			user: GitHubAuthor | null
			created_at: string
			updated_at: string | null
			in_reply_to_id: number | null
			pull_request_review_id: number | null
		}

		// Use explicit repo path if provided, otherwise use :owner/:repo placeholder
		const apiPath = repo
			? `repos/${repo}/pulls/${prNumber}/comments`
			: `repos/:owner/:repo/pulls/${prNumber}/comments`

		const args = [
			'api',
			apiPath,
			'--paginate',
			'--jq',
			'[.[] | {id: .id, body: .body, path: .path, line: .line, side: .side, user: .user, created_at: .created_at, updated_at: .updated_at, in_reply_to_id: .in_reply_to_id, pull_request_review_id: .pull_request_review_id}]',
		]

		const raw = await executeGhCommand<GitHubReviewComment[]>(args)

		// Filter by reviewId if provided (already validated above)
		let comments = raw
		if (numericReviewId !== undefined) {
			comments = comments.filter(c => c.pull_request_review_id === numericReviewId)
		}

		// Normalize and process each comment
		const results: ReviewCommentResult[] = []
		for (const comment of comments) {
			const processedBody = await processMarkdownImages(comment.body, 'github')
			results.push({
				id: String(comment.id),
				body: processedBody,
				path: comment.path,
				line: comment.line,
				side: comment.side,
				author: normalizeAuthor(comment.user),
				createdAt: comment.created_at,
				updatedAt: comment.updated_at ?? null,
				inReplyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
				pullRequestReviewId: comment.pull_request_review_id,
			})
		}

		return results
	}

	/**
	 * Fetch a specific comment by ID using gh API
	 * Normalizes author to FlexibleAuthor format
	 */
	async getComment(input: GetCommentInput): Promise<CommentDetailResult> {
		const { commentId, repo } = input
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

		// Use explicit repo path if provided, otherwise use :owner/:repo placeholder
		const apiPath = repo
			? `repos/${repo}/issues/comments/${numericCommentId}`
			: `repos/:owner/:repo/issues/comments/${numericCommentId}`

		// Use gh api to fetch specific comment
		const raw = await executeGhCommand<GitHubCommentResponse>([
			'api',
			apiPath,
			'--jq',
			'{id: .id, body: .body, user: .user, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, reactions: .reactions}',
		])

		// Process authenticated images in comment body
		const processedBody = await processMarkdownImages(raw.body, 'github')

		// Normalize to CommentDetailResult
		return {
			id: String(raw.id),
			body: processedBody,
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

	/**
	 * Create a new issue
	 */
	async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
		const { title, body, labels, repo } = input
		// teamKey is ignored for GitHub

		const result = await createIssue(title, body, { labels, repo })

		// Ensure number is numeric
		const issueNumber = typeof result.number === 'number'
			? result.number
			: parseInt(String(result.number), 10)

		return {
			id: String(issueNumber),
			url: result.url,
			number: issueNumber,
		}
	}

	/**
	 * Create a child issue linked to a parent issue
	 * GitHub requires two-step process: create issue, then link via GraphQL
	 */
	async createChildIssue(input: CreateChildIssueInput): Promise<CreateIssueResult> {
		const { parentId, title, body, labels, repo } = input
		// teamKey is ignored for GitHub

		// Convert parent identifier to number
		const parentNumber = parseInt(parentId, 10)
		if (isNaN(parentNumber)) {
			throw new Error(`Invalid GitHub parent issue number: ${parentId}. GitHub issue IDs must be numeric.`)
		}

		// Step 1: Get parent issue's GraphQL node ID
		const parentNodeId = await getIssueNodeId(parentNumber, repo)

		// Step 2: Create the child issue
		const childResult = await createIssue(title, body, { labels, repo })
		const childNumber = typeof childResult.number === 'number'
			? childResult.number
			: parseInt(String(childResult.number), 10)

		// Step 3: Get child issue's GraphQL node ID
		const childNodeId = await getIssueNodeId(childNumber, repo)

		// Step 4: Link child to parent via GraphQL mutation
		await addSubIssue(parentNodeId, childNodeId)

		return {
			id: String(childNumber),
			url: childResult.url,
			number: childNumber,
		}
	}

	/**
	 * Create a blocking dependency between two issues (A blocks B)
	 * Uses GitHub's sub-issues API: blocking issue becomes parent, blocked issue becomes sub-issue
	 */
	async createDependency(input: CreateDependencyInput): Promise<void> {
		const { blockingIssue, blockedIssue, repo } = input

		// Convert string IDs to numbers
		const blockingNumber = parseInt(blockingIssue, 10)
		if (isNaN(blockingNumber)) {
			throw new Error(`Invalid GitHub issue number: ${blockingIssue}. GitHub issue IDs must be numeric.`)
		}

		const blockedNumber = parseInt(blockedIssue, 10)
		if (isNaN(blockedNumber)) {
			throw new Error(`Invalid GitHub issue number: ${blockedIssue}. GitHub issue IDs must be numeric.`)
		}

		// Get the database ID of the blocking issue
		// GitHub API: POST /issues/{blocked_issue_number}/dependencies/blocked_by with body issue_id={blocking_database_id}
		const blockingDatabaseId = await getIssueDatabaseId(blockingNumber, repo)

		// Create the dependency: path uses blocked issue number, body uses blocking issue DB ID
		await createIssueDependency(blockedNumber, blockingDatabaseId, repo)
	}

	/**
	 * Get dependencies for an issue
	 */
	async getDependencies(input: GetDependenciesInput): Promise<DependenciesResult> {
		const { number, direction, repo } = input

		const issueNumber = parseInt(number, 10)
		if (isNaN(issueNumber)) {
			throw new Error(`Invalid GitHub issue number: ${number}. GitHub issue IDs must be numeric.`)
		}

		const result: DependenciesResult = {
			blocking: [],
			blockedBy: [],
		}

		// Fetch dependencies based on direction
		if (direction === 'blocking' || direction === 'both') {
			result.blocking = await getIssueDependencies(issueNumber, 'blocking', repo)
		}

		if (direction === 'blocked_by' || direction === 'both') {
			result.blockedBy = await getIssueDependencies(issueNumber, 'blocked_by', repo)
		}

		return result
	}

	/**
	 * Remove a blocking dependency between two issues (A blocks B)
	 * Uses GitHub's sub-issues API: blocking issue is parent, blocked issue is sub-issue
	 */
	async removeDependency(input: RemoveDependencyInput): Promise<void> {
		const { blockingIssue, blockedIssue, repo } = input

		// Convert string IDs to numbers
		const blockingNumber = parseInt(blockingIssue, 10)
		if (isNaN(blockingNumber)) {
			throw new Error(`Invalid GitHub issue number: ${blockingIssue}. GitHub issue IDs must be numeric.`)
		}

		const blockedNumber = parseInt(blockedIssue, 10)
		if (isNaN(blockedNumber)) {
			throw new Error(`Invalid GitHub issue number: ${blockedIssue}. GitHub issue IDs must be numeric.`)
		}

		// Get the database ID of the blocking issue
		// GitHub API: DELETE /issues/{blocked_issue_number}/dependencies/blocked_by with body issue_id={blocking_database_id}
		const blockingDatabaseId = await getIssueDatabaseId(blockingNumber, repo)

		// Remove the dependency: path uses blocked issue number, body uses blocking issue DB ID
		await removeIssueDependency(blockedNumber, blockingDatabaseId, repo)
	}

	/**
	 * Get child issues (sub-issues) of a parent issue
	 */
	async getChildIssues(input: GetChildIssuesInput): Promise<ChildIssueResult[]> {
		const { number, repo } = input

		const issueNumber = parseInt(number, 10)
		if (isNaN(issueNumber)) {
			throw new Error(`Invalid GitHub issue number: ${number}. GitHub issue IDs must be numeric.`)
		}

		return await getSubIssues(issueNumber, repo)
	}

	/**
	 * Close an issue
	 */
	async closeIssue(input: CloseIssueInput): Promise<void> {
		const { number, repo } = input

		const issueNumber = parseInt(number, 10)
		if (isNaN(issueNumber)) {
			throw new Error(`Invalid GitHub issue number: ${number}. GitHub issue IDs must be numeric.`)
		}

		await closeGhIssue(issueNumber, repo)
	}

	/**
	 * Reopen a closed issue
	 */
	async reopenIssue(input: ReopenIssueInput): Promise<void> {
		const { number, repo } = input

		const issueNumber = parseInt(number, 10)
		if (isNaN(issueNumber)) {
			throw new Error(`Invalid GitHub issue number: ${number}. GitHub issue IDs must be numeric.`)
		}

		await reopenGhIssue(issueNumber, repo)
	}

	/**
	 * Edit an issue's properties
	 * State changes are delegated to closeIssue/reopenIssue
	 */
	async editIssue(input: EditIssueInput): Promise<void> {
		const { number, title, body, state, labels, repo } = input

		const issueNumber = parseInt(number, 10)
		if (isNaN(issueNumber)) {
			throw new Error(`Invalid GitHub issue number: ${number}. GitHub issue IDs must be numeric.`)
		}

		// Handle state changes via close/reopen
		if (state === 'closed') {
			await this.closeIssue({ number, repo })
		} else if (state === 'open') {
			await this.reopenIssue({ number, repo })
		}

		// Handle other field updates
		if (title !== undefined || body !== undefined || labels !== undefined) {
			await editGhIssue(
				issueNumber,
				{
					...(title !== undefined && { title }),
					...(body !== undefined && { body }),
					...(labels !== undefined && { labels }),
				},
				repo
			)
		}
	}
}
