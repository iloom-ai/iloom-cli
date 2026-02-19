import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import { SwarmSetupService, type SwarmChildIssue, type SwarmAgentMetadata } from './SwarmSetupService.js'
import type { GitWorktreeManager } from './GitWorktreeManager.js'
import type { MetadataManager, LoomMetadata } from './MetadataManager.js'
import type { AgentManager } from './AgentManager.js'
import type { SettingsManager } from './SettingsManager.js'
import type { PromptTemplateManager } from './PromptTemplateManager.js'

// Mock dependencies
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

		// Re-configure mock after vitest's automatic mockReset
		mockGenerateAndWriteMcpConfigFile.mockResolvedValue('/Users/test/.config/iloom-ai/mcp-configs/test.json')

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
		it('renders agents with swarm naming convention', async () => {
			const result = await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(result.renderedFiles).toHaveLength(1)
			expect(result.renderedFiles[0]).toBe('iloom-swarm-issue-implementer.md')
		})

		it('loads agents with SWARM_MODE=true', async () => {
			await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ SWARM_MODE: true }),
			)
		})

		it('writes agent files WITHOUT frontmatter (prompt body only)', async () => {
			await service.renderSwarmAgents('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			// Should NOT start with ---
			expect(writtenContent).not.toMatch(/^---/)
			// Should contain the prompt body
			expect(writtenContent).toContain('Implement things')
		})

		it('returns metadata with model and tools for each agent', async () => {
			const result = await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(result.metadata).toHaveProperty('iloom-swarm-issue-implementer')
			expect(result.metadata['iloom-swarm-issue-implementer']!.model).toBe('opus')
			expect(result.metadata['iloom-swarm-issue-implementer']!.tools).toEqual(['Bash', 'Read'])
		})

		it('omits tools from metadata when agent has no tools defined', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-analyzer': {
					description: 'Analyzer agent',
					prompt: 'Analyze things',
					model: 'sonnet',
				},
			})

			const result = await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(result.metadata['iloom-swarm-issue-analyzer']!.model).toBe('sonnet')
			expect(result.metadata['iloom-swarm-issue-analyzer']).not.toHaveProperty('tools')
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

		it('passes SWARM_AGENT_METADATA as template variable when provided', async () => {
			const agentMetadata: SwarmAgentMetadata = {
				'iloom-swarm-issue-implementer': { model: 'opus', tools: ['Bash'] },
			}
			await service.renderSwarmWorkerAgent(
				'/Users/dev/project-epic-610',
				agentMetadata,
			)

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					SWARM_AGENT_METADATA: expect.stringContaining('iloom-swarm-issue-implementer'),
				}),
			)
		})

		it('does not pass MCP_CONFIG_JSON as template variable', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('MCP_CONFIG_JSON')
		})

		it('omits SWARM_AGENT_METADATA when not provided', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('SWARM_AGENT_METADATA')
		})

		it('writes agent file with frontmatter to .claude/agents/iloom-swarm-worker.md', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/agents/iloom-swarm-worker.md',
				expect.stringContaining('---\nname: iloom-swarm-worker\n'),
				'utf-8',
			)
		})

		it('includes frontmatter with correct fields', async () => {
			await service.renderSwarmWorkerAgent('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('name: iloom-swarm-worker')
			expect(writtenContent).toContain('description: Swarm worker agent that implements a child issue following the full iloom workflow.')
			expect(writtenContent).toContain('model: opus')
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
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any)

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
	})

	describe('setupSwarm', () => {
		it('runs full setup: child worktrees, agents, and worker agent', async () => {
			const result = await service.setupSwarm(
				'610',
				'epic/610',
				'/Users/dev/project-epic-610',
				childIssues,
				'/Users/dev/project',
				'github',
			)

			expect(result.epicWorktreePath).toBe('/Users/dev/project-epic-610')
			expect(result.epicBranch).toBe('epic/610')
			expect(result.childWorktrees).toHaveLength(2)
			expect(result.agentsRendered.length).toBeGreaterThan(0)
			expect(result.workerAgentRendered).toBe(true)
		})

		it('passes agent metadata to renderSwarmWorkerAgent (no mcpConfigJson)', async () => {
			await service.setupSwarm(
				'610',
				'epic/610',
				'/Users/dev/project-epic-610',
				childIssues,
				'/Users/dev/project',
				'github',
			)

			// Verify that getPrompt was called with SWARM_AGENT_METADATA containing agent metadata
			// but NOT with MCP_CONFIG_JSON (removed in favor of per-loom config files)
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'issue',
				expect.objectContaining({
					SWARM_AGENT_METADATA: expect.stringContaining('iloom-swarm-issue-implementer'),
					EPIC_WORKTREE_PATH: '/Users/dev/project-epic-610',
				}),
			)
			const calledVariables = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]![1]
			expect(calledVariables).not.toHaveProperty('MCP_CONFIG_JSON')
		})
	})
})
