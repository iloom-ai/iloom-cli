import path from 'path'
import { getRepoInfo } from './github.js'
import { logger } from './logger.js'

/**
 * Generate MCP configuration for issue management
 * Uses a single server that can handle both issues and pull requests
 * Returns array of MCP server config objects
 * @param contextType - Optional context type (issue or pr)
 * @param repo - Optional repo in "owner/repo" format. If not provided, will auto-detect from git.
 * @param provider - Issue management provider (default: 'github')
 */
export async function generateIssueManagementMcpConfig(
	contextType?: 'issue' | 'pr',
	repo?: string,
	provider: 'github' | 'linear' = 'github'
): Promise<Record<string, unknown>[]> {
	// Build provider-specific environment variables
	let envVars: Record<string, string> = {
		ISSUE_PROVIDER: provider,
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
		const githubEventName = contextType === 'issue' ? 'issues' : contextType === 'pr' ? 'pull_request' : undefined

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
			contextType: contextType ?? 'auto-detect',
			githubEventName: githubEventName ?? 'auto-detect'
		})
	} else {
		// Linear needs API token for GraphQL calls
		// Get from env var (settings are not available in this context)
		const linearApiToken = process.env.LINEAR_API_TOKEN
		if (linearApiToken) {
			envVars = {
				...envVars,
				LINEAR_API_TOKEN: linearApiToken,
			}
		}
		logger.debug('Generated MCP config for Linear issue management', {
			provider,
			contextType: contextType ?? 'auto-detect',
			hasApiToken: !!linearApiToken,
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