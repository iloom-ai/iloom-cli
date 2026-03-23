import path from 'path'
import fs from 'fs-extra'
import { AgentManager } from './AgentManager.js'
import { SettingsManager } from './SettingsManager.js'
import { PromptTemplateManager, buildReviewTemplateVariables, type TemplateVariables } from './PromptTemplateManager.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { getLogger } from '../utils/logger-context.js'

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
 * SwarmSetupService handles rendering swarm-mode agents and skill files.
 *
 * Called from the spin command (ignite.ts) when an epic loom is detected.
 * The epic worktree already exists (created by `il start`).
 */
export class SwarmSetupService {
	constructor(
		private agentManager: AgentManager,
		private settingsManager: SettingsManager,
		private templateManager: PromptTemplateManager,
	) {}

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

		// Apply per-agent swarmModel and swarmEffort overrides from user settings.
		// Default swarm model/effort values are now declared in agent template frontmatter
		// using {{#if SWARM_MODE}} conditionals, so only user overrides are needed here.
		for (const [agentName, agentConfig] of Object.entries(agents)) {
			let updated = agentConfig
			const userSwarmModel = settings?.agents?.[agentName]?.swarmModel
			if (userSwarmModel) {
				updated = { ...updated, model: userSwarmModel }
			}

			const userSwarmEffort = settings?.agents?.[agentName]?.swarmEffort
			const userBaseEffort = settings?.agents?.[agentName]?.effort
			if (userSwarmEffort) {
				updated = { ...updated, effort: userSwarmEffort }
			} else if (userBaseEffort) {
				updated = { ...updated, effort: userBaseEffort }
			}
			agents[agentName] = updated
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
				...(agentConfig.effort ? [`effort: ${agentConfig.effort}`] : []),
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
				...(agentConfig.effort ? [`effort: ${agentConfig.effort}`] : []),
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
			const workerEffort = settings?.agents?.['iloom-swarm-worker']?.swarmEffort ?? settings?.agents?.['iloom-swarm-worker']?.effort

			const frontmatter = [
				'---',
				'name: iloom-swarm-worker',
				'description: Swarm worker agent that implements a child issue following the full iloom workflow.',
				`model: ${workerModel}`,
				...(workerEffort ? [`effort: ${workerEffort}`] : []),
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
				...buildReviewTemplateVariables(true, settings?.agents),
			}

			const agents = await this.agentManager.loadAgents(settings, templateVariables, ['iloom-wave-verifier.md'])
			const verifierConfig = agents['iloom-wave-verifier']

			if (!verifierConfig) {
				getLogger().debug('No wave verifier agent template found — skipping')
				return false
			}

			// Get model and effort from settings or use the template's declared values
			const verifierModel = settings?.agents?.['iloom-wave-verifier']?.model ?? verifierConfig.model ?? 'sonnet'
			const verifierEffort = settings?.agents?.['iloom-wave-verifier']?.swarmEffort
				?? settings?.agents?.['iloom-wave-verifier']?.effort
				?? verifierConfig.effort

			// Build the agent file WITH frontmatter (standalone custom agent type)
			const frontmatter = [
				'---',
				'name: iloom-swarm-wave-verifier',
				`description: ${verifierConfig.description ?? 'Wave verification agent that checks must-have criteria after each swarm wave.'}`,
				`model: ${verifierModel}`,
				...(verifierEffort ? [`effort: ${verifierEffort}`] : []),
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
