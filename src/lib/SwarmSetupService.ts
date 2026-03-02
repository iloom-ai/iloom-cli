import path from 'path'
import fs from 'fs-extra'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { MetadataManager, type WriteMetadataInput, type SwarmState } from './MetadataManager.js'
import { AgentManager } from './AgentManager.js'
import { SettingsManager } from './SettingsManager.js'
import { PromptTemplateManager, buildReviewTemplateVariables, type TemplateVariables } from './PromptTemplateManager.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { getLogger } from '../utils/logger-context.js'
import { generateWorktreePath } from '../utils/git.js'

/**
 * Metadata entry for a child issue (worktree creation deferred to orchestrator via MCP tool)
 */
export interface ChildMetadataEntry {
	issueId: string
	branch: string
	worktreePath: string
	status: 'pending'
}

/**
 * Result of the swarm setup process
 */
export interface SwarmSetupResult {
	epicWorktreePath: string
	epicBranch: string
	childMetadata: ChildMetadataEntry[]
	agentsRendered: string[]
	workerAgentRendered: boolean
	verifierAgentRendered: boolean
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
 * SwarmSetupService handles the creation of child metadata entries
 * for swarm mode, plus rendering swarm-mode agents and skill files.
 *
 * Called from the spin command (ignite.ts) when an epic loom is detected.
 * The epic worktree already exists (created by `il start`).
 *
 * Child worktrees are NOT created here - they are deferred to the orchestrator
 * which creates them just-in-time via the MCP worktree tool.
 */
export class SwarmSetupService {
	constructor(
		// gitWorktree is accepted for constructor compatibility but no longer used directly.
		// Worktree creation is deferred to the MCP worktree tool.
		_gitWorktree: GitWorktreeManager,
		private metadataManager: MetadataManager,
		private agentManager: AgentManager,
		private settingsManager: SettingsManager,
		private templateManager: PromptTemplateManager,
	) {}

