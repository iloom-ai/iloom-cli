import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SwarmSupervisor, type EpicLoomContext } from './SwarmSupervisor.js'
import type { BeadsManager, BeadsTask } from './BeadsManager.js'
import type { BeadsSyncService, SyncResult } from './BeadsSyncService.js'
import type { LoomManager } from './LoomManager.js'
import type { SwarmSettings } from './SettingsManager.js'
import type { Loom } from '../types/loom.js'

// Mock timers/promises so sleep(2000) resolves immediately
vi.mock('timers/promises', () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}))

// Mock execa
vi.mock('execa', () => ({
	execa: vi.fn(),
}))

// Mock fs-extra
vi.mock('fs-extra', () => ({
	default: {
		ensureDir: vi.fn(),
		createWriteStream: vi.fn(() => ({
			write: vi.fn(),
			end: vi.fn(),
		})),
	},
}))

// Mock github utils
vi.mock('../utils/github.js', () => ({
	executeGhCommand: vi.fn(),
}))

// Mock logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	},
}))

import { execa } from 'execa'
import { executeGhCommand } from '../utils/github.js'
import { logger } from '../utils/logger.js'

// --- Helpers ---

function createMockBeadsManager(): BeadsManager {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		ready: vi.fn().mockResolvedValue([]),
		claim: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		releaseClaim: vi.fn().mockResolvedValue(undefined),
		create: vi.fn().mockResolvedValue('task-1'),
		addDependency: vi.fn().mockResolvedValue(undefined),
		ensureInstalled: vi.fn().mockResolvedValue(undefined),
		isInstalled: vi.fn().mockResolvedValue(true),
		getBeadsDir: vi.fn().mockReturnValue('/tmp/beads'),
	} as unknown as BeadsManager
}

function createMockSyncService(): BeadsSyncService {
	return {
		syncEpicToBeads: vi.fn().mockResolvedValue({
			created: [],
			skipped: [],
			dependenciesCreated: 0,
		} as SyncResult),
	} as unknown as BeadsSyncService
}

function createMockLoomManager(): LoomManager {
	return {
		createIloom: vi.fn().mockResolvedValue({
			id: 'issue-100',
			path: '/tmp/worktree/issue-100',
			branch: 'feat/issue-100',
			type: 'issue',
			identifier: 100,
			port: 3100,
			createdAt: new Date(),
			lastAccessed: new Date(),
		} as Loom),
	} as unknown as LoomManager
}

function createDefaultSettings(): SwarmSettings {
	return {
		maxConcurrent: 3,
		maxRetries: 1,
		maxConflictRetries: 3,
		beadsDir: '~/.config/iloom-ai/beads',
		autoInstallBeads: false,
	}
}

function createEpicLoomContext(): EpicLoomContext {
	return {
		epicIssueNumber: '50',
		epicBranch: 'feat/epic-50',
		epicLoomPath: '/tmp/worktree/epic-50',
		projectPath: '/tmp/project',
	}
}

function createBeadsTask(id: string, title: string): BeadsTask {
	return { id, title, status: 'ready' }
}

/**
 * Creates a mock execa child process that resolves immediately.
 * The .then() callback fires synchronously via microtask queue,
 * so by the next await point the agent's exitCode is set.
 */
function createMockChildProcess(exitCode: number, pid: number = 1234) {
	const resolved = Promise.resolve({ exitCode })

	const mockProcess = Object.assign(resolved, {
		pid,
		all: { pipe: vi.fn() },
		stdout: null,
		stderr: null,
		kill: vi.fn(),
	})

	return mockProcess
}

