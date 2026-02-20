import { readFile } from 'fs/promises'
import { accessSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import fg from 'fast-glob'
import { MarkdownAgentParser } from '../utils/MarkdownAgentParser.js'
import { logger } from '../utils/logger.js'
import type { IloomSettings } from './SettingsManager.js'
import { PromptTemplateManager, TemplateVariables, buildReviewTemplateVariables } from './PromptTemplateManager.js'

// Agent schema interface
export interface AgentConfig {
	description: string
	prompt: string
	tools?: string[]  // Optional - when omitted, agent inherits all tools from parent
	model: string
	color?: string
}

// Container for all loaded agents (keyed by agent name without extension)
export interface AgentConfigs {
	[agentName: string]: AgentConfig
}

export class AgentManager {
	private agentDir: string
	private templateManager: PromptTemplateManager

	constructor(agentDir?: string, templateManager?: PromptTemplateManager) {
		this.templateManager = templateManager ?? new PromptTemplateManager()
		if (agentDir) {
			this.agentDir = agentDir
		} else {
			// Find agents relative to package installation
			// Same pattern as PromptTemplateManager
			// When running from dist/, agents are copied to dist/agents/
			const currentFileUrl = import.meta.url
			const currentFilePath = fileURLToPath(currentFileUrl)
			const distDir = path.dirname(currentFilePath)

			// Walk up to find the agents directory
			let agentDirPath = path.join(distDir, 'agents')
			let currentDir = distDir

			while (currentDir !== path.dirname(currentDir)) {
				const candidatePath = path.join(currentDir, 'agents')
				try {
					accessSync(candidatePath)
					agentDirPath = candidatePath
					break
				} catch {
					currentDir = path.dirname(currentDir)
				}
			}

			this.agentDir = agentDirPath
			logger.debug('AgentManager initialized', { agentDir: this.agentDir })
		}
	}

	/**
	 * Load agent configuration files from markdown (.md) format
	 * Optionally apply model overrides from settings and template variable substitution
	 * Throws error if agents directory doesn't exist or files are malformed
	 * @param settings - Optional project settings with per-agent model overrides
	 * @param templateVariables - Optional variables for template substitution in agent prompts
	 * @param patterns - Optional glob patterns to filter which agents to load (default: ['*.md'])
	 *                   Supports negation patterns like ['*.md', '!iloom-framework-detector.md']
	 */
	async loadAgents(
		settings?: IloomSettings,
		templateVariables?: TemplateVariables,
		patterns: string[] = ['*.md']
	): Promise<AgentConfigs> {
		// Use fast-glob to filter agent files based on patterns
		const agentFiles = await fg(patterns, {
			cwd: this.agentDir,
			onlyFiles: true,
		})

		const agents: AgentConfigs = {}

		for (const filename of agentFiles) {
			const agentPath = path.join(this.agentDir, filename)

			try {
				const content = await readFile(agentPath, 'utf-8')

				// Parse markdown with frontmatter
				const parsed = this.parseMarkdownAgent(content, filename)
				const agentConfig = parsed.config
				const agentName = parsed.name

				// Validate required fields
				this.validateAgentConfig(agentConfig, agentName)

				agents[agentName] = agentConfig
				logger.debug(`Loaded agent: ${agentName}`)
			} catch (error) {
				logger.error(`Failed to load agent from ${filename}`, { error })
				throw new Error(
					`Failed to load agent from ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`,
				)
			}
		}

		// Apply template variable substitution to agent prompts if variables provided
		if (templateVariables) {
			// Extract review config from settings and add to template variables
			Object.assign(templateVariables, buildReviewTemplateVariables(settings?.agents))

			for (const [agentName, agentConfig] of Object.entries(agents)) {
				agents[agentName] = {
					...agentConfig,
					prompt: this.templateManager.substituteVariables(agentConfig.prompt, templateVariables),
				}
				logger.debug(`Applied template substitution to agent: ${agentName}`)
			}
		}

		// Apply settings overrides if provided
		if (settings?.agents) {
			for (const [agentName, agentSettings] of Object.entries(settings.agents)) {
				if (agents[agentName] && agentSettings.model) {
					logger.debug(`Overriding model for ${agentName}: ${agents[agentName].model} -> ${agentSettings.model}`)
					agents[agentName] = {
						...agents[agentName],
						model: agentSettings.model,
					}
				} else if (!agents[agentName]) {
					// Skip warning for runtime-generated agents (e.g., swarm worker)
					const RUNTIME_GENERATED_AGENTS = ['iloom-swarm-worker']
					if (!RUNTIME_GENERATED_AGENTS.includes(agentName)) {
						// Only warn if the agent file doesn't exist at all (typo in settings)
						// Skip warning if the agent exists but wasn't loaded due to pattern filtering
						const agentFile = path.join(this.agentDir, `${agentName}.md`)
						try {
							accessSync(agentFile)
						} catch {
							logger.warn(`Settings reference unknown agent: ${agentName}`)
						}
					}
				}
			}
		}

		return agents
	}

	/**
	 * Validate agent configuration has required fields
	 * Note: tools is optional - when omitted, agent inherits all tools from parent
	 */
	private validateAgentConfig(config: AgentConfig, agentName: string): void {
		const requiredFields: (keyof AgentConfig)[] = ['description', 'prompt', 'model']

		for (const field of requiredFields) {
			if (!config[field]) {
				throw new Error(`Agent ${agentName} missing required field: ${field}`)
			}
		}

		// Tools is optional, but if present must be an array
		if (config.tools !== undefined && !Array.isArray(config.tools)) {
			throw new Error(`Agent ${agentName} tools must be an array`)
		}
	}

	/**
	 * Parse markdown agent file with YAML frontmatter
	 * @param content - Raw markdown file content
	 * @param filename - Original filename for error messages
	 * @returns Parsed agent config and name
	 */
	private parseMarkdownAgent(content: string, filename: string): { config: AgentConfig; name: string } {
		try {
			// Parse frontmatter using custom parser
			const { data, content: markdownBody } = MarkdownAgentParser.parse(content)

			// Validate frontmatter has required fields
			if (!data.name) {
				throw new Error('Missing required field: name')
			}
			if (!data.description) {
				throw new Error('Missing required field: description')
			}
			// Note: tools is now optional - when omitted, agent inherits all tools from parent
			if (!data.model) {
				throw new Error('Missing required field: model')
			}

			// Parse tools from comma-separated string to array (only if tools field is present)
			let tools: string[] | undefined
			if (data.tools) {
				tools = data.tools
					.split(',')
					.map((tool: string) => tool.trim())
					.filter((tool: string) => tool.length > 0)
			}

			// Validate model and warn if non-standard
			const validModels = ['sonnet', 'opus', 'haiku']
			if (!validModels.includes(data.model)) {
				logger.warn(
					`Agent ${data.name} uses model "${data.model}" which may not be recognized by Claude CLI, and your workflow may fail or produce unexpected results. ` +
						`Valid values are: ${validModels.join(', ')}`
				)
			}

			// Construct AgentConfig
			const config: AgentConfig = {
				description: data.description,
				prompt: markdownBody.trim(),
				model: data.model,
				...(tools && { tools }),
				...(data.color && { color: data.color }),
			}

			return { config, name: data.name }
		} catch (error) {
			throw new Error(
				`Failed to parse markdown agent ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}

	/**
	 * Format loaded agents for Claude CLI --agents flag
	 * Returns object suitable for JSON.stringify
	 */
	formatForCli(agents: AgentConfigs): Record<string, unknown> {
		// The agents object is already in the correct format
		// Just return it - launchClaude will JSON.stringify it
		return agents as Record<string, unknown>
	}
}
