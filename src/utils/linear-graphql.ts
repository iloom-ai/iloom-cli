/**
 * Linear GraphQL API client
 * Direct GraphQL queries/mutations to Linear API
 */

import type { LinearIssue, LinearComment } from '../types/linear.js'
import { LinearServiceError } from '../types/linear.js'
import { logger } from './logger.js'

// Use native fetch (Node.js 18+ has it built-in)
declare const fetch: typeof globalThis.fetch

const LINEAR_API_ENDPOINT = 'https://api.linear.app/graphql'

/**
 * GraphQL response wrapper
 */
interface GraphQLResponse<T> {
	data?: T
	errors?: Array<{
		message: string
		extensions?: {
			code?: string
		}
	}>
}

/**
 * Execute a GraphQL query/mutation against Linear API
 * @param query - GraphQL query or mutation string
 * @param variables - Query variables
 * @param apiToken - Linear API token
 * @returns Parsed response data
 * @throws LinearServiceError on API errors
 */
async function executeGraphQL<T>(query: string, variables: Record<string, unknown>, apiToken: string): Promise<T> {
	if (!apiToken) {
		throw new LinearServiceError('UNAUTHORIZED', 'LINEAR_API_TOKEN is required for GraphQL operations')
	}

	logger.debug('Executing Linear GraphQL request', {
		operation: query.slice(0, 50),
		variables: JSON.stringify(variables),
	})

	try {
		const response = await fetch(LINEAR_API_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiToken}`,
			},
			body: JSON.stringify({ query, variables }),
		})

		if (!response.ok) {
			if (response.status === 401) {
				throw new LinearServiceError('UNAUTHORIZED', `Linear API authentication failed: ${response.statusText}`)
			}
			if (response.status === 429) {
				throw new LinearServiceError('RATE_LIMITED', 'Linear API rate limit exceeded')
			}
			throw new LinearServiceError(
				'CLI_ERROR',
				`Linear API request failed: ${response.status} ${response.statusText}`,
			)
		}

		const result = (await response.json()) as GraphQLResponse<T>

		if (result.errors && result.errors.length > 0) {
			const firstError = result.errors[0]
			if (!firstError) {
				throw new LinearServiceError('CLI_ERROR', 'Unknown GraphQL error', result.errors)
			}

			const errorCode = firstError.extensions?.code

			// Map GraphQL error codes to LinearErrorCode
			if (errorCode === 'AUTHENTICATION_ERROR' || errorCode === 'FORBIDDEN') {
				throw new LinearServiceError('UNAUTHORIZED', firstError.message)
			}
			if (errorCode === 'NOT_FOUND') {
				throw new LinearServiceError('NOT_FOUND', firstError.message)
			}
			if (errorCode === 'RATE_LIMITED') {
				throw new LinearServiceError('RATE_LIMITED', firstError.message)
			}

			// Generic error
			throw new LinearServiceError('CLI_ERROR', firstError.message, result.errors)
		}

		if (!result.data) {
			throw new LinearServiceError('CLI_ERROR', 'Linear API returned no data')
		}

		return result.data
	} catch (error) {
		if (error instanceof LinearServiceError) {
			throw error
		}
		// Network or other errors
		throw new LinearServiceError('CLI_ERROR', `Failed to execute Linear GraphQL request: ${String(error)}`, error)
	}
}

/**
 * Fetch a Linear issue by identifier (e.g., "ENG-123")
 * @param identifier - Issue identifier in TEAM-NUMBER format
 * @param apiToken - Linear API token
 * @returns Linear issue
 * @throws LinearServiceError if issue not found
 */
export async function fetchLinearIssueByIdentifier(identifier: string, apiToken: string): Promise<LinearIssue> {
	const query = `
		query IssueByIdentifier($filter: IssueFilter!) {
			issues(filter: $filter, first: 1) {
				nodes {
					id
					identifier
					title
					description
					state {
						id
						name
						type
					}
					labels {
						nodes {
							name
						}
					}
					assignee {
						name
						displayName
					}
					createdAt
					updatedAt
					team {
						id
						key
						name
					}
				}
			}
		}
	`

	interface IssueQueryResponse {
		issues: {
			nodes: Array<{
				id: string
				identifier: string
				title: string
				description: string | null
				state: {
					id: string
					name: string
					type: 'started' | 'unstarted' | 'completed' | 'canceled'
				}
				labels: {
					nodes: Array<{ name: string }>
				}
				assignee: { name: string; displayName?: string } | null
				createdAt: string
				updatedAt: string
				team: {
					id: string
					key: string
					name: string
				}
			}>
		}
	}

	const result = await executeGraphQL<IssueQueryResponse>(
		query,
		{ filter: { identifier: { eq: identifier } } },
		apiToken,
	)

	if (!result.issues.nodes || result.issues.nodes.length === 0) {
		throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
	}

	const issue = result.issues.nodes[0]
	if (!issue) {
		throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
	}

	return {
		id: issue.id,
		identifier: issue.identifier,
		title: issue.title,
		description: issue.description,
		state: issue.state,
		labels: issue.labels.nodes.map((n) => ({ name: n.name })),
		assignee: issue.assignee,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
		team: issue.team,
	}
}

/**
 * Get a single Linear comment by ID
 * @param commentId - Comment UUID
 * @param apiToken - Linear API token
 * @returns Linear comment
 * @throws LinearServiceError if comment not found
 */
export async function getLinearCommentGraphQL(commentId: string, apiToken: string): Promise<LinearComment> {
	const query = `
		query Comment($id: String!) {
			comment(id: $id) {
				id
				body
				createdAt
				user {
					name
					displayName
				}
			}
		}
	`

	interface CommentQueryResponse {
		comment: {
			id: string
			body: string
			createdAt: string
			user: { name: string; displayName?: string }
		} | null
	}

	const result = await executeGraphQL<CommentQueryResponse>(query, { id: commentId }, apiToken)

	if (!result.comment) {
		throw new LinearServiceError('NOT_FOUND', `Linear comment ${commentId} not found`)
	}

	return {
		id: result.comment.id,
		body: result.comment.body,
		createdAt: result.comment.createdAt,
		user: result.comment.user,
	}
}

/**
 * Create a Linear comment
 * @param issueId - Issue UUID
 * @param body - Comment body (markdown)
 * @param apiToken - Linear API token
 * @returns Created comment
 * @throws LinearServiceError on creation failure
 */
export async function createLinearCommentGraphQL(
	issueId: string,
	body: string,
	apiToken: string,
): Promise<LinearComment> {
	const mutation = `
		mutation CommentCreate($issueId: String!, $body: String!) {
			commentCreate(input: { issueId: $issueId, body: $body }) {
				success
				comment {
					id
					body
					createdAt
					user {
						name
						displayName
					}
				}
			}
		}
	`

	interface CommentCreateResponse {
		commentCreate: {
			success: boolean
			comment: {
				id: string
				body: string
				createdAt: string
				user: { name: string; displayName?: string }
			}
		}
	}

	const result = await executeGraphQL<CommentCreateResponse>(mutation, { issueId, body }, apiToken)

	if (!result.commentCreate.success) {
		throw new LinearServiceError('CLI_ERROR', 'Failed to create Linear comment')
	}

	return {
		id: result.commentCreate.comment.id,
		body: result.commentCreate.comment.body,
		createdAt: result.commentCreate.comment.createdAt,
		user: result.commentCreate.comment.user,
	}
}

/**
 * Update a Linear comment
 * @param commentId - Comment UUID
 * @param body - Updated comment body (markdown)
 * @param apiToken - Linear API token
 * @returns Updated comment
 * @throws LinearServiceError on update failure
 */
export async function updateLinearCommentGraphQL(
	commentId: string,
	body: string,
	apiToken: string,
): Promise<LinearComment> {
	const mutation = `
		mutation CommentUpdate($id: String!, $body: String!) {
			commentUpdate(id: $id, input: { body: $body }) {
				success
				comment {
					id
					body
					createdAt
					user {
						name
						displayName
					}
				}
			}
		}
	`

	interface CommentUpdateResponse {
		commentUpdate: {
			success: boolean
			comment: {
				id: string
				body: string
				createdAt: string
				user: { name: string; displayName?: string }
			}
		}
	}

	const result = await executeGraphQL<CommentUpdateResponse>(mutation, { id: commentId, body }, apiToken)

	if (!result.commentUpdate.success) {
		throw new LinearServiceError('CLI_ERROR', 'Failed to update Linear comment')
	}

	return {
		id: result.commentUpdate.comment.id,
		body: result.commentUpdate.comment.body,
		createdAt: result.commentUpdate.comment.createdAt,
		user: result.commentUpdate.comment.user,
	}
}

/**
 * Fetch all comments for a Linear issue
 * @param issueId - Issue UUID
 * @param apiToken - Linear API token
 * @returns Array of comments
 * @throws LinearServiceError on fetch failure
 */
export async function fetchIssueCommentsGraphQL(issueId: string, apiToken: string): Promise<LinearComment[]> {
	const query = `
		query IssueComments($id: String!) {
			issue(id: $id) {
				comments(first: 100) {
					nodes {
						id
						body
						createdAt
						user {
							name
							displayName
						}
					}
				}
			}
		}
	`

	interface IssueCommentsResponse {
		issue: {
			comments: {
				nodes: Array<{
					id: string
					body: string
					createdAt: string
					user: { name: string; displayName?: string }
				}>
			}
		} | null
	}

	const result = await executeGraphQL<IssueCommentsResponse>(query, { id: issueId }, apiToken)

	if (!result.issue) {
		throw new LinearServiceError('NOT_FOUND', `Linear issue ${issueId} not found`)
	}

	return result.issue.comments.nodes.map((node) => ({
		id: node.id,
		body: node.body,
		createdAt: node.createdAt,
		user: node.user,
	}))
}

/**
 * Get team UUID by team key
 * @param teamKey - Team key (e.g., "ENG", "PLAT")
 * @param apiToken - Linear API token
 * @returns Team UUID
 * @throws LinearServiceError if team not found
 */
export async function getTeamIdByKey(teamKey: string, apiToken: string): Promise<string> {
	const query = `
		query TeamByKey($filter: TeamFilter!) {
			teams(filter: $filter, first: 1) {
				nodes {
					id
					key
					name
				}
			}
		}
	`

	interface TeamQueryResponse {
		teams: {
			nodes: Array<{
				id: string
				key: string
				name: string
			}>
		}
	}

	const result = await executeGraphQL<TeamQueryResponse>(
		query,
		{ filter: { key: { eq: teamKey } } },
		apiToken,
	)

	if (!result.teams.nodes || result.teams.nodes.length === 0) {
		throw new LinearServiceError('NOT_FOUND', `Linear team with key ${teamKey} not found`)
	}

	const team = result.teams.nodes[0]
	if (!team) {
		throw new LinearServiceError('NOT_FOUND', `Linear team with key ${teamKey} not found`)
	}

	return team.id
}

/**
 * Update a Linear issue's workflow state
 * @param issueId - Issue UUID
 * @param stateName - Target state name (e.g., "In Progress", "Done")
 * @param apiToken - Linear API token
 * @throws LinearServiceError on update failure
 */
export async function updateLinearIssueStateGraphQL(
	issueId: string,
	stateName: string,
	apiToken: string,
): Promise<void> {
	// First, get the state ID by name for the issue's team
	const query = `
		query IssueWithStates($issueId: String!) {
			issue(id: $issueId) {
				id
				team {
					states {
						nodes {
							id
							name
						}
					}
				}
			}
		}
	`

	interface IssueStatesResponse {
		issue: {
			id: string
			team: {
				states: {
					nodes: Array<{
						id: string
						name: string
					}>
				}
			}
		} | null
	}

	const statesResult = await executeGraphQL<IssueStatesResponse>(query, { issueId }, apiToken)

	if (!statesResult.issue) {
		throw new LinearServiceError('NOT_FOUND', `Linear issue ${issueId} not found`)
	}

	const state = statesResult.issue.team.states.nodes.find((s) => s.name === stateName)
	if (!state) {
		throw new LinearServiceError('INVALID_STATE', `State "${stateName}" not found for this team`)
	}

	// Update the issue's state
	const mutation = `
		mutation IssueUpdate($id: String!, $stateId: String!) {
			issueUpdate(id: $id, input: { stateId: $stateId }) {
				success
			}
		}
	`

	interface IssueUpdateResponse {
		issueUpdate: {
			success: boolean
		}
	}

	const updateResult = await executeGraphQL<IssueUpdateResponse>(mutation, { id: issueId, stateId: state.id }, apiToken)

	if (!updateResult.issueUpdate.success) {
		throw new LinearServiceError('CLI_ERROR', 'Failed to update Linear issue state')
	}
}

/**
 * Create a Linear issue
 * @param teamId - Team ID (UUID, not key)
 * @param title - Issue title
 * @param description - Issue description (markdown)
 * @param apiToken - Linear API token
 * @returns Created issue
 * @throws LinearServiceError on creation failure
 */
export async function createLinearIssueGraphQL(
	teamId: string,
	title: string,
	description: string,
	apiToken: string,
): Promise<LinearIssue> {
	const mutation = `
		mutation IssueCreate($teamId: String!, $title: String!, $description: String!) {
			issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
				success
				issue {
					id
					identifier
					title
					description
					state {
						id
						name
						type
					}
					labels {
						nodes {
							name
						}
					}
					assignee {
						name
						displayName
					}
					createdAt
					updatedAt
					team {
						id
						key
						name
					}
				}
			}
		}
	`

	interface IssueCreateResponse {
		issueCreate: {
			success: boolean
			issue: {
				id: string
				identifier: string
				title: string
				description: string | null
				state: {
					id: string
					name: string
					type: 'started' | 'unstarted' | 'completed' | 'canceled'
				}
				labels: {
					nodes: Array<{ name: string }>
				}
				assignee: { name: string; displayName?: string } | null
				createdAt: string
				updatedAt: string
				team: {
					id: string
					key: string
					name: string
				}
			}
		}
	}

	const result = await executeGraphQL<IssueCreateResponse>(mutation, { teamId, title, description }, apiToken)

	if (!result.issueCreate.success) {
		throw new LinearServiceError('CLI_ERROR', 'Failed to create Linear issue')
	}

	const issue = result.issueCreate.issue

	return {
		id: issue.id,
		identifier: issue.identifier,
		title: issue.title,
		description: issue.description,
		state: issue.state,
		labels: issue.labels.nodes.map((n) => ({ name: n.name })),
		assignee: issue.assignee,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
		team: issue.team,
	}
}
