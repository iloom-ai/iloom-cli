// BitBucketApiClient - REST API wrapper for BitBucket operations
// Handles authentication and common API request patterns

import https from 'node:https'
import { getLogger } from '../../../utils/logger-context.js'

/**
 * BitBucket API configuration
 */
export interface BitBucketConfig {
	username: string
	apiToken: string // API token from BitBucket settings
	workspace?: string // Optional, can be auto-detected from git remote
	repoSlug?: string // Optional, can be auto-detected from git remote
}

/**
 * BitBucket pull request response from API
 */
export interface BitBucketPullRequest {
	id: number
	title: string
	description: string
	state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'
	author: {
		display_name: string
		uuid: string
	}
	source: {
		branch: {
			name: string
		}
	}
	destination: {
		branch: {
			name: string
		}
	}
	created_on: string
	updated_on: string
	links: {
		html: {
			href: string
		}
	}
	[key: string]: unknown
}

/**
 * BitBucket workspace member response from API
 * Used for resolving usernames to account IDs
 */
export interface BitBucketWorkspaceMember {
	user: {
		account_id: string
		display_name: string
		uuid: string
		nickname?: string
	}
}

/**
 * BitBucket repository response from API
 */
export interface BitBucketRepository {
	slug: string
	name: string
	full_name: string
	workspace: {
		slug: string
	}
	links: {
		html: {
			href: string
		}
	}
	[key: string]: unknown
}

interface BitBucketWorkspaceMembersResponse { values: BitBucketWorkspaceMember[]; next?: string }

/**
 * BitBucket current user response from /user endpoint
 */
export interface BitBucketCurrentUser {
	account_id: string
	display_name: string
	nickname?: string
}

/**
 * BitBucketApiClient provides low-level REST API access to BitBucket
 * 
 * Authentication: Basic Auth with username and API token
 * API Reference: https://developer.atlassian.com/cloud/bitbucket/rest/intro/
 * 
 * Note: As of September 9, 2025, BitBucket app passwords can no longer be created.
 * Use API tokens with scopes instead. All existing app passwords will be disabled on June 9, 2026.
 */
export class BitBucketApiClient {
	private readonly baseUrl = 'https://api.bitbucket.org/2.0'
	private readonly authHeader: string
	private readonly workspace: string | undefined
	private readonly repoSlug: string | undefined

	constructor(config: BitBucketConfig) {
		// Create Basic Auth header with API token
		const credentials = Buffer.from(`${config.username}:${config.apiToken}`).toString('base64')
		this.authHeader = `Basic ${credentials}`
		
		this.workspace = config.workspace
		this.repoSlug = config.repoSlug
	}

	/**
	 * Make an HTTP request to BitBucket API
	 */
	private async request<T>(
		method: 'GET' | 'POST',
		endpoint: string,
		body?: unknown
	): Promise<T> {
		// If endpoint is already a full URL, use it directly; otherwise prepend baseUrl
		const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
			? new URL(endpoint)
			: new URL(`${this.baseUrl}${endpoint}`)
		getLogger().debug(`BitBucket API ${method} request`, { url: url.toString() })

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
						reject(new Error(`BitBucket API error (${res.statusCode}): ${data}`))
						return
					}

					// Handle empty response
					if (res.statusCode === 204 || !data) {
						resolve({} as T)
						return
					}

