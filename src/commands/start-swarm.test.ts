import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StartCommand } from './start.js'
import { GitHubService } from '../lib/GitHubService.js'
import { LoomManager } from '../lib/LoomManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { BeadsManager, BeadsError } from '../lib/BeadsManager.js'
import { SwarmSupervisor } from '../lib/SwarmSupervisor.js'
import { findMainWorktreePathWithSettings } from '../utils/git.js'
import { promptConfirmation } from '../utils/prompt.js'
import { getRepoInfo } from '../utils/github.js'

// Mock all external dependencies
vi.mock('../lib/GitHubService.js')
vi.mock('../lib/LoomManager.js', () => ({
	LoomManager: vi.fn(() => ({
		createIloom: vi.fn().mockResolvedValue({
			id: 'epic-loom-100',
			path: '/test/worktrees/issue-100',
			branch: 'epic/issue-100',
			type: 'issue',
			identifier: 100,
			port: 3100,
			createdAt: new Date(),
			issueData: { title: 'Epic: Build feature X' },
		}),
		listLooms: vi.fn().mockResolvedValue([]),
	})),
}))
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/EnvironmentManager.js')
vi.mock('../lib/ClaudeContextManager.js')
vi.mock('../lib/AgentManager.js')
vi.mock('../lib/SettingsManager.js', () => ({
	SettingsManager: vi.fn(() => ({
		loadSettings: vi.fn().mockResolvedValue({}),
	})),
}))
vi.mock('../lib/BeadsManager.js', () => {
	const BeadsError = class extends Error {
		constructor(
			message: string,
			public readonly exitCode: number | undefined,
			public readonly stderr: string,
		) {
			super(message)
			this.name = 'BeadsError'
		}
	}
	return {
		BeadsManager: vi.fn(() => ({
			ensureInstalled: vi.fn().mockResolvedValue(undefined),
			init: vi.fn().mockResolvedValue(undefined),
			isInstalled: vi.fn().mockResolvedValue(true),
			ready: vi.fn().mockResolvedValue([]),
			list: vi.fn().mockResolvedValue([]),
			create: vi.fn().mockResolvedValue('task-1'),
			claim: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			releaseClaim: vi.fn().mockResolvedValue(undefined),
			addDependency: vi.fn().mockResolvedValue(undefined),
			getBeadsDir: vi.fn().mockReturnValue('/test/beads'),
					})),
		BeadsError,
	}
})
vi.mock('../lib/BeadsSyncService.js', () => ({
	BeadsSyncService: vi.fn(() => ({
		syncEpicToBeads: vi.fn().mockResolvedValue({
			created: [],
			skipped: [],
			dependenciesCreated: 0,
		}),
	})),
}))
vi.mock('../lib/SwarmSupervisor.js', () => ({
	SwarmSupervisor: vi.fn(() => ({
		run: vi.fn().mockResolvedValue({
			totalTasks: 3,
			completed: 3,
			failed: 0,
			mergedPRs: 3,
			failedMerges: 0,
			duration: 60000,
		}),
	})),
}))

vi.mock('../utils/git.js', async () => {
	const actual = await vi.importActual<typeof import('../utils/git.js')>('../utils/git.js')
	return {
		...actual,
		branchExists: vi.fn().mockResolvedValue(false),
		findMainWorktreePathWithSettings: vi.fn().mockResolvedValue('/test/main'),
		executeGitCommand: vi.fn().mockResolvedValue(''),
	}
})
vi.mock('../utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn().mockResolvedValue(false),
	getConfiguredRepoFromSettings: vi.fn().mockResolvedValue('owner/repo'),
	parseGitRemotes: vi.fn().mockResolvedValue([]),
	validateConfiguredRemote: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../utils/claude.js', () => ({
	launchClaude: vi.fn().mockResolvedValue('Enhanced description'),
}))
vi.mock('../utils/browser.js', () => ({
	openBrowser: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../utils/prompt.js', () => ({
	waitForKeypress: vi.fn().mockResolvedValue('a'),
	promptInput: vi.fn(),
	promptConfirmation: vi.fn().mockResolvedValue(true),
	isInteractiveEnvironment: vi.fn().mockReturnValue(true),
}))
vi.mock('../utils/first-run-setup.js', () => ({
	needsFirstRunSetup: vi.fn().mockResolvedValue(false),
	launchFirstRunSetup: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	})),
}))
vi.mock('../utils/github.js', () => ({
	getRepoInfo: vi.fn().mockResolvedValue({ owner: 'iloom-ai', name: 'iloom-test-project' }),
	executeGhCommand: vi.fn(),
}))
vi.mock('../mcp/IssueManagementProviderFactory.js', () => ({
	IssueManagementProviderFactory: {
		create: vi.fn().mockReturnValue({
			getChildIssues: vi.fn().mockResolvedValue([]),
			getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
		}),
	},
}))
vi.mock('../lib/EpicDetector.js', () => ({
	EpicDetector: vi.fn(() => ({
		detect: vi.fn().mockResolvedValue({
			isEpic: true,
			totalChildren: 3,
			readyChildren: 2,
			blockedChildren: 1,
			hasDependencies: true,
		}),
	})),
}))

