/**
 * Type definitions for Issue Management MCP Server
 */

/**
 * Supported issue management providers
 */
export type IssueProvider = 'github' | 'linear' | 'jira'

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
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for getting pull request details
 */
export interface GetPRInput {
	number: string // PR number
	includeComments?: boolean | undefined // Whether to include comments (default: true)
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL
}

/**
 * Input schema for getting PR review comments (inline code comments)
 */
export interface GetReviewCommentsInput {
	number: string // PR number
	reviewId?: string | undefined // Optional review ID to filter by
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL
}

/**
 * Output schema for a single PR review comment (inline code comment)
 */
export interface ReviewCommentResult {
	id: string
	body: string
	path: string // File path the comment is on
	line: number | null // Line number in the diff
	side: string | null // Side of the diff ('LEFT' or 'RIGHT')
	author: FlexibleAuthor | null
	createdAt: string
	updatedAt: string | null
	inReplyToId: string | null // If this is a reply to another review comment
	pullRequestReviewId: number | null // The review this comment belongs to
}

/**
 * Input schema for getting a specific comment
 */
export interface GetCommentInput {
	commentId: string // Comment identifier to fetch
	number: string // Issue or PR identifier (context for providers that need it)
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for creating a comment
 */
export interface CreateCommentInput {
	number: string // Issue or PR identifier
	body: string // Comment markdown content
	type: 'issue' | 'pr' // Type of entity to comment on
	markupLanguage?: 'GFM' | undefined // Markup language for body content (must be GFM)
}

/**
 * Input schema for updating a comment
 */
export interface UpdateCommentInput {
	commentId: string // Comment identifier to update
	number: string // Issue or PR identifier (context for providers that need it)
	body: string // Updated markdown content
	type?: 'issue' | 'pr' | undefined // Optional type to route PR comments to GitHub regardless of configured provider
	markupLanguage?: 'GFM' | undefined // Markup language for body content (must be GFM)
}

/**
 * Input schema for creating an issue
 */
export interface CreateIssueInput {
	title: string // Issue title
	body: string // Issue body/description (markdown supported)
	labels?: string[] | undefined // Optional labels to apply
	teamKey?: string | undefined // Required for Linear, ignored for GitHub
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
	markupLanguage?: 'GFM' | undefined // Markup language for body content (must be GFM)
}

/**
 * Input schema for creating a child issue linked to a parent issue
 */
export interface CreateChildIssueInput {
	parentId: string // Parent issue identifier (GitHub issue number or Linear identifier like "ENG-123")
	title: string // Child issue title
	body: string // Child issue body/description (markdown supported)
	labels?: string[] | undefined // Optional labels to apply
	teamKey?: string | undefined // Linear only - falls back to parent's team. Ignored for GitHub.
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
	markupLanguage?: 'GFM' | undefined // Markup language for body content (must be GFM)
}

/**
 * Input schema for creating a blocking dependency between two issues
 */
export interface CreateDependencyInput {
	blockingIssue: string // Issue that blocks
	blockedIssue: string // Issue being blocked
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for getting dependencies of an issue
 */
export interface GetDependenciesInput {
	number: string // Issue identifier
	direction: 'blocking' | 'blocked_by' | 'both' // Which direction of dependencies to fetch
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for getting child issues of a parent issue
 */
export interface GetChildIssuesInput {
	number: string // Parent issue identifier (GitHub issue number or Linear identifier like "ENG-123")
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Result for a single child issue
 */
export interface ChildIssueResult {
	id: string // Issue identifier
	title: string // Issue title
	url: string // Issue URL
	state: string // Issue state (open, closed, etc.)
}

/**
 * Input schema for removing a blocking dependency between two issues
 */
export interface RemoveDependencyInput {
	blockingIssue: string // Issue that blocks
	blockedIssue: string // Issue being blocked
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for closing an issue
 */
export interface CloseIssueInput {
	number: string // Issue identifier
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for reopening an issue
 */
export interface ReopenIssueInput {
	number: string // Issue identifier
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
}

/**
 * Input schema for editing an issue
 */
export interface EditIssueInput {
	number: string // Issue identifier
	title?: string | undefined // New issue title
	body?: string | undefined // New issue body/description
	state?: 'open' | 'closed' | undefined // New issue state
	labels?: string[] | undefined // Labels to set on the issue
	repo?: string | undefined // Optional repository in "owner/repo" format or full GitHub URL (GitHub only)
	markupLanguage?: 'GFM' | undefined // Markup language for body content (must be GFM)
}

/**
 * Single dependency result item
 */
export interface DependencyResult {
	id: string
	title: string
	url: string
	state: string
}

/**
 * Result for get dependencies operation
 */
export interface DependenciesResult {
	blocking: DependencyResult[]
	blockedBy: DependencyResult[]
}

/**
 * Output schema for issue creation
 */
export interface CreateIssueResult {
	id: string // Issue identifier (number for GitHub, identifier for Linear)
	url: string // Issue URL
	number?: number // GitHub issue number (undefined for Linear)
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
 * Output schema for pull request details
 */
export interface PRResult {
	// Core fields
	id: string
	number: number
	title: string
	body: string
	state: string
	url: string

