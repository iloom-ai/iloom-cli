import { execa } from 'execa'
import type {
	GitHubIssue,
	GitHubPullRequest,
	GitHubProject,
	GitHubAuthStatus,
	ProjectItem,
	ProjectField,
} from '../types/github.js'
import { logger } from './logger.js'

// Core GitHub CLI execution wrapper
export async function executeGhCommand<T = unknown>(
	args: string[],
	options?: { cwd?: string; timeout?: number }
): Promise<T> {
	const result = await execa('gh', args, {
		cwd: options?.cwd ?? process.cwd(),
		timeout: options?.timeout ?? 30000,
		encoding: 'utf8',
	})

	// Parse JSON output if --json flag, --format json, --jq, or GraphQL was used
	const isJson =
		args.includes('--json') ||
		args.includes('--jq') ||
		(args.includes('--format') && args[args.indexOf('--format') + 1] === 'json') ||
		(args[0] === 'api' && args[1] === 'graphql')
	const data = isJson ? JSON.parse(result.stdout) : result.stdout

	return data as T
}

// Authentication checking
export async function checkGhAuth(): Promise<GitHubAuthStatus> {
	try {
		const output = await executeGhCommand<string>(['auth', 'status'])

		// Parse auth status output - handle both old and new formats
		// Old format: "Logged in to github.com as username"
		// New format: "✓ Logged in to github.com account username (keyring)"

		// Split output into lines to find the active account
		const lines = output.split('\n')
		let username: string | undefined
		let scopes: string[] = []

		// Find the active account (look for "Active account: true" or first account if none marked)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]

			// Match new format: "✓ Logged in to github.com account username"
			const newFormatMatch = line?.match(/Logged in to github\.com account ([^\s(]+)/)
			if (newFormatMatch) {
				const accountName = newFormatMatch[1]

				// Check if this is the active account
				const nextFewLines = lines.slice(i + 1, i + 5).join('\n')
				const isActive = nextFewLines.includes('Active account: true')

				// If this is the active account, or we haven't found one yet and there's no "Active account" marker
				if (isActive || (!username && !output.includes('Active account:'))) {
					username = accountName

					// Find scopes for this account
					const scopeMatch = nextFewLines.match(/Token scopes: (.+)/)
					if (scopeMatch?.[1]) {
						scopes = scopeMatch[1].split(', ').map(scope => scope.replace(/^'|'$/g, ''))
					}

					// If this is the active account, we're done
					if (isActive) break
				}
			}

			// Fallback: match old format
			if (!username) {
				const oldFormatMatch = line?.match(/Logged in to github\.com as ([^\s]+)/)
				if (oldFormatMatch) {
					username = oldFormatMatch[1]
				}
			}
		}

		// If scopes not yet extracted, try the old "Token scopes" format
		if (scopes.length === 0) {
			const scopeMatch = output.match(/Token scopes: (.+)/)
			scopes = scopeMatch?.[1]?.split(', ').map(scope => scope.replace(/^'|'$/g, '')) ?? []
		}

		return {
			hasAuth: true,
			scopes,
			...(username && { username }),
		}
	} catch (error) {
		// Only return "no auth" for specific authentication errors
		if (error instanceof Error && 'stderr' in error && (error as {stderr?: string}).stderr?.includes('You are not logged into any GitHub hosts')) {
			return { hasAuth: false, scopes: [] }
		}
		// Re-throw unexpected errors
		throw error
	}
}

export async function hasProjectScope(): Promise<boolean> {
	const auth = await checkGhAuth()
	return auth.scopes.includes('project')
}

// Issue fetching
export async function fetchGhIssue(
	issueNumber: number,
	repo?: string
): Promise<GitHubIssue> {
	logger.debug('Fetching GitHub issue', { issueNumber, repo })

	const args = [
		'issue',
		'view',
		String(issueNumber),
		'--json',
		'number,title,body,state,labels,assignees,url,createdAt,updatedAt',
	]

	if (repo) {
		args.push('--repo', repo)
	}

	return executeGhCommand<GitHubIssue>(args)
}

// PR fetching
export async function fetchGhPR(
	prNumber: number,
	repo?: string
): Promise<GitHubPullRequest> {
	logger.debug('Fetching GitHub PR', { prNumber, repo })

	const args = [
		'pr',
		'view',
		String(prNumber),
		'--json',
		'number,title,body,state,headRefName,baseRefName,url,isDraft,isCrossRepository,mergeable,createdAt,updatedAt',
	]

	if (repo) {
		args.push('--repo', repo)
	}

	return executeGhCommand<GitHubPullRequest>(args)
}