/**
 * Helper to create a mock issue with the iloom-epic label
 */
function createMockEpicIssue(number: number) {
	return {
		number,
		title: 'Epic: Build feature X',
		body: 'Epic description',
		state: 'open' as const,
		labels: ['iloom-epic'],
		assignees: [],
		url: `https://github.com/owner/repo/issues/${number}`,
	}
}

/**
 * Helper to create a mock non-epic issue
 */
function createMockIssue(number: number) {
	return {
		number,
		title: 'Regular issue',
		body: 'Issue description',
		state: 'open' as const,
		labels: [],
		assignees: [],
		url: `https://github.com/owner/repo/issues/${number}`,
	}
}

describe('StartCommand - Swarm Mode Integration', () => {
	let mockGitHubService: GitHubService
	let mockLoomManager: { createIloom: ReturnType<typeof vi.fn>; listLooms: ReturnType<typeof vi.fn> }
	let mockSettingsManager: { loadSettings: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		mockGitHubService = new GitHubService()
		mockGitHubService.supportsPullRequests = true
		mockGitHubService.providerName = 'github'

		mockLoomManager = new LoomManager() as unknown as typeof mockLoomManager
		mockSettingsManager = new SettingsManager() as unknown as typeof mockSettingsManager
		mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({})

		// Re-setup mocks that get cleared by mockReset
		vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue('/test/main')
		vi.mocked(getRepoInfo).mockResolvedValue({ owner: 'iloom-ai', name: 'iloom-test-project' })
	})

	describe('epic detection triggers swarm flow', () => {
		it('should detect epic, confirm, create loom, and run supervisor', async () => {
			// Set up epic issue
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Use --swarm to bypass interactive confirmation
			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '100',
				options: { swarm: true },
			})

			// Verify epic loom was created
			expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						isEpic: true,
						swarmStatus: 'pending',
						enableClaude: false,
						enableCode: false,
					}),
				}),
			)

			// Verify BeadsManager was constructed and ensureInstalled called
			expect(BeadsManager).toHaveBeenCalledWith('/test/main', expect.objectContaining({
				maxConcurrent: 3,
			}))

			// Verify SwarmSupervisor was constructed and run called
			expect(SwarmSupervisor).toHaveBeenCalled()
			const supervisorInstance = vi.mocked(SwarmSupervisor).mock.results[0]?.value
			expect(supervisorInstance.run).toHaveBeenCalledWith(
				expect.objectContaining({
					epicIssueNumber: '100',
					epicBranch: 'epic/issue-100',
					epicLoomPath: '/test/worktrees/issue-100',
					projectPath: '/test/main',
					beadsPrefix: 'iloom-test-project',
				}),
			)
		})

		it('should skip swarm and run normally when --swarm on non-epic issue', async () => {
			const normalIssue = createMockIssue(200)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 200,
				rawInput: '200',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(normalIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '200',
				options: { swarm: true },
			})

			// Normal loom creation should happen (not epic)
			expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.not.objectContaining({
						isEpic: true,
					}),
				}),
			)

			// SwarmSupervisor should NOT be called
			expect(SwarmSupervisor).not.toHaveBeenCalled()
		})
	})

	describe('--swarm flag bypasses confirmation', () => {
		it('should skip confirmation when --swarm is passed', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '100',
				options: { swarm: true },
			})

			// Confirmation should NOT be called when --swarm is set
			expect(promptConfirmation).not.toHaveBeenCalled()

			// Supervisor should still run
			expect(SwarmSupervisor).toHaveBeenCalled()
		})
	})

	describe('--max-agents override', () => {
		it('should pass --max-agents override to SwarmSupervisor settings', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '100',
				options: { swarm: true, maxAgents: 5 },
			})

			// SwarmSupervisor should be constructed with maxConcurrent: 5
			expect(SwarmSupervisor).toHaveBeenCalledWith(
				expect.anything(), // beadsManager
				expect.anything(), // syncService
				expect.anything(), // loomManager
				expect.objectContaining({
					maxConcurrent: 5,
				}),
			)
		})

		it('should use settings maxConcurrent when --max-agents not provided', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Configure swarm settings
			mockSettingsManager.loadSettings.mockResolvedValue({
				swarm: {
					maxConcurrent: 7,
					maxRetries: 2,
					maxConflictRetries: 4,
				},
			})

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '100',
				options: { swarm: true },
			})

			expect(SwarmSupervisor).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.objectContaining({
					maxConcurrent: 7,
					maxRetries: 2,
					maxConflictRetries: 4,
				}),
			)
		})
	})

	describe('non-epic issue is unaffected', () => {
		it('should proceed with normal flow for non-epic issues', async () => {
			const normalIssue = createMockIssue(200)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 200,
				rawInput: '200',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(normalIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '200',
				options: {},
			})

			// Normal loom creation (not epic)
			expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						enableClaude: true,
						enableCode: true,
					}),
				}),
			)

			// No swarm components involved
			expect(BeadsManager).not.toHaveBeenCalled()
			expect(SwarmSupervisor).not.toHaveBeenCalled()
		})
	})

	describe('error handling', () => {
		it('should propagate BeadsError when Beads install fails', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Make BeadsManager.ensureInstalled throw
			const MockedBeadsManager = vi.mocked(BeadsManager)
			MockedBeadsManager.mockImplementationOnce(() => ({
				ensureInstalled: vi.fn().mockRejectedValue(
					new BeadsError('Beads CLI is required for swarm mode', undefined, 'User declined installation'),
				),
				init: vi.fn(),
				isInstalled: vi.fn(),
				ready: vi.fn(),
				list: vi.fn(),
				create: vi.fn(),
				claim: vi.fn(),
				close: vi.fn(),
				releaseClaim: vi.fn(),
				addDependency: vi.fn(),
				getBeadsDir: vi.fn().mockReturnValue('/test/beads'),
							}) as unknown as BeadsManager)

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await expect(
				command.execute({
					identifier: '100',
					options: { swarm: true },
				}),
			).rejects.toThrow('Beads CLI is required for swarm mode')
		})

		it('should propagate error when supervisor crashes', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Make supervisor.run throw
			const MockedSupervisor = vi.mocked(SwarmSupervisor)
			MockedSupervisor.mockImplementationOnce(() => ({
				run: vi.fn().mockRejectedValue(new Error('Supervisor crashed unexpectedly')),
			}) as unknown as SwarmSupervisor)

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await expect(
				command.execute({
					identifier: '100',
					options: { swarm: true },
				}),
			).rejects.toThrow('Supervisor crashed unexpectedly')
		})

		it('should set exit code 1 when all tasks fail', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Supervisor returns all-failed result
			const MockedSupervisor = vi.mocked(SwarmSupervisor)
			MockedSupervisor.mockImplementationOnce(() => ({
				run: vi.fn().mockResolvedValue({
					totalTasks: 3,
					completed: 0,
					failed: 3,
					mergedPRs: 0,
					failedMerges: 0,
					duration: 30000,
				}),
			}) as unknown as SwarmSupervisor)

			const originalExitCode = process.exitCode

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '100',
				options: { swarm: true },
			})

			expect(process.exitCode).toBe(1)

			// Restore
			process.exitCode = originalExitCode
		})

		it('should not set exit code 1 when some tasks succeed', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Supervisor returns partial success
			const MockedSupervisor = vi.mocked(SwarmSupervisor)
			MockedSupervisor.mockImplementationOnce(() => ({
				run: vi.fn().mockResolvedValue({
					totalTasks: 3,
					completed: 2,
					failed: 1,
					mergedPRs: 2,
					failedMerges: 0,
					duration: 45000,
				}),
			}) as unknown as SwarmSupervisor)

			const originalExitCode = process.exitCode
			process.exitCode = undefined

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			await command.execute({
				identifier: '100',
				options: { swarm: true },
			})

			// Should not set exitCode to 1 when some tasks completed
			expect(process.exitCode).toBeUndefined()

			// Restore
			process.exitCode = originalExitCode
		})
	})

	describe('JSON mode with swarm', () => {
		it('should return StartResult in JSON mode without running supervisor', async () => {
			const epicIssue = createMockEpicIssue(100)
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 100,
				rawInput: '100',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(epicIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			const command = new StartCommand(
				mockGitHubService,
				mockLoomManager as unknown as LoomManager,
				undefined,
				mockSettingsManager as unknown as SettingsManager,
			)

			const result = await command.execute({
				identifier: '100',
				options: { swarm: true, json: true },
			})

			// Should return StartResult
			expect(result).toEqual(expect.objectContaining({
				id: 'epic-loom-100',
				isEpic: true,
				swarmStatus: 'pending',
			}))

			// Supervisor should NOT be called in JSON mode
			expect(SwarmSupervisor).not.toHaveBeenCalled()
		})
	})
})
