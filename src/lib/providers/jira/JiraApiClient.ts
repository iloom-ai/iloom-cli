// JiraApiClient - REST API wrapper for Jira operations
// Handles authentication and common API request patterns

import https from 'node:https'
import { getLogger } from '../../../utils/logger-context.js'
import { markdownToAdf } from './AdfMarkdownConverter.js'

/**
 * Jira API configuration
 */
export interface JiraConfig {
	host: string // e.g., "https://yourcompany.atlassian.net"
	username: string // email address or username
	apiToken: string // API token from Atlassian account
}

/**
 * Jira issue response from API
 */
/**
 * Jira issue link (relationship between issues)
 */
export interface JiraIssueLink {
	id: string
	type: {
		id: string
		name: string
		inward: string
		outward: string
	}
	inwardIssue?: {
		id: string
		key: string
		fields: {
			summary: string
			status: { name: string }
		}
	}
	outwardIssue?: {
		id: string
		key: string
		fields: {
			summary: string
			status: { name: string }
		}
	}
}

export interface JiraIssue {
	id: string
	key: string
	fields: {
		summary: string
		description: string | null | unknown // Can be string, ADF object, or null
		status: {
			name: string
		}
		issuetype: {
			name: string
		}
		project: {
			key: string
			name: string
		}
		assignee: {
			displayName: string
			emailAddress: string
			accountId: string
		} | null
		reporter: {
			displayName: string
			emailAddress: string
			accountId: string
		}
		labels: string[]
		created: string
		updated: string
		issuelinks?: JiraIssueLink[]
		parent?: {
			id: string
			key: string
			fields: {
				summary: string
				status: { name: string }
			}
		}
		[key: string]: unknown // Allow additional fields
	}
	[key: string]: unknown // Allow additional top-level fields
}

/**
 * Jira comment response from API
 */
export interface JiraComment {
	id: string
	author: {
		displayName: string
		emailAddress: string
		accountId: string
	}
	body: string | unknown // Can be string or ADF object
	created: string
	updated: string
	[key: string]: unknown
}

/**
 * Jira transition response from API
 */
export interface JiraTransition {
	id: string
	name: string
	to: {
		id: string
		name: string
	}
}

/**
 * JiraApiClient provides low-level REST API access to Jira
 * 
 * Authentication: Basic Auth with username and API token
 * API Reference: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */
export class JiraApiClient {
	private readonly baseUrl: string
	private readonly authHeader: string

	constructor(config: JiraConfig) {
		this.baseUrl = `${config.host.replace(/\/$/, '')}/rest/api/3`
		
		// Create Basic Auth header
		const credentials = Buffer.from(`${config.username}:${config.apiToken}`).toString('base64')
		this.authHeader = `Basic ${credentials}`
	}

