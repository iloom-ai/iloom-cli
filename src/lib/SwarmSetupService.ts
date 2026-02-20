import path from 'path'
import fs from 'fs-extra'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { MetadataManager, type WriteMetadataInput, type SwarmState } from './MetadataManager.js'
import { AgentManager } from './AgentManager.js'
import { SettingsManager, type IloomSettings } from './SettingsManager.js'
import { PromptTemplateManager, buildReviewTemplateVariables, type TemplateVariables } from './PromptTemplateManager.js'
import { IssueTrackerFactory } from './IssueTrackerFactory.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { getLogger } from '../utils/logger-context.js'
import { installDependencies } from '../utils/package-manager.js'
import { generateWorktreePath } from '../utils/git.js'
import { generateAndWriteMcpConfigFile } from '../utils/mcp.js'

/**
 * Result of the swarm setup process
 */
export interface SwarmSetupResult {
	epicWorktreePath: string
	epicBranch: string
	childWorktrees: Array<{
		issueId: string
		worktreePath: string
		branch: string
		success: boolean
		error?: string
	}>
	agentsRendered: string[]
	workerAgentRendered: boolean
}

/**
 * Metadata extracted from agent YAML frontmatter for use in claude -p commands.
 * Maps agent file name (without .md) to model and tools info.
 */
export interface SwarmAgentMetadata {
	[agentFileName: string]: {
		model: string
		tools?: string[]
	}
}

/**
 * Child issue data as stored in epic metadata
 */
export interface SwarmChildIssue {
	number: string   // Prefixed: "#123" for GitHub, "ENG-123" for Linear
	title: string
	body: string
	url: string
}

/**
 * SwarmSetupService handles the creation of child worktrees
 * for swarm mode, plus rendering swarm-mode agents and skill files.
 *
 * Called from the spin command (ignite.ts) when an epic loom is detected.
 * The epic worktree already exists (created by `il start`).
 */
export class SwarmSetupService {
	constructor(
		private gitWorktree: GitWorktreeManager,
		private metadataManager: MetadataManager,
		private agentManager: AgentManager,
		private settingsManager: SettingsManager,
		private templateManager: PromptTemplateManager,
	) {}

