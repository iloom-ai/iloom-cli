import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SwarmSupervisor, type EpicLoomContext, type SwarmProgress } from './SwarmSupervisor.js'
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
		writeJson: vi.fn(),
		rename: vi.fn(),
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
import fs from 'fs-extra'
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
		list: vi.fn().mockResolvedValue([]),
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

function createBeadsTask(id: string, title: string, status = 'ready'): BeadsTask {
	return { id, title, status }
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
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)  // PR search
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
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)  // PR search
				.mockResolvedValueOnce(undefined as never)          // PR merge
				.mockResolvedValueOnce(undefined as never)          // issue close

			await supervisor.run(epicLoom)

			expect(beadsManager.close).toHaveBeenCalledWith('100', 'merged PR #42')
			expect(executeGhCommand).toHaveBeenCalledWith(
				['issue', 'close', '100'],
			)
		})
	})

	describe('failure handling and retry', () => {
		it('should retry a failed task when below maxRetries', async () => {
			settings.maxRetries = 2

			const task1 = createBeadsTask('100', 'Flaky task')
			let readyCallCount = 0
			let execaCallCount = 0

			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				// First call: return the task (initial attempt)
				if (readyCallCount === 1) return [task1]
				// Second call: task re-appears after claim release (retry)
				if (readyCallCount === 2) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Flaky task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			vi.mocked(execa).mockImplementation(() => {
				execaCallCount++
				// First attempt fails, second succeeds
				if (execaCallCount === 1) return createMockChildProcess(1) as never
				return createMockChildProcess(0) as never
			})

			vi.mocked(loomManager.createIloom)
				.mockResolvedValueOnce({
					id: 'issue-100', path: '/tmp/worktree/issue-100', branch: 'feat/100',
					type: 'issue', identifier: 100, port: 3100,
					createdAt: new Date(), lastAccessed: new Date(),
				} as Loom)
				.mockResolvedValueOnce({
					id: 'issue-100-retry', path: '/tmp/worktree/issue-100-retry', branch: 'feat/100',
					type: 'issue', identifier: 100, port: 3100,
					createdAt: new Date(), lastAccessed: new Date(),
				} as Loom)

			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			const result = await supervisor.run(epicLoom)

			// Claim released after first failure, then re-claimed on retry
			expect(beadsManager.releaseClaim).toHaveBeenCalledWith('100')
			expect(beadsManager.claim).toHaveBeenCalledTimes(2)
			// Second attempt succeeded
			expect(result.completed).toBe(1)
			expect(result.failed).toBe(0)

			// Should log the retry
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Retrying task 100'),
			)
		})

		it('should permanently fail a task after exhausting maxRetries', async () => {
			settings.maxRetries = 1

			const task1 = createBeadsTask('100', 'Permanently failing')
			let readyCallCount = 0

			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Permanently failing' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(1)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			const result = await supervisor.run(epicLoom)

			expect(result.failed).toBe(1)
			expect(result.completed).toBe(0)
			// Should close the task in Beads as failed
			expect(beadsManager.close).toHaveBeenCalledWith(
				'100',
				expect.stringContaining('failed after 1 attempts'),
			)
		})

		it('should not retry when maxRetries is 0', async () => {
			settings.maxRetries = 0

			const task1 = createBeadsTask('100', 'No retry task')
			let readyCallCount = 0

			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'No retry task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(1)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			const result = await supervisor.run(epicLoom)

			// Should fail immediately without retry since maxRetries=0 means 0 retries allowed,
			// but the first attempt still counts as attempt 1
			// With maxRetries=0, attempt (1) >= maxRetries (0) should trigger permanent failure
			expect(result.failed).toBe(1)
			expect(beadsManager.claim).toHaveBeenCalledTimes(1)
		})

		it('should skip permanently failed tasks even if they appear in ready()', async () => {
			settings.maxRetries = 1

			const task1 = createBeadsTask('100', 'Failing task')
			let readyCallCount = 0

			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				// Task keeps appearing in ready() even after permanent failure
				if (readyCallCount <= 3) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Failing task' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(1)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			const result = await supervisor.run(epicLoom)

			// Should only have claimed once (first attempt fails and gets permanently failed)
			expect(beadsManager.claim).toHaveBeenCalledTimes(1)
			expect(result.failed).toBe(1)
		})
	})

	describe('merge conflict resolution', () => {
		it('should spawn a conflict resolver when merge conflict detected', async () => {
			const task1 = createBeadsTask('100', 'Task with conflict')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task with conflict' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			// First execa call: agent process (succeeds)
			// Second execa call: conflict resolver (succeeds)
			const agentProcess = createMockChildProcess(0, 1001)
			const resolverProcess = createMockChildProcess(0, 2001)
			let execaCallCount = 0
			vi.mocked(execa).mockImplementation(() => {
				execaCallCount++
				if (execaCallCount === 1) return agentProcess as never
				return resolverProcess as never
			})

			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)           // PR search
				.mockRejectedValueOnce(new Error('merge conflict'))          // first merge attempt fails
				.mockResolvedValueOnce(undefined as never)                   // retry merge succeeds
				.mockResolvedValueOnce(undefined as never)                   // issue close

			const result = await supervisor.run(epicLoom)

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Merge conflict detected for PR #42'),
			)
			// Resolver spawned with conflict env vars
			expect(execa).toHaveBeenCalledWith(
				'il',
				['spin', '-p'],
				expect.objectContaining({
					env: expect.objectContaining({
						ILOOM_CONFLICT_RESOLUTION: '1',
						ILOOM_CONFLICT_PR: '42',
					}),
				}),
			)
			expect(result.mergedPRs).toBe(1)
			expect(result.completed).toBe(1)
		})

		it('should fail after exhausting maxConflictRetries', async () => {
			settings.maxConflictRetries = 1

			const task1 = createBeadsTask('100', 'Unresolvable conflict')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Unresolvable conflict' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const agentProcess = createMockChildProcess(0, 1001)
			const resolverProcess = createMockChildProcess(0, 2001)
			let execaCallCount = 0
			vi.mocked(execa).mockImplementation(() => {
				execaCallCount++
				if (execaCallCount === 1) return agentProcess as never
				return resolverProcess as never
			})

			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)           // PR search
				.mockRejectedValueOnce(new Error('merge conflict'))          // first merge fails
				.mockRejectedValueOnce(new Error('merge conflict'))          // retry after resolution also fails
				.mockRejectedValueOnce(new Error('merge conflict'))          // conflicts exhausted

			const result = await supervisor.run(epicLoom)

			expect(result.failedMerges).toBe(1)
			expect(result.failed).toBe(1)
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining('could not be resolved after'),
			)
		})

		it('should detect various conflict error messages', async () => {
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
			const resolverProcess = createMockChildProcess(0)
			let execaCallCount = 0
			vi.mocked(execa).mockImplementation(() => {
				execaCallCount++
				if (execaCallCount === 1) return mockProcess as never
				return resolverProcess as never
			})

			// Test "CONFLICT" pattern
			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)             // PR search
				.mockRejectedValueOnce(new Error('CONFLICT in file.ts'))       // merge with CONFLICT
				.mockResolvedValueOnce(undefined as never)                     // retry merge succeeds
				.mockResolvedValueOnce(undefined as never)                     // issue close

			const result = await supervisor.run(epicLoom)

			expect(result.mergedPRs).toBe(1)
		})

		it('should handle non-conflict merge failures without spawning resolver', async () => {
			const task1 = createBeadsTask('100', 'Task with auth failure')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Task with auth failure' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			// Non-conflict error
			vi.mocked(executeGhCommand)
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)     // PR search
				.mockRejectedValueOnce(new Error('Authentication failed'))  // non-conflict error

			const result = await supervisor.run(epicLoom)

			expect(result.failedMerges).toBe(1)
			expect(result.failed).toBe(1)
			// Should NOT have spawned a resolver (only one execa call for the agent)
			expect(execa).toHaveBeenCalledTimes(1)
		})
	})

	describe('resume support', () => {
		it('should skip completed tasks on resume', async () => {
			// Mock list() returning some completed tasks
			vi.mocked(beadsManager.list).mockResolvedValue([
				createBeadsTask('100', 'Done task', 'closed'),
				createBeadsTask('101', 'Ready task', 'ready'),
			])

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [],
				skipped: ['100', '101'],
				dependenciesCreated: 0,
			})

			// Mock ready() to return only the non-closed task on first call, then none
			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [createBeadsTask('101', 'Ready task')]
				return []
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)
			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			const result = await supervisor.run(epicLoom)

			// completed=1 from resume + 1 from agent completing
			expect(result.completed).toBe(2)
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Resuming swarm'),
			)
		})

		it('should release stale in_progress claims on resume', async () => {
			vi.mocked(beadsManager.list).mockResolvedValue([
				createBeadsTask('100', 'Stale task', 'in_progress'),
			])

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [],
				skipped: ['100'],
				dependenciesCreated: 0,
			})

			// After claim release, the task shows up as ready
			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [createBeadsTask('100', 'Stale task')]
				return []
			})

			const mockProcess = createMockChildProcess(0)
			vi.mocked(execa).mockReturnValue(mockProcess as never)
			vi.mocked(executeGhCommand).mockResolvedValue([] as never)

			const result = await supervisor.run(epicLoom)

			// Stale claim should have been released
			expect(beadsManager.releaseClaim).toHaveBeenCalledWith('100')
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Released stale claim on task 100'),
			)
			// Task was re-attempted and completed
			expect(result.completed).toBe(1)
		})

		it('should not resume when list returns empty', async () => {
			vi.mocked(beadsManager.list).mockResolvedValue([])

			const result = await supervisor.run(epicLoom)

			expect(logger.info).not.toHaveBeenCalledWith(
				expect.stringContaining('Resuming swarm'),
			)
			expect(result.completed).toBe(0)
		})

		it('should handle list() failure gracefully', async () => {
			vi.mocked(beadsManager.list).mockRejectedValue(new Error('DB error'))

			const result = await supervisor.run(epicLoom)

			// Should not crash, just continue without resume
			expect(result.completed).toBe(0)
			expect(result.failed).toBe(0)
		})
	})

	describe('progress reporting', () => {
		it('should write progress file on state changes', async () => {
			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [],
				skipped: [],
				dependenciesCreated: 0,
			})

			await supervisor.run(epicLoom)

			// Should have written progress at least twice (initial + final)
			expect(fs.writeJson).toHaveBeenCalled()
		})

		it('should write correct progress structure', async () => {
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

			// Get the last call to writeJson to check the final progress
			const writeJsonCalls = vi.mocked(fs.writeJson).mock.calls
			const lastCall = writeJsonCalls[writeJsonCalls.length - 1]
			const progress = lastCall[1] as SwarmProgress

			expect(progress.epicIssue).toBe('50')
			expect(progress.epicBranch).toBe('feat/epic-50')
			expect(progress.status).toBe('completed')
			expect(progress.startedAt).toBeTruthy()
			expect(progress.updatedAt).toBeTruthy()
			expect(progress.dag).toBeDefined()
			expect(progress.stats).toBeDefined()
			expect(progress.stats.total).toBe(1)
			expect(progress.stats.completed).toBe(1)
			expect(progress.failures).toEqual([])
		})

		it('should include failures in progress file', async () => {
			settings.maxRetries = 1

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

			const mockProcess = createMockChildProcess(1)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			await supervisor.run(epicLoom)

			const writeJsonCalls = vi.mocked(fs.writeJson).mock.calls
			const lastCall = writeJsonCalls[writeJsonCalls.length - 1]
			const progress = lastCall[1] as SwarmProgress

			expect(progress.failures.length).toBe(1)
			expect(progress.failures[0].issue).toBe('100')
			expect(progress.failures[0].reason).toContain('Agent exited with code 1')
		})

		it('should log progress summary during loop', async () => {
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

			// Should have logged a progress summary at least once
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Active:'),
			)
		})

		it('should set status to failed when all tasks fail', async () => {
			settings.maxRetries = 1

			const task1 = createBeadsTask('100', 'Fail')

			let readyCallCount = 0
			vi.mocked(beadsManager.ready).mockImplementation(async () => {
				readyCallCount++
				if (readyCallCount === 1) return [task1]
				return []
			})

			vi.mocked(syncService.syncEpicToBeads).mockResolvedValue({
				created: [{ issueId: '100', beadsTaskId: '100', title: 'Fail' }],
				skipped: [],
				dependenciesCreated: 0,
			})

			const mockProcess = createMockChildProcess(1)
			vi.mocked(execa).mockReturnValue(mockProcess as never)

			await supervisor.run(epicLoom)

			const writeJsonCalls = vi.mocked(fs.writeJson).mock.calls
			const lastCall = writeJsonCalls[writeJsonCalls.length - 1]
			const progress = lastCall[1] as SwarmProgress

			expect(progress.status).toBe('failed')
		})

		it('should not crash when progress file write fails', async () => {
			vi.mocked(fs.writeJson).mockRejectedValue(new Error('disk full'))

			const result = await supervisor.run(epicLoom)

			// Should complete without error
			expect(result.duration).toBeGreaterThanOrEqual(0)
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

		it('should handle double SIGINT by killing agents and scheduling exit', () => {
			const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
			const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as unknown as NodeJS.Timeout)

			const handler = (supervisor as unknown as { handleSignal: () => void }).handleSignal.bind(supervisor)

			// First signal: sets shuttingDown
			handler()
			expect((supervisor as unknown as { shuttingDown: boolean }).shuttingDown).toBe(true)

			// Second signal: schedules force exit after grace period
			handler()
			expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000)

			// Invoke the scheduled callback to verify it calls process.exit(1)
			const scheduledCallback = setTimeoutSpy.mock.calls[0][0] as () => void
			scheduledCallback()
			expect(exitSpy).toHaveBeenCalledWith(1)

			exitSpy.mockRestore()
			setTimeoutSpy.mockRestore()
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
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)  // PR search
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
				.mockResolvedValueOnce([{ number: 42, headRefName: 'feat/issue-100' }] as never)  // PR search
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
