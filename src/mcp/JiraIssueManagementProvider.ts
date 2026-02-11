/**
 * Jira implementation of Issue Management Provider
 * Uses JiraIssueTracker for all operations
 * Normalizes Jira-specific fields to provider-agnostic core fields
 */

import type {
	IssueManagementProvider,
	GetIssueInput,
	GetCommentInput,
	CreateCommentInput,
	UpdateCommentInput,
	CreateIssueInput,
	CreateIssueResult,
	IssueResult,
	CommentDetailResult,
	CommentResult,
	FlexibleAuthor,
} from './types.js'
import { JiraIssueTracker } from '../lib/providers/jira/JiraIssueTracker.js'
import type { JiraTrackerConfig } from '../lib/providers/jira/JiraIssueTracker.js'
import type { Issue } from '../types/index.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import type { IloomSettings } from '../lib/SettingsManager.js'

/**
 * Normalize Jira author to FlexibleAuthor format
 */
function normalizeAuthor(author: { displayName?: string; emailAddress?: string; accountId?: string } | null | undefined): FlexibleAuthor | null {
	if (!author) return null

	return {
		id: author.accountId ?? author.emailAddress ?? 'unknown',
		displayName: author.displayName ?? author.emailAddress ?? 'Unknown',
		...(author.emailAddress && { email: author.emailAddress }),
		...(author.accountId && { accountId: author.accountId }),
	}
}
/**
 * Extract Jira configuration from settings (for cli usage) or environment variables (in mcp server)
 */
const getJiraTrackerConfig = (settings: IloomSettings): JiraTrackerConfig => {
	const jiraSettings = settings.issueManagement?.jira

	if (jiraSettings?.host && jiraSettings?.username && jiraSettings?.apiToken && jiraSettings?.projectKey) {
			const config: JiraTrackerConfig = {
			host: jiraSettings.host,
			username: jiraSettings.username,
			apiToken: jiraSettings.apiToken,
			projectKey: jiraSettings.projectKey,
		}

		if (jiraSettings.transitionMappings) {
			config.transitionMappings = jiraSettings.transitionMappings
		}

		return config;
	}

	if (process.env.JIRA_HOST && process.env.JIRA_USERNAME && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY) {
		const config: JiraTrackerConfig = {
			host: process.env.JIRA_HOST,
			username: process.env.JIRA_USERNAME,
			apiToken: process.env.JIRA_API_TOKEN,
			projectKey: process.env.JIRA_PROJECT_KEY,
		}

		if (process.env.JIRA_TRANSITION_MAPPINGS) {
			try {
				config.transitionMappings = JSON.parse(process.env.JIRA_TRANSITION_MAPPINGS)
			} catch {
				throw new Error('Invalid JSON in JIRA_TRANSITION_MAPPINGS environment variable')
			}
		}

		return config
	}

	throw new Error(
		'Missing required Jira settings: issueManagement.jira.{host, username, apiToken, projectKey} or corresponding environment variables'
	)	
}

/**
 * Jira-specific implementation of IssueManagementProvider
 */
export class JiraIssueManagementProvider implements IssueManagementProvider {
	readonly providerName = 'jira'
	readonly issuePrefix = ''
	private tracker: JiraIssueTracker

	constructor(settings: IloomSettings) {
		const config = getJiraTrackerConfig(settings);

		this.tracker = new JiraIssueTracker(config)
	}

	/**
	 * Static factory for convenience when settings aren't pre-loaded
	 */
	static async create(): Promise<JiraIssueManagementProvider> {
		const settingsManager = new SettingsManager()
		const settings = await settingsManager.loadSettings()
		return new JiraIssueManagementProvider(settings)
	}

	/**
	 * Fetch issue details using JiraIssueTracker
	 */
	async getIssue(input: GetIssueInput): Promise<IssueResult> {
		const { number, includeComments = true } = input

		// Fetch issue from Jira
		const issue = await this.tracker.getIssue(number)
		const issueExt = issue as Issue & {
			id?: string
			key?: string
			author?: {
				displayName?: string
				emailAddress?: string
				accountId?: string
			}
			issueType?: string
			priority?: string
			status?: string
		}

		// Normalize to IssueResult format
		const result: IssueResult = {
			id: issueExt.id ?? String(issue.number),
			title: issue.title,
			body: issue.body,
			state: issue.state,
			url: issue.url,
			provider: 'jira',
			author: normalizeAuthor(issueExt.author),
			number: issue.number,
			key: issueExt.key,
			// Preserve Jira-specific fields
			...(issueExt.issueType && { issueType: issueExt.issueType }),
			...(issueExt.priority && { priority: issueExt.priority }),
			...(issueExt.status && { status: issueExt.status }),
		}

		// Add labels if present
		if (issue.labels && issue.labels.length > 0) {
			result.labels = issue.labels.map(label => ({ name: label }))
		}

		// Add assignees if present - Issue type uses assignees array of strings
		if (issue.assignees && issue.assignees.length > 0) {
			result.assignees = issue.assignees.map(name => ({
				id: name,
				displayName: name,
			}))
		}

		// Fetch and add comments if requested
		if (includeComments) {
			const comments = await this.tracker.getComments(number)
			result.comments = comments.map((comment: {
				id: string
				body: string
				author: { displayName: string; emailAddress: string; accountId: string }
				createdAt: string
				updatedAt: string
			}) => ({
				id: comment.id,
				body: comment.body,
				author: normalizeAuthor(comment.author),
				createdAt: comment.createdAt,
				updatedAt: comment.updatedAt,
			}))
		}

		return result
	}

	/**
	 * Fetch a specific comment by ID
	 */
	async getComment(input: GetCommentInput): Promise<CommentDetailResult> {
		const { commentId, number } = input

		// Fetch all comments and find the specific one
		const comments = await this.tracker.getComments(number)
		const comment = comments.find(c => c.id === commentId)

		if (!comment) {
			throw new Error(`Comment ${commentId} not found on issue ${number}`)
		}

		return {
			id: comment.id,
			body: comment.body,
			author: normalizeAuthor(comment.author),
			created_at: comment.createdAt,
			updated_at: comment.updatedAt,
		}
	}

	/**
	 * Create a new comment on an issue
	 */
	async createComment(input: CreateCommentInput): Promise<CommentResult> {
		const { number, body } = input
		const normalizedKey = this.tracker.normalizeIdentifier(number)

		// Jira doesn't distinguish between issue and PR comments
		const comment = await this.tracker.addComment(normalizedKey, body)

		return {
			id: comment.id,
			url: `${this.tracker.getConfig().host}/browse/${normalizedKey}?focusedCommentId=${comment.id}`,
			created_at: new Date().toISOString(),
		}
	}

	/**
	 * Update an existing comment
	 */
	async updateComment(input: UpdateCommentInput): Promise<CommentResult> {
		const { commentId, number, body } = input
		const normalizedKey = this.tracker.normalizeIdentifier(number)

		// Update comment via tracker
		await this.tracker.updateComment(normalizedKey, commentId, body)

		return {
			id: commentId,
			url: `${this.tracker.getConfig().host}/browse/${normalizedKey}?focusedCommentId=${commentId}`,
			updated_at: new Date().toISOString(),
		}
	}

	/**
	 * Create a new issue
	 */
	async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
		const { title, body } = input

		// Create issue via tracker (labels not supported in current implementation)
		const issue = await this.tracker.createIssue(title, body)

		const result: CreateIssueResult = {
			id: String(issue.number),
			url: issue.url,
		}

		// Only add number if it's actually a number
		if (typeof issue.number === 'number') {
			result.number = issue.number
		}

		return result
	}
}
