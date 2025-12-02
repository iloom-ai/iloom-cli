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
import type {
	IssueProvider,
	GetIssueInput,
	GetCommentInput,
	CreateCommentInput,
	UpdateCommentInput,
} from './types.js'

// Validate required environment variables
function validateEnvironment(): IssueProvider {
	const provider = process.env.ISSUE_PROVIDER as IssueProvider | undefined
	if (!provider) {
		console.error('Missing required environment variable: ISSUE_PROVIDER')
		process.exit(1)
	}

	if (provider !== 'github' && provider !== 'linear') {
		console.error(`Invalid ISSUE_PROVIDER: ${provider}. Must be 'github' or 'linear'`)
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

	// Linear doesn't need additional env vars - it uses the linearis CLI which handles auth

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
		},
		outputSchema: {
			// Core validated fields
			id: z.string().describe('Issue identifier'),
			title: z.string().describe('Issue title'),
			body: z.string().describe('Issue body/description'),
			state: z.string().describe('Issue state (open, closed, etc.)'),
			url: z.string().describe('Issue URL'),
			provider: z.enum(['github', 'linear']).describe('Issue management provider'),

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
	async ({ number, includeComments }: GetIssueInput) => {
		console.error(`Fetching issue ${number}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider
			)
			const result = await provider.getIssue({ number, includeComments })

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
	async ({ commentId, number }: GetCommentInput) => {
		console.error(`Fetching comment ${commentId} from issue ${number}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider
			)
			const result = await provider.getComment({ commentId, number })

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
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider
			)
			const result = await provider.createComment({ number, body, type })

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
		},
		outputSchema: {
			id: z.string(),
			url: z.string(),
			updated_at: z.string().optional(),
		},
	},
	async ({ commentId, number, body }: UpdateCommentInput) => {
		console.error(`Updating comment ${commentId} on issue ${number}`)

		try {
			const provider = IssueManagementProviderFactory.create(
				process.env.ISSUE_PROVIDER as IssueProvider
			)
			const result = await provider.updateComment({ commentId, number, body })

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

// Main server startup
async function main(): Promise<void> {
	console.error('Starting Issue Management MCP Server...')

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

	console.error('Issue Management MCP Server running on stdio transport')
}

// Run the server
main().catch((error) => {
	console.error('Fatal error starting MCP server:', error)
	process.exit(1)
})
