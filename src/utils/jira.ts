/**
 * Jira utilities for the issues command
 * Follows the pattern of fetchGitHubIssueList and fetchLinearIssueList
 */

import type { JiraApiClient, JiraIssue } from '../lib/providers/jira/index.js'

/**
 * Escape a string value for safe interpolation into JQL queries.
 * Prevents JQL injection by escaping backslashes and double quotes.
 */
export function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export interface JiraIssueListItem {
  id: string        // issue key e.g. "PROJ-123"
  title: string     // fields.summary
  updatedAt: string // fields.updated (ISO string)
  url: string       // {host}/browse/{key}
  state: string     // fields.status.name
}

/**
 * Fetch a list of Jira issues for a project, excluding done statuses
 * @param client - Configured JiraApiClient instance
 * @param options - Fetch options
 * @returns Array of issues sorted by updated date
 */
export async function fetchJiraIssueList(
  client: JiraApiClient,
  options: {
    host: string
    projectKey: string
    doneStatuses?: string[]
    limit?: number
    sprint?: string | undefined
    mine?: boolean | undefined
  },
): Promise<JiraIssueListItem[]> {
  const { host, projectKey, doneStatuses = ['Done'], limit = 100, sprint, mine } = options

  // Build JQL with status exclusion
  const statusExclusions = doneStatuses.map((s) => `"${escapeJql(s)}"`).join(', ')
  let jql = `project = "${escapeJql(projectKey)}" AND status NOT IN (${statusExclusions})`

  // Add sprint filter
  if (sprint === 'current') {
    jql += ' AND sprint in openSprints()'
  } else if (sprint) {
    jql += ` AND sprint = "${escapeJql(sprint)}"`
  }

  // Add assignee filter
  if (mine) {
    jql += ' AND assignee = currentUser()'
  }

  jql += ' ORDER BY updated DESC'

  const issues: JiraIssue[] = await client.searchIssues(jql)

  const baseUrl = host.replace(/\/$/, '')

  return issues.slice(0, limit).map((issue) => ({
    id: issue.key,
    title: issue.fields.summary,
    updatedAt: issue.fields.updated,
    url: `${baseUrl}/browse/${issue.key}`,
    state: issue.fields.status.name,
  }))
}
