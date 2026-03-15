import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import { SwarmSetupService } from './SwarmSetupService.js'
import type { AgentManager } from './AgentManager.js'
import type { SettingsManager, IloomSettings } from './SettingsManager.js'
import type { PromptTemplateManager } from './PromptTemplateManager.js'

vi.mock('../utils/logger-context.js', () => ({
	getLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
	}),
}))

vi.mock('fs-extra', () => ({
	default: {
		ensureDir: vi.fn(),
		writeFile: vi.fn(),
		pathExists: vi.fn(),
		copy: vi.fn(),
		mkdtemp: vi.fn(),
	},
}))

vi.mock('../utils/package-info.js', () => ({
	getPackageInfo: () => ({ name: 'iloom', version: '1.2.3' }),
}))

const PLUGIN_DIR = '/tmp/iloom-swarm-plugin-test'
const EPIC_WORKTREE_PATH = '/Users/dev/project-epic-610'

describe('SwarmSetupService', () => {
	let service: SwarmSetupService
	let mockAgentManager: AgentManager
	let mockSettingsManager: SettingsManager
	let mockTemplateManager: PromptTemplateManager

	beforeEach(() => {
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(fs.pathExists).mockResolvedValue(true as never)
		vi.mocked(fs.copy).mockResolvedValue(undefined)
		vi.mocked(fs.mkdtemp).mockResolvedValue('/tmp/iloom-swarm-plugin-abc123')

		mockAgentManager = {
			loadAgents: vi.fn().mockResolvedValue({
				'iloom-issue-implementer': {
					description: 'Implementer agent',
					prompt: 'Implement things',
					tools: ['Bash', 'Read'],
					model: 'opus',
					color: 'green',
				},
			}),
		} as unknown as AgentManager

		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({}),
		} as unknown as SettingsManager

		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('# Rendered swarm skill content'),
		} as unknown as PromptTemplateManager

		service = new SwarmSetupService(
			mockAgentManager,
			mockSettingsManager,
			mockTemplateManager,
		)
	})

	describe('renderSwarmAgents', () => {
		it('writes agent files to pluginDir/agents/ and skill wrappers to pluginDir/skills/', async () => {
			const result = await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(result.renderedSkills).toHaveLength(1)
			expect(result.renderedSkills[0]).toBe('issue-implementer')
			expect(result.renderedAgents).toHaveLength(1)
			expect(result.renderedAgents[0]).toBe('issue-implementer')

			// Verify agents directory was created in plugin dir
			expect(fs.ensureDir).toHaveBeenCalledWith(
				`${PLUGIN_DIR}/agents`,
			)

			// Verify agent file was written to plugin dir
			expect(fs.writeFile).toHaveBeenCalledWith(
				`${PLUGIN_DIR}/agents/issue-implementer.md`,
				expect.any(String),
				'utf-8',
			)

			// Verify skill directory was created in plugin dir
			expect(fs.ensureDir).toHaveBeenCalledWith(
				`${PLUGIN_DIR}/skills/issue-implementer`,
			)

			// Verify thin SKILL.md was written to the plugin skill directory
			expect(fs.writeFile).toHaveBeenCalledWith(
				`${PLUGIN_DIR}/skills/issue-implementer/SKILL.md`,
				expect.any(String),
				'utf-8',
			)
		})

		it('loads agents with SWARM_MODE and EPIC_WORKTREE_PATH', async () => {
			await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					SWARM_MODE: true,
					EPIC_WORKTREE_PATH,
				}),
			)
		})

		it('writes agent file with full prompt and skill wrapper with delegation body', async () => {
			await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
			const agentFileCall = writeFileCalls.find(
				(call) => (call[0] as string).endsWith('issue-implementer.md'),
			)
			const skillFileCall = writeFileCalls.find(
				(call) => (call[0] as string).endsWith('SKILL.md'),
			)

			// Agent file should contain full prompt
			const agentContent = agentFileCall![1] as string
			expect(agentContent).toMatch(/^---/)
			expect(agentContent).toContain('name: issue-implementer')
			expect(agentContent).toContain('description: Implementer agent')
			expect(agentContent).toContain('model: ')
			expect(agentContent).not.toContain('context: fork')
			expect(agentContent).not.toContain('agent:')
			expect(agentContent).toContain('Implement things')

			// Skill wrapper should be thin with agent reference
			const skillContent = skillFileCall![1] as string
			expect(skillContent).toMatch(/^---/)
			expect(skillContent).toContain('name: issue-implementer')
			expect(skillContent).toContain('description: Implementer agent')
			expect(skillContent).toContain('model: ')
			expect(skillContent).toContain('context: fork')
			expect(skillContent).toContain('agent: issue-implementer')
			expect(skillContent).not.toContain('agent: general-purpose')
			expect(skillContent).toContain('Proceed via your system prompt.')
			expect(skillContent).not.toContain('Implement things')
		})

		describe('phase agent swarmModel overrides', () => {
			// Helper to extract agent file content by swarm name
			const getAgentContent = (swarmName: string): string | undefined => {
				const call = vi.mocked(fs.writeFile).mock.calls.find(
					(c) => (c[0] as string).endsWith(`${swarmName}.md`),
				)
				return call ? (call[1] as string) : undefined
			}

			it('uses per-agent swarmModel when configured', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
					agents: {
						'iloom-issue-implementer': { swarmModel: 'haiku' },
					},
				} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-implementer': {
						description: 'Implementer agent',
						prompt: 'Implement things',
						tools: ['Bash', 'Read'],
						model: 'opus',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				expect(getAgentContent('issue-implementer')).toContain('model: haiku')
			})

			it('applies default swarmModel (sonnet) for agents in default map when no swarmModel configured', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
					agents: {
						'iloom-issue-implementer': { model: 'opus' },
					},
				} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-implementer': {
						description: 'Implementer agent',
						prompt: 'Implement things',
						tools: ['Bash', 'Read'],
						model: 'opus',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				// iloom-issue-implementer is in the default swarmModel map, so it should be sonnet
				expect(getAgentContent('issue-implementer')).toContain('model: sonnet')
			})

			it('applies default swarmModel (opus) for analyzer agent', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-analyzer': {
						description: 'Analyzer agent',
						prompt: 'Analyze things',
						model: 'sonnet',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				// iloom-issue-analyzer is in the default swarmModel map as opus
				expect(getAgentContent('issue-analyzer')).toContain('model: opus')
			})

			it('non-swarm model override does not affect swarm mode when default map covers the agent', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
					agents: {
						'iloom-issue-implementer': { model: 'haiku' },
						'iloom-issue-analyzer': { model: 'haiku' },
						'iloom-issue-planner': { model: 'haiku' },
					},
				} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-implementer': {
						description: 'Implementer agent',
						prompt: 'Implement things',
						model: 'haiku',
					},
					'iloom-issue-analyzer': {
						description: 'Analyzer agent',
						prompt: 'Analyze things',
						model: 'haiku',
					},
					'iloom-issue-planner': {
						description: 'Planner agent',
						prompt: 'Plan things',
						model: 'haiku',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				// Even though non-swarm model is set to haiku, swarm defaults override
				// Check agent files (which carry the full prompt and model)
				expect(getAgentContent('issue-implementer')).toContain('model: sonnet')
				expect(getAgentContent('issue-analyzer')).toContain('model: opus')
				expect(getAgentContent('issue-planner')).toContain('model: sonnet')
			})

			it('explicit swarmModel overrides both non-swarm model and default map', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
					agents: {
						'iloom-issue-implementer': { model: 'haiku', swarmModel: 'opus' },
						'iloom-issue-analyzer': { model: 'haiku', swarmModel: 'haiku' },
					},
				} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-implementer': {
						description: 'Implementer agent',
						prompt: 'Implement things',
						model: 'haiku',
					},
					'iloom-issue-analyzer': {
						description: 'Analyzer agent',
						prompt: 'Analyze things',
						model: 'haiku',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				// Explicit swarmModel always wins over both non-swarm model and default map
				expect(getAgentContent('issue-implementer')).toContain('model: opus')
				expect(getAgentContent('issue-analyzer')).toContain('model: haiku')
			})

			it('different agents can have different swarmModels', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
					agents: {
						'iloom-issue-implementer': { swarmModel: 'sonnet' },
						'iloom-issue-planner': { swarmModel: 'haiku' },
					},
				} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-implementer': {
						description: 'Implementer agent',
						prompt: 'Implement things',
						tools: ['Bash', 'Read'],
						model: 'opus',
					},
					'iloom-issue-planner': {
						description: 'Planner agent',
						prompt: 'Plan things',
						model: 'opus',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				expect(getAgentContent('issue-implementer')).toContain('model: sonnet')
				expect(getAgentContent('issue-planner')).toContain('model: haiku')
			})

			it('swarmModel override does not emit allowed-tools even when agent has tools', async () => {
				vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
					agents: {
						'iloom-issue-implementer': { swarmModel: 'haiku' },
					},
				} as unknown as IloomSettings)

				vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
					'iloom-issue-implementer': {
						description: 'Implementer agent',
						prompt: 'Implement things',
						tools: ['Bash', 'Read'],
						model: 'opus',
					},
				})

				await service.renderSwarmAgents(PLUGIN_DIR, EPIC_WORKTREE_PATH)

				const agentContent = getAgentContent('issue-implementer')
				expect(agentContent).toContain('model: haiku')
				expect(agentContent).not.toContain('allowed-tools')
			})
		})
	})

	describe('renderSwarmWorkerAgent', () => {
		it('calls PromptTemplateManager.getPrompt with SWARM_MODE=true and ONE_SHOT_MODE=true', async () => {
			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					SWARM_MODE: true,
					ONE_SHOT_MODE: true,
				}),
			)
		})

		it('passes EPIC_WORKTREE_PATH as template variable', async () => {
			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					EPIC_WORKTREE_PATH,
				}),
			)
		})

		it('does not pass MCP_CONFIG_JSON or SWARM_AGENT_METADATA as template variables', async () => {
			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('MCP_CONFIG_JSON')
			expect(calledVariables).not.toHaveProperty('SWARM_AGENT_METADATA')
			expect(calledVariables).not.toHaveProperty('SWARM_SUB_AGENT_TIMEOUT_MS')
		})

		it('writes agent file with frontmatter to pluginDir/agents/worker.md', async () => {
			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(fs.writeFile).toHaveBeenCalledWith(
				`${PLUGIN_DIR}/agents/worker.md`,
				expect.stringContaining('---\nname: worker\n'),
				'utf-8',
			)
		})

		it('includes frontmatter with correct fields and defaults model to sonnet', async () => {
			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('name: worker')
			expect(writtenContent).toContain('description: Swarm worker agent that implements a child issue following the full iloom workflow.')
			expect(writtenContent).toContain('model: sonnet')
		})

		it('uses model from settings.agents["iloom-swarm-worker"] when configured', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
				agents: {
					'iloom-swarm-worker': {
						model: 'haiku',
					},
				},
			} as unknown as IloomSettings)

			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('model: haiku')
			expect(writtenContent).not.toContain('model: opus')
		})

		it('includes rendered template content in the body', async () => {
			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('# Rendered swarm skill content')
		})

		it('includes review configuration variables from settings', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
				agents: {
					'iloom-code-reviewer': {
						enabled: true,
						providers: { claude: 'opus' },
					},
				},
		} as unknown as IloomSettings)

			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					SWARM_MODE: true,
					ONE_SHOT_MODE: true,
					REVIEW_ENABLED: true,
					REVIEW_CLAUDE_MODEL: 'opus',
				}),
			)
		})

		it('returns true on success', async () => {
			const result = await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(result).toBe(true)
		})

		it('returns false and logs warning when getPrompt fails', async () => {
			vi.mocked(mockTemplateManager.getPrompt).mockRejectedValueOnce(
				new Error('Template not found'),
			)

			const result = await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(result).toBe(false)
		})

		it('should pass review template variables computed with swarm context', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
				agents: {
					'iloom-issue-planner': { review: true, swarmReview: false },
					'iloom-issue-analyzer': { review: true },
				},
			} as unknown as IloomSettings)

			await service.renderSwarmWorkerAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			// swarmReview: false should override review: true for planner in swarm mode
			// analyzer has no swarmReview, so it defaults to false in swarm mode
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					PLANNER_REVIEW_ENABLED: false,
					ANALYZER_REVIEW_ENABLED: false,
				}),
			)
		})

	})

	describe('renderSwarmWaveVerifierAgent', () => {
		it('passes review template variables to loadAgents', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
				agents: {
					'iloom-code-reviewer': {
						enabled: true,
						providers: { claude: 'opus', gemini: 'pro', codex: 'o3' },
					},
				},
			} as unknown as IloomSettings)

			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-wave-verifier': {
					description: 'Wave verifier',
					prompt: 'Verify things',
					model: 'sonnet',
				},
			})

			await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					SWARM_MODE: true,
					EPIC_WORKTREE_PATH,
					REVIEW_ENABLED: true,
					REVIEW_CLAUDE_MODEL: 'opus',
					HAS_REVIEW_CLAUDE: true,
					REVIEW_GEMINI_MODEL: 'pro',
					HAS_REVIEW_GEMINI: true,
					REVIEW_CODEX_MODEL: 'o3',
					HAS_REVIEW_CODEX: true,
				}),
				['iloom-wave-verifier.md'],
			)
		})

		it('writes agent file with frontmatter and prompt body', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-wave-verifier': {
					description: 'Wave verification agent',
					prompt: 'Verify the wave integration',
					model: 'sonnet',
				},
			})

			await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('wave-verifier.md'),
			)?.[1] as string

			expect(writtenContent).toContain('name: wave-verifier')
			expect(writtenContent).toContain('description: Wave verification agent')
			expect(writtenContent).toContain('model: sonnet')
			expect(writtenContent).toContain('Verify the wave integration')
		})

		it('uses model from settings when configured', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
				agents: {
					'iloom-wave-verifier': { model: 'opus' },
				},
			} as unknown as IloomSettings)

			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-wave-verifier': {
					description: 'Wave verifier',
					prompt: 'Verify things',
					model: 'sonnet',
				},
			})

			await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('wave-verifier.md'),
			)?.[1] as string

			expect(writtenContent).toContain('model: opus')
		})

		it('includes tools in frontmatter when agent defines them', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-wave-verifier': {
					description: 'Wave verifier',
					prompt: 'Verify things',
					model: 'sonnet',
					tools: ['Bash', 'Read', 'Grep'],
				},
			})

			await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('wave-verifier.md'),
			)?.[1] as string

			expect(writtenContent).toContain('tools: Bash, Read, Grep')
		})

		it('returns false when wave verifier template is not found', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({})

			const result = await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(result).toBe(false)
		})

		it('returns false and logs warning when loadAgents fails', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockRejectedValueOnce(
				new Error('Failed to load agents'),
			)

			const result = await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(result).toBe(false)
		})

		it('defaults review variables when no agent settings configured', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce(null)

			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-wave-verifier': {
					description: 'Wave verifier',
					prompt: 'Verify things',
					model: 'sonnet',
				},
			})

			await service.renderSwarmWaveVerifierAgent(PLUGIN_DIR, EPIC_WORKTREE_PATH)

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				null,
				expect.objectContaining({
					REVIEW_ENABLED: true,
					HAS_REVIEW_CLAUDE: true,
					REVIEW_CLAUDE_MODEL: 'sonnet',
					HAS_REVIEW_GEMINI: false,
					HAS_REVIEW_CODEX: false,
				}),
				['iloom-wave-verifier.md'],
			)
		})
	})

	describe('createPluginManifest', () => {
		it('writes plugin.json to pluginDir/.claude-plugin/', async () => {
			await service.createPluginManifest(PLUGIN_DIR)

			expect(fs.ensureDir).toHaveBeenCalledWith(`${PLUGIN_DIR}/.claude-plugin`)
			expect(fs.writeFile).toHaveBeenCalledWith(
				`${PLUGIN_DIR}/.claude-plugin/plugin.json`,
				expect.stringContaining('"name": "iloom-swarm"'),
				'utf-8',
			)
		})

		it('includes version from package info', async () => {
			await service.createPluginManifest(PLUGIN_DIR)

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('plugin.json'),
			)?.[1] as string

			const parsed = JSON.parse(writtenContent)
			expect(parsed.name).toBe('iloom-swarm')
			expect(parsed.version).toBe('1.2.3')
		})
	})

	describe('setupSwarm', () => {
		it('runs full setup: renders agents, worker agent, and verifier agent', async () => {
			const result = await service.setupSwarm(
				'epic/610',
				EPIC_WORKTREE_PATH,
			)

			expect(result.epicWorktreePath).toBe(EPIC_WORKTREE_PATH)
			expect(result.epicBranch).toBe('epic/610')
			expect(result.skillsRendered.length).toBeGreaterThan(0)
			expect(result.renderedAgents.length).toBeGreaterThan(0)
			expect(result.workerAgentRendered).toBe(true)
			expect(result.verifierAgentRendered).toBeDefined()
		})

		it('returns pluginDir in result', async () => {
			const result = await service.setupSwarm(
				'epic/610',
				EPIC_WORKTREE_PATH,
			)

			expect(result.pluginDir).toBe('/tmp/iloom-swarm-plugin-abc123')
		})

		it('creates plugin manifest before rendering agents', async () => {
			await service.setupSwarm(
				'epic/610',
				EPIC_WORKTREE_PATH,
			)

			// Verify mkdtemp was called to create temp dir
			expect(fs.mkdtemp).toHaveBeenCalledWith(
				expect.stringContaining('iloom-swarm-plugin-'),
			)

			// Verify plugin manifest was created
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('.claude-plugin/plugin.json'),
				expect.stringContaining('"name": "iloom-swarm"'),
				'utf-8',
			)
		})

		it('does not pass SWARM_AGENT_METADATA or MCP_CONFIG_JSON to worker agent', async () => {
			await service.setupSwarm(
				'epic/610',
				EPIC_WORKTREE_PATH,
			)

			// Verify getPrompt was called for the worker agent
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					EPIC_WORKTREE_PATH,
				}),
			)
			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('MCP_CONFIG_JSON')
			expect(calledVariables).not.toHaveProperty('SWARM_AGENT_METADATA')
		})
	})
})
