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
import { preAcceptClaudeTrust } from '../utils/claude-trust.js'
import { installDependencies } from '../utils/package-manager.js'
import { generateWorktreePath } from '../utils/git.js'
import { generateAndWriteMcpConfigFile } from '../utils/mcp.js'

/**
 * Result of the swarm setup process
 */
export interface SwarmSetupResult {
	epicWorktreePath: string
	epicBranch: string
	skillsRendered: string[]
	renderedAgents: string[]
	workerAgentRendered: boolean
	verifierAgentRendered: boolean
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
	): Promise<Array<{
		issueId: string
		worktreePath: string
		branch: string
		success: boolean
		error?: string
	}>> {
		return Promise.all(childIssues.map(async (child) => {
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

				// Pre-accept Claude Code trust for child worktree
				try {
					await preAcceptClaudeTrust(childWorktreePath)
				} catch (error) {
					getLogger().warn(`Failed to pre-accept Claude trust for child worktree: ${error instanceof Error ? error.message : String(error)}`)
				}

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

				getLogger().success(`Created child worktree for ${child.number}`)
				return {
					issueId: rawId,
					worktreePath: childWorktreePath,
					branch: childBranch,
					success: true,
				}
			} catch (error) {
				const rawId = child.number.replace(/^#/, '')
				const errorMessage = error instanceof Error ? error.message : 'Unknown error'
				getLogger().warn(`Failed to create child worktree for ${child.number}: ${errorMessage}`)
				return {
					issueId: rawId,
					worktreePath: '',
					branch: '',
					success: false,
					error: errorMessage,
				}
			}
		}))
	}

	/**
	 * Render swarm-mode agent templates as custom agent files AND thin skill wrappers.
	 *
	 * For each phase agent, two files are written:
	 * 1. Agent file at `.claude/agents/iloom-swarm-<phase>.md` - contains frontmatter
	 *    (name, description, model) and the full agent prompt as body.
	 * 2. Thin skill wrapper at `.claude/skills/iloom-swarm-<phase>/SKILL.md` - contains
	 *    frontmatter with `agent: iloom-swarm-<phase>` and a minimal body.
	 *
	 * Skills are auto-discovered by Claude Code and invoked via /skill-name syntax.
	 * The agent file carries the real prompt; the skill just delegates to it.
	 */
	async renderSwarmAgents(epicWorktreePath: string): Promise<{
		renderedSkills: string[]
		renderedAgents: string[]
	}> {
		const claudeSkillsDir = path.join(epicWorktreePath, '.claude', 'skills')
		const claudeAgentsDir = path.join(epicWorktreePath, '.claude', 'agents')
		await fs.ensureDir(claudeSkillsDir)
		await fs.ensureDir(claudeAgentsDir)

		const settings = await this.settingsManager.loadSettings()

		const templateVariables: TemplateVariables = {
			SWARM_MODE: true,
			EPIC_WORKTREE_PATH: epicWorktreePath,
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

		const renderedSkills: string[] = []
		const renderedAgents: string[] = []

		// Agents that are rendered as standalone custom agent types (with frontmatter
		// in .claude/agents/) rather than as skills. These are skipped here
		// and rendered separately with their own dedicated methods.
		const standaloneAgents = new Set(['iloom-wave-verifier'])

		for (const [agentName, agentConfig] of Object.entries(agents)) {
			if (standaloneAgents.has(agentName)) {
				continue
			}

			// Compute agent/skill name: iloom-swarm-<phase>
			const swarmName = agentName.startsWith('iloom-')
				? `iloom-swarm-${agentName.slice('iloom-'.length)}`
				: `iloom-swarm-${agentName}`

			// 1. Write agent file to .claude/agents/<swarmName>.md
			const agentFrontmatter = [
				'---',
				`name: ${swarmName}`,
				`description: ${agentConfig.description}`,
				`model: ${agentConfig.model}`,
				'---',
			].join('\n')

			const agentContent = `${agentFrontmatter}\n\n${agentConfig.prompt}\n`
			await fs.writeFile(path.join(claudeAgentsDir, `${swarmName}.md`), agentContent, 'utf-8')
			renderedAgents.push(swarmName)
			getLogger().debug(`Rendered swarm agent: ${swarmName}`)

			// 2. Write thin skill wrapper to .claude/skills/<swarmName>/SKILL.md
			const skillDir = path.join(claudeSkillsDir, swarmName)
			await fs.ensureDir(skillDir)

			const skillFrontmatter = [
				'---',
				`name: ${swarmName}`,
				`description: ${agentConfig.description}`,
				`model: ${agentConfig.model}`,
				'context: fork',
				`agent: ${swarmName}`,
				'---',
			].join('\n')

			const skillContent = `${skillFrontmatter}\n\nProceed via your system prompt.\n`
			await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8')
			renderedSkills.push(swarmName)
			getLogger().debug(`Rendered swarm skill wrapper: ${swarmName}`)
		}

		getLogger().success(`Rendered ${renderedAgents.length} swarm agents and ${renderedSkills.length} skill wrappers`)
		return { renderedSkills, renderedAgents }
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
				COMPLEXITY_OVERRIDE: 'simple',
				EPIC_WORKTREE_PATH: epicWorktreePath,
				ISSUE_PREFIX: issuePrefix,
				...buildReviewTemplateVariables(true, settings?.agents),
			}

			// Render issue prompt template with swarm variables
			const agentBody = await this.templateManager.getPrompt('issue', variables)

			// Build the agent file with frontmatter
			const workerModel = settings?.agents?.['iloom-swarm-worker']?.model ?? 'sonnet'

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

			// Load agents to get the wave verifier template (rendered with template variables)
			const templateVariables: TemplateVariables = {
				SWARM_MODE: true,
				EPIC_WORKTREE_PATH: epicWorktreePath,
			}

			const agents = await this.agentManager.loadAgents(settings, templateVariables, ['iloom-wave-verifier.md'])
			const verifierConfig = agents['iloom-wave-verifier']

			if (!verifierConfig) {
				getLogger().debug('No wave verifier agent template found — skipping')
				return false
			}

			// Get model from settings or use the template's declared model
			const verifierModel = settings?.agents?.['iloom-wave-verifier']?.model ?? verifierConfig.model ?? 'sonnet'

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
	 * Copy .claude/agents/ and .claude/skills/ from the epic worktree to each child worktree.
	 *
	 * Child workers need local access to agent files (used as custom agent types) and
	 * skill files (invoked via /skill-name). Without this copy, child worktrees lack
	 * the rendered files since they only exist in the epic worktree after rendering.
	 */
	async copyAgentsAndSkillsToChildWorktrees(
		epicWorktreePath: string,
		childWorktrees: Array<{
			issueId: string
			worktreePath: string
			branch: string
			success: boolean
			error?: string
		}>,
	): Promise<void> {
		const agentsSourceDir = path.join(epicWorktreePath, '.claude', 'agents')
		const skillsSourceDir = path.join(epicWorktreePath, '.claude', 'skills')

		const agentsExist = await fs.pathExists(agentsSourceDir)
		const skillsExist = await fs.pathExists(skillsSourceDir)

		if (!agentsExist && !skillsExist) {
			getLogger().warn('No .claude/agents/ or .claude/skills/ directory in epic worktree to copy')
			return
		}

		const successfulChildren = childWorktrees.filter((c) => c.success)

		await Promise.all(successfulChildren.map(async (child) => {
			try {
				if (agentsExist) {
					const targetAgentsDir = path.join(child.worktreePath, '.claude', 'agents')
					await fs.copy(agentsSourceDir, targetAgentsDir, { overwrite: true })
					getLogger().debug(`Copied .claude/agents/ to ${child.worktreePath}`)
				}
				if (skillsExist) {
					const targetSkillsDir = path.join(child.worktreePath, '.claude', 'skills')
					await fs.copy(skillsSourceDir, targetSkillsDir, { overwrite: true })
					getLogger().debug(`Copied .claude/skills/ to ${child.worktreePath}`)
				}
			} catch (error) {
				// Non-fatal: worker can fall back to epic worktree path
				getLogger().warn(
					`Failed to copy agents/skills to child worktree ${child.issueId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
				)
			}
		}))

		getLogger().success(`Copied agents and skills to ${successfulChildren.length} child worktrees`)
	}

	/**
	 * Run the full swarm setup: render agents, worker agent, and wave verifier.
	 *
	 * The epic worktree already exists (created by `il start`).
	 * Child worktrees are created on-the-fly by the orchestrator as issues become unblocked.
	 */
	async setupSwarm(
		epicBranch: string,
		epicWorktreePath: string,
	): Promise<SwarmSetupResult> {
		// 1. Render swarm agents and skill wrappers to epic worktree
		const { renderedSkills: skillsRendered, renderedAgents } =
			await this.renderSwarmAgents(epicWorktreePath)

		// 2. Render the swarm worker agent file
		const workerAgentRendered = await this.renderSwarmWorkerAgent(epicWorktreePath)

		// 3. Render the wave verifier agent file (standalone custom agent type with frontmatter)
		const verifierAgentRendered = await this.renderSwarmWaveVerifierAgent(epicWorktreePath)

		getLogger().success('Swarm setup complete: agents and skills rendered')

		return {
			epicWorktreePath,
			epicBranch,
			skillsRendered,
			renderedAgents,
			workerAgentRendered,
			verifierAgentRendered,
		}
	}
}
