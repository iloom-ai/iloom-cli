// IssueTracker interface definition
// Generic interface for issue tracking providers (GitHub, Linear, Jira, etc.)

import type { Issue, PullRequest, IssueTrackerInputDetection } from '../types/index.js'

/**
 * IssueTracker interface - abstraction for issue tracking providers
 * Follows DatabaseProvider pattern from src/types/index.ts:94-111
 *
 * Design Philosophy:
 * - Core methods are required and work with generic Issue/PullRequest types
 * - PR methods are optional (not all trackers have PR concepts)
 * - Identifiers use string | number to support both GitHub (#123) and Linear (ENG-123)
 * - Providers expose capabilities via boolean flags (supportsPullRequests, etc.)
 */
export interface IssueTracker {
	// Metadata - provider identification and capabilities
	readonly providerName: string
	readonly supportsPullRequests: boolean

	// Input detection - determine type from user input
	detectInputType(input: string, repo?: string): Promise<IssueTrackerInputDetection>

	// Issue operations - core functionality all providers must support
	fetchIssue(identifier: string | number, repo?: string): Promise<Issue>
	isValidIssue(identifier: string | number, repo?: string): Promise<Issue | false>
	validateIssueState(issue: Issue): Promise<void>
	createIssue(
		title: string,
		body: string,
		repository?: string,
		labels?: string[]
	): Promise<{ number: number; url: string }>
	getIssueUrl(identifier: string | number, repo?: string): Promise<string>

	// Pull Request operations - optional, check supportsPullRequests before calling
	fetchPR?(identifier: string | number, repo?: string): Promise<PullRequest>
	isValidPR?(identifier: string | number, repo?: string): Promise<PullRequest | false>
	validatePRState?(pr: PullRequest): Promise<void>

	// Status management - optional, check provider capabilities before calling
	moveIssueToInProgress?(identifier: string | number): Promise<void>

	// Context extraction - formats issue/PR for AI prompts
	extractContext(entity: Issue | PullRequest): string
}