	/**
	 * Create metadata entries for each child issue without creating actual worktrees.
	 * Worktree creation is deferred to the orchestrator via the MCP worktree tool,
	 * which creates worktrees just-in-time from the latest epic branch HEAD.
	 *
	 * Writes iloom-metadata.json for each child with state: 'pending' and parentLoom.
	 * Uses standard iloom naming conventions via generateWorktreePath() to compute
	 * the planned branch name and worktree path.
	 *
	 * @param childIssues - Array of child issues from epic metadata
	 * @param epicBranch - The epic branch name (base branch for children)
	 * @param epicWorktreePath - Path to the epic worktree
	 * @param mainWorktreePath - Path to the main worktree (project root)
	 * @param epicIssueNumber - The parent epic issue number
	 * @param issueTrackerName - The issue tracker provider name (e.g., 'github')
	 * @returns Array of metadata entries for each child issue
	 */
	async createChildMetadata(
		childIssues: SwarmChildIssue[],
		epicBranch: string,
		epicWorktreePath: string,
		mainWorktreePath: string,
		epicIssueNumber: string | number,
		issueTrackerName: string,
	): Promise<ChildMetadataEntry[]> {
		const results: ChildMetadataEntry[] = []

		for (const child of childIssues) {
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

			getLogger().info(`Creating metadata for child issue ${child.number} (worktree deferred)...`)

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

			await this.metadataManager.writeMetadata(childWorktreePath, metadataInput)

			getLogger().success(`Created metadata for child issue ${child.number}`)
			results.push({
				issueId: rawId,
				branch: childBranch,
				worktreePath: childWorktreePath,
				status: 'pending',
			})
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

		// Compute sub-agent timeout for wave verifier template (mirrors renderSwarmWorkerAgent pattern)
		const subAgentTimeoutMinutes = settings?.agents?.['iloom-swarm-worker']?.subAgentTimeout ?? 10
		const subAgentTimeoutMs = subAgentTimeoutMinutes * 60 * 1000

		const templateVariables: TemplateVariables = {
			SWARM_MODE: true,
			EPIC_WORKTREE_PATH: epicWorktreePath,
			SWARM_SUB_AGENT_TIMEOUT_MS: subAgentTimeoutMs,
		}

		const agents = await this.agentManager.loadAgents(settings, templateVariables)

		// Default swarmModel map for "Balanced" mode. All swarm phase agents are
		// listed explicitly so that swarm mode never accidentally inherits a
		// non-swarm model override. User-configured swarmModel values always
		// take precedence.
		const defaultSwarmModels: Record<string, 'sonnet' | 'opus' | 'haiku'> = {
			'iloom-issue-analyzer': 'opus',
			'iloom-issue-analyze-and-plan': 'opus',
			'iloom-issue-planner': 'sonnet',
			'iloom-issue-implementer': 'sonnet',
			'iloom-issue-enhancer': 'sonnet',
			'iloom-code-reviewer': 'sonnet',
			'iloom-issue-complexity-evaluator': 'haiku',
		}

		// Apply per-agent swarmModel overrides (user-configured takes precedence over defaults)
		for (const [agentName, agentConfig] of Object.entries(agents)) {
			const userSwarmModel = settings?.agents?.[agentName]?.swarmModel
			if (userSwarmModel) {
				agents[agentName] = { ...agentConfig, model: userSwarmModel }
			} else if (defaultSwarmModels[agentName]) {
				agents[agentName] = { ...agentConfig, model: defaultSwarmModels[agentName] }
			}
		}

		const renderedFiles: string[] = []
		const metadata: SwarmAgentMetadata = {}

		// Agents that are rendered as standalone custom agent types (with frontmatter)
		// rather than as phase agents (without frontmatter). These are skipped here
		// and rendered separately with their own dedicated methods.
		const standaloneAgents = new Set(['iloom-wave-verifier'])

		for (const [agentName, agentConfig] of Object.entries(agents)) {
			if (standaloneAgents.has(agentName)) {
				continue
			}

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

			// Compute sub-agent timeout in milliseconds (default: 10 minutes)
			const subAgentTimeoutMinutes = settings?.agents?.['iloom-swarm-worker']?.subAgentTimeout ?? 10
			const subAgentTimeoutMs = subAgentTimeoutMinutes * 60 * 1000

			// Build template variables for swarm worker agent rendering
			const variables: TemplateVariables = {
				SWARM_MODE: true,
				ONE_SHOT_MODE: true,
				COMPLEXITY_OVERRIDE: 'simple',
				EPIC_WORKTREE_PATH: epicWorktreePath,
				ISSUE_PREFIX: issuePrefix,
				SWARM_SUB_AGENT_TIMEOUT_MS: subAgentTimeoutMs,
				...(agentMetadata && { SWARM_AGENT_METADATA: JSON.stringify(agentMetadata) }),
				...buildReviewTemplateVariables(true, settings?.agents),
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
	 * Render the wave verifier agent file to the epic worktree's .claude/agents/ directory.
	 *
	 * This creates an agent file at `.claude/agents/iloom-swarm-wave-verifier.md` WITH frontmatter,
	 * making it available as a custom agent type via `subagent_type: "iloom-swarm-wave-verifier"`.
	 * Unlike phase agents (which are appended as system prompts), the wave verifier is a standalone
	 * agent that the orchestrator spawns directly for verification child issues.
	 */
	async renderSwarmWaveVerifierAgent(epicWorktreePath: string): Promise<boolean> {
		const agentsDir = path.join(epicWorktreePath, '.claude', 'agents')
		const agentOutputPath = path.join(agentsDir, 'iloom-swarm-wave-verifier.md')

		await fs.ensureDir(agentsDir)

		try {
			const settings = await this.settingsManager.loadSettings()

			// Compute sub-agent timeout (mirrors renderSwarmWorkerAgent pattern)
			const subAgentTimeoutMinutes = settings?.agents?.['iloom-swarm-worker']?.subAgentTimeout ?? 10
			const subAgentTimeoutMs = subAgentTimeoutMinutes * 60 * 1000

			// Load agents to get the wave verifier template (rendered with template variables)
			const templateVariables: TemplateVariables = {
				SWARM_MODE: true,
				EPIC_WORKTREE_PATH: epicWorktreePath,
				SWARM_SUB_AGENT_TIMEOUT_MS: subAgentTimeoutMs,
			}

			const agents = await this.agentManager.loadAgents(settings, templateVariables, ['iloom-wave-verifier.md'])
			const verifierConfig = agents['iloom-wave-verifier']

			if (!verifierConfig) {
				getLogger().debug('No wave verifier agent template found — skipping')
				return false
			}

			// Get model from settings or use the template's declared model
			const verifierModel = settings?.agents?.['iloom-wave-verifier']?.model ?? verifierConfig.model ?? 'opus'

			// Build the agent file WITH frontmatter (standalone custom agent type)
			const frontmatter = [
				'---',
				'name: iloom-swarm-wave-verifier',
				`description: ${verifierConfig.description ?? 'Wave verification agent that checks must-have criteria after each swarm wave.'}`,
				`model: ${verifierModel}`,
				...(verifierConfig.tools ? [`tools: ${verifierConfig.tools.join(', ')}`] : []),
				'---',
			].join('\n')

			const content = `${frontmatter}\n\n${verifierConfig.prompt}\n`

			await fs.writeFile(agentOutputPath, content, 'utf-8')
			getLogger().success(`Rendered wave verifier agent to ${agentOutputPath}`)
			return true
		} catch (error) {
			getLogger().warn(
				`Failed to render wave verifier agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
			return false
		}
	}

	/**
	 * Copy .claude/agents/ from the epic worktree to a child worktree.
	 *
	 * Child workers need local access to agent files (used via --append-system-prompt-file).
	 * Without this copy, child worktrees lack the rendered agent files since they only
	 * exist in the epic worktree after renderSwarmAgents/renderSwarmWorkerAgent.
	 *
	 * NOTE: This method is no longer called from setupSwarm(). It is used by the
	 * MCP worktree tool which copies agents when creating each child worktree on-demand.
	 */
	async copyAgentsToChildWorktree(
		epicWorktreePath: string,
		childWorktreePath: string,
	): Promise<void> {
		const sourceDir = path.join(epicWorktreePath, '.claude', 'agents')

		if (!await fs.pathExists(sourceDir)) {
			getLogger().warn('No .claude/agents/ directory in epic worktree to copy')
			return
		}

		try {
			const targetDir = path.join(childWorktreePath, '.claude', 'agents')
			await fs.copy(sourceDir, targetDir, { overwrite: true })
			getLogger().debug(`Copied .claude/agents/ to ${childWorktreePath}`)
		} catch (error) {
			// Non-fatal: worker can fall back to epic worktree path
			getLogger().warn(
				`Failed to copy agents to child worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Run the full swarm setup: child metadata, agents, and worker agent.
	 *
	 * The epic worktree already exists (created by `il start`).
	 * Child worktrees are NOT created here - they are deferred to the orchestrator
	 * which creates them just-in-time via the MCP worktree tool.
	 */
	async setupSwarm(
		epicIssueNumber: string | number,
		epicBranch: string,
		epicWorktreePath: string,
		childIssues: SwarmChildIssue[],
		mainWorktreePath: string,
		issueTrackerName: string,
	): Promise<SwarmSetupResult> {
		// 1. Create metadata entries for child issues (worktrees deferred to orchestrator)
		const childMetadata = await this.createChildMetadata(
			childIssues,
			epicBranch,
			epicWorktreePath,
			mainWorktreePath,
			epicIssueNumber,
			issueTrackerName,
		)

		// 2. Render swarm agents to epic worktree's .claude/ directory (returns metadata)
		const { renderedFiles: agentsRendered, metadata: agentMetadata } =
			await this.renderSwarmAgents(epicWorktreePath)

		// 3. Render the swarm worker agent file with agent metadata
		const workerAgentRendered = await this.renderSwarmWorkerAgent(
			epicWorktreePath,
			agentMetadata,
		)

		// 3b. Render the wave verifier agent file (standalone custom agent type with frontmatter)
		const verifierAgentRendered = await this.renderSwarmWaveVerifierAgent(epicWorktreePath)

		// Agent copying to child worktrees is now handled by the MCP worktree tool
		// at the time each child worktree is created just-in-time

		getLogger().success(
			`Swarm setup complete: ${childMetadata.length} child issues (worktrees created on-demand)`,
		)

		return {
			epicWorktreePath,
			epicBranch,
			childMetadata,
			agentsRendered,
			workerAgentRendered,
			verifierAgentRendered,
		}
	}
}
