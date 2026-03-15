import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { AgentManager } from './AgentManager.js'
import { SettingsManager, type ClaudeModel } from './SettingsManager.js'
import { PromptTemplateManager, buildReviewTemplateVariables, type TemplateVariables } from './PromptTemplateManager.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { getLogger } from '../utils/logger-context.js'
import { getPackageInfo } from '../utils/package-info.js'

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
	pluginDir: string
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
	 * 1. Agent file at `<pluginDir>/agents/<phase>.md` - contains frontmatter
	 *    (name, description, model) and the full agent prompt as body.
	 * 2. Thin skill wrapper at `<pluginDir>/skills/<phase>/SKILL.md` - contains
	 *    frontmatter with `agent: <phase>` and a minimal body.
	 *
	 * Skills are auto-discovered by Claude Code and invoked via /skill-name syntax.
	 * The agent file carries the real prompt; the skill just delegates to it.
	 * Agent names use short form (e.g., `issue-implementer`) since the plugin
	 * namespace (`iloom-swarm:`) provides the prefix.
	 */
	async renderSwarmAgents(pluginDir: string, epicWorktreePath: string): Promise<{
		renderedSkills: string[]
		renderedAgents: string[]
	}> {
		const claudeSkillsDir = path.join(pluginDir, 'skills')
		const claudeAgentsDir = path.join(pluginDir, 'agents')
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
		const defaultSwarmModels: Record<string, ClaudeModel> = {
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
		// in <pluginDir>/agents/) rather than as skills. These are skipped here
		// and rendered separately with their own dedicated methods.
		const standaloneAgents = new Set(['iloom-wave-verifier'])

		for (const [agentName, agentConfig] of Object.entries(agents)) {
			if (standaloneAgents.has(agentName)) {
				continue
			}

			// Compute agent/skill name: <phase> (e.g., issue-implementer)
			// The plugin namespace (iloom-swarm:) provides the full qualified name.
			const swarmName = agentName.startsWith('iloom-')
				? agentName.slice('iloom-'.length)
				: agentName

			// 1. Write agent file to <pluginDir>/agents/<swarmName>.md
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

			// 2. Write thin skill wrapper to <pluginDir>/skills/<swarmName>/SKILL.md
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
	 * Render the swarm worker agent file to the plugin directory.
	 *
	 * This creates an agent file at `<pluginDir>/agents/worker.md` containing
	 * the full iloom workflow instructions (rendered from issue-prompt.txt with SWARM_MODE=true).
	 * The orchestrator spawns children with `subagent_type: "iloom-swarm:worker"` so these
	 * instructions become the agent's system prompt (high authority), rather than arriving
	 * as a skill invocation (low authority user message).
	 *
	 * The agent file is shared across all children. Issue-specific context (number, title,
	 * worktree path, body) is provided per-child via the Task prompt from the orchestrator.
	 */
	async renderSwarmWorkerAgent(
		pluginDir: string,
		epicWorktreePath: string,
	): Promise<boolean> {
		const agentsDir = path.join(pluginDir, 'agents')
		const agentOutputPath = path.join(agentsDir, 'worker.md')

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

			// Settings key stays as 'iloom-swarm-worker' for backward compatibility,
			// even though the plugin agent name is now just 'worker' (namespaced as iloom-swarm:worker).
			const workerModel = settings?.agents?.['iloom-swarm-worker']?.model ?? 'sonnet'

			const frontmatter = [
				'---',
				'name: worker',
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
	 * Render the wave verifier agent file to the plugin directory.
	 *
	 * This creates an agent file at `<pluginDir>/agents/wave-verifier.md` WITH frontmatter,
	 * making it available as a custom agent type via `subagent_type: "iloom-swarm:wave-verifier"`.
	 * Unlike phase agents (which are appended as system prompts), the wave verifier is a standalone
	 * agent that the orchestrator spawns directly for verification child issues.
	 */
	async renderSwarmWaveVerifierAgent(pluginDir: string, epicWorktreePath: string): Promise<boolean> {
		const agentsDir = path.join(pluginDir, 'agents')
		const agentOutputPath = path.join(agentsDir, 'wave-verifier.md')

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

			// Get model from settings or use the template's declared model
			const verifierModel = settings?.agents?.['iloom-wave-verifier']?.model ?? verifierConfig.model ?? 'sonnet'

			// Build the agent file WITH frontmatter (standalone custom agent type)
			const frontmatter = [
				'---',
				'name: wave-verifier',
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
	 * Create the plugin manifest file at `<pluginDir>/.claude-plugin/plugin.json`.
	 *
	 * The manifest declares the plugin name (`iloom-swarm`) and version, enabling
	 * Claude Code to namespace all agents/skills under `iloom-swarm:`.
	 */
	async createPluginManifest(pluginDir: string): Promise<void> {
		const manifestDir = path.join(pluginDir, '.claude-plugin')
		await fs.ensureDir(manifestDir)

		const manifest = {
			name: 'iloom-swarm',
			version: getPackageInfo().version,
		}

		await fs.writeFile(
			path.join(manifestDir, 'plugin.json'),
			JSON.stringify(manifest, null, 2),
			'utf-8',
		)
		getLogger().debug(`Created plugin manifest at ${manifestDir}/plugin.json`)
	}

	/**
	 * Run the full swarm setup: render agents, worker agent, and wave verifier.
	 *
	 * Creates a temporary plugin directory for all swarm agent/skill files,
	 * keeping them isolated from the worktree's `.claude/` directory.
	 * The epic worktree already exists (created by `il start`).
	 * Child worktrees are created on-the-fly by the orchestrator as issues become unblocked.
	 */
	async setupSwarm(
		epicBranch: string,
		epicWorktreePath: string,
	): Promise<SwarmSetupResult> {
		// 0. Create temp plugin directory for swarm agents/skills
		const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iloom-swarm-plugin-'))
		await this.createPluginManifest(pluginDir)

		// 1. Render swarm agents and skill wrappers to plugin dir
		const { renderedSkills: skillsRendered, renderedAgents } =
			await this.renderSwarmAgents(pluginDir, epicWorktreePath)

		// 2. Render the swarm worker agent file
		const workerAgentRendered = await this.renderSwarmWorkerAgent(pluginDir, epicWorktreePath)

		// 3. Render the wave verifier agent file (standalone custom agent type with frontmatter)
		const verifierAgentRendered = await this.renderSwarmWaveVerifierAgent(pluginDir, epicWorktreePath)

		getLogger().success('Swarm setup complete: agents and skills rendered')

		return {
			epicWorktreePath,
			epicBranch,
			skillsRendered,
			renderedAgents,
			workerAgentRendered,
			verifierAgentRendered,
			pluginDir,
		}
	}
}
