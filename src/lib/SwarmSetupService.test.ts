import path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import { SwarmSetupService, type SwarmChildIssue } from './SwarmSetupService.js'
import type { GitWorktreeManager } from './GitWorktreeManager.js'
import type { MetadataManager } from './MetadataManager.js'
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

		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('# Rendered swarm skill content'),
		} as unknown as PromptTemplateManager

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

		it('handles individual worktree creation failures gracefully', async () => {
			vi.mocked(mockGitWorktree.createWorktree)
				.mockResolvedValueOnce('/Users/dev/project-epic-610/worktree-1')
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
			} as unknown as Awaited<ReturnType<typeof mockSettingsManager.loadSettings>>)

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

	describe('renderSwarmSkills', () => {
		it('renders skill files for each mapped agent to .claude/skills/ directory', async () => {
			// Setup: mock loadAgents to return mapped agents + unmapped framework-detector
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-enhancer': {
					description: 'Enhances issues',
					prompt: 'Enhance the issue',
					model: 'opus',
				},
				'iloom-issue-implementer': {
					description: 'Implements issues',
					prompt: 'Implement the issue',
					tools: ['Bash', 'Read'],
					model: 'opus',
				},
				'iloom-framework-detector': {
					description: 'Detects frameworks',
					prompt: 'Detect frameworks',
					model: 'sonnet',
				},
			})

			const result = await service.renderSwarmSkills('/Users/dev/project-epic-610')

			// Should render 2 skills (enhancer + implementer), NOT framework-detector
			expect(result).toHaveLength(2)
			expect(result).toContain('iloom-enhance')
			expect(result).toContain('iloom-implement')
			expect(result).not.toContain('iloom-framework-detector')

			// Verify ensureDir called for each skill directory
			expect(fs.ensureDir).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-enhance',
			)
			expect(fs.ensureDir).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-implement',
			)

			// Verify writeFile called with correct paths
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-enhance/SKILL.md',
				expect.any(String),
				'utf-8',
			)
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-implement/SKILL.md',
				expect.any(String),
				'utf-8',
			)
		})

		it('uses agent-to-skill name mapping for directory names', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-enhancer': {
					description: 'Enhances issues',
					prompt: 'Enhance the issue',
					model: 'opus',
				},
			})

			const result = await service.renderSwarmSkills('/Users/dev/project-epic-610')

			// Should use mapped name (iloom-enhance), not agent name (iloom-issue-enhancer)
			expect(result).toEqual(['iloom-enhance'])
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/Users/dev/project-epic-610/.claude/skills/iloom-enhance/SKILL.md',
				expect.any(String),
				'utf-8',
			)
		})

		it('includes skill frontmatter with disable-model-invocation: true', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-enhancer': {
					description: 'Enhances issues',
					prompt: 'Enhance the issue',
					tools: ['Bash', 'Read'],
					model: 'opus',
					color: 'blue',
				},
			})

			await service.renderSwarmSkills('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('name: iloom-enhance')
			expect(writtenContent).toContain('description: Enhances issues')
			expect(writtenContent).toContain('disable-model-invocation: true')
			// Should NOT contain agent-specific fields
			expect(writtenContent).not.toContain('model:')
			expect(writtenContent).not.toContain('tools:')
			expect(writtenContent).not.toContain('color:')
		})

		it('loads agents with SWARM_MODE=true and review template variables', async () => {
			await service.renderSwarmSkills('/Users/dev/project-epic-610')

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					SWARM_MODE: true,
					REVIEW_ENABLED: true, // default review enabled
				}),
			)
		})

		it('returns array of rendered skill directory names', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-enhancer': {
					description: 'Enhances issues',
					prompt: 'Enhance the issue',
					model: 'opus',
				},
				'iloom-code-reviewer': {
					description: 'Reviews code',
					prompt: 'Review the code',
					model: 'opus',
				},
			})

			const result = await service.renderSwarmSkills('/Users/dev/project-epic-610')

			expect(result).toEqual(expect.arrayContaining(['iloom-enhance', 'iloom-review']))
			expect(result).toHaveLength(2)
		})

		it('skips agents not in the skill mapping (e.g., framework-detector)', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-framework-detector': {
					description: 'Detects frameworks',
					prompt: 'Detect frameworks',
					model: 'sonnet',
				},
				'iloom-issue-implementer': {
					description: 'Implements issues',
					prompt: 'Implement the issue',
					model: 'opus',
				},
			})

			const result = await service.renderSwarmSkills('/Users/dev/project-epic-610')

			expect(result).toEqual(['iloom-implement'])
			// Should only write one file (implementer), not framework-detector
			expect(fs.writeFile).toHaveBeenCalledTimes(1)
		})

		it('propagates errors (fail-fast behavior)', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-enhancer': {
					description: 'Enhances issues',
					prompt: 'Enhance the issue',
					model: 'opus',
				},
			})
			vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('Disk full'))

			await expect(service.renderSwarmSkills('/Users/dev/project-epic-610')).rejects.toThrow('Disk full')
		})

		it('includes agent prompt body in the skill content', async () => {
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValueOnce({
				'iloom-issue-enhancer': {
					description: 'Enhances issues',
					prompt: 'You are an issue enhancement agent.\n\nEnhance the issue thoroughly.',
					model: 'opus',
				},
			})

			await service.renderSwarmSkills('/Users/dev/project-epic-610')

			const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]![1] as string
			expect(writtenContent).toContain('You are an issue enhancement agent.')
			expect(writtenContent).toContain('Enhance the issue thoroughly.')
		})
	})

	describe('setupSwarm', () => {
		it('runs full setup: child worktrees, agents, worker agent, and skills', async () => {
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
			expect(result.skillsRendered).toBeInstanceOf(Array)
			expect(result.skillsRendered.length).toBeGreaterThan(0)
		})

		it('includes skillsRendered in the result', async () => {
			const result = await service.setupSwarm(
				'610',
				'epic/610',
				'/Users/dev/project-epic-610',
				childIssues,
				'/Users/dev/project',
				'github',
			)

			// The default mock returns iloom-issue-implementer which maps to iloom-implement
			expect(result.skillsRendered).toContain('iloom-implement')
		})

		it('aborts setup if renderSwarmSkills fails', async () => {
			// Make loadAgents succeed for renderSwarmAgents but set up writeFile to fail
			// on the skill write (after the agent writes succeed)
			const writeFileMock = vi.mocked(fs.writeFile)
			// First calls from renderSwarmAgents and renderSwarmWorkerAgent succeed
			// Then renderSwarmSkills fails
			let callCount = 0
			writeFileMock.mockImplementation(async () => {
				callCount++
				// renderSwarmAgents writes 1 file, renderSwarmWorkerAgent writes 1 file
				// renderSwarmSkills write (3rd call) should fail
				if (callCount >= 3) {
					throw new Error('Skill rendering failed')
				}
			})

			await expect(
				service.setupSwarm(
					'610',
					'epic/610',
					'/Users/dev/project-epic-610',
					childIssues,
					'/Users/dev/project',
					'github',
				),
			).rejects.toThrow('Skill rendering failed')
		})
	})
})