describe('SwarmSupervisor', () => {
	let beadsManager: ReturnType<typeof createMockBeadsManager>
	let syncService: ReturnType<typeof createMockSyncService>
	let loomManager: ReturnType<typeof createMockLoomManager>
	let settings: SwarmSettings
	let supervisor: SwarmSupervisor
	let epicLoom: EpicLoomContext

	beforeEach(() => {
		beadsManager = createMockBeadsManager()
		syncService = createMockSyncService()
		loomManager = createMockLoomManager()
		settings = createDefaultSettings()
		epicLoom = createEpicLoomContext()
		supervisor = new SwarmSupervisor(beadsManager, syncService, loomManager, settings)
	})

	describe('run', () => {
		it('should initialize Beads and sync epic children', async () => {
			const result = await supervisor.run(epicLoom)

			expect(beadsManager.init).toHaveBeenCalled()
			expect(syncService.syncEpicToBeads).toHaveBeenCalledWith('50')
			expect(result.totalTasks).toBe(0)
			expect(result.completed).toBe(0)
			expect(result.failed).toBe(0)
		})

		it('should return totalTasks from sync result', async () => {
			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [
					{ issueId: '100', beadsTaskId: '100', title: 'Task 1' },
					{ issueId: '101', beadsTaskId: '101', title: 'Task 2' },
				],
				skipped: ['102'],
				dependenciesCreated: 1,
			} as SyncResult)

			const result = await supervisor.run(epicLoom)

			expect(result.totalTasks).toBe(3)
		})

		it('should track duration', async () => {
			const result = await supervisor.run(epicLoom)
			expect(result.duration).toBeGreaterThanOrEqual(0)
		})

		it('should claim ready tasks and spawn agents', async () => {
			const task1 = createBeadsTask('100', 'Fix bug')
			let readyCallCount = 0

			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Fix bug' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			// Mock child process that completes immediately with success
			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			// No PR found (agent completed without creating one)
			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			const result = await supervisor.run(epicLoom)

			expect(beadsManager.claim).toHaveBeenCalledWith('100')
			expect(loomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
					identifier: 100,
					baseBranch: 'feat/epic-50',
					options: { swarmMode: true },
				}),
			)
			expect(result.completed).toBe(1)
		})

		it('should respect maxConcurrent setting', async () => {
			settings.maxConcurrent = 2

			const task1 = createBeadsTask('100', 'Task 1')
			const task2 = createBeadsTask('101', 'Task 2')
			const task3 = createBeadsTask('102', 'Task 3')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1, task2, task3]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [
					{ issueId: '100', beadsTaskId: '100', title: 'Task 1' },
					{ issueId: '101', beadsTaskId: '101', title: 'Task 2' },
					{ issueId: '102', beadsTaskId: '102', title: 'Task 3' },
				],
				skipped: [],
				dependenciesCreated: 0,
			})

			const proc1 = createMockChildProcess(0, 1001)
			const proc2 = createMockChildProcess(0, 1002)
			let callIndex = 0
			vi.mocked(execa).mockImplementation(() => {
				const proc = callIndex === 0 ? proc1 : proc2
				callIndex++
				return proc as never
			})

			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			vi.mocked(loomManager.createIloom)
				.mockResolvedValueOnce({
					id: 'issue-100', path: '/tmp/worktree/issue-100', branch: 'feat/100',
					type: 'issue', identifier: 100, port: 3100,
					createdAt: new Date(), lastAccessed: new Date(),
				} as Loom)
				.mockResolvedValueOnce({
					id: 'issue-101', path: '/tmp/worktree/issue-101', branch: 'feat/101',
					type: 'issue', identifier: 101, port: 3101,
					createdAt: new Date(), lastAccessed: new Date(),
				} as Loom)

			await supervisor.run(epicLoom)

			// Should only claim 2 tasks (maxConcurrent), not 3
			expect(beadsManager.claim).toHaveBeenCalledTimes(2)
			expect(beadsManager.claim).toHaveBeenCalledWith('100')
			expect(beadsManager.claim).toHaveBeenCalledWith('101')
		})

		it('should handle failed agents by releasing their claim', async () => {
			const task1 = createBeadsTask('100', 'Failing task')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Failing task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			// Mock agent that exits with failure
			const mockProcess = createMockChildProcess(1)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			const result = await supervisor.run(epicLoom)

			expect(beadsManager.releaseClaim).toHaveBeenCalledWith('100')
			expect(result.failed).toBe(1)
			expect(result.completed).toBe(0)
		})

		it('should enqueue and merge PRs sequentially on success', async () => {
			const task1 = createBeadsTask('100', 'Task with PR')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task with PR' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			// Mock PR search - found a PR, then merge, then issue close
			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42 }] as never)  // PR search
				.mockResolvedValueOnce(undefined as never)          // PR merge
				.mockResolvedValueOnce(undefined as never)          // issue close

			const result = await supervisor.run(epicLoom)

			// Verify PR was merged
			expect(executeGhCommand).toHaveBeenCalledWith(
				['pr', 'merge', '42', '--merge', '--delete-branch'],
			)
			expect(result.mergedPRs).toBe(1)
			expect(result.completed).toBe(1)
		})

		it('should handle merge failures', async () => {
			const task1 = createBeadsTask('100', 'Task with failing merge')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			// PR search finds PR, but merge fails
			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42 }] as never)  // PR search
				.mockRejectedValueOnce(new Error('Merge conflict'))  // PR merge fails

			const result = await supervisor.run(epicLoom)

			expect(result.failedMerges).toBe(1)
			expect(result.failed).toBe(1)
		})

		it('should close Beads task and issue after successful merge', async () => {
			const task1 = createBeadsTask('100', 'Complete task')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Complete task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42 }] as never)  // PR search
				.mockResolvedValueOnce(undefined as never)          // PR merge
				.mockResolvedValueOnce(undefined as never)          // issue close

			await supervisor.run(epicLoom)

			expect(beadsManager.close).toHaveBeenCalledWith('100', 'merged PR #42')
			expect(executeGhCommand).toHaveBeenCalledWith(
				['issue', 'close', '100'],
			)
		})

		it('should set swarm environment variables when spawning agents', async () => {
			const task1 = createBeadsTask('100', 'Task 1')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task 1' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)
			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			await supervisor.run(epicLoom)

			expect(execa).toHaveBeenCalledWith(
				'il',
				['spin', '-p'],
				expect.objectContaining({
					cwd: '/tmp/worktree/issue-100',
					env: expect.objectContaining({
						ILOOM_SWARM_MODE: '1',
						ILOOM_EPIC_BRANCH: 'feat/epic-50',
						ILOOM_EPIC_ISSUE: '50',
					}),
					reject: false,
					all: true,
				}),
			)
		})

		it('should handle claim failures gracefully', async () => {
			const task1 = createBeadsTask('100', 'Task 1')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task 1' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			// Claim fails
			vi.mocked(beadsManager.claim).mockRejectedValue(new Error('Already claimed'))

			const result = await supervisor.run(epicLoom)

			expect(result.failed).toBe(1)
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining('Failed to claim/spawn agent for task 100'),
			)
		})

		it('should complete immediately when no tasks exist', async () => {
			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [],
				skipped: [],
				dependenciesCreated: 0,
			})

			const result = await supervisor.run(epicLoom)

			expect(result.totalTasks).toBe(0)
			expect(result.completed).toBe(0)
			expect(result.failed).toBe(0)
		})

		it('should pass parentLoom info when creating child looms', async () => {
			const task1 = createBeadsTask('100', 'Task 1')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task 1' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)
			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			await supervisor.run(epicLoom)

			expect(loomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					parentLoom: {
						type: 'issue',
						identifier: '50',
						branchName: 'feat/epic-50',
						worktreePath: '/tmp/worktree/epic-50',
					},
				}),
			)
		})

		it('should handle alphanumeric issue IDs (e.g., Linear)', async () => {
			const task1 = createBeadsTask('ENG-123', 'Linear task')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: 'ENG-123', beadsTaskId: 'ENG-123', title: 'Linear task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)
			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			await supervisor.run(epicLoom)

			expect(loomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
					identifier: 'ENG-123',
				}),
			)
		})
	})

	describe('graceful shutdown', () => {
		it('should stop claiming tasks when shuttingDown is true', async () => {
			const task1 = createBeadsTask('100', 'Task 1')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) {
					// Trigger shutdown before claiming
					;(supervisor as unknown as { shuttingDown: boolean }).shuttingDown = true
					return [task1]
				}
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task 1' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			await supervisor.run(epicLoom)

			// Should NOT have claimed any tasks since shuttingDown was set
			expect(beadsManager.claim).not.toHaveBeenCalled()
		})

		it('should handle double SIGINT by process.exit', () => {
			const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

			const handler = (supervisor as unknown as { handleSignal: () => void }).handleSignal.bind(supervisor)

			// First signal: sets shuttingDown
			handler()
			expect((supervisor as unknown as { shuttingDown: boolean }).shuttingDown).toBe(true)

			// Second signal: force exit
			handler()
			expect(exitSpy).toHaveBeenCalledWith(1)

			exitSpy.mockRestore()
		})
	})

	describe('issue close failure', () => {
		it('should not fail the merge if issue close fails', async () => {
			const task1 = createBeadsTask('100', 'Task')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42 }] as never)  // PR search
				.mockResolvedValueOnce(undefined as never)          // PR merge succeeds
				.mockRejectedValueOnce(new Error('Cannot close'))   // issue close fails

			const result = await supervisor.run(epicLoom)

			expect(result.mergedPRs).toBe(1)
			expect(result.completed).toBe(1)
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to close issue 100'),
			)
		})
	})

	describe('Beads task close failure', () => {
		it('should not fail the merge if Beads close fails', async () => {
			const task1 = createBeadsTask('100', 'Task')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42 }] as never)  // PR search
				.mockResolvedValueOnce(undefined as never)          // PR merge
				.mockResolvedValueOnce(undefined as never)          // issue close

			// Beads close fails
			vi.mocked(beadsManager.close).mockRejectedValue(new Error('Beads error'))

			const result = await supervisor.run(epicLoom)

			expect(result.mergedPRs).toBe(1)
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to close Beads task 100'),
			)
		})
	})
})