	/**
	 * Make an HTTP request to Jira API
	 */
	private async request<T>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		endpoint: string,
		body?: unknown
	): Promise<T> {
		const url = new URL(`${this.baseUrl}${endpoint}`)
		getLogger().debug(`Jira API ${method} request`, { url: url.toString() })
		if (body) {
			getLogger().debug('Jira API request body', JSON.stringify(body, null, 2))
		}

		return new Promise((resolve, reject) => {
			const options: https.RequestOptions = {
				hostname: url.hostname,
				port: url.port || 443,
				path: url.pathname + url.search,
				method,
				headers: {
					'Authorization': this.authHeader,
					'Accept': 'application/json',
					'Content-Type': 'application/json',
				},
			}

			const req = https.request({ ...options, timeout: 30000 }, (res) => {
				const chunks: Buffer[] = []

				res.on('data', (chunk: Buffer) => {
					chunks.push(chunk)
				})

				res.on('end', () => {
					const data = Buffer.concat(chunks).toString('utf8')

					if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
						let errorDetail = data
						try {
							const parsed = JSON.parse(data)
							const parts: string[] = []
							if (parsed.errorMessages?.length) {
								parts.push(`messages: ${parsed.errorMessages.join(', ')}`)
							}
							if (parsed.errors && Object.keys(parsed.errors).length) {
								parts.push(`field errors: ${JSON.stringify(parsed.errors)}`)
							}
							if (parts.length) {
								errorDetail = parts.join('; ')
							}
						} catch {
							// Use raw data if not JSON
						}
						reject(new Error(`Jira API error (${res.statusCode}): ${errorDetail}`))
						return
					}

					// Handle empty response (e.g., 204 No Content)
					if (res.statusCode === 204 || !data) {
						resolve({} as T)
						return
					}

					try {
						resolve(JSON.parse(data) as T)
					} catch (error) {
						reject(new Error(`Failed to parse Jira API response: ${error}`))
					}
				})
			})

			req.on('timeout', () => {
				req.destroy()
				reject(new Error('Jira API request timed out after 30 seconds'))
			})

			req.on('error', (error) => {
				reject(new Error(`Jira API request failed: ${error.message}`))
			})

			if (body) {
				req.write(JSON.stringify(body))
			}

			req.end()
		})
	}

	/**
	 * Make a GET request to Jira API
	 */
	private async get<T>(endpoint: string): Promise<T> {
		return this.request<T>('GET', endpoint)
	}

	/**
	 * Make a POST request to Jira API
	 */
	private async post<T>(endpoint: string, body: unknown): Promise<T> {
		return this.request<T>('POST', endpoint, body)
	}

	/**
	 * Make a PUT request to Jira API
	 */
	private async put<T>(endpoint: string, body: unknown): Promise<T> {
		return this.request<T>('PUT', endpoint, body)
	}

	/**
	 * Make a DELETE request to Jira API
	 */
	private async delete(endpoint: string): Promise<void> {
		await this.request('DELETE', endpoint)
	}

	/**
	 * Fetch an issue by key (e.g., "PROJ-123")
	 */
	async getIssue(issueKey: string): Promise<JiraIssue> {
		return this.get<JiraIssue>(`/issue/${issueKey}`)
	}

	/**
	 * Add a comment to an issue
	 * Accepts Markdown content which is converted to ADF for Jira
	 */
	async addComment(issueKey: string, body: string): Promise<JiraComment> {
		const adfBody = markdownToAdf(body);
		getLogger().debug('Adding comment to Jira issue', { issueKey, bodyLength: body.length })
		return this.post<JiraComment>(`/issue/${issueKey}/comment`, {
			body: adfBody
		})
	}

	/**
	 * Get all comments for an issue
	 */
	async getComments(issueKey: string): Promise<JiraComment[]> {
		const response = await this.get<{ comments: JiraComment[]; total: number; maxResults: number }>(`/issue/${issueKey}/comment?maxResults=5000`)
		if (response.total > response.comments.length) {
			getLogger().warn(`Comments truncated for issue ${issueKey}: returned ${response.comments.length} of ${response.total} total comments`)
		}
		return response.comments
	}

	/**
	 * Update a comment on an issue
	 * Accepts Markdown content which is converted to ADF for Jira
	 */
	async updateComment(issueKey: string, commentId: string, body: string): Promise<JiraComment> {
		return this.put<JiraComment>(`/issue/${issueKey}/comment/${commentId}`, {
			body: markdownToAdf(body),
		})
	}

	/**
	 * Get available transitions for an issue
	 */
	async getTransitions(issueKey: string): Promise<JiraTransition[]> {
		const response = await this.get<{ transitions: JiraTransition[] }>(`/issue/${issueKey}/transitions`)
		return response.transitions
	}

	/**
	 * Transition an issue to a new state
	 */
	async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
		await this.post(`/issue/${issueKey}/transitions`, {
			transition: {
				id: transitionId,
			},
		})
	}

	/**
	 * Create a new issue
	 * Accepts Markdown description which is converted to ADF for Jira
	 */
	async createIssue(projectKey: string, summary: string, description: string, issueType = 'Task'): Promise<JiraIssue> {
		return this.post<JiraIssue>('/issue', {
			fields: {
				project: {
					key: projectKey,
				},
				summary,
				description: markdownToAdf(description),
				issuetype: {
					name: issueType,
				},
			},
		})
	}

	/**
	 * Update an issue's fields (summary, description)
	 * @param issueKey - Jira issue key (e.g., "PROJ-123")
	 * @param fields - Fields to update
	 */
	async updateIssue(issueKey: string, fields: { summary?: string; description?: string }): Promise<void> {
		const updateFields: Record<string, unknown> = {}
		if (fields.summary !== undefined) {
			updateFields.summary = fields.summary
		}
		if (fields.description !== undefined) {
			updateFields.description = markdownToAdf(fields.description)
		}

		await this.put(`/issue/${issueKey}`, { fields: updateFields })
	}

	/**
	 * Create an issue with a parent (subtask or child issue)
	 * Accepts Markdown description which is converted to ADF for Jira
	 */
	async createIssueWithParent(
		projectKey: string,
		summary: string,
		description: string,
		parentKey: string,
		issueType = 'Subtask'
	): Promise<JiraIssue> {
		return this.post<JiraIssue>('/issue', {
			fields: {
				project: {
					key: projectKey,
				},
				summary,
				description: markdownToAdf(description),
				issuetype: {
					name: issueType,
				},
				parent: {
					key: parentKey,
				},
			},
		})
	}

	/**
	 * Create an issue link (dependency/relationship between issues)
	 * @param inwardKey - The issue key for the inward side (e.g., the blocked issue)
	 * @param outwardKey - The issue key for the outward side (e.g., the blocking issue)
	 * @param linkType - The link type name (e.g., "Blocks")
	 */
	async createIssueLink(inwardKey: string, outwardKey: string, linkType: string): Promise<void> {
		await this.post('/issueLink', {
			type: {
				name: linkType,
			},
			inwardIssue: {
				key: inwardKey,
			},
			outwardIssue: {
				key: outwardKey,
			},
		})
	}

	/**
	 * Delete an issue link by ID
	 */
	async deleteIssueLink(linkId: string): Promise<void> {
		await this.delete(`/issueLink/${linkId}`)
	}

	/**
	 * Search issues using JQL
	 * Automatically paginates through all results up to MAX_SEARCH_RESULTS.
	 */
	async searchIssues(jql: string): Promise<JiraIssue[]> {
		const MAX_SEARCH_RESULTS = 5000
		const allIssues: JiraIssue[] = []
		let nextPageToken: string | undefined
		const maxResults = 100

		while (allIssues.length < MAX_SEARCH_RESULTS) {
			const body: Record<string, unknown> = {
				jql,
				maxResults,
				fields: [
					'summary', 'description', 'status', 'issuetype', 'project',
					'assignee', 'reporter', 'labels', 'created', 'updated',
					'issuelinks', 'parent',
				],
			}
			if (nextPageToken) {
				body.nextPageToken = nextPageToken
			}
			const response = await this.post<{ issues: JiraIssue[]; nextPageToken?: string }>(
				'/search/jql',
				body
			)
			allIssues.push(...response.issues)

			if (!response.nextPageToken || response.issues.length === 0) {
				break
			}

			nextPageToken = response.nextPageToken
		}

		if (allIssues.length >= MAX_SEARCH_RESULTS) {
			getLogger().warn(`Search results truncated at ${MAX_SEARCH_RESULTS} issues. The query matched more results than the safety cap allows.`, { jql, returnedCount: allIssues.length })
		}

		return allIssues
	}

	/**
	 * Test connection to Jira API
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.get('/myself')
			return true
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes('Jira API error (401)') || message.includes('Jira API error (403)')) {
				getLogger().error('Jira connection test failed: authentication error', { error })
				return false
			}
			throw error
		}
	}
}
