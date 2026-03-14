import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import { SwarmSetupService, type SwarmChildIssue } from './SwarmSetupService.js'
import type { GitWorktreeManager } from './GitWorktreeManager.js'
import type { MetadataManager, LoomMetadata } from './MetadataManager.js'
import type { AgentManager } from './AgentManager.js'
import type { SettingsManager, IloomSettings } from './SettingsManager.js'
import type { PromptTemplateManager } from './PromptTemplateManager.js'

// Mock dependencies
vi.mock('../utils/claude-trust.js', () => ({
	preAcceptClaudeTrust: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../utils/package-manager.js', () => ({
	installDependencies: vi.fn().mockResolvedValue(undefined),
}))

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
		ensureDir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		pathExists: vi.fn().mockResolvedValue(true),
		copy: vi.fn().mockResolvedValue(undefined),
	},
}))

const { mockGenerateAndWriteMcpConfigFile } = vi.hoisted(() => ({
	mockGenerateAndWriteMcpConfigFile: vi.fn().mockResolvedValue('/Users/test/.config/iloom-ai/mcp-configs/test.json'),
}))

vi.mock('../utils/mcp.js', () => ({
	generateAndWriteMcpConfigFile: mockGenerateAndWriteMcpConfigFile,
}))

vi.mock('./IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		getProviderName: vi.fn().mockReturnValue('github'),
	},
}))

