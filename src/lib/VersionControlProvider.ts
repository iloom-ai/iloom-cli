// VersionControlProvider interface definition
// Generic interface for version control providers (GitHub, BitBucket, GitLab, etc.)

import type { PullRequest } from '../types/index.js'

/**
 * Result of PR creation operation
 */
export interface PRCreationResult {
	url: string
	number: number
	wasExisting: boolean
}

/**
 * Existing PR information
 */
export interface ExistingPR {
	number: number
	url: string
}

/**
 * Represents an inline review comment on a pull request
 */
export interface ReviewComment {
	id: string
	body: string
	path: string
	line: number | null
	side: string | null
	author: { id: string; displayName: string } | null
	createdAt: string
	updatedAt: string | null
	inReplyToId: string | null
}

/**
 * VersionControlProvider interface - abstraction for VCS providers
 * 
 * Design Philosophy:
 * - Focuses exclusively on PR/MR (Pull Request/Merge Request) operations
 * - Separates version control concerns from issue tracking
 * - Identifiers use number for PR numbers (consistent with most VCS systems)
 * - Providers expose capabilities via metadata fields
 */
export interface VersionControlProvider {
	// Metadata - provider identification and capabilities
	readonly providerName: string
	readonly supportsForks: boolean
	readonly supportsDraftPRs: boolean

	// PR operations - core functionality all providers must support
	checkForExistingPR(branchName: string, cwd?: string): Promise<ExistingPR | null>
	createPR(
		branchName: string,
		title: string,
		body: string,
		baseBranch: string,
		cwd?: string
	): Promise<PRCreationResult>
	createDraftPR?(
		branchName: string,
		title: string,
		body: string,
		baseBranch: string,
		cwd?: string
	): Promise<PRCreationResult>
	markPRReadyForReview?(prNumber: number, cwd?: string): Promise<void>
	
	// PR metadata and state
	fetchPR(prNumber: number, cwd?: string): Promise<PullRequest>
	getPRUrl(prNumber: number, cwd?: string): Promise<string>
	
	// PR comments
	createPRComment(prNumber: number, body: string, cwd?: string): Promise<{ id: string; url: string }>
	updatePRComment?(prNumber: number, commentId: string, body: string, cwd?: string): Promise<{ id: string; url: string }>
	getReviewComments?(prNumber: number, cwd?: string): Promise<ReviewComment[]>
	createReviewComment?(prNumber: number, path: string, line: number, body: string, cwd?: string): Promise<{ id: string; url: string }>

	// Remote and repository detection
	detectRepository(cwd?: string): Promise<{ owner: string; repo: string } | null>
	getTargetRemote(cwd?: string): Promise<string>
	
	// PR body generation (optional, can delegate to external service)
	generatePRBody?(issueNumber: string | number | undefined, worktreePath: string): Promise<string>
}
