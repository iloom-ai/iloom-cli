/**
 * Worktree MCP Server
 *
 * Provides the orchestrator with a `create_worktree` tool for just-in-time
 * child worktree creation during swarm execution. This ensures each worktree
 * is branched from the latest epic branch HEAD, producing higher-quality
 * agent output and fewer merge conflicts for later waves.
 *
 * Environment variables (all required):
 * - EPIC_WORKTREE_PATH: Path to the epic worktree (source for agent files)
 * - EPIC_BRANCH: Epic branch name (base for child branches)
 * - MAIN_WORKTREE_PATH: Path to main worktree (for generateWorktreePath)
 * - EPIC_ISSUE_NUMBER: Parent epic issue number (for metadata parentLoom)
 * - ISSUE_TRACKER: Provider name (github/linear/jira)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import path from 'path'
import fs from 'fs-extra'
import { executeGitCommand, generateWorktreePath } from '../utils/git.js'
import { preAcceptClaudeTrust } from '../utils/claude-trust.js'
import { installDependencies } from '../utils/package-manager.js'
import { generateAndWriteMcpConfigFile } from '../utils/mcp.js'
import { MetadataManager, type SwarmState } from '../lib/MetadataManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { SettingsManager } from '../lib/SettingsManager.js'

/**
 * Validated environment variables for the worktree server
 */
export interface WorktreeServerEnv {
	epicWorktreePath: string
	epicBranch: string
	mainWorktreePath: string
	epicIssueNumber: string
	issueTracker: string
}

/**
 * Result of the create_worktree tool
 */
export interface CreateWorktreeResult {
	worktreePath: string
	branchName: string
	alreadyExisted: boolean
}

/**
 * Validate required environment variables.
 * Exits with error if any are missing.
 */
function validateEnvironment(): WorktreeServerEnv {
	const required: Record<string, string | undefined> = {
		EPIC_WORKTREE_PATH: process.env.EPIC_WORKTREE_PATH,
		EPIC_BRANCH: process.env.EPIC_BRANCH,
		MAIN_WORKTREE_PATH: process.env.MAIN_WORKTREE_PATH,
		EPIC_ISSUE_NUMBER: process.env.EPIC_ISSUE_NUMBER,
		ISSUE_TRACKER: process.env.ISSUE_TRACKER,
	}

	const missing = Object.entries(required)
		.filter(([, value]) => !value)
		.map(([key]) => key)

	if (missing.length > 0) {
		console.error(`Missing required environment variables: ${missing.join(', ')}`)
		process.exit(1)
	}

	// Safe to cast: we've verified all values are defined above
	return {
		epicWorktreePath: required.EPIC_WORKTREE_PATH as string,
		epicBranch: required.EPIC_BRANCH as string,
		mainWorktreePath: required.MAIN_WORKTREE_PATH as string,
		epicIssueNumber: required.EPIC_ISSUE_NUMBER as string,
		issueTracker: required.ISSUE_TRACKER as string,
	}
}

// Store validated env for use in tool handlers
let validatedEnv: WorktreeServerEnv | null = null

/**
 * Get the validated environment config.
 * Throws if called before validateEnvironment().
 */
function getEnv(): WorktreeServerEnv {
	if (!validatedEnv) {
		throw new Error('Environment not validated - validateEnvironment() must be called first')
	}
	return validatedEnv
}

/**
 * Create a child worktree for a given issue number.
 *
 * Replicates the 6 per-child setup steps from SwarmSetupService.createChildWorktrees():
 * 1. Compute branch name and worktree path
 * 2. Check idempotency (return early if worktree already exists)
 * 3. Create git worktree from current HEAD of epic branch
 * 4. Pre-accept Claude trust for the new worktree
 * 5. Write metadata with state: 'pending' and parentLoom
 * 6. Generate and write MCP config file + iloom-swarm-mcp-config-path
 * 7. Install dependencies in the new worktree
 * 8. Copy agent files from epic worktree to child worktree
 *
 * On partial failure after worktree creation, cleans up the worktree to avoid zombies.
 *
 * @param issueNumber - The issue number (e.g., "123" or "ENG-123")
 * @param env - Validated environment configuration
 * @returns Result with worktreePath, branchName, and alreadyExisted flag
 */
