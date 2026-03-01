import path from 'path'
import os from 'os'
import fs from 'fs-extra'
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
		if (jiraSettings?.defaultIssueType) {
			envVars.JIRA_DEFAULT_ISSUE_TYPE = jiraSettings.defaultIssueType
		}
		if (jiraSettings?.defaultSubtaskType) {
			envVars.JIRA_DEFAULT_SUBTASK_TYPE = jiraSettings.defaultSubtaskType
		}

		logger.debug('Generated MCP config for Jira issue management', {
			provider,
			hasApiToken: !!jiraSettings?.apiToken,
			projectKey: jiraSettings?.projectKey,
			contextType: contextType ?? 'auto-detect',
		})
	}

	// Compute absolute path to the MCP server JS file
	const serverJsPath = path.join(path.dirname(new globalThis.URL(import.meta.url).pathname), '../dist/mcp/issue-management-server.js')
	const resolvedServerJsPath = path.resolve(serverJsPath)

	// Generate single MCP server config
	const mcpServerConfig = {
		mcpServers: {
			issue_management: {
				transport: 'stdio',
				command: 'node',
				args: [resolvedServerJsPath],
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
export function slugifyPath(loomPath: string): string {
	let slug = loomPath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

/**
 * Resolve recap file path for a given worktree path
 */
export function resolveRecapFilePath(worktreePath: string): string {
	const recapsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')
	return path.join(recapsDir, slugifyPath(worktreePath))
}

/**
 * Read recap file (returns empty object if not found or invalid)
 */
export async function readRecapFile(filePath: string): Promise<Record<string, unknown>> {
	try {
		if (await fs.pathExists(filePath)) {
			const content = await fs.readFile(filePath, 'utf8')
			return JSON.parse(content) as Record<string, unknown>
		}
	} catch {
		// Ignore read errors - return empty recap
	}
	return {}
}

/**
 * Write recap file (ensures parent directory exists)
 */
export async function writeRecapFile(filePath: string, recap: Record<string, unknown>): Promise<void> {
	await fs.ensureDir(path.dirname(filePath), { mode: 0o755 })
	await fs.writeFile(filePath, JSON.stringify(recap, null, 2), { mode: 0o644 })
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

	// Compute metadata file path (same directory/naming as MetadataManager)
	const loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms')
	const metadataFilePath = path.join(loomsDir, slugifyPath(loomPath))

	// Pass env vars:
	// - RECAP_FILE_PATH: where to read/write recap data
	// - LOOM_METADATA_JSON: stringified loom metadata (parsed by MCP using LoomMetadata type)
	// - METADATA_FILE_PATH: path to loom metadata file (for state transition tools)
	const envVars = {
		RECAP_FILE_PATH: recapFilePath,
		LOOM_METADATA_JSON: JSON.stringify(loomMetadata),
		METADATA_FILE_PATH: metadataFilePath,
	}

	logger.debug('Generated MCP config for recap server', {
		loomPath,
		recapFilePath,
		loomMetadataDescription: loomMetadata.description,
	})

	// Compute absolute path to the recap MCP server JS file
	const recapServerJsPath = path.resolve(
		path.join(
			path.dirname(new globalThis.URL(import.meta.url).pathname),
			'../dist/mcp/recap-server.js'
		)
	)

	return [
		{
			mcpServers: {
				recap: {
					transport: 'stdio',
					command: 'node',
					args: [recapServerJsPath],
					env: envVars,
				},
			},
		},
	]
}

/**
 * Generate MCP configuration for the harness server
 *
 * The harness server provides Claude with a `signal` tool to send structured
 * messages to the iloom harness process via Unix domain socket.
 *
 * @param socketPath - Absolute path to the harness Unix domain socket
 */
export function generateHarnessMcpConfig(socketPath: string): Record<string, unknown>[] {
	const harnessServerJsPath = path.resolve(
		path.join(
			path.dirname(new globalThis.URL(import.meta.url).pathname),
			'../dist/mcp/harness-server.js'
		)
	)

	logger.debug('Generated MCP config for harness server', { socketPath })

	return [
		{
			mcpServers: {
				harness: {
					transport: 'stdio',
					command: 'node',
					args: [harnessServerJsPath],
					env: { ILOOM_HARNESS_SOCKET: socketPath },
				},
			},
		},
	]
}

/**
 * Get the MCP configs directory path
 */
export function getMcpConfigsDir(): string {
	return path.join(os.homedir(), '.config', 'iloom-ai', 'mcp-configs')
}

/**
 * Get the MCP config file path for a given loom path
 */
export function getMcpConfigFilePath(loomPath: string): string {
	return path.join(getMcpConfigsDir(), slugifyPath(loomPath))
}

/**
 * Generate and write a per-loom MCP config file to ~/.config/iloom-ai/mcp-configs/<loom-slug>.json
 *
 * Merges issue management and recap MCP server configs into a single file.
 * Used by swarm workers to pass --mcp-config <path> to claude -p commands.
 *
 * @param loomPath - Absolute path to the loom workspace
 * @param loomMetadata - The loom metadata object
 * @param provider - Issue tracker provider name
 * @param settings - Optional settings for provider configuration
 * @returns The absolute path to the written MCP config file
 */
export async function generateAndWriteMcpConfigFile(
	loomPath: string,
	loomMetadata: LoomMetadata,
	provider: 'github' | 'linear' | 'jira' = 'github',
	settings?: IloomSettings,
): Promise<string> {
	const mcpConfigs: Record<string, unknown>[] = []

	// Generate issue management MCP config
	try {
		const issueMcpConfigs = await generateIssueManagementMcpConfig(
			'issue',
			undefined,
			provider,
			settings,
		)
		mcpConfigs.push(...issueMcpConfigs)
	} catch (error) {
		logger.warn(`Failed to generate issue management MCP config for loom: ${error instanceof Error ? error.message : 'Unknown error'}`)
	}

	// Generate recap MCP config
	try {
		const recapMcpConfigs = generateRecapMcpConfig(loomPath, loomMetadata)
		mcpConfigs.push(...recapMcpConfigs)
	} catch (error) {
		logger.warn(`Failed to generate recap MCP config for loom: ${error instanceof Error ? error.message : 'Unknown error'}`)
	}

	// Merge all mcpServers into a single config object
	const mergedServers: Record<string, unknown> = {}
	for (const config of mcpConfigs) {
		if ('mcpServers' in config && typeof config.mcpServers === 'object') {
			Object.assign(mergedServers, config.mcpServers)
		}
	}

	const mergedConfig = { mcpServers: mergedServers }

	// Verify MCP server JS files exist before writing config
	for (const [serverName, serverConfig] of Object.entries(mergedServers)) {
		const config = serverConfig as { args?: string[] }
		const jsPath = config.args?.[0]
		if (jsPath) {
			const exists = await fs.pathExists(jsPath)
			if (!exists) {
				logger.warn(`MCP server JS file not found: ${serverName} -> ${jsPath}`)
			}
		}
	}

	// Write to file
	const configDir = getMcpConfigsDir()
	await fs.ensureDir(configDir, { mode: 0o755 })

	const configFilePath = getMcpConfigFilePath(loomPath)
	await fs.writeFile(configFilePath, JSON.stringify(mergedConfig, null, 2), { mode: 0o644 })

	return configFilePath
}