	// Normalized author with flexible structure
	author: FlexibleAuthor | null

	// PR-specific fields
	headRefName: string // source branch
	baseRefName: string // target branch

	// Optional flexible fields
	files?: Array<{
		path: string
		additions: number
		deletions: number
		[key: string]: unknown
	}>
	commits?: Array<{
		oid: string
		messageHeadline: string
		author: FlexibleAuthor | null
		[key: string]: unknown
	}>
	comments?: Array<{
		id: string
		body: string
		author: FlexibleAuthor | null
		createdAt: string
		[key: string]: unknown
	}>

	// Passthrough for additional fields
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
	readonly issuePrefix: string  // "#" for GitHub, "" for Linear

	/**
	 * Fetch issue details
	 */
	getIssue(input: GetIssueInput): Promise<IssueResult>

	/**
	 * Fetch pull request details
	 * Note: Only GitHub supports PRs. Linear provider should throw an error.
	 */
	getPR(input: GetPRInput): Promise<PRResult>

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

	/**
	 * Create a new issue
	 */
	createIssue(input: CreateIssueInput): Promise<CreateIssueResult>

	/**
	 * Create a child issue linked to a parent issue
	 * For GitHub: creates issue and links via sub-issue API (two API calls)
	 * For Linear: creates issue atomically with parent relationship
	 */
	createChildIssue(input: CreateChildIssueInput): Promise<CreateIssueResult>

	/**
	 * Create a blocking dependency between two issues
	 * @param input - The blocking and blocked issue identifiers
	 */
	createDependency(input: CreateDependencyInput): Promise<void>

	/**
	 * Get dependencies for an issue
	 * @param input - The issue identifier and direction (blocking, blocked_by, or both)
	 * @returns Dependencies in the requested direction(s)
	 */
	getDependencies(input: GetDependenciesInput): Promise<DependenciesResult>

	/**
	 * Remove a blocking dependency between two issues
	 * @param input - The blocking and blocked issue identifiers
	 */
	removeDependency(input: RemoveDependencyInput): Promise<void>

	/**
	 * Get child issues of a parent issue
	 * @param input - The parent issue identifier
	 * @returns Array of child issues
	 */
	getChildIssues(input: GetChildIssuesInput): Promise<ChildIssueResult[]>

	/**
	 * Close an issue
	 * @param input - The issue identifier and optional repo
	 */
	closeIssue(input: CloseIssueInput): Promise<void>

	/**
	 * Reopen a closed issue
	 * @param input - The issue identifier and optional repo
	 */
	reopenIssue(input: ReopenIssueInput): Promise<void>

	/**
	 * Edit an issue's properties (title, body, state, labels)
	 * @param input - The issue identifier and fields to update
	 */
	editIssue(input: EditIssueInput): Promise<void>
}
