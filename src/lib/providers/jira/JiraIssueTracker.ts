// JiraIssueTracker - Implements IssueTracker interface for Jira
// Provides issue management operations via Jira REST API

import type { IssueTracker } from '../../IssueTracker.js'
import type { Issue, IssueTrackerInputDetection } from '../../../types/index.js'
import { JiraApiClient, type JiraConfig, type JiraIssue, type JiraTransition } from './JiraApiClient.js'
import { getLogger } from '../../../utils/logger-context.js'
import { adfToMarkdown } from './AdfMarkdownConverter.js'

/**
 * Jira-specific configuration
 */
export interface JiraTrackerConfig extends JiraConfig {
	projectKey: string
	transitionMappings?: Record<string, string> // Map iloom states to Jira transition names
}

/**
 * JiraIssueTracker implements IssueTracker for Jira
 * 
 * Key differences from GitHub/Linear:
 * - Issue identifiers are strings (e.g., "PROJ-123")
 * - No issue prefix (unlike GitHub's "#")
 * - State changes require workflow transitions (not direct status updates)
 * - Content uses Atlassian Document Format (ADF), converted to/from Markdown
 */
export class JiraIssueTracker implements IssueTracker {
	readonly providerName = 'jira'
	readonly supportsPullRequests = false

	private readonly client: JiraApiClient
	private readonly config: JiraTrackerConfig

	constructor(config: JiraTrackerConfig) {
		this.config = config
		this.client = new JiraApiClient({
			host: config.host,
			username: config.username,
			apiToken: config.apiToken,
		})
	}

	/**
	 * Normalize identifier to canonical uppercase form
	 * Jira issue keys are case-sensitive in the API (must be uppercase)
	 */
	normalizeIdentifier(identifier: string | number): string {
		return String(identifier).toUpperCase()
	}

	/**
	 * Detect input type from user input
	 * Jira issues follow pattern: PROJECTKEY-123 (case-insensitive)
	 */
	async detectInputType(input: string): Promise<IssueTrackerInputDetection> {
		// Pattern: PROJECTKEY-123 (case-insensitive to accept lowercase from branch names or user input)
		const jiraPattern = /^([A-Z][A-Z0-9]+)-(\d+)$/i
		const match = input.match(jiraPattern)

		if (!match) {
			return { type: 'unknown', identifier: null, rawInput: input }
		}

		const issueKey = this.normalizeIdentifier(input)
		getLogger().debug('Checking if input is a Jira issue', { issueKey })

		// Verify the issue exists
		try {
			await this.client.getIssue(issueKey)
			return { type: 'issue', identifier: issueKey, rawInput: input }
		} catch (error) {
			getLogger().debug('Issue not found', { issueKey, error })
			return { type: 'unknown', identifier: null, rawInput: input }
		}
	}

	/**
	 * Fetch issue details
	 */
	async fetchIssue(identifier: string | number): Promise<Issue> {
		const issueKey = this.normalizeIdentifier(identifier)
		getLogger().debug('Fetching Jira issue', { issueKey })

		const jiraIssue = await this.client.getIssue(issueKey)
		return this.mapJiraIssueToIssue(jiraIssue)
	}

	/**
	 * Check if issue exists (silent validation)
	 */
	async isValidIssue(identifier: string | number): Promise<Issue | false> {
		try {
			return await this.fetchIssue(identifier)
		} catch (error) {
			getLogger().debug('Issue validation failed', { identifier, error })
			return false
		}
	}

	/**
	 * Validate issue state
	 * Note: Jira doesn't have a simple "closed" state - depends on workflow
	 */
	async validateIssueState(issue: Issue): Promise<void> {
		// Jira state validation is workflow-specific
		// For now, we'll just log the state
		getLogger().debug('Jira issue state', { issueKey: issue.number, state: issue.state })
		
		// Could add custom validation logic here based on config
		// For example, warn if issue is in "Done" state
		if (issue.state.toLowerCase() === 'done') {
			getLogger().warn('Issue is already in Done state', { issueKey: issue.number })
		}
	}

	/**
	 * Create a new issue
	 */
	async createIssue(
		title: string,
		body: string,
		_repository?: string,
		_labels?: string[]
	): Promise<{ number: string | number; url: string }> {
		getLogger().debug('Creating Jira issue', { title, projectKey: this.config.projectKey })

		// Convert markdown body to plain text for Jira description
		// Note: Jira API expects Atlassian Document Format (ADF)
		// We use a simplified plain text approach here
		const jiraIssue = await this.client.createIssue(
			this.config.projectKey,
			title,
			body
		)

		return {
			number: jiraIssue.key,
			url: `${this.config.host}/browse/${jiraIssue.key}`,
		}
	}

	/**
	 * Get issue URL
	 */
	async getIssueUrl(identifier: string | number): Promise<string> {
		const issueKey = this.normalizeIdentifier(identifier)
		return `${this.config.host}/browse/${issueKey}`
	}

	/**
	 * Move issue to "In Progress" state
	 * Uses configured transition mapping or default transition name
	 */
	async moveIssueToInProgress(identifier: string | number): Promise<void> {
		const issueKey = this.normalizeIdentifier(identifier)
		getLogger().debug('Moving Jira issue to In Progress', { issueKey })

		// Get available transitions
		const transitions = await this.client.getTransitions(issueKey)
		
		// Look for the transition in config mapping or use default names
		const transitionName = this.config.transitionMappings?.['In Progress'] 
			?? this.findTransitionByName(transitions, ['In Progress', 'Start Progress', 'Start'])

		if (!transitionName) {
			throw new Error(
				`Could not find "In Progress" transition for ${issueKey}. ` +
				`Available transitions: ${transitions.map(t => t.name).join(', ')}. ` +
				`Configure custom mapping in settings.json: issueManagement.jira.transitionMappings`
			)
		}

		// Find transition ID
		const transition = transitions.find(t => t.name === transitionName)
		if (!transition) {
			throw new Error(`Transition "${transitionName}" not found`)
		}

		await this.client.transitionIssue(issueKey, transition.id)
		getLogger().info('Issue transitioned successfully', { issueKey, transition: transitionName })
	}

