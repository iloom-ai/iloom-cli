// Core GitHub response types
export interface GitHubIssue {
	number: number
	title: string
	body: string
	state: 'OPEN' | 'CLOSED' // GitHub GraphQL format
	labels: { name: string }[]
	assignees: { login: string }[]
	url: string
	createdAt: string
	updatedAt: string
}

// Pull Request types
export interface GitHubPullRequest {
	number: number
	title: string
	body: string
	state: 'OPEN' | 'CLOSED' | 'MERGED'
	headRefName: string // source branch
	baseRefName: string // target branch
	url: string
	isDraft: boolean
	mergeable: 'CONFLICTING' | 'MERGEABLE' | 'UNKNOWN'
	createdAt: string
	updatedAt: string
}

// GitHub Projects types
export interface GitHubProject {
	number: number
	id: string
	name: string
	fields: ProjectField[]
}

export interface ProjectField {
	id: string
	name: string
	dataType: 'SINGLE_SELECT' | 'TEXT' | 'NUMBER' | 'DATE'
	options?: ProjectFieldOption[]
}

export interface ProjectFieldOption {
	id: string
	name: string
}

export interface ProjectItem {
	id: string
	content: {
		type: 'Issue' | 'PullRequest' | 'DraftIssue'
		number: number
	}
	fieldValues: Record<string, unknown>
}

// Command result types
export interface GitHubCommandResult<T = unknown> {
	success: boolean
	data?: T
	error?: string
	rateLimitRemaining?: number
	rateLimitReset?: Date
}

export interface GitHubAuthStatus {
	hasAuth: boolean
	scopes: string[]
	username?: string
}

// Input detection types
export interface GitHubInputDetection {
	type: 'issue' | 'pr' | 'unknown'
	number: number | null
	rawInput: string
}

// Context and error types
export interface GitHubContext {
	issue?: GitHubIssue
	pullRequest?: GitHubPullRequest
	formattedContext: string
}

export enum GitHubErrorCode {
	NOT_FOUND = 'NOT_FOUND',
	UNAUTHORIZED = 'UNAUTHORIZED',
	RATE_LIMITED = 'RATE_LIMITED',
	NETWORK_ERROR = 'NETWORK_ERROR',
	INVALID_STATE = 'INVALID_STATE',
	MISSING_SCOPE = 'MISSING_SCOPE',
}

export class GitHubError extends Error {
	constructor(
		public code: GitHubErrorCode,
		message: string,
		public details?: unknown
	) {
		super(message)
		this.name = 'GitHubError'
	}
}
