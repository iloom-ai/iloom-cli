/**
 * Issue Management MCP Server
 *
 * A Model Context Protocol server that enables Claude to interact with issue trackers
 * (GitHub, Linear, etc.) during workflows. Provides tools for fetching issues, reading
 * comments, and creating/updating comments.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { IssueManagementProviderFactory } from './IssueManagementProviderFactory.js'
import { JiraWikiSanitizer } from '../utils/jira-wiki-sanitizer.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import { VCSProviderFactory } from '../lib/VCSProviderFactory.js'
import type { VersionControlProvider } from '../lib/VersionControlProvider.js'
import type {
	IssueProvider,
	GetIssueInput,
	GetPRInput,
	GetCommentInput,
	CreateCommentInput,
	UpdateCommentInput,
	CreateIssueInput,
	CreateChildIssueInput,
	CreateDependencyInput,
	GetDependenciesInput,
	GetChildIssuesInput,
	RemoveDependencyInput,
	CloseIssueInput,
	ReopenIssueInput,
	EditIssueInput,
	GetReviewCommentsInput,
} from './types.js'

// Module-level settings loaded at startup
let settings: IloomSettings | undefined

// Module-level VCS provider (non-null when BitBucket or other non-GitHub VCS is configured)
let vcsProvider: VersionControlProvider | null = null

// Validate required environment variables
function validateEnvironment(): IssueProvider {
	const provider = process.env.ISSUE_PROVIDER as IssueProvider | undefined
	if (!provider) {
		console.error('Missing required environment variable: ISSUE_PROVIDER')
		process.exit(1)
	}

	if (provider !== 'github' && provider !== 'linear' && provider !== 'jira') {
		console.error(`Invalid ISSUE_PROVIDER: ${provider}. Must be 'github', 'linear', or 'jira'`)
		process.exit(1)
	}

	// GitHub-specific validation
	if (provider === 'github') {
		const required = ['REPO_OWNER', 'REPO_NAME']
		const missing = required.filter((key) => !process.env[key])

		if (missing.length > 0) {
			console.error(
				`Missing required environment variables for GitHub provider: ${missing.join(', ')}`
			)
			process.exit(1)
		}
	}

	// Linear requires API token for SDK authentication
	if (provider === 'linear') {
		if (!process.env.LINEAR_API_TOKEN) {
			console.error('Missing required environment variable for Linear provider: LINEAR_API_TOKEN')
			process.exit(1)
		}
	}

	// Jira requires host, username, API token, and project key
	if (provider === 'jira') {
		const required = ['JIRA_HOST', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']
		const missing = required.filter((key) => !process.env[key])

		if (missing.length > 0) {
			console.error(
				`Missing required environment variables for Jira provider: ${missing.join(', ')}`
			)
			process.exit(1)
		}
	}

	return provider
}

// Initialize the MCP server
const server = new McpServer({
	name: 'issue-management-broker',
	version: '0.1.0',
})

// Define flexible author schema
const flexibleAuthorSchema = z.object({
	id: z.string(),
	displayName: z.string(),
}).passthrough()

// Register get_issue tool
server.registerTool(
	'get_issue',
	{
		title: 'Get Issue',
		description:
			'Fetch issue details including body, title, comments, labels, assignees, and other metadata. ' +
			'Author fields vary by provider: GitHub uses { login }, Linear uses { name, displayName }, Jira uses { displayName, accountId }. ' +
			'All authors have normalized core fields: { id, displayName } plus provider-specific fields.',
		inputSchema: {
			number: z.string().describe('The issue identifier'),
			includeComments: z
				.boolean()
				.optional()
				.describe('Whether to include comments (default: true)'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			// Core validated fields
			id: z.string().describe('Issue identifier'),
			title: z.string().describe('Issue title'),
			body: z.string().describe('Issue body/description'),
			state: z.string().describe('Issue state (open, closed, etc.)'),
			url: z.string().describe('Issue URL'),
			provider: z.enum(['github', 'linear', 'jira']).describe('Issue management provider'),

			// Flexible author - core fields + passthrough
			author: flexibleAuthorSchema.nullable().describe(
				'Issue author with normalized { id, displayName } plus provider-specific fields'
			),

			// Optional flexible arrays
			assignees: z.array(flexibleAuthorSchema).optional().describe(
				'Issue assignees with normalized { id, displayName } plus provider-specific fields'
			),
			labels: z.array(
				z.object({ name: z.string() }).passthrough()
			).optional().describe('Issue labels'),

			// Comments with flexible author
			comments: z.array(
				z.object({
					id: z.string(),
					body: z.string(),
					author: flexibleAuthorSchema.nullable(),
					createdAt: z.string(),
				}).passthrough()
			).optional().describe('Issue comments with flexible author structure'),
		},
	},
	async ({ number, includeComments, repo }: GetIssueInput) => {
		console.error(`Fetching issue ${number}${repo ? ` from ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			const result = await provider.getIssue({ number, includeComments, repo })

			console.error(`Issue fetched successfully: ${result.number} - ${result.title}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to fetch issue: ${errorMessage}`)
			throw new Error(`Failed to fetch issue: ${errorMessage}`)
		}
	}
)

// Import GitHubIssueManagementProvider for GitHub fallback on PR tools
import { GitHubIssueManagementProvider } from './GitHubIssueManagementProvider.js'

// Register get_pr tool
server.registerTool(
	'get_pr',
	{
		title: 'Get Pull Request',
		description:
			'Fetch pull request details including title, body, comments, files, commits, and branch information. ' +
			'Uses the configured VCS provider (GitHub or BitBucket). Falls back to GitHub when no VCS provider is configured. ' +
			'Author fields have normalized core fields: { id, displayName } plus provider-specific fields.',
		inputSchema: {
			number: z.string().describe('The PR number'),
			includeComments: z
				.boolean()
				.optional()
				.describe('Whether to include comments (default: true)'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository.'
				),
		},
		outputSchema: {
			// Core validated fields
			id: z.string().describe('PR identifier'),
			number: z.number().describe('PR number'),
			title: z.string().describe('PR title'),
			body: z.string().describe('PR body/description'),
			state: z.string().describe('PR state (OPEN, CLOSED, MERGED)'),
			url: z.string().describe('PR URL'),

			// Branch info
			headRefName: z.string().describe('Source branch name'),
			baseRefName: z.string().describe('Target branch name'),

			// Flexible author - core fields + passthrough
			author: flexibleAuthorSchema.nullable().describe(
				'PR author with normalized { id, displayName } plus provider-specific fields'
			),

			// Optional flexible arrays
			files: z.array(
				z.object({
					path: z.string(),
					additions: z.number(),
					deletions: z.number(),
				}).passthrough()
			).optional().describe('Changed files in the PR'),
			commits: z.array(
				z.object({
					oid: z.string(),
					messageHeadline: z.string(),
					author: flexibleAuthorSchema.nullable(),
				}).passthrough()
			).optional().describe('Commits in the PR'),
			comments: z.array(
				z.object({
					id: z.string(),
					body: z.string(),
					author: flexibleAuthorSchema.nullable(),
					createdAt: z.string(),
				}).passthrough()
			).optional().describe('PR comments'),
		},
	},
	async ({ number, includeComments, repo }: GetPRInput) => {
		console.error(`Fetching PR ${number}${repo ? ` from ${repo}` : ''}`)

		try {
			// Use VCS provider when available (e.g., BitBucket), fall back to GitHub
			if (vcsProvider) {
				if (repo) {
					console.error(`VCS provider path does not support 'repo' override parameter, using configured repository`)
				}
				// Note: includeComments is not passed to vcsProvider.fetchPR() because
				// BitBucket's fetchPR API does not support filtering comments separately.
				// Comments are not included in the VCS provider response.
				const pr = await vcsProvider.fetchPR(parseInt(number, 10))
				// Note: author, files, commits, and comments are not available in the
				// VCS provider path. BitBucket's fetchPR returns core PR metadata only.
				const result = {
					id: String(pr.number),
					number: pr.number,
					title: pr.title,
					body: pr.body,
					state: pr.state.toUpperCase(),
					url: pr.url,
					headRefName: pr.branch,
					baseRefName: pr.baseBranch,
					author: null as null,
					isDraft: pr.isDraft,
				}

				console.error(`PR fetched successfully: #${result.number} - ${result.title}`)

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(result),
						},
					],
					structuredContent: result as unknown as { [x: string]: unknown },
				}
			}

			// Fall back to GitHub provider
			const provider = new GitHubIssueManagementProvider()
			const result = await provider.getPR({ number, includeComments, repo })

			console.error(`PR fetched successfully: #${result.number} - ${result.title}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to fetch PR: ${errorMessage}`)
			throw new Error(`Failed to fetch PR: ${errorMessage}`)
		}
	}
)

// Register get_review_comments tool
server.registerTool(
	'get_review_comments',
	{
		title: 'Get PR Review Comments',
		description:
			'Fetch inline code review comments on a pull request (comments on specific files and lines). ' +
			'Returns comments with file path, line number, diff side, author, and reply threading. ' +
			'Uses the configured VCS provider when available, falls back to GitHub.',
		inputSchema: {
			number: z.string().describe('The PR number'),
			reviewId: z
				.string()
				.optional()
				.describe('Optional review ID to filter comments by a specific review'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository.'
				),
		},
		outputSchema: {
			comments: z.array(
				z.object({
					id: z.string().describe('Review comment ID'),
					body: z.string().describe('Comment body content'),
					path: z.string().describe('File path the comment is on'),
					line: z.number().nullable().describe('Line number in the diff'),
					side: z.string().nullable().describe('Side of the diff (LEFT or RIGHT)'),
					author: flexibleAuthorSchema.nullable().describe('Comment author'),
					createdAt: z.string().describe('Comment creation timestamp'),
					updatedAt: z.string().nullable().describe('Comment last updated timestamp'),
					inReplyToId: z.string().nullable().describe('ID of the comment this replies to'),
					pullRequestReviewId: z.number().nullable().describe('The review this comment belongs to'),
				})
			).describe('Inline review comments on the PR'),
		},
	},
	async ({ number, reviewId, repo }: GetReviewCommentsInput) => {
		console.error(`Fetching review comments for PR ${number}${reviewId ? ` (review ${reviewId})` : ''}${repo ? ` from ${repo}` : ''}`)

		try {
			// Use VCS provider when available and it supports review comments
			if (vcsProvider?.getReviewComments) {
				if (repo) {
					console.error(`VCS provider path does not support 'repo' override parameter, using configured repository`)
				}
				// Note: reviewId filtering is not supported for the VCS provider path.
				// BitBucket does not have a concept of "reviews" grouping inline comments.
				// All inline comments are returned regardless of reviewId parameter.
				if (reviewId) {
					console.error(`VCS provider path does not support 'reviewId' filter, returning all inline comments`)
				}
				const reviewComments = await vcsProvider.getReviewComments(parseInt(number, 10))

				// Map ReviewComment[] to output shape (add pullRequestReviewId: null for non-GitHub providers)
				const comments = reviewComments.map(c => ({
					...c,
					pullRequestReviewId: null,
				}))

				console.error(`Review comments fetched successfully: ${comments.length} comments`)

				const result = { comments }
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(result),
						},
					],
					structuredContent: result as unknown as { [x: string]: unknown },
				}
			}

			// Fall back to GitHub provider
			const provider = new GitHubIssueManagementProvider()
			const comments = await provider.getReviewComments({ number, reviewId, repo })

			console.error(`Review comments fetched successfully: ${comments.length} comments`)

			const result = { comments }
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to fetch review comments: ${errorMessage}`)
			throw new Error(`Failed to fetch review comments: ${errorMessage}`)
		}
	}
)

// Register get_comment tool
server.registerTool(
	'get_comment',
	{
		title: 'Get Comment',
		description:
			'Fetch a specific comment by ID. Author has normalized core fields { id, displayName } plus provider-specific fields.',
		inputSchema: {
			commentId: z.string().describe('The comment identifier to fetch'),
			number: z.string().describe('The issue or PR identifier (context for providers that need it)'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			id: z.string().describe('Comment identifier'),
			body: z.string().describe('Comment body content'),
			author: flexibleAuthorSchema.nullable().describe(
				'Comment author with normalized { id, displayName } plus provider-specific fields'
			),
			created_at: z.string().describe('Comment creation timestamp'),
			updated_at: z.string().optional().describe('Comment last updated timestamp'),
		},
	},
	async ({ commentId, number, repo }: GetCommentInput) => {
		console.error(`Fetching comment ${commentId} from issue ${number}${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			const result = await provider.getComment({ commentId, number, repo })

			console.error(`Comment fetched successfully: ${result.id}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to fetch comment: ${errorMessage}`)
			throw new Error(`Failed to fetch comment: ${errorMessage}`)
		}
	}
)

// Register create_comment tool
server.registerTool(
	'create_comment',
	{
		title: 'Create Comment',
		description:
			'Create a new comment on an issue or pull request. Use this to start tracking a workflow phase.',
		inputSchema: {
			number: z.string().describe('The issue or PR identifier'),
			body: z.string().describe('The comment body (markdown supported)'),
			type: z
				.enum(['issue', 'pr'])
				.describe('Type of entity to comment on (issue or pr)'),
			markupLanguage: z.literal('GFM').describe('The markup language for the body content. Must be GitHub Flavored Markdown (GFM).'),
		},
		outputSchema: {
			id: z.string(),
			url: z.string(),
			created_at: z.string().optional(),
		},
	},
	async ({ number, body, type }: CreateCommentInput) => {
		console.error(`Creating ${type} comment on ${number}`)

		try {
			const sanitizedBody = JiraWikiSanitizer.sanitize(body)

			// Use VCS provider for PR comments when available (e.g., BitBucket)
			if (type === 'pr' && vcsProvider) {
				const vcsResult = await vcsProvider.createPRComment(parseInt(number, 10), sanitizedBody)

				console.error(
					`Comment created successfully: ${vcsResult.id} at ${vcsResult.url}`
				)

				const result = { id: vcsResult.id, url: vcsResult.url, created_at: new Date().toISOString() }
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(result),
						},
					],
					structuredContent: result as unknown as { [x: string]: unknown },
				}
			}

			// Fall back to issue management provider (GitHub for PR comments, configured provider for issues)
			const providerType = type === 'pr' ? 'github' : (process.env.ISSUE_PROVIDER as IssueProvider)
			const provider = IssueManagementProviderFactory.create(providerType, settings)
			const result = await provider.createComment({ number, body: sanitizedBody, type })

			console.error(
				`Comment created successfully: ${result.id} at ${result.url}`
			)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to create comment: ${errorMessage}`)
			throw new Error(`Failed to create ${type} comment: ${errorMessage}`)
		}
	}
)

// Register update_comment tool
server.registerTool(
	'update_comment',
	{
		title: 'Update Comment',
		description:
			'Update an existing comment. Use this to update progress during a workflow phase.',
		inputSchema: {
			commentId: z.string().describe('The comment identifier to update'),
			number: z.string().describe('The issue or PR identifier (context for providers that need it)'),
			body: z.string().describe('The updated comment body (markdown supported)'),
			type: z.enum(['issue', 'pr']).optional().describe('Optional type to route PR comments to GitHub regardless of configured provider'),
			markupLanguage: z.literal('GFM').describe('The markup language for the body content. Must be GitHub Flavored Markdown (GFM).'),
		},
		outputSchema: {
			id: z.string(),
			url: z.string(),
			updated_at: z.string().optional(),
		},
	},
	async ({ commentId, number, body, type }: UpdateCommentInput) => {
		console.error(`Updating comment ${commentId} on ${type === 'pr' ? 'PR' : 'issue'} ${number}`)

		try {
			const sanitizedBody = JiraWikiSanitizer.sanitize(body)

			// Use VCS provider for PR comments when available and it supports update
			if (type === 'pr' && vcsProvider?.updatePRComment) {
				const vcsResult = await vcsProvider.updatePRComment(parseInt(number, 10), commentId, sanitizedBody)

				console.error(
					`Comment updated successfully: ${vcsResult.id} at ${vcsResult.url}`
				)

				const result = { id: vcsResult.id, url: vcsResult.url, updated_at: new Date().toISOString() }
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(result),
						},
					],
					structuredContent: result as unknown as { [x: string]: unknown },
				}
			}

			// Fall back to issue management provider (GitHub for PR comments, configured provider for issues)
			const providerType = type === 'pr' ? 'github' : (process.env.ISSUE_PROVIDER as IssueProvider)
			const provider = IssueManagementProviderFactory.create(providerType, settings)
			const result = await provider.updateComment({ commentId, number, body: sanitizedBody })

			console.error(
				`Comment updated successfully: ${result.id} at ${result.url}`
			)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to update comment: ${errorMessage}`)
			throw new Error(`Failed to update comment: ${errorMessage}`)
		}
	}
)

// Register create_issue tool
server.registerTool(
	'create_issue',
	{
		title: 'Create Issue',
		description:
			'Create a new issue in the configured issue tracker. ' +
			'For GitHub: creates issue in the configured repository. ' +
			'For Linear: requires teamKey parameter (e.g., "ENG", "PLAT"), or configure issueManagement.linear.teamId in settings, or call get_issue first to auto-detect the team.',
		inputSchema: {
			title: z.string().describe('The issue title'),
			body: z.string().describe('The issue body/description (markdown supported)'),
			labels: z.array(z.string()).optional().describe('Optional labels to apply to the issue'),
			teamKey: z.string().optional().describe('Team key for Linear (e.g., "ENG"). Falls back to settings or team extracted from previous get_issue call. Ignored for GitHub.'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
			markupLanguage: z.literal('GFM').describe('The markup language for the body content. Must be GitHub Flavored Markdown (GFM).'),
		},
		outputSchema: {
			id: z.string().describe('Issue identifier'),
			url: z.string().describe('Issue URL'),
			number: z.number().optional().describe('Issue number (GitHub only)'),
		},
	},
	async ({ title, body, labels, teamKey, repo }: CreateIssueInput) => {
		console.error(`Creating issue: ${title}${repo ? ` in ${repo}` : ''}`)

		try {
			const sanitizedBody = JiraWikiSanitizer.sanitize(body)
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			const result = await provider.createIssue({ title, body: sanitizedBody, labels, teamKey, repo })

			console.error(`Issue created successfully: ${result.id} at ${result.url}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to create issue: ${errorMessage}`)
			throw new Error(`Failed to create issue: ${errorMessage}`)
		}
	}
)

// Register create_child_issue tool
server.registerTool(
	'create_child_issue',
	{
		title: 'Create Child Issue',
		description:
			'Create a new child issue linked to a parent issue. ' +
			'For GitHub: creates issue and links via sub-issue API (requires two API calls). ' +
			'For Linear: creates issue atomically with parent relationship. ' +
			'The parentId should be the parent issue identifier (GitHub issue number or Linear identifier like "ENG-123").',
		inputSchema: {
			parentId: z.string().describe('Parent issue identifier (GitHub issue number or Linear identifier like "ENG-123")'),
			title: z.string().describe('The child issue title'),
			body: z.string().describe('The child issue body/description (markdown supported)'),
			labels: z.array(z.string()).optional().describe('Optional labels to apply to the child issue'),
			teamKey: z.string().optional().describe('Team key for Linear (e.g., "ENG"). Falls back to parent team. Ignored for GitHub.'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
			markupLanguage: z.literal('GFM').describe('The markup language for the body content. Must be GitHub Flavored Markdown (GFM).'),
		},
		outputSchema: {
			id: z.string().describe('Issue identifier'),
			url: z.string().describe('Issue URL'),
			number: z.number().optional().describe('Issue number (GitHub only)'),
		},
	},
	async ({ parentId, title, body, labels, teamKey, repo }: CreateChildIssueInput) => {
		console.error(`Creating child issue for parent ${parentId}: ${title}${repo ? ` in ${repo}` : ''}`)

		try {
			const sanitizedBody = JiraWikiSanitizer.sanitize(body)
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			const result = await provider.createChildIssue({ parentId, title, body: sanitizedBody, labels, teamKey, repo })

			console.error(`Child issue created successfully: ${result.id} at ${result.url}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to create child issue: ${errorMessage}`)
			throw new Error(`Failed to create child issue: ${errorMessage}`)
		}
	}
)

// Define dependency result schema
const dependencyResultSchema = z.object({
	id: z.string().describe('Issue identifier'),
	title: z.string().describe('Issue title'),
	url: z.string().describe('Issue URL'),
	state: z.string().describe('Issue state'),
})

// Register create_dependency tool
server.registerTool(
	'create_dependency',
	{
		title: 'Create Dependency',
		description:
			'Create a blocking dependency between two issues. ' +
			'The blockingIssue will block the blockedIssue. ' +
			'For GitHub: uses the sub-issue API. ' +
			'For Linear: creates a "blocks" relation.',
		inputSchema: {
			blockingIssue: z.string().describe('The issue that blocks (GitHub issue number or Linear identifier like "ENG-123")'),
			blockedIssue: z.string().describe('The issue being blocked (GitHub issue number or Linear identifier like "ENG-123")'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			success: z.boolean().describe('Whether the dependency was created successfully'),
		},
	},
	async ({ blockingIssue, blockedIssue, repo }: CreateDependencyInput) => {
		console.error(`Creating dependency: ${blockingIssue} blocks ${blockedIssue}${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			await provider.createDependency({ blockingIssue, blockedIssue, repo })

			console.error(`Dependency created successfully: ${blockingIssue} -> ${blockedIssue}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ success: true }),
					},
				],
				structuredContent: { success: true },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to create dependency: ${errorMessage}`)
			throw new Error(`Failed to create dependency: ${errorMessage}`)
		}
	}
)

// Register get_dependencies tool
server.registerTool(
	'get_dependencies',
	{
		title: 'Get Dependencies',
		description:
			'Get blocking/blocked_by dependencies for an issue. ' +
			'Returns lists of issues that this issue blocks and/or is blocked by.',
		inputSchema: {
			number: z.string().describe('Issue identifier (GitHub issue number or Linear identifier like "ENG-123")'),
			direction: z
				.enum(['blocking', 'blocked_by', 'both'])
				.describe('Which dependencies to fetch: "blocking" for issues this blocks, "blocked_by" for issues blocking this, "both" for all'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			blocking: z.array(dependencyResultSchema).describe('Issues that this issue blocks'),
			blockedBy: z.array(dependencyResultSchema).describe('Issues that block this issue'),
		},
	},
	async ({ number, direction, repo }: GetDependenciesInput) => {
		console.error(`Getting dependencies for ${number} (direction: ${direction})${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			const result = await provider.getDependencies({ number, direction, repo })

			console.error(`Dependencies fetched: ${result.blocking.length} blocking, ${result.blockedBy.length} blocked_by`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(result),
					},
				],
				structuredContent: result as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to get dependencies: ${errorMessage}`)
			throw new Error(`Failed to get dependencies: ${errorMessage}`)
		}
	}
)

// Register remove_dependency tool
server.registerTool(
	'remove_dependency',
	{
		title: 'Remove Dependency',
		description:
			'Remove a blocking dependency between two issues. ' +
			'The blockingIssue will no longer block the blockedIssue.',
		inputSchema: {
			blockingIssue: z.string().describe('The issue that blocks (GitHub issue number or Linear identifier like "ENG-123")'),
			blockedIssue: z.string().describe('The issue being blocked (GitHub issue number or Linear identifier like "ENG-123")'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			success: z.boolean().describe('Whether the dependency was removed successfully'),
		},
	},
	async ({ blockingIssue, blockedIssue, repo }: RemoveDependencyInput) => {
		console.error(`Removing dependency: ${blockingIssue} blocks ${blockedIssue}${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			await provider.removeDependency({ blockingIssue, blockedIssue, repo })

			console.error(`Dependency removed successfully: ${blockingIssue} -> ${blockedIssue}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ success: true }),
					},
				],
				structuredContent: { success: true },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to remove dependency: ${errorMessage}`)
			throw new Error(`Failed to remove dependency: ${errorMessage}`)
		}
	}
)

// Define child issue result schema (reuse dependencyResultSchema pattern)
const childIssueResultSchema = z.object({
	id: z.string().describe('Issue identifier'),
	title: z.string().describe('Issue title'),
	url: z.string().describe('Issue URL'),
	state: z.string().describe('Issue state'),
})

// Register get_child_issues tool
server.registerTool(
	'get_child_issues',
	{
		title: 'Get Child Issues',
		description:
			'Get child issues (sub-issues) of a parent issue. ' +
			'Returns a list of issues that are children of the specified parent.',
		inputSchema: {
			number: z.string().describe('Parent issue identifier (GitHub issue number or Linear identifier like "ENG-123")'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			children: z.array(childIssueResultSchema).describe('Child issues of the parent'),
		},
	},
	async ({ number, repo }: GetChildIssuesInput) => {
		console.error(`Getting child issues for ${number}${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			const result = await provider.getChildIssues({ number, repo })

			console.error(`Child issues fetched: ${result.length} children`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ children: result }),
					},
				],
				structuredContent: { children: result } as unknown as { [x: string]: unknown },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to get child issues: ${errorMessage}`)
			throw new Error(`Failed to get child issues: ${errorMessage}`)
		}
	}
)

// Register close_issue tool
server.registerTool(
	'close_issue',
	{
		title: 'Close Issue',
		description:
			'Close an issue in the configured issue tracker. ' +
			'For GitHub: uses `gh issue close`. ' +
			'For Linear: transitions issue to "Done" state. ' +
			'For Jira: transitions issue to "Done" state.',
		inputSchema: {
			number: z.string().describe('The issue identifier'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			success: z.boolean().describe('Whether the issue was closed successfully'),
		},
	},
	async ({ number, repo }: CloseIssueInput) => {
		console.error(`Closing issue ${number}${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			await provider.closeIssue({ number, repo })

			console.error(`Issue closed successfully: ${number}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ success: true }),
					},
				],
				structuredContent: { success: true },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to close issue: ${errorMessage}`)
			throw new Error(`Failed to close issue: ${errorMessage}`)
		}
	}
)

// Register reopen_issue tool
server.registerTool(
	'reopen_issue',
	{
		title: 'Reopen Issue',
		description:
			'Reopen a closed issue in the configured issue tracker. ' +
			'For GitHub: uses `gh issue reopen`. ' +
			'For Linear: transitions issue to "Todo" state. ' +
			'For Jira: transitions issue to "Reopen" or "To Do" state.',
		inputSchema: {
			number: z.string().describe('The issue identifier'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
		},
		outputSchema: {
			success: z.boolean().describe('Whether the issue was reopened successfully'),
		},
	},
	async ({ number, repo }: ReopenIssueInput) => {
		console.error(`Reopening issue ${number}${repo ? ` in ${repo}` : ''}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			await provider.reopenIssue({ number, repo })

			console.error(`Issue reopened successfully: ${number}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ success: true }),
					},
				],
				structuredContent: { success: true },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to reopen issue: ${errorMessage}`)
			throw new Error(`Failed to reopen issue: ${errorMessage}`)
		}
	}
)

// Register edit_issue tool
server.registerTool(
	'edit_issue',
	{
		title: 'Edit Issue',
		description:
			'Edit an issue\'s properties (title, body, state, labels) in the configured issue tracker. ' +
			'State changes use close/reopen internally. ' +
			'For GitHub: uses `gh issue edit` for field updates and `gh issue close/reopen` for state. ' +
			'For Linear: uses Linear SDK to update fields and state transitions. ' +
			'For Jira: uses REST API to update fields and transitions for state.',
		inputSchema: {
			number: z.string().describe('The issue identifier'),
			title: z.string().optional().describe('New issue title'),
			body: z.string().optional().describe('New issue body/description'),
			state: z.enum(['open', 'closed']).optional().describe('New issue state'),
			labels: z.array(z.string()).optional().describe('Labels to add to the issue'),
			repo: z
				.string()
				.optional()
				.describe(
					'Optional repository in "owner/repo" format or full GitHub URL. ' +
					'When not provided, uses the current repository. GitHub only.'
				),
			markupLanguage: z.literal('GFM').optional().describe('The markup language for the body content. Must be GitHub Flavored Markdown (GFM).'),
		},
		outputSchema: {
			success: z.boolean().describe('Whether the issue was edited successfully'),
		},
	},
	async ({ number, title, body, state, labels, repo }: EditIssueInput) => {
		console.error(`Editing issue ${number}${repo ? ` in ${repo}` : ''}`)

		try {
			const sanitizedBody = body ? JiraWikiSanitizer.sanitize(body) : undefined
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider,
				settings
			)
			await provider.editIssue({ number, title, body: sanitizedBody, state, labels, repo })

			console.error(`Issue edited successfully: ${number}`)

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ success: true }),
					},
				],
				structuredContent: { success: true },
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Failed to edit issue: ${errorMessage}`)
			throw new Error(`Failed to edit issue: ${errorMessage}`)
		}
	}
)

// Main server startup
async function main(): Promise<void> {
	console.error('=== Issue Management MCP Server Starting ===')
	console.error(`PID: ${process.pid}`)
	console.error(`Node version: ${process.version}`)
	console.error(`CWD: ${process.cwd()}`)
	console.error(`Script: ${new URL(import.meta.url).pathname}`)

	// Log all ISSUE_PROVIDER-related env vars (redact sensitive values)
	const relevantEnvKeys = [
		'ISSUE_PROVIDER', 'REPO_OWNER', 'REPO_NAME', 'GITHUB_API_URL', 'GITHUB_EVENT_NAME',
		'DRAFT_PR_NUMBER', 'LINEAR_API_TOKEN', 'LINEAR_TEAM_KEY',
		'JIRA_HOST', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY',
	]
	console.error('Environment variables:')
	for (const key of relevantEnvKeys) {
		const val = process.env[key]
		if (val !== undefined) {
			console.error(`  ${key}=${val}`)
		}
	}

	// Load settings for providers that need them
	const settingsManager = new SettingsManager()
	settings = await settingsManager.loadSettings()
	console.error('Settings loaded')

	// Initialize VCS provider if configured (e.g., BitBucket)
	try {
		vcsProvider = VCSProviderFactory.create(settings)
		if (vcsProvider) {
			console.error(`VCS provider initialized: ${vcsProvider.providerName}`)
		}
	} catch (error) {
		// Only catch configuration-related errors (missing credentials, unsupported provider).
		// Re-throw unexpected errors to avoid silently swallowing real failures.
		if (
			error instanceof Error &&
			(error.message.includes('is required') || error.message.includes('Unsupported VCS provider'))
		) {
			console.error(`Failed to initialize VCS provider (falling back to GitHub): ${error.message}`)
			vcsProvider = null
		} else {
			throw error
		}
	}

	// Validate environment and get provider
	const provider = validateEnvironment()
	console.error('Environment validated')
	console.error(`Issue management provider: ${provider}`)

	if (provider === 'github') {
		console.error(`Repository: ${process.env.REPO_OWNER}/${process.env.REPO_NAME}`)
		console.error(`Event type: ${process.env.GITHUB_EVENT_NAME ?? 'not specified'}`)
	}

	// Connect stdio transport
	const transport = new StdioServerTransport()
	await server.connect(transport)

	console.error('=== Issue Management MCP Server READY (stdio transport) ===')
}

// Run the server
main().catch((error) => {
	console.error('Fatal error starting MCP server:', error)
	process.exit(1)
})