// Project operations
export async function fetchProjectList(
	owner: string
): Promise<GitHubProject[]> {
	const result = await executeGhCommand<{ projects: GitHubProject[] }>([
		'project',
		'list',
		'--owner',
		owner,
		'--limit',
		'100',
		'--format',
		'json',
	])

	return result?.projects ?? []
}

export async function fetchProjectItems(
	projectNumber: number,
	owner: string
): Promise<ProjectItem[]> {
	const result = await executeGhCommand<{ items: ProjectItem[] }>([
		'project',
		'item-list',
		String(projectNumber),
		'--owner',
		owner,
		'--limit',
		'10000',
		'--format',
		'json',
	])

	return result?.items ?? []
}

export async function fetchProjectFields(
	projectNumber: number,
	owner: string
): Promise<{ fields: ProjectField[] }> {
	const result = await executeGhCommand<{ fields: ProjectField[] }>([
		'project',
		'field-list',
		String(projectNumber),
		'--owner',
		owner,
		'--format',
		'json',
	])

	return result ?? { fields: [] }
}

export async function updateProjectItemField(
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string
): Promise<void> {
	await executeGhCommand([
		'project',
		'item-edit',
		'--id',
		itemId,
		'--project-id',
		projectId,
		'--field-id',
		fieldId,
		'--single-select-option-id',
		optionId,
		'--format',
		'json',
	])
}

// GitHub Issue Operations

interface IssueCreateResponse {
	number: string | number
	url: string
}

/**
 * Create a new GitHub issue
 * @param title - The issue title
 * @param body - The issue body (markdown supported)
 * @param options - Optional configuration
 * @param options.repo - Repository in format "owner/repo" (uses current repo if not provided)
 * @param options.labels - Array of label names to add to the issue
 * @returns Issue metadata including number and URL
 */
export async function createIssue(
	title: string,
	body: string,
	options?: { repo?: string | undefined; labels?: string[] | undefined }
): Promise<IssueCreateResponse> {
	const { repo, labels } = options ?? {}

	logger.debug('Creating GitHub issue', { title, repo, labels })

	const args = [
		'issue',
		'create',
		'--title',
		title,
		'--body',
		body,
	]

	// Add repo if provided
	if (repo) {
		args.splice(2, 0, '--repo', repo)
	}

	// Add labels if provided
	if (labels && labels.length > 0) {
		args.push('--label', labels.join(','))
	}

	const execaOptions: { timeout: number; encoding: 'utf8'; cwd?: string } = {
		timeout: 30000,
		encoding: 'utf8',
	}

	if (!repo) {
		execaOptions.cwd = process.cwd()
	}

	const result = await execa('gh', args, execaOptions)

	// Parse the URL from the output (format: "https://github.com/owner/repo/issues/123")
	const urlMatch = result.stdout.trim().match(/https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/)
	if (!urlMatch?.[1]) {
		throw new Error(`Failed to parse issue URL from gh output: ${result.stdout}`)
	}

	const issueNumber = parseInt(urlMatch[1], 10)
	const issueUrl = urlMatch[0]

	return {
		number: issueNumber,
		url: issueUrl,
	}
}

/**
 * @deprecated Use createIssue with options.repo instead
 * Create a new GitHub issue in a specific repository
 * @param title - Issue title
 * @param body - Issue body (markdown)
 * @param repository - Repository in format "owner/repo"
 * @param labels - Optional array of label names to add to the issue
 * @returns Issue number and URL
 */
export async function createIssueInRepo(
	title: string,
	body: string,
	repository: string,
	labels?: string[]
): Promise<IssueCreateResponse> {
	return createIssue(title, body, { repo: repository, labels })
}

// GitHub Comment Operations

interface CommentResponse {
	id: number
	url: string
	created_at?: string
	updated_at?: string
}

interface RepoInfo {
	owner: string
	name: string
}

/**
 * Create a comment on a GitHub issue
 * @param issueNumber - The issue number
 * @param body - The comment body (markdown supported)
 * @param repo - Optional repo in "owner/repo" format
 * @returns Comment metadata including ID and URL
 */