					try {
						resolve(JSON.parse(data) as T)
					} catch (error) {
						reject(new Error(`Failed to parse BitBucket API response: ${error}`))
					}
				})
			})

			req.on('error', (error) => {
				reject(new Error(`BitBucket API request failed: ${error.message}`))
			})

			if (body) {
				req.write(JSON.stringify(body))
			}

			req.end()
		})
	}

	/**
	 * Make a GET request to BitBucket API
	 */
	private async get<T>(endpoint: string): Promise<T> {
		return this.request<T>('GET', endpoint)
	}

	/**
	 * Make a POST request to BitBucket API
	 */
	private async post<T>(endpoint: string, body: unknown): Promise<T> {
		return this.request<T>('POST', endpoint, body)
	}

	/**
	 * Get repository information
	 */
	async getRepository(workspace: string, repoSlug: string): Promise<BitBucketRepository> {
		return this.get<BitBucketRepository>(`/repositories/${workspace}/${repoSlug}`)
	}

	/**
	 * Get a pull request by ID
	 */
	async getPullRequest(
		workspace: string,
		repoSlug: string,
		prId: number
	): Promise<BitBucketPullRequest> {
		return this.get<BitBucketPullRequest>(
			`/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`
		)
	}

	/**
	 * List open pull requests for a branch
	 *
	 * Note: BitBucket uses BBQL (BitBucket Query Language) for filtering.
	 * The q parameter must use the format: q=source.branch.name="branch-name"
	 * When using BBQL, we include state filter in the query to ensure it's applied.
	 * See: https://developer.atlassian.com/cloud/bitbucket/rest/intro/#filtering
	 */
	async listPullRequests(
		workspace: string,
		repoSlug: string,
		sourceBranch?: string
	): Promise<BitBucketPullRequest[]> {
		let endpoint = `/repositories/${workspace}/${repoSlug}/pullrequests`

		if (sourceBranch) {
			// Use BBQL query syntax for filtering by source branch AND state
			// Include state="OPEN" in the query to exclude DECLINED/MERGED/SUPERSEDED PRs
			const query = `state="OPEN" AND source.branch.name="${sourceBranch}"`
			endpoint += `?q=${encodeURIComponent(query)}`
		} else {
			// No branch filter, just filter by state
			endpoint += `?state=OPEN`
		}

		const response = await this.get<{ values: BitBucketPullRequest[] }>(endpoint)
		return response.values
	}

	/**
	 * Create a pull request
	 */
	async createPullRequest(
		workspace: string,
		repoSlug: string,
		title: string,
		description: string,
		sourceBranch: string,
		destinationBranch: string,
		reviewerAccountIds?: string[]
	): Promise<BitBucketPullRequest> {
		const payload: Record<string, unknown> = {
			title,
			description,
			source: {
				branch: {
					name: sourceBranch,
				},
			},
			destination: {
				branch: {
					name: destinationBranch,
				},
			},
		}

		// Add reviewers if provided
		if (reviewerAccountIds && reviewerAccountIds.length > 0) {
			payload.reviewers = reviewerAccountIds.map(id => ({ account_id: id }))
		}

		return this.post<BitBucketPullRequest>(
			`/repositories/${workspace}/${repoSlug}/pullrequests`,
			payload
		)
	}

	/**
	 * Add a comment to a pull request
	 */
	async addPRComment(
		workspace: string,
		repoSlug: string,
		prId: number,
		content: string
	): Promise<void> {
		await this.post(
			`/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`,
			{
				content: {
					raw: content,
				},
			}
		)
	}

	/**
	 * Find workspace members by usernames
	 * Returns a map of username -> account_id for resolved users
	 * Handles pagination to fetch all workspace members
	 */
	async findUsersByUsername(
		workspace: string,
		usernames: string[]
	): Promise<Map<string, string>> {
		const result = new Map<string, string>()

		// Fetch all workspace members with pagination
		const allMembers = await this.getAllWorkspaceMembers(workspace)

		getLogger().debug(`Resolving ${usernames.length} usernames against ${allMembers.length} workspace members`, { allMembers})

		// Match usernames against fetched members
		for (const username of usernames) {
			const usernameLower = username.toLowerCase()
			const member = allMembers.find(m =>
				m.user.nickname?.toLowerCase() === usernameLower ||
				m.user.display_name.toLowerCase() === usernameLower
			)

			if (member) {
				result.set(username, member.user.account_id)
				getLogger().debug(`Resolved reviewer ${username} to account ID ${member.user.account_id}`)
			} else {
				getLogger().warn(`Could not resolve reviewer ${username} to a BitBucket account ID`)
			}
		}

		return result
	}

	/**
	 * Fetch all workspace members with pagination
	 */
	private async getAllWorkspaceMembers(workspace: string): Promise<BitBucketWorkspaceMember[]> {
		const allMembers: BitBucketWorkspaceMember[] = []
		let nextUrl: string | null = `/workspaces/${workspace}/members`

		while (nextUrl) {
			const response: BitBucketWorkspaceMembersResponse =
				await this.get(nextUrl)

			allMembers.push(...response.values)

			// BitBucket pagination uses 'next' field with full URL
			// Use it directly since request() now handles full URLs
			nextUrl = response.next ?? null
		}

		getLogger().debug(`Fetched ${allMembers.length} workspace members from BitBucket`)
		return allMembers
	}

	/**
	 * Get the currently authenticated user
	 */
	async getCurrentUser(): Promise<BitBucketCurrentUser> {
		return this.get<BitBucketCurrentUser>('/user')
	}

	/**
	 * Test connection to BitBucket API
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.getCurrentUser()
			return true
		} catch (error) {
			getLogger().error('BitBucket connection test failed', { error })
			return false
		}
	}

	/**
	 * Get configured workspace
	 */
	getWorkspace(): string | undefined {
		return this.workspace
	}

	/**
	 * Get configured repository slug
	 */
	getRepoSlug(): string | undefined {
		return this.repoSlug
	}
}
