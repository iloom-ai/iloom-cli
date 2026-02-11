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
		method: 'GET' | 'POST' | 'PUT',
		endpoint: string,
		body?: unknown
	): Promise<T> {
		const url = new URL(`${this.baseUrl}${endpoint}`)
		getLogger().debug(`Jira API ${method} request`, { url: url.toString() })

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

			const req = https.request(options, (res) => {
				let data = ''

				res.on('data', (chunk) => {
					data += chunk
				})

				res.on('end', () => {
					if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(`Jira API error (${res.statusCode}): ${data}`))
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
		getLogger().debug('Adding comment to Jira issue', { issueKey, body, adfBody })
		return this.post<JiraComment>(`/issue/${issueKey}/comment`, {
			body: adfBody
		})
	}

	/**
	 * Get all comments for an issue
	 */
	async getComments(issueKey: string): Promise<JiraComment[]> {
		const response = await this.get<{ comments: JiraComment[] }>(`/issue/${issueKey}/comment`)
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
	 * Test connection to Jira API
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.get('/myself')
			return true
		} catch (error) {
			getLogger().error('Jira connection test failed', { error })
			return false
		}
	}
}