export async function createIssueComment(
	issueNumber: number,
	body: string,
	repo?: string
): Promise<CommentResponse> {
	logger.debug('Creating issue comment', { issueNumber, repo })

	const apiPath = repo
		? `repos/${repo}/issues/${issueNumber}/comments`
		: `repos/:owner/:repo/issues/${issueNumber}/comments`

	return executeGhCommand<CommentResponse>([
		'api',
		apiPath,
		'-f',
		`body=${body}`,
		'--jq',
		'{id: .id, url: .html_url, created_at: .created_at}',
	])
}

/**
 * Update an existing GitHub comment
 * @param commentId - The comment ID
 * @param body - The updated comment body (markdown supported)
 * @param repo - Optional repo in "owner/repo" format
 * @returns Updated comment metadata
 */
export async function updateIssueComment(
	commentId: number,
	body: string,
	repo?: string
): Promise<CommentResponse> {
	logger.debug('Updating issue comment', { commentId, repo })

	const apiPath = repo
		? `repos/${repo}/issues/comments/${commentId}`
		: `repos/:owner/:repo/issues/comments/${commentId}`

	return executeGhCommand<CommentResponse>([
		'api',
		apiPath,
		'-X',
		'PATCH',
		'-f',
		`body=${body}`,
		'--jq',
		'{id: .id, url: .html_url, updated_at: .updated_at}',
	])
}

/**
 * Create a comment on a GitHub pull request
 * Note: PR comments use the same endpoint as issue comments
 * @param prNumber - The PR number
 * @param body - The comment body (markdown supported)
 * @param repo - Optional repo in "owner/repo" format
 * @returns Comment metadata including ID and URL
 */
export async function createPRComment(
	prNumber: number,
	body: string,
	repo?: string
): Promise<CommentResponse> {
	logger.debug('Creating PR comment', { prNumber, repo })

	const apiPath = repo
		? `repos/${repo}/issues/${prNumber}/comments`
		: `repos/:owner/:repo/issues/${prNumber}/comments`

	// PR comments use the issues endpoint
	return executeGhCommand<CommentResponse>([
		'api',
		apiPath,
		'-f',
		`body=${body}`,
		'--jq',
		'{id: .id, url: .html_url, created_at: .created_at}',
	])
}

/**
 * Get repository owner and name from current directory
 * @returns Repository owner and name
 */
export async function getRepoInfo(): Promise<RepoInfo> {
	logger.debug('Fetching repository info')

	const result = await executeGhCommand<{ owner: { login: string }; name: string }>([
		'repo',
		'view',
		'--json',
		'owner,name',
	])

	return {
		owner: result.owner.login,
		name: result.name,
	}
}

// GitHub Sub-Issue Operations

/**
 * Get the GraphQL node ID for a GitHub issue
 * Required for sub-issue API which uses node IDs, not issue numbers
 * @param issueNumber - The issue number
 * @param repo - Optional repo in "owner/repo" format
 * @returns GraphQL node ID (e.g., "I_kwDOPvp_cc7...")
 */
export async function getIssueNodeId(
	issueNumber: number,
	repo?: string
): Promise<string> {
	logger.debug('Fetching GitHub issue node ID', { issueNumber, repo })

	const args = ['issue', 'view', String(issueNumber), '--json', 'id']
	if (repo) {
		args.push('--repo', repo)
	}

	const result = await executeGhCommand<{ id: string }>(args)
	return result.id
}

/**
 * Link a child issue to a parent issue using GitHub's sub-issue API
 * Requires GraphQL-Features: sub_issues header
 * @param parentNodeId - GraphQL node ID of the parent issue
 * @param childNodeId - GraphQL node ID of the child issue
 */
export async function addSubIssue(
	parentNodeId: string,
	childNodeId: string
): Promise<void> {
	logger.debug('Linking child issue to parent', { parentNodeId, childNodeId })

	const mutation = `
		mutation addSubIssue($parentId: ID!, $subIssueId: ID!) {
			addSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
				issue { id }
				subIssue { id }
			}
		}
	`

	await executeGhCommand([
		'api', 'graphql',
		'-H', 'GraphQL-Features: sub_issues',
		'-f', `query=${mutation}`,
		'-F', `parentId=${parentNodeId}`,
		'-F', `subIssueId=${childNodeId}`,
	])
}

/**
 * Get sub-issues (children) of a parent GitHub issue
 * Uses GraphQL to query the sub-issue relationship
 * @param issueNumber - The parent issue number
 * @param repo - Optional repo in "owner/repo" format
 * @returns Array of child issues with id, title, url, and state
 */
