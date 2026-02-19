import path from 'path'
import os from 'os'
import { getRepoInfo } from './github.js'
import { logger } from './logger.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import type { LoomMetadata } from '../lib/MetadataManager.js'

/**
 * Generate MCP configuration for issue management
 * Uses a single server that can handle both issues and pull requests
 * Returns array of MCP server config objects
 * @param contextType - Optional context type (issue or pr)
 * @param repo - Optional repo in "owner/repo" format. If not provided, will auto-detect from git.
 * @param provider - Issue management provider (default: 'github')
 * @param settings - Optional settings to extract Linear API token from
 * @param draftPrNumber - Optional draft PR number for github-draft-pr mode (routes comments to PR)
 */
export async function generateIssueManagementMcpConfig(
	contextType?: 'issue' | 'pr',
	repo?: string,
	provider: 'github' | 'linear' | 'jira' = 'github',
	settings?: IloomSettings,
	draftPrNumber?: number
): Promise<Record<string, unknown>[]> {
	// When draftPrNumber is provided (github-draft-pr mode), force contextType to 'pr'
	// This ensures agents route comments to the draft PR instead of the issue
	const effectiveContextType = draftPrNumber ? 'pr' : contextType

	// Build provider-specific environment variables
	let envVars: Record<string, string> = {
		ISSUE_PROVIDER: provider,
	}

	// Add draft PR number to env vars if provided
	if (draftPrNumber) {
		envVars.DRAFT_PR_NUMBER = String(draftPrNumber)
	}

	if (provider === 'github') {
		// Get repository information for GitHub - either from provided repo string or auto-detect
		let owner: string
		let name: string

		if (repo) {
			const parts = repo.split('/')
			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				throw new Error(`Invalid repo format: ${repo}. Expected "owner/repo"`)
			}
			owner = parts[0]
			name = parts[1]
		} else {
			const repoInfo = await getRepoInfo()
			owner = repoInfo.owner
			name = repoInfo.name
		}

		// Map logical types to GitHub's webhook event names (handle GitHub's naming quirk here)
		// Use effectiveContextType which may be overridden by draftPrNumber
		const githubEventName = effectiveContextType === 'issue' ? 'issues' : effectiveContextType === 'pr' ? 'pull_request' : undefined

		envVars = {
			...envVars,
			REPO_OWNER: owner,
			REPO_NAME: name,
			GITHUB_API_URL: 'https://api.github.com/',
			...(githubEventName && { GITHUB_EVENT_NAME: githubEventName }),
		}

		logger.debug('Generated MCP config for GitHub issue management', {
			provider,
			repoOwner: owner,
			repoName: name,
			contextType: effectiveContextType ?? 'auto-detect',
			githubEventName: githubEventName ?? 'auto-detect',
			draftPrNumber: draftPrNumber ?? undefined,
		})
	} else if (provider === 'linear') {
		// Linear needs API token passed through
		const apiToken = settings?.issueManagement?.linear?.apiToken ?? process.env.LINEAR_API_TOKEN

		if (apiToken) {
			envVars.LINEAR_API_TOKEN = apiToken
		}

		// Pass through LINEAR_TEAM_KEY from settings (primary) or env var (fallback)
		// Settings teamId is the preferred source as it's configured via `il init`
		const teamKey = settings?.issueManagement?.linear?.teamId ?? process.env.LINEAR_TEAM_KEY
		if (teamKey) {
			envVars.LINEAR_TEAM_KEY = teamKey
		}

		logger.debug('Generated MCP config for Linear issue management', {
			provider,
			hasApiToken: !!apiToken,
			hasTeamKey: !!teamKey,
			contextType: contextType ?? 'auto-detect',
		})
	} else if (provider === 'jira') {
		// Jira configuration - pass credentials via environment variables
		const jiraSettings = settings?.issueManagement?.jira

		if (jiraSettings?.host) {
			envVars.JIRA_HOST = jiraSettings.host
		}
		if (jiraSettings?.username) {
			envVars.JIRA_USERNAME = jiraSettings.username
		}
		if (jiraSettings?.apiToken) {
			envVars.JIRA_API_TOKEN = jiraSettings.apiToken
		}
		if (jiraSettings?.projectKey) {
			envVars.JIRA_PROJECT_KEY = jiraSettings.projectKey
		}
		if (jiraSettings?.transitionMappings) {
			envVars.JIRA_TRANSITION_MAPPINGS = JSON.stringify(jiraSettings.transitionMappings)
		}

		logger.debug('Generated MCP config for Jira issue management', {
			provider,
			hasApiToken: !!jiraSettings?.apiToken,
			projectKey: jiraSettings?.projectKey,
			contextType: contextType ?? 'auto-detect',
		})
	}

	// Generate single MCP server config
	const mcpServerConfig = {
		mcpServers: {
			issue_management: {
				transport: 'stdio',
				command: 'node',
				args: [path.join(path.dirname(new globalThis.URL(import.meta.url).pathname), '../dist/mcp/issue-management-server.js')],
				env: envVars,
			},
		},
	}

	return [mcpServerConfig]
}

/**
 * Reuse MetadataManager.slugifyPath() algorithm for recap file naming
 *
 * Algorithm:
 * 1. Trim trailing slashes
 * 2. Replace all path separators (/ or \) with ___ (triple underscore)
 * 3. Replace any other non-alphanumeric characters (except _ and -) with -
 * 4. Append .json
 */
function slugifyPath(loomPath: string): string {
	let slug = loomPath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

/**
 * Generate MCP configuration for recap server
 *
 * The recap server captures session context (goal, decisions, insights, risks, assumptions)
 * for the VS Code Loom Context Panel.
 *
 * @param loomPath - Absolute path to the loom workspace
 * @param loomMetadata - The loom metadata object (will be stringified as JSON)
 */
export function generateRecapMcpConfig(
	loomPath: string,
	loomMetadata: LoomMetadata
): Record<string, unknown>[] {
	// Compute recap file path using slugifyPath algorithm (same as MetadataManager)
	const recapsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')
	const recapFilePath = path.join(recapsDir, slugifyPath(loomPath))

	// Pass both env vars:
	// - RECAP_FILE_PATH: where to read/write recap data
	// - LOOM_METADATA_JSON: stringified loom metadata (parsed by MCP using LoomMetadata type)
	const envVars = {
		RECAP_FILE_PATH: recapFilePath,
		LOOM_METADATA_JSON: JSON.stringify(loomMetadata),
	}

	logger.debug('Generated MCP config for recap server', {
		loomPath,
		recapFilePath,
		loomMetadataDescription: loomMetadata.description,
	})

	return [
		{
			mcpServers: {
				recap: {
					transport: 'stdio',
					command: 'node',
					args: [
						path.join(
							path.dirname(new globalThis.URL(import.meta.url).pathname),
							'../dist/mcp/recap-server.js'
						),
					],
					env: envVars,
				},
			},
		},
	]
}