describe('SwarmSetupService', () => {
	let service: SwarmSetupService
	let mockGitWorktree: GitWorktreeManager
	let mockMetadataManager: MetadataManager
	let mockAgentManager: AgentManager
	let mockSettingsManager: SettingsManager
	let mockTemplateManager: PromptTemplateManager

	const childIssues: SwarmChildIssue[] = [
		{ number: '#101', title: 'Child issue 1', body: 'Body 1', url: 'https://github.com/org/repo/issues/101' },
		{ number: '#102', title: 'Child issue 2', body: 'Body 2', url: 'https://github.com/org/repo/issues/102' },
	]

	const mockLoomMetadata: LoomMetadata = {
		description: 'Child issue 1',
		created_at: '2024-01-01T00:00:00Z',
		branchName: 'issue/101',
		worktreePath: '/Users/dev/project__issue-101',
		issueType: 'issue',
		issueKey: null,
		issue_numbers: ['101'],
		pr_numbers: [],
		issueTracker: 'github',
		colorHex: '#808080',
		sessionId: '',
		projectPath: '/Users/dev/project',
		issueUrls: { '101': 'https://github.com/org/repo/issues/101' },
		prUrls: {},
		draftPrNumber: null,
		oneShot: null,
		capabilities: [],
		state: 'pending',
		childIssueNumbers: [],
		parentLoom: {
			type: 'epic',
			identifier: '610',
			branchName: 'epic/610',
			worktreePath: '/Users/dev/project-epic-610',
		},
		childIssues: [],
		dependencyMap: {},
		mcpConfigPath: null,
	}

	beforeEach(() => {
		mockGitWorktree = {
			createWorktree: vi.fn().mockResolvedValue(undefined),
			removeWorktree: vi.fn().mockResolvedValue(undefined),
		} as unknown as GitWorktreeManager

		mockMetadataManager = {
			writeMetadata: vi.fn().mockResolvedValue(undefined),
			readMetadata: vi.fn().mockResolvedValue(mockLoomMetadata),
			updateMetadata: vi.fn().mockResolvedValue(undefined),
		} as unknown as MetadataManager

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

		// Re-configure mocks after vitest's automatic mockReset
		mockGenerateAndWriteMcpConfigFile.mockResolvedValue('/Users/test/.config/iloom-ai/mcp-configs/test.json')
		vi.mocked(fs.pathExists).mockResolvedValue(true as never)
		vi.mocked(fs.copy).mockResolvedValue(undefined)

		service = new SwarmSetupService(
			mockGitWorktree,
			mockMetadataManager,
			mockAgentManager,
			mockSettingsManager,
			mockTemplateManager,
		)
	})

	describe('createChildWorktrees', () => {
		it('creates worktrees for each child issue with standard naming', async () => {
			const results = await service.createChildWorktrees(
				childIssues,
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			expect(results).toHaveLength(2)
			expect(results[0]!.success).toBe(true)
			expect(results[0]!.issueId).toBe('101')
			expect(results[0]!.branch).toBe('issue/101')
			expect(results[1]!.success).toBe(true)
			expect(results[1]!.issueId).toBe('102')
			expect(results[1]!.branch).toBe('issue/102')
		})

		it('creates worktrees branched from the epic branch', async () => {
			await service.createChildWorktrees(
				childIssues,
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
				expect.objectContaining({
					branch: 'issue/101',
					createBranch: true,
					baseBranch: 'epic/610',
				}),
			)
		})

		it('writes metadata with state pending and parentLoom reference', async () => {
			await service.createChildWorktrees(
				childIssues,
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			expect(mockMetadataManager.writeMetadata).toHaveBeenCalledTimes(2)
			const firstCall = vi.mocked(mockMetadataManager.writeMetadata).mock.calls[0]
			const metadataInput = firstCall![1]

			expect(metadataInput.state).toBe('pending')
			expect(metadataInput.issueType).toBe('issue')
			expect(metadataInput.issue_numbers).toEqual(['101'])
			expect(metadataInput.parentLoom).toEqual({
				type: 'epic',
				identifier: '610',
				branchName: 'epic/610',
				worktreePath: '/Users/dev/project-epic-610',
			})
		})

		it('generates MCP config file for each child worktree', async () => {
			await service.createChildWorktrees(
				childIssues,
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			// Should be called once per child
			expect(mockGenerateAndWriteMcpConfigFile).toHaveBeenCalledTimes(2)
			// Should update metadata with mcpConfigPath
			expect(mockMetadataManager.updateMetadata).toHaveBeenCalledTimes(2)
			expect(mockMetadataManager.updateMetadata).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					mcpConfigPath: '/Users/test/.config/iloom-ai/mcp-configs/test.json',
				}),
			)
		})

		it('writes iloom-swarm-mcp-config-path file to .claude/ in each child worktree', async () => {
			await service.createChildWorktrees(
				childIssues,
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			// Should write iloom-swarm-mcp-config-path for each child
			const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
			const configPathWrites = writeFileCalls.filter(
				(call) => typeof call[0] === 'string' && (call[0] as string).endsWith('iloom-swarm-mcp-config-path'),
			)
			expect(configPathWrites).toHaveLength(2)
			// Each file should contain just the MCP config path string
			expect(configPathWrites[0]![1]).toBe('/Users/test/.config/iloom-ai/mcp-configs/test.json')
			expect(configPathWrites[1]![1]).toBe('/Users/test/.config/iloom-ai/mcp-configs/test.json')
		})

		it('handles individual worktree creation failures gracefully', async () => {
			vi.mocked(mockGitWorktree.createWorktree)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('Branch already exists'))

			const results = await service.createChildWorktrees(
				childIssues,
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			expect(results).toHaveLength(2)
			expect(results[0]!.success).toBe(true)
			expect(results[1]!.success).toBe(false)
			expect(results[1]!.error).toBe('Branch already exists')
		})

		it('cleans up worktree if metadata write fails', async () => {
			vi.mocked(mockMetadataManager.writeMetadata).mockRejectedValueOnce(new Error('Write failed'))

			const results = await service.createChildWorktrees(
				[childIssues[0]!],
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			expect(results[0]!.success).toBe(false)
			expect(mockGitWorktree.removeWorktree).toHaveBeenCalled()
		})

		it('continues if MCP config generation fails', async () => {
			mockGenerateAndWriteMcpConfigFile.mockRejectedValueOnce(new Error('MCP config failed'))

			const results = await service.createChildWorktrees(
				[childIssues[0]!],
				'epic/610',
				'/Users/dev/project-epic-610',
				'/Users/dev/project',
				'610',
				'github',
			)

			// Should still succeed despite MCP config failure
			expect(results[0]!.success).toBe(true)
		})
	})

	describe('renderSwarmAgents', () => {
		it('writes agent files to .claude/agents/ and skill wrappers to .claude/skills/', async () => {
			const result = await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(result.renderedSkills).toHaveLength(1)
			expect(result.renderedSkills[0]).toBe('iloom-swarm-issue-implementer')
			expect(result.renderedAgents).toHaveLength(1)
			expect(result.renderedAgents[0]).toBe('iloom-swarm-issue-implementer')

			// Verify agents directory was created
			expect(fs.ensureDir).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents',
			)

			// Verify agent file was written
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents/iloom-swarm-issue-implementer.md',
				expect.any(String),
				'utf-8',
			)

			// Verify skill directory was created
			expect(fs.ensureDir).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-swarm-issue-implementer',
			)

			// Verify thin SKILL.md was written to the skill directory
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-swarm-issue-implementer/SKILL.md',
				expect.any(String),
				'utf-8',
			)
		})

		it('loads agents with SWARM_MODE and EPIC_WORKTREE_PATH', async () => {
			await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					SWARM_MODE: true,
					EPIC_WORKTREE_PATH: '/Users/dev/project-epic-610',
				}),
			)
		})

		it('writes agent file with full prompt and skill wrapper with delegation body', async () => {
			await service.renderSwarmAgents('/Users/dev/project-epic-610')

			const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
			const agentFileCall = writeFileCalls.find(
				(call) => (call[0] as string).endsWith('iloom-swarm-issue-implementer.md'),
			)
			const skillFileCall = writeFileCalls.find(
				(call) => (call[0] as string).endsWith('SKILL.md'),
			)

			// Agent file should contain full prompt
			const agentContent = agentFileCall![1] as string
			expect(agentContent).toMatch(/^---/)
			expect(agentContent).toContain('name: iloom-swarm-issue-implementer')
			expect(agentContent).toContain('description: Implementer agent')
			expect(agentContent).toContain('model: ')
			expect(agentContent).not.toContain('context: fork')
			expect(agentContent).not.toContain('agent:')
			expect(agentContent).toContain('Implement things')

			// Skill wrapper should be thin with agent reference
			const skillContent = skillFileCall![1] as string
			expect(skillContent).toMatch(/^---/)
			expect(skillContent).toContain('name: iloom-swarm-issue-implementer')
			expect(skillContent).toContain('description: Implementer agent')
			expect(skillContent).toContain('model: ')
			expect(skillContent).toContain('context: fork')
			expect(skillContent).toContain('agent: iloom-swarm-issue-implementer')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				expect(getAgentContent('iloom-swarm-issue-implementer')).toContain('model: haiku')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				// iloom-issue-implementer is in the default swarmModel map, so it should be sonnet
				expect(getAgentContent('iloom-swarm-issue-implementer')).toContain('model: sonnet')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				// iloom-issue-analyzer is in the default swarmModel map as opus
				expect(getAgentContent('iloom-swarm-issue-analyzer')).toContain('model: opus')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				// Even though non-swarm model is set to haiku, swarm defaults override
				// Check agent files (which carry the full prompt and model)
				expect(getAgentContent('iloom-swarm-issue-implementer')).toContain('model: sonnet')
				expect(getAgentContent('iloom-swarm-issue-analyzer')).toContain('model: opus')
				expect(getAgentContent('iloom-swarm-issue-planner')).toContain('model: sonnet')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				// Explicit swarmModel always wins over both non-swarm model and default map
				expect(getAgentContent('iloom-swarm-issue-implementer')).toContain('model: opus')
				expect(getAgentContent('iloom-swarm-issue-analyzer')).toContain('model: haiku')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				expect(getAgentContent('iloom-swarm-issue-implementer')).toContain('model: sonnet')
				expect(getAgentContent('iloom-swarm-issue-planner')).toContain('model: haiku')
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

				await service.renderSwarmAgents('/Users/dev/project-epic-610')

				const agentContent = getAgentContent('iloom-swarm-issue-implementer')
				expect(agentContent).toContain('model: haiku')
				expect(agentContent).not.toContain('allowed-tools')
			})
		})
	})

	describe('renderSwarmWorkerAgent', () => {
		it('calls PromptTemplateManager.getPrompt with SWARM_MODE=true and ONE_SHOT_MODE=true', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					SWARM_MODE: true,
					ONE_SHOT_MODE: true,
				}),
			)
		})

		it('passes EPIC_WORKTREE_PATH as template variable', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					EPIC_WORKTREE_PATH: '/Users/dev/project-epic-610',
				}),
			)
		})

		it('does not pass MCP_CONFIG_JSON or SWARM_AGENT_METADATA as template variables', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('MCP_CONFIG_JSON')
			expect(calledVariables).not.toHaveProperty('SWARM_AGENT_METADATA')
			expect(calledVariables).not.toHaveProperty('SWARM_SUB_AGENT_TIMEOUT_MS')
		})

		it('writes agent file with frontmatter to .claude/agents/iloom-swarm-worker.md', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents/iloom-swarm-worker.md',
				expect.stringContaining('---\nname: iloom-swarm-worker\n'),
				'utf-8',
			)
		})

		it('includes frontmatter with correct fields and defaults model to sonnet', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('name: iloom-swarm-worker')
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

			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('model: haiku')
			expect(writtenContent).not.toContain('model: opus')
		})

		it('includes rendered template content in the body', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

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

			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

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
			const result = await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			expect(result).toBe(true)
		})

		it('returns false and logs warning when getPrompt fails', async () => {
			vi.mocked(mockTemplateManager.getPrompt).mockRejectedValueOnce(
				new Error('Template not found'),
			)

			const result = await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			expect(result).toBe(false)
		})

		it('should pass review template variables computed with swarm context', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValueOnce({
				agents: {
					'iloom-issue-planner': { review: true, swarmReview: false },
					'iloom-issue-analyzer': { review: true },
				},
			} as unknown as IloomSettings)

			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

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

			await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					SWARM_MODE: true,
					EPIC_WORKTREE_PATH: '/Users/dev/project-epic-610',
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

			await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('iloom-swarm-wave-verifier.md'),
			)?.[1] as string

			expect(writtenContent).toContain('name: iloom-swarm-wave-verifier')
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

			await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('iloom-swarm-wave-verifier.md'),
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

			await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
				(call) => (call[0] as string).endsWith('iloom-swarm-wave-verifier.md'),
			)?.[1] as string

			expect(writtenContent).toContain('tools: Bash, Read, Grep')
		})

		it('returns false when wave verifier template is not found', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({})

			const result = await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

			expect(result).toBe(false)
		})

		it('returns false and logs warning when loadAgents fails', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockRejectedValueOnce(
				new Error('Failed to load agents'),
			)

			const result = await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

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

			await service.renderSwarmWaveVerifierAgent('/Users/dev/project-epic-610')

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

	describe('copyAgentsAndSkillsToChildWorktrees', () => {
		it('copies both .claude/agents/ and .claude/skills/ from epic to each successful child worktree', async () => {
			const childWorktrees = [
				{ issueId: '101', worktreePath: '/Users/dev/project__issue-101', branch: 'issue/101', success: true },
				{ issueId: '102', worktreePath: '/Users/dev/project__issue-102', branch: 'issue/102', success: true },
			]

			await service.copyAgentsAndSkillsToChildWorktrees('/Users/dev/project-epic-610', childWorktrees)

			// 2 children x 2 directories (agents + skills) = 4 copy calls
			expect(fs.copy).toHaveBeenCalledTimes(4)
			expect(fs.copy).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents',
				'/Users/dev/project__issue-101/.claude/agents',
				{ overwrite: true },
			)
			expect(fs.copy).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills',
				'/Users/dev/project__issue-101/.claude/skills',
				{ overwrite: true },
			)
			expect(fs.copy).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents',
				'/Users/dev/project__issue-102/.claude/agents',
				{ overwrite: true },
			)
			expect(fs.copy).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills',
				'/Users/dev/project__issue-102/.claude/skills',
				{ overwrite: true },
			)
		})

		it('skips failed child worktrees', async () => {
			const childWorktrees = [
				{ issueId: '101', worktreePath: '/Users/dev/project__issue-101', branch: 'issue/101', success: true },
				{ issueId: '102', worktreePath: '', branch: '', success: false, error: 'Branch already exists' },
			]

			await service.copyAgentsAndSkillsToChildWorktrees('/Users/dev/project-epic-610', childWorktrees)

			// 1 child x 2 directories = 2 copy calls
			expect(fs.copy).toHaveBeenCalledTimes(2)
		})

		it('skips copy when neither agents nor skills directories exist', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const childWorktrees = [
				{ issueId: '101', worktreePath: '/Users/dev/project__issue-101', branch: 'issue/101', success: true },
			]

			await service.copyAgentsAndSkillsToChildWorktrees('/Users/dev/project-epic-610', childWorktrees)

			expect(fs.copy).not.toHaveBeenCalled()
		})

		it('copies only agents when skills directory does not exist', async () => {
			vi.mocked(fs.pathExists)
				.mockResolvedValueOnce(true as never)  // agents exists
				.mockResolvedValueOnce(false as never)  // skills does not exist

			const childWorktrees = [
				{ issueId: '101', worktreePath: '/Users/dev/project__issue-101', branch: 'issue/101', success: true },
			]

			await service.copyAgentsAndSkillsToChildWorktrees('/Users/dev/project-epic-610', childWorktrees)

			expect(fs.copy).toHaveBeenCalledTimes(1)
			expect(fs.copy).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents',
				'/Users/dev/project__issue-101/.claude/agents',
				{ overwrite: true },
			)
		})

		it('copies only skills when agents directory does not exist', async () => {
			vi.mocked(fs.pathExists)
				.mockResolvedValueOnce(false as never)  // agents does not exist
				.mockResolvedValueOnce(true as never)   // skills exists

			const childWorktrees = [
				{ issueId: '101', worktreePath: '/Users/dev/project__issue-101', branch: 'issue/101', success: true },
			]

			await service.copyAgentsAndSkillsToChildWorktrees('/Users/dev/project-epic-610', childWorktrees)

			expect(fs.copy).toHaveBeenCalledTimes(1)
			expect(fs.copy).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills',
				'/Users/dev/project__issue-101/.claude/skills',
				{ overwrite: true },
			)
		})

		it('continues if copy fails for one child', async () => {
			vi.mocked(fs.copy)
				.mockRejectedValueOnce(new Error('Permission denied'))
				.mockResolvedValue(undefined)

			const childWorktrees = [
				{ issueId: '101', worktreePath: '/Users/dev/project__issue-101', branch: 'issue/101', success: true },
				{ issueId: '102', worktreePath: '/Users/dev/project__issue-102', branch: 'issue/102', success: true },
			]

			await service.copyAgentsAndSkillsToChildWorktrees('/Users/dev/project-epic-610', childWorktrees)

			// Should attempt all copies despite first failure
			expect(fs.copy).toHaveBeenCalled()
		})
	})

	describe('setupSwarm', () => {
		it('runs full setup: renders agents, worker agent, and verifier agent (no child worktrees)', async () => {
			const result = await service.setupSwarm(
				'epic/610',
				'/Users/dev/project-epic-610',
			)

			expect(result.epicWorktreePath).toBe('/Users/dev/project-epic-610')
			expect(result.epicBranch).toBe('epic/610')
			expect(result.skillsRendered.length).toBeGreaterThan(0)
			expect(result.renderedAgents.length).toBeGreaterThan(0)
			expect(result.workerAgentRendered).toBe(true)
			expect(result.verifierAgentRendered).toBeDefined()
		})

		it('does not create child worktrees or copy agents/skills to children', async () => {
			await service.setupSwarm(
				'epic/610',
				'/Users/dev/project-epic-610',
			)

			// Should NOT have called createWorktree (child worktrees are created on-the-fly by orchestrator)
			expect(mockGitWorktree.createWorktree).not.toHaveBeenCalled()
			// Should NOT have checked for agents/skills dirs to copy (no child worktrees to copy to)
			expect(fs.copy).not.toHaveBeenCalled()
		})

		it('does not pass SWARM_AGENT_METADATA or MCP_CONFIG_JSON to worker agent', async () => {
			await service.setupSwarm(
				'epic/610',
				'/Users/dev/project-epic-610',
			)

			// Verify getPrompt was called for the worker agent
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					EPIC_WORKTREE_PATH: '/Users/dev/project-epic-610',
				}),
			)
			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('MCP_CONFIG_JSON')
			expect(calledVariables).not.toHaveProperty('SWARM_AGENT_METADATA')
		})
	})
})