export async function getSubIssues(
	issueNumber: number,
	repo?: string
): Promise<Array<{ id: string; title: string; url: string; state: string }>> {
	logger.debug('Fetching GitHub sub-issues', { issueNumber, repo })

	// Get the node ID for the parent issue
	const parentNodeId = await getIssueNodeId(issueNumber, repo)

	// Query sub-issues using GraphQL
	const query = `
		query getSubIssues($parentId: ID!) {
			node(id: $parentId) {
				... on Issue {
					subIssues(first: 100) {
						nodes {
							number
							title
							url
							state
						}
					}
				}
			}
		}
	`

	interface SubIssueNode {
		number: number
		title: string
		url: string
		state: string
	}

	interface SubIssuesResponse {
		data: {
			node: {
				subIssues: {
					nodes: SubIssueNode[]
				}
			} | null
		}
	}

	try {
		const result = await executeGhCommand<SubIssuesResponse>([
			'api', 'graphql',
			'-H', 'GraphQL-Features: sub_issues',
			'-f', `query=${query}`,
			'-F', `parentId=${parentNodeId}`,
		])

		const subIssues = result.data.node?.subIssues?.nodes ?? []

		return subIssues.map(issue => ({
			id: String(issue.number),
			title: issue.title,
			url: issue.url,
			state: issue.state.toLowerCase(),
		}))
	} catch (error) {
		// Return empty array if sub-issues feature is not available or no children
		if (error instanceof Error) {
			const errorMessage = error.message
			const stderr = 'stderr' in error ? (error as { stderr?: string }).stderr ?? '' : ''
			const combinedError = `${errorMessage} ${stderr}`

			// Check for feature not available or empty result
			if (combinedError.includes('sub_issues') || combinedError.includes('null')) {
				return []
			}
		}
		throw error
	}
}

// GitHub Issue Dependency Operations

/**
 * GitHub dependency result from API
 */
interface GitHubDependency {
	id: number
	number: number
	title: string
	state: string
	html_url: string
}

/**
 * Get the internal database ID for a GitHub issue
 * Required for dependency API which uses database IDs, not node IDs
 * @param issueNumber - The issue number
 * @param repo - Optional repo in "owner/repo" format
 * @returns Internal GitHub issue database ID
 */
export async function getIssueDatabaseId(
	issueNumber: number,
	repo?: string
): Promise<number> {
	logger.debug('Fetching GitHub issue database ID', { issueNumber, repo })

	const apiPath = repo
		? `repos/${repo}/issues/${issueNumber}`
		: `repos/:owner/:repo/issues/${issueNumber}`

	const result = await executeGhCommand<{ id: number }>([
		'api',
		apiPath,
		'--jq',
		'{id: .id}',
	])

	return result.id
}

/**
 * Get dependencies for a GitHub issue
 * Uses GitHub's issue dependencies API
 * @param issueNumber - The issue number
 * @param direction - 'blocking' for issues this blocks, 'blocked_by' for issues blocking this
 * @param repo - Optional repo in "owner/repo" format
 * @returns Array of dependency objects with id, title, url, state
 */
export async function getIssueDependencies(
	issueNumber: number,
	direction: 'blocking' | 'blocked_by',
	repo?: string
): Promise<Array<{ id: string; databaseId: number; title: string; url: string; state: string }>> {
	logger.debug('Fetching GitHub issue dependencies', { issueNumber, direction, repo })

	// Use the dependencies API with the appropriate direction endpoint
	const apiPath = repo
		? `repos/${repo}/issues/${issueNumber}/dependencies/${direction}`
		: `repos/:owner/:repo/issues/${issueNumber}/dependencies/${direction}`

	try {
		const result = await executeGhCommand<GitHubDependency[]>([
			'api',
			'-H', 'Accept: application/vnd.github+json',
			'-H', 'X-GitHub-Api-Version: 2022-11-28',
			'--jq', '.',
			apiPath,
		])

		return (result ?? []).map(dep => ({
			id: String(dep.number),
			databaseId: dep.id,
			title: dep.title,
			url: dep.html_url,
			state: dep.state,
		}))
	} catch (error) {
		// Return empty array for 404 on the dependencies endpoint
		// This indicates the issue exists but has no dependencies configured
		if (error instanceof Error) {
			const errorMessage = error.message
			const stderr = 'stderr' in error ? (error as { stderr?: string }).stderr ?? '' : ''
			const combinedError = `${errorMessage} ${stderr}`

			// Check for 404 specifically on dependencies endpoint
			if (combinedError.includes('404') && combinedError.includes('dependencies')) {
				return []
			}
		}
		throw error
	}
}