export async function createWorktree(
	issueNumber: string,
	env: WorktreeServerEnv,
): Promise<CreateWorktreeResult> {
	// Step 1: Compute branch name and worktree path
	// Sanitize ID for safe git branch naming (replace non-alphanumeric except - and _ with -)
	const safeId = issueNumber.replace(/^#/, '').replace(/[^a-zA-Z0-9-_]/g, '-')
	const branchName = `issue/${safeId}`
	const worktreePath = generateWorktreePath(branchName, env.mainWorktreePath)

	// Step 2: Idempotency check - if worktree already exists, return early
	if (await fs.pathExists(worktreePath)) {
		console.error(`Worktree already exists at ${worktreePath}, returning existing`)
		return { worktreePath, branchName, alreadyExisted: true }
	}

	// Step 3: Create git worktree from epic branch HEAD
	console.error(`Creating worktree for issue ${issueNumber} at ${worktreePath}...`)
	try {
		await executeGitCommand(
			['worktree', 'add', '-b', branchName, worktreePath, env.epicBranch],
			{ cwd: env.mainWorktreePath, timeout: 300000 },
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to create git worktree: ${message}`)
	}

	// From this point, if anything fails we clean up the worktree
	try {
		// Step 4: Pre-accept Claude Code trust for child worktree
		try {
			await preAcceptClaudeTrust(worktreePath)
		} catch (error) {
			console.error(`Warning: Failed to pre-accept Claude trust: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Step 5: Update metadata with worktree-specific fields
		const metadataManager = new MetadataManager()

		// Metadata was already written by createChildMetadata() during spin.
		// Use updateMetadata() to merge worktree-specific fields without overwriting
		// the existing description, issueUrls, and other rich metadata.
		await metadataManager.updateMetadata(worktreePath, {
			worktreePath,
			branchName,
			state: 'pending' as SwarmState,
			parentLoom: {
				type: 'epic',
				identifier: env.epicIssueNumber,
				branchName: env.epicBranch,
				worktreePath: env.epicWorktreePath,
			},
		})

		// Step 6: Generate and write per-loom MCP config file
		try {
			const childMetadata = await metadataManager.readMetadata(worktreePath)
			if (childMetadata) {
				const settingsManager = new SettingsManager()
				const settings = await settingsManager.loadSettings()
				const providerName = IssueTrackerFactory.getProviderName(settings) as 'github' | 'linear' | 'jira'
				const mcpConfigPath = await generateAndWriteMcpConfigFile(
					worktreePath,
					childMetadata,
					providerName,
					settings,
				)
				await metadataManager.updateMetadata(worktreePath, { mcpConfigPath })

				// Write MCP config path to .claude/iloom-swarm-mcp-config-path for worker discovery
				const claudeDir = path.join(worktreePath, '.claude')
				await fs.ensureDir(claudeDir)
				await fs.writeFile(
					path.join(claudeDir, 'iloom-swarm-mcp-config-path'),
					mcpConfigPath,
					'utf-8',
				)

				console.error(`Wrote MCP config for issue ${issueNumber}: ${mcpConfigPath}`)
			}
		} catch (error) {
			// Non-fatal: child can still work without MCP config
			console.error(`Warning: Failed to write MCP config for issue ${issueNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Step 7: Install dependencies in the child worktree
		try {
			await installDependencies(worktreePath, true, true)
		} catch (error) {
			console.error(`Warning: Failed to install dependencies for issue ${issueNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}

		// Step 8: Copy agent files from epic worktree to child worktree
		const sourceAgentsDir = path.join(env.epicWorktreePath, '.claude', 'agents')
		if (await fs.pathExists(sourceAgentsDir)) {
			try {
				const targetAgentsDir = path.join(worktreePath, '.claude', 'agents')
				await fs.copy(sourceAgentsDir, targetAgentsDir, { overwrite: true })
				console.error(`Copied .claude/agents/ to ${worktreePath}`)
			} catch (error) {
				// Non-fatal: worker can fall back to epic worktree path
				console.error(`Warning: Failed to copy agents for issue ${issueNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		}

		console.error(`Successfully created worktree for issue ${issueNumber}`)
		return { worktreePath, branchName, alreadyExisted: false }
	} catch (error) {
		// Clean up the worktree on failure to avoid zombies
		console.error(`Worktree creation failed after git worktree add, cleaning up ${worktreePath}...`)
		try {
			await executeGitCommand(
				['worktree', 'remove', '--force', worktreePath],
				{ cwd: env.mainWorktreePath, timeout: 30000 },
			)
		} catch {
			console.error(`Warning: Could not clean up worktree at ${worktreePath}`)
		}
		throw error
	}
}

// Initialize MCP server
const server = new McpServer({
	name: 'iloom-worktree',
	version: '0.1.0',
})

// Register create_worktree tool
server.registerTool(
	'create_worktree',
	{
		title: 'Create Worktree',
		description:
			'Create a child worktree for a given issue number, branched from the current epic branch HEAD. ' +
			'Handles all setup: git worktree creation, Claude trust, metadata, MCP config, dependency installation, and agent file copying. ' +
			'Idempotent: returns existing worktree if already created.',
		inputSchema: {
			issueNumber: z.string().describe('The issue number to create a worktree for (e.g., "123" or "ENG-123")'),
		},
	},
	async ({ issueNumber }) => {
		const env = getEnv()

		try {
			const result = await createWorktree(issueNumber, env)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err)
			return {
				content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
				isError: true,
			}
		}
	}
)

// Main server startup
async function main(): Promise<void> {
	console.error('=== Iloom Worktree MCP Server Starting ===')
	console.error(`PID: ${process.pid}`)
	console.error(`Node version: ${process.version}`)
	console.error(`CWD: ${process.cwd()}`)
	console.error(`Script: ${fileURLToPath(import.meta.url)}`)

	console.error('Environment variables:')
	console.error(`  EPIC_WORKTREE_PATH=${process.env.EPIC_WORKTREE_PATH ?? '<not set>'}`)
	console.error(`  EPIC_BRANCH=${process.env.EPIC_BRANCH ?? '<not set>'}`)
	console.error(`  MAIN_WORKTREE_PATH=${process.env.MAIN_WORKTREE_PATH ?? '<not set>'}`)
	console.error(`  EPIC_ISSUE_NUMBER=${process.env.EPIC_ISSUE_NUMBER ?? '<not set>'}`)
	console.error(`  ISSUE_TRACKER=${process.env.ISSUE_TRACKER ?? '<not set>'}`)

	validatedEnv = validateEnvironment()
	console.error(`Epic worktree: ${validatedEnv.epicWorktreePath}`)
	console.error(`Epic branch: ${validatedEnv.epicBranch}`)
	console.error(`Main worktree: ${validatedEnv.mainWorktreePath}`)

	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('=== Iloom Worktree MCP Server READY (stdio transport) ===')
}

// Only run main when executed directly (not when imported in tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
	main().catch((error) => {
		console.error('Fatal error starting MCP server:', error)
		process.exit(1)
	})
}
