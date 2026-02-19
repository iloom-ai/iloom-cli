import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SwarmSetupService, type SwarmChildIssue } from './SwarmSetupService.js'
import type { GitWorktreeManager } from './GitWorktreeManager.js'
import type { MetadataManager } from './MetadataManager.js'
import type { AgentManager } from './AgentManager.js'
import type { SettingsManager } from './SettingsManager.js'

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

describe('SwarmSetupService', () => {
	let service: SwarmSetupService
	let mockGitWorktree: GitWorktreeManager
	let mockMetadataManager: MetadataManager
	let mockAgentManager: AgentManager
	let mockSettingsManager: SettingsManager

	const childIssues: SwarmChildIssue[] = [
		{ number: '#101', title: 'Child issue 1', body: 'Body 1', url: 'https://github.com/org/repo/issues/101' },
		{ number: '#102', title: 'Child issue 2', body: 'Body 2', url: 'https://github.com/org/repo/issues/102' },
	]

	beforeEach(() => {
		mockGitWorktree = {
			createWorktree: vi.fn().mockResolvedValue(undefined),
			removeWorktree: vi.fn().mockResolvedValue(undefined),
		} as unknown as GitWorktreeManager

		mockMetadataManager = {
			writeMetadata: vi.fn().mockResolvedValue(undefined),
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

		service = new SwarmSetupService(
			mockGitWorktree,
			mockMetadataManager,
			mockAgentManager,
			mockSettingsManager,
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
	})

	describe('renderSwarmAgents', () => {
		it('renders agents with swarm naming convention', async () => {
			const result = await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(result).toHaveLength(1)
			expect(result[0]).toBe('iloom-swarm-issue-implementer.md')
		})

		it('loads agents with SWARM_MODE=true', async () => {
			await service.renderSwarmAgents('/Users/dev/project-epic-610')

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ SWARM_MODE: true }),
			)
		})
	})

	describe('setupSwarm', () => {
		it('runs full setup: child worktrees and agents', async () => {
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
		})
	})
})