/**
 * Create a dependency between two issues (A blocks B)
 * Uses GitHub's issue dependencies API
 * @param blockedIssueNumber - The issue number that is blocked
 * @param blockingIssueDatabaseId - The database ID of the issue that blocks
 * @param repo - Optional repo in "owner/repo" format
 * @throws Error with specific message for: dependency already exists, issue not found, or dependencies feature not enabled
 */
export async function createIssueDependency(
	blockedIssueNumber: number,
	blockingIssueDatabaseId: number,
	repo?: string
): Promise<void> {
	logger.debug('Creating GitHub issue dependency', { blockedIssueNumber, blockingIssueDatabaseId, repo })

	// POST to the blocked issue's blocked_by endpoint with the blocking issue's database ID
	const apiPath = repo
		? `repos/${repo}/issues/${blockedIssueNumber}/dependencies/blocked_by`
		: `repos/:owner/:repo/issues/${blockedIssueNumber}/dependencies/blocked_by`

	try {
		await executeGhCommand([
			'api',
			'-X', 'POST',
			'-H', 'Accept: application/vnd.github+json',
			'-H', 'X-GitHub-Api-Version: 2022-11-28',
			apiPath,
			'-F', `issue_id=${blockingIssueDatabaseId}`,
		])
	} catch (error) {
		if (error instanceof Error) {
			const errorMessage = error.message
			const stderr = 'stderr' in error ? (error as { stderr?: string }).stderr ?? '' : ''
			const combinedError = `${errorMessage} ${stderr}`

			// Check for dependency already exists (422 Unprocessable Entity)
			if (combinedError.includes('422') || combinedError.includes('already exists') || combinedError.includes('Unprocessable Entity')) {
				throw new Error(`Dependency already exists: issue #${blockedIssueNumber} is already blocked by the specified issue`)
			}

			// Check for issue not found (404)
			if (combinedError.includes('404') || combinedError.includes('Not Found')) {
				throw new Error(`Issue not found: unable to create dependency for issue #${blockedIssueNumber}. The issue may not exist or you may not have access to it.`)
			}

			// Check for dependencies feature not enabled (403 or specific error message)
			if (combinedError.includes('403') || combinedError.includes('Forbidden') || combinedError.includes('not enabled')) {
				throw new Error(`Dependencies feature not enabled: the repository may not have issue dependencies enabled. This feature requires GitHub Enterprise or specific repository settings.`)
			}
		}

		// Re-throw the original error if it doesn't match any known patterns
		throw error
	}
}

/**
 * Remove a dependency between two issues (A blocks B)
 * Uses GitHub's issue dependencies API
 * @param blockedIssueNumber - The issue number that is blocked
 * @param blockingIssueDatabaseId - The database ID of the issue that blocks
 * @param repo - Optional repo in "owner/repo" format
 */
export async function removeIssueDependency(
	blockedIssueNumber: number,
	blockingIssueDatabaseId: number,
	repo?: string
): Promise<void> {
	logger.debug('Removing GitHub issue dependency', { blockedIssueNumber, blockingIssueDatabaseId, repo })

	// DELETE from the blocked issue's blocked_by endpoint with the blocking issue's database ID
	const apiPath = repo
		? `repos/${repo}/issues/${blockedIssueNumber}/dependencies/blocked_by/${blockingIssueDatabaseId}`
		: `repos/:owner/:repo/issues/${blockedIssueNumber}/dependencies/blocked_by/${blockingIssueDatabaseId}`

	await executeGhCommand([
		'api',
		'-X', 'DELETE',
		'-H', 'Accept: application/vnd.github+json',
		'-H', 'X-GitHub-Api-Version: 2022-11-28',
		apiPath,
	])
}

// Issue State Operations

/**
 * Close a GitHub issue
 * @param issueNumber - The issue number
 * @param repo - Optional repo in "owner/repo" format
 */
export async function closeGhIssue(
	issueNumber: number,
	repo?: string
): Promise<void> {
	logger.debug('Closing GitHub issue', { issueNumber, repo })

	const args = ['issue', 'close', String(issueNumber)]
	if (repo) {
		args.push('--repo', repo)
	}

	await executeGhCommand(args)
}

/**
 * Reopen a GitHub issue
 * @param issueNumber - The issue number
 * @param repo - Optional repo in "owner/repo" format
 */