	/**
	 * Move issue to "Ready for Review" state
	 * Uses configured transition mapping or default transition name
	 */
	async moveIssueToReadyForReview(identifier: string | number): Promise<void> {
		const issueKey = this.normalizeIdentifier(identifier)
		getLogger().debug('Moving Jira issue to Ready for Review', { issueKey })

		// Get available transitions
		const transitions = await this.client.getTransitions(issueKey)

		// Look for the transition in config mapping or use default names
		const transitionName = this.config.transitionMappings?.['Ready for Review']
			?? this.findTransitionByName(transitions, ['Ready for Review', 'In Review', 'Code Review', 'Review'])

		if (!transitionName) {
			throw new Error(
				`Could not find "Ready for Review" transition for ${issueKey}. ` +
				`Available transitions: ${transitions.map(t => t.name).join(', ')}. ` +
				`Configure custom mapping in settings.json: issueManagement.jira.transitionMappings`
			)
		}

		// Find transition ID
		const transition = transitions.find(t => t.name === transitionName)
		if (!transition) {
			throw new Error(`Transition "${transitionName}" not found`)
		}

		await this.client.transitionIssue(issueKey, transition.id)
		getLogger().info('Issue transitioned to Ready for Review', { issueKey, transition: transitionName })
	}

	/**
	 * Extract context from issue for AI prompts
	 */
	extractContext(entity: Issue): string {
		return `Issue: ${entity.number}
Title: ${entity.title}
Status: ${entity.state}
URL: ${entity.url}

Description:
${entity.body}

${entity.labels.length > 0 ? `Labels: ${entity.labels.join(', ')}` : ''}
${entity.assignees.length > 0 ? `Assignees: ${entity.assignees.join(', ')}` : ''}`
	}

	/**
	 * Get issue details (alias for fetchIssue for MCP compatibility)
	 */
	async getIssue(identifier: string | number): Promise<Issue> {
		return this.fetchIssue(identifier)
	}

	/**
	 * Get all comments for an issue
	 */
	async getComments(identifier: string | number): Promise<Array<{
		id: string
		body: string
		author: { displayName: string; emailAddress: string; accountId: string }
		createdAt: string
		updatedAt: string
	}>> {
		const issueKey = this.normalizeIdentifier(identifier)
		getLogger().debug('Fetching Jira comments', { issueKey })

		const comments = await this.client.getComments(issueKey)
		
		// Map to expected format
		return comments.map(comment => ({
			id: comment.id,
			body: adfToMarkdown(comment.body),
			author: comment.author,
			createdAt: comment.created,
			updatedAt: comment.updated,
		}))
	}

	/**
	 * Add a comment to an issue
	 */
	async addComment(identifier: string | number, body: string): Promise<{ id: string }> {
		const issueKey = this.normalizeIdentifier(identifier)
		getLogger().debug('Adding Jira comment', { issueKey })

		const comment = await this.client.addComment(issueKey, body)
		return { id: comment.id }
	}

	/**
	 * Update an existing comment
	 */
	async updateComment(identifier: string | number, commentId: string, body: string): Promise<void> {
		const issueKey = this.normalizeIdentifier(identifier)
		getLogger().debug('Updating Jira comment', { issueKey, commentId })

		await this.client.updateComment(issueKey, commentId, body)
	}

	/**
	 * Get configuration (for MCP provider)
	 */
	getConfig(): JiraTrackerConfig {
		return this.config
	}

	/**
	 * Map Jira API issue to generic Issue type
	 */
	private mapJiraIssueToIssue(jiraIssue: JiraIssue): Issue & {
		id?: string
		key?: string
		author?: {
			displayName: string
			emailAddress: string
			accountId: string
		}
		assignee?: {
			displayName: string
			emailAddress: string
			accountId: string
		} | null
		issueType?: string
		status?: string
	} {
		// Extract description - handle ADF format or plain string
		const description = adfToMarkdown(jiraIssue.fields.description)

		return {
			id: jiraIssue.id,
			key: jiraIssue.key,
			number: jiraIssue.key,
			title: jiraIssue.fields.summary,
			body: description,
			state: jiraIssue.fields.status.name.toLowerCase() as 'open' | 'closed',
			labels: jiraIssue.fields.labels,
			assignees: jiraIssue.fields.assignee 
				? [jiraIssue.fields.assignee.displayName]
				: [],
			assignee: jiraIssue.fields.assignee,
			author: jiraIssue.fields.reporter,
			url: `${this.config.host}/browse/${jiraIssue.key}`,
			issueType: jiraIssue.fields.issuetype.name,
			status: jiraIssue.fields.status.name,
		}
	}

	/**
	 * Find a transition by name, trying multiple possible names
	 */
	private findTransitionByName(transitions: JiraTransition[], names: string[]): string | null {
		for (const name of names) {
			const transition = transitions.find(t => 
				t.name.toLowerCase() === name.toLowerCase()
			)
			if (transition) {
				return transition.name
			}
		}
		return null
	}
}
