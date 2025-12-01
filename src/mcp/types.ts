/**
 * Type definitions for Issue Management MCP Server
 */

/**
 * Supported issue management providers
 */
export type IssueProvider = 'github' | 'linear'

/**
 * Environment variables required by MCP server
 */
export interface McpServerEnvironment {
	ISSUE_PROVIDER: IssueProvider
	REPO_OWNER: string
	REPO_NAME: string
	GITHUB_EVENT_NAME?: 'issues' | 'pull_request' // Optional, GitHub-specific
	GITHUB_API_URL?: string // Optional, defaults to https://api.github.com/
}

/**
 * Input schema for getting issue details
 */
export interface GetIssueInput {
	number: string // Issue identifier (GitHub uses numbers, Linear uses UUIDs, etc.)
	includeComments?: boolean | undefined // Whether to include comments (default: true)
}

/**
 * Input schema for getting a specific comment
 */
export interface GetCommentInput {
	commentId: string // Comment identifier to fetch
	number: string // Issue or PR identifier (context for providers that need it)
}

/**
 * Input schema for creating a comment
 */
export interface CreateCommentInput {
	number: string // Issue or PR identifier
	body: string // Comment markdown content
	type: 'issue' | 'pr' // Type of entity to comment on
}

/**
 * Input schema for updating a comment
 */
export interface UpdateCommentInput {
	commentId: string // Comment identifier to update
	number: string // Issue or PR identifier (context for providers that need it)
	body: string // Updated markdown content
}

/**
 * Flexible author structure supporting multiple providers
 * Core fields: id, displayName
 * Passthrough fields: login (GitHub), name (Linear), email, avatarUrl, etc.
 */
export interface FlexibleAuthor {
	id: string
	displayName: string
	[key: string]: unknown // Allow provider-specific fields
}

/**
 * Output schema for issue details
 * Uses hybrid core + passthrough approach for provider flexibility
 */
export interface IssueResult {
	// Core validated fields (always present)
	id: string
	title: string
	body: string
	state: string
	url: string
	provider: IssueProvider

	// Normalized author with flexible structure
	author: FlexibleAuthor | null

	// Optional flexible fields
	assignees?: FlexibleAuthor[]
	labels?: Array<{ name: string; [key: string]: unknown }>
	comments?: Array<{
		id: string
		body: string
		author: FlexibleAuthor | null
		createdAt: string
		[key: string]: unknown // Allow provider-specific comment fields
	}>

	// Passthrough for provider-specific fields (milestone, cycle, sprint, priority, etc.)
	[key: string]: unknown
}

/**
 * Output schema for comment details
 * Uses flexible author structure for provider compatibility
 */
export interface CommentDetailResult {
	id: string
	body: string
	author: FlexibleAuthor | null
	created_at: string
	updated_at?: string
	[key: string]: unknown // Allow provider-specific fields (reactions, resolvedAt, etc.)
}

/**
 * Output schema for comment operations
 */
export interface CommentResult {
	id: string
	url: string
	created_at?: string
	updated_at?: string
}

/**
 * Provider interface for issue management operations
 * Each provider (GitHub, Linear, etc.) must implement this interface
 */
export interface IssueManagementProvider {
	readonly providerName: string

	/**
	 * Fetch issue details
	 */
	getIssue(input: GetIssueInput): Promise<IssueResult>

	/**
	 * Fetch a specific comment by ID
	 */
	getComment(input: GetCommentInput): Promise<CommentDetailResult>

	/**
	 * Create a new comment on an issue or PR
	 */
	createComment(input: CreateCommentInput): Promise<CommentResult>

	/**
	 * Update an existing comment
	 */
	updateComment(input: UpdateCommentInput): Promise<CommentResult>
}