export async function reopenGhIssue(
	issueNumber: number,
	repo?: string
): Promise<void> {
	logger.debug('Reopening GitHub issue', { issueNumber, repo })

	const args = ['issue', 'reopen', String(issueNumber)]
	if (repo) {
		args.push('--repo', repo)
	}

	await executeGhCommand(args)
}

/**
 * Edit a GitHub issue's properties
 * @param issueNumber - The issue number
 * @param options - Fields to update
 * @param options.title - New issue title
 * @param options.body - New issue body
 * @param options.labels - Labels to add to the issue
 * @param repo - Optional repo in "owner/repo" format
 */
export async function editGhIssue(
	issueNumber: number,
	options: { title?: string; body?: string; labels?: string[] },
	repo?: string
): Promise<void> {
	logger.debug('Editing GitHub issue', { issueNumber, options, repo })

	const args = ['issue', 'edit', String(issueNumber)]

	if (options.title !== undefined) {
		args.push('--title', options.title)
	}
	if (options.body !== undefined) {
		args.push('--body', options.body)
	}
	if (options.labels) {
		// Use --add-label for each label. gh issue edit replaces with comma-separated --add-label
		if (options.labels.length > 0) {
			args.push('--add-label', options.labels.join(','))
		}
	}
	if (repo) {
		args.push('--repo', repo)
	}

	await executeGhCommand(args)
}

// Issue List Operations (for il issues command)

export interface GitHubIssueListItem {
	id: string
	title: string
	updatedAt: string
	url: string
	state: string
}

/**
 * Fetch a list of open GitHub issues sorted by recently updated
 * @param options - Fetch options
 * @param options.limit - Maximum number of issues to return (default: 100)
 * @param options.cwd - Working directory for gh CLI (default: process.cwd())
 * @returns Array of issues
 */
export async function fetchGitHubIssueList(
	options?: { limit?: number; cwd?: string; mine?: boolean }
): Promise<GitHubIssueListItem[]> {
	const limit = options?.limit ?? 100

	logger.debug('Fetching GitHub issue list', { limit, cwd: options?.cwd, mine: options?.mine })

	const args = [
		'issue',
		'list',
		'--state', 'open',
		'--json', 'number,title,updatedAt,url,state',
		'--limit', String(limit),
		'--search', 'sort:updated-desc',
	]

	if (options?.mine) {
		args.push('--assignee', '@me')
	}

	const result = await executeGhCommand<Array<{
		number: number
		title: string
		updatedAt: string
		url: string
		state: string
	}>>(args, options?.cwd ? { cwd: options.cwd } : undefined)

	return (result ?? []).map(item => ({
		id: String(item.number),
		title: item.title,
		updatedAt: item.updatedAt,
		url: item.url,
		state: item.state.toLowerCase(),
	}))
}

/**
 * Fetch a list of open, non-draft GitHub PRs sorted by recently updated
 * @param options - Fetch options
 * @param options.limit - Maximum number of PRs to return (default: 100)
 * @param options.cwd - Working directory for gh CLI (default: process.cwd())
 * @returns Array of PRs mapped to GitHubIssueListItem (with [PR] title prefix)
 */
export async function fetchGitHubPRList(
	options?: { limit?: number; cwd?: string; mine?: boolean }
): Promise<GitHubIssueListItem[]> {
	const limit = options?.limit ?? 100
	// Over-fetch to account for draft PRs that will be filtered out client-side
	// gh pr list has no --draft=false flag
	const fetchLimit = Math.max(limit * 2, 50)

	logger.debug('Fetching GitHub PR list', { limit, fetchLimit, cwd: options?.cwd, mine: options?.mine })

	const args = [
		'pr', 'list',
		'--state', 'open',
		'--json', 'number,title,updatedAt,url,state,isDraft',
		'--limit', String(fetchLimit),
	]

	if (options?.mine) {
		args.push('--assignee', '@me')
	}

	const result = await executeGhCommand<Array<{
		number: number
		title: string
		updatedAt: string
		url: string
		state: string
		isDraft: boolean
	}>>(args, options?.cwd ? { cwd: options.cwd } : undefined)

	return (result ?? [])
		.filter(item => !item.isDraft)
		.slice(0, limit)
		.map(item => ({
			id: String(item.number),
			title: `[PR] ${item.title}`,
			updatedAt: item.updatedAt,
			url: item.url,
			state: item.state.toLowerCase(),
		}))
}