describe('rendered worker prompt has no @agent- strings in SWARM_MODE', () => {
	it('renders issue-prompt.txt with SWARM_MODE=true and ONE_SHOT_MODE=true, verifying no @agent- strings remain', async () => {
		// Use the real PromptTemplateManager to render the actual template
		const { PromptTemplateManager, buildReviewTemplateVariables } = await import('./PromptTemplateManager.js')
		const templateDir = path.join(process.cwd(), 'templates', 'prompts')
		const templateManager = new PromptTemplateManager(templateDir)

		// Render with all SWARM_MODE-relevant variables set to true
		const variables = {
			SWARM_MODE: true,
			ONE_SHOT_MODE: true,
			INTERACTIVE_MODE: false,
			...buildReviewTemplateVariables({
				'iloom-code-reviewer': { enabled: true },
				'iloom-artifact-reviewer': { enabled: true },
				'iloom-issue-enhancer': { review: true },
				'iloom-issue-analyzer': { review: true },
				'iloom-issue-planner': { review: true },
				'iloom-issue-analyze-and-plan': { review: true },
				'iloom-issue-implementer': { review: true },
				'iloom-issue-complexity-evaluator': { review: true },
			}),
		}

		const rendered = await templateManager.getPrompt('issue', variables)

		// The primary invariant: no @agent- strings should remain
		// when rendered for SWARM_MODE + ONE_SHOT_MODE
		expect(rendered).not.toContain('@agent-')
	})
})