	/**
	 * Create child worktrees for each child issue, branched off the epic branch.
	 * Writes iloom-metadata.json for each child with state: 'pending' and parentLoom.
	 * Generates and writes per-loom MCP config file for each child.
	 *
	 * Uses standard iloom naming conventions via generateWorktreePath().
	 *
	 * @param childIssues - Array of child issues from epic metadata
	 * @param epicBranch - The epic branch name (base branch for children)
	 * @param epicWorktreePath - Path to the epic worktree
	 * @param mainWorktreePath - Path to the main worktree (project root)
	 * @param epicIssueNumber - The parent epic issue number
	 * @param issueTrackerName - The issue tracker provider name (e.g., 'github')
	 * @param settings - Optional settings for MCP config generation
	 * @returns Array of results for each child worktree creation
	 */
	async createChildWorktrees(
		childIssues: SwarmChildIssue[],
		epicBranch: string,
		epicWorktreePath: string,
		mainWorktreePath: string,
		epicIssueNumber: string | number,
		issueTrackerName: string,
		settings?: IloomSettings,
	): Promise<SwarmSetupResult['childWorktrees']> {
		const results: SwarmSetupResult['childWorktrees'] = []

		for (const child of childIssues) {
			try {
				// Strip prefix from child number (e.g., "#123" -> "123", "ENG-123" stays as-is for branch naming)
				const rawId = child.number.replace(/^#/, '')

				// Sanitize ID for safe git branch naming (replace non-alphanumeric except - and _ with -)
				const safeId = rawId.replace(/[^a-zA-Z0-9-_]/g, '-')

				// Use standard iloom branch naming: issue/<id> pattern
				const childBranch = `issue/${safeId}`

				// Use standard iloom worktree path generation
				const childWorktreePath = generateWorktreePath(
					childBranch,
					mainWorktreePath,
				)

				getLogger().info(`Creating child worktree for ${child.number}: ${childWorktreePath}...`)

				await this.gitWorktree.createWorktree({
					path: childWorktreePath,
					branch: childBranch,
					createBranch: true,
					baseBranch: epicBranch,
				})

				// Write metadata with state: 'pending' and parentLoom
				const metadataInput: WriteMetadataInput = {
					description: child.title,
					branchName: childBranch,
					worktreePath: childWorktreePath,
					issueType: 'issue',
					issue_numbers: [rawId],
					pr_numbers: [],
					issueTracker: issueTrackerName,
					colorHex: '#808080',
					sessionId: '', // No session - not launching Claude directly
					projectPath: mainWorktreePath,
					issueUrls: { [rawId]: child.url },
					prUrls: {},
					capabilities: [],
					state: 'pending' as SwarmState,
					parentLoom: {
						type: 'epic',
						identifier: epicIssueNumber,
						branchName: epicBranch,
						worktreePath: epicWorktreePath,
					},
				}

				try {
					await this.metadataManager.writeMetadata(childWorktreePath, metadataInput)
				} catch (metaError) {
					// Clean up the worktree to avoid zombie worktrees without metadata
					getLogger().warn(`Metadata write failed for ${child.number}, cleaning up worktree...`)
					try {
						await this.gitWorktree.removeWorktree(childWorktreePath, { force: true })
					} catch {
						getLogger().debug(`Could not clean up worktree at ${childWorktreePath}`)
					}
					throw metaError
				}

				// Generate and write per-loom MCP config file
				try {
					const childMetadata = await this.metadataManager.readMetadata(childWorktreePath)
					if (childMetadata) {
						const providerName = IssueTrackerFactory.getProviderName(
							settings ?? await this.settingsManager.loadSettings(),
						) as 'github' | 'linear' | 'jira'
						const mcpConfigPath = await generateAndWriteMcpConfigFile(
							childWorktreePath,
							childMetadata,
							providerName,
							settings,
						)
						await this.metadataManager.updateMetadata(childWorktreePath, { mcpConfigPath })

						// Write MCP config path to .claude/iloom-swarm-mcp-config-path for worker discovery
						const claudeDir = path.join(childWorktreePath, '.claude')
						await fs.ensureDir(claudeDir)
						await fs.writeFile(
							path.join(claudeDir, 'iloom-swarm-mcp-config-path'),
							mcpConfigPath,
							'utf-8',
						)

						getLogger().debug(`Wrote MCP config for ${child.number}: ${mcpConfigPath}`)
					}
				} catch (error) {
					// Non-fatal: child can still work without MCP config
					getLogger().warn(
						`Failed to write MCP config for child ${child.number}: ${error instanceof Error ? error.message : 'Unknown error'}`,
					)
				}

				// Install dependencies in the child worktree
				try {
					await installDependencies(childWorktreePath, true, true)
				} catch (error) {
					getLogger().warn(
						`Failed to install dependencies in child worktree ${child.number}: ${error instanceof Error ? error.message : 'Unknown error'}`,
					)
				}

				results.push({
					issueId: rawId,
					worktreePath: childWorktreePath,
					branch: childBranch,
					success: true,
				})

				getLogger().success(`Created child worktree for ${child.number}`)
			} catch (error) {
				const rawId = child.number.replace(/^#/, '')
				const errorMessage = error instanceof Error ? error.message : 'Unknown error'
				getLogger().warn(`Failed to create child worktree for ${child.number}: ${errorMessage}`)
				results.push({
					issueId: rawId,
					worktreePath: '',
					branch: '',
					success: false,
					error: errorMessage,
				})
			}
		}

		return results
	}

	/**
	 * Render swarm-mode agent templates to the epic worktree's .claude/agents/ directory.
	 *
	 * Phase agent files are written WITHOUT frontmatter (prompt body only) because they are
	 * loaded via `--append-system-prompt-file` which does not parse YAML frontmatter.
	 * Model and tools metadata is extracted from the agent config and returned separately
	 * for use as CLI flags in `claude -p` commands.
	 */
	async renderSwarmAgents(epicWorktreePath: string): Promise<{
		renderedFiles: string[]
		metadata: SwarmAgentMetadata
	}> {
		const claudeAgentsDir = path.join(epicWorktreePath, '.claude', 'agents')
		await fs.ensureDir(claudeAgentsDir)

		const settings = await this.settingsManager.loadSettings()

		const templateVariables: TemplateVariables = {
			SWARM_MODE: true,
		}

		const agents = await this.agentManager.loadAgents(settings, templateVariables)

		const renderedFiles: string[] = []
		const metadata: SwarmAgentMetadata = {}

		for (const [agentName, agentConfig] of Object.entries(agents)) {
			const swarmFileName = agentName.startsWith('iloom-')
				? `iloom-swarm-${agentName.slice('iloom-'.length)}.md`
				: `iloom-swarm-${agentName}.md`

			const agentKey = swarmFileName.replace('.md', '')

			// Extract metadata from agent config for use in claude -p CLI flags
			metadata[agentKey] = {
				model: agentConfig.model,
				...(agentConfig.tools && { tools: agentConfig.tools }),
			}

			// Write file WITHOUT frontmatter - prompt body only
			// Phase agents are loaded via --append-system-prompt-file which does not parse YAML frontmatter
			const outputPath = path.join(claudeAgentsDir, swarmFileName)
			await fs.writeFile(outputPath, agentConfig.prompt + '\n', 'utf-8')
			renderedFiles.push(swarmFileName)
			getLogger().debug(`Rendered swarm agent: ${swarmFileName}`)
		}

		getLogger().success(`Rendered ${renderedFiles.length} swarm agents to ${claudeAgentsDir}`)
		return { renderedFiles, metadata }
	}

	/**
	 * Render the swarm worker agent file to the epic worktree's .claude/agents/ directory.
	 *
	 * This creates an agent file at `.claude/agents/iloom-swarm-worker.md` containing
	 * the full iloom workflow instructions (rendered from issue-prompt.txt with SWARM_MODE=true).
	 * The orchestrator spawns children with `subagent_type: "iloom-swarm-worker"` so these
	 * instructions become the agent's system prompt (high authority), rather than arriving
	 * as a skill invocation (low authority user message).
	 *
	 * The agent file is shared across all children. Issue-specific context (number, title,
	 * worktree path, body) is provided per-child via the Task prompt from the orchestrator.
	 */
	async renderSwarmWorkerAgent(
		epicWorktreePath: string,
		agentMetadata?: SwarmAgentMetadata,
	): Promise<boolean> {
		const agentsDir = path.join(epicWorktreePath, '.claude', 'agents')
		const agentOutputPath = path.join(agentsDir, 'iloom-swarm-worker.md')

		await fs.ensureDir(agentsDir)

		try {
			// Load settings for review configuration and issue prefix
			const settings = await this.settingsManager.loadSettings()
			const providerType = settings?.issueManagement?.provider ?? 'github'
			const issuePrefix = IssueManagementProviderFactory.create(providerType, settings ?? undefined).issuePrefix

			// Build template variables for swarm worker agent rendering
			const variables: TemplateVariables = {
				SWARM_MODE: true,
				ONE_SHOT_MODE: true,
				EPIC_WORKTREE_PATH: epicWorktreePath,
				ISSUE_PREFIX: issuePrefix,
				...(agentMetadata && { SWARM_AGENT_METADATA: JSON.stringify(agentMetadata) }),
				...buildReviewTemplateVariables(settings?.agents),
			}

			// Render issue prompt template with swarm variables
			const agentBody = await this.templateManager.getPrompt('issue', variables)

			// Build the agent file with frontmatter
			const workerModel = settings?.agents?.['iloom-swarm-worker']?.model ?? 'opus'

			const frontmatter = [
				'---',
				'name: iloom-swarm-worker',
				'description: Swarm worker agent that implements a child issue following the full iloom workflow.',
				`model: ${workerModel}`,
				'---',
			].join('\n')

			const content = `${frontmatter}\n\n${agentBody}\n`

			await fs.writeFile(agentOutputPath, content, 'utf-8')
			getLogger().success(`Rendered swarm worker agent to ${agentOutputPath}`)
			return true
		} catch (error) {
			// Intentional graceful degradation: setupSwarm reports workerAgentRendered=false
			// in its result rather than aborting the entire swarm setup.
			getLogger().warn(
				`Failed to render swarm worker agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
			return false
		}
	}

	/**
	 * Run the full swarm setup: child worktrees, agents, and worker agent.
	 *
	 * The epic worktree already exists (created by `il start`).
	 */
	async setupSwarm(
		epicIssueNumber: string | number,
		epicBranch: string,
		epicWorktreePath: string,
		childIssues: SwarmChildIssue[],
		mainWorktreePath: string,
		issueTrackerName: string,
		settings?: IloomSettings,
	): Promise<SwarmSetupResult> {
		// 1. Create child worktrees (with per-loom MCP config generation)
		const childWorktrees = await this.createChildWorktrees(
			childIssues,
			epicBranch,
			epicWorktreePath,
			mainWorktreePath,
			epicIssueNumber,
			issueTrackerName,
			settings,
		)

		// 2. Render swarm agents to epic worktree's .claude/ directory (returns metadata)
		const { renderedFiles: agentsRendered, metadata: agentMetadata } =
			await this.renderSwarmAgents(epicWorktreePath)

		// 3. Render the swarm worker agent file with agent metadata
		const workerAgentRendered = await this.renderSwarmWorkerAgent(
			epicWorktreePath,
			agentMetadata,
		)

		const successCount = childWorktrees.filter((c) => c.success).length
		const failCount = childWorktrees.filter((c) => !c.success).length

		getLogger().success(
			`Swarm setup complete: ${successCount} child worktrees` +
				(failCount > 0 ? ` (${failCount} failed)` : ''),
		)

		return {
			epicWorktreePath,
			epicBranch,
			childWorktrees,
			agentsRendered,
			workerAgentRendered,
		}
	}
}
