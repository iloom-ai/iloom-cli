import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BeadsSyncService } from './BeadsSyncService.js'
import type { BeadsManager, BeadsTask } from './BeadsManager.js'
import type { IssueManagementProvider, ChildIssueResult, DependenciesResult } from '../mcp/types.js'

// Mock logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

function createMockBeadsManager(): {
	[K in keyof BeadsManager]: ReturnType<typeof vi.fn>
} {
	return {
		getBeadsDir: vi.fn().mockReturnValue('/mock/beads/dir'),
		isInstalled: vi.fn().mockResolvedValue(true),
		ensureInstalled: vi.fn().mockResolvedValue(undefined),
		init: vi.fn().mockResolvedValue(undefined),
		create: vi.fn().mockResolvedValue(''),
		addDependency: vi.fn().mockResolvedValue(undefined),
		ready: vi.fn().mockResolvedValue([]),
		claim: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		releaseClaim: vi.fn().mockResolvedValue(undefined),
	}
}

function createMockIssueProvider(): {
	[K in keyof IssueManagementProvider]: ReturnType<typeof vi.fn>
} {
	return {
		getIssue: vi.fn(),
		getPR: vi.fn(),
		getComment: vi.fn(),
		createComment: vi.fn(),
		updateComment: vi.fn(),
		createIssue: vi.fn(),
		createChildIssue: vi.fn(),
		createDependency: vi.fn(),
		getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
		removeDependency: vi.fn(),
		getChildIssues: vi.fn().mockResolvedValue([]),
	}
}

describe('BeadsSyncService', () => {
	let syncService: BeadsSyncService
	let mockBeadsManager: ReturnType<typeof createMockBeadsManager>
	let mockIssueProvider: ReturnType<typeof createMockIssueProvider>

	beforeEach(() => {
		mockBeadsManager = createMockBeadsManager()
		mockIssueProvider = createMockIssueProvider()
		syncService = new BeadsSyncService(
			mockBeadsManager as unknown as BeadsManager,
			mockIssueProvider as unknown as IssueManagementProvider,
		)
	})

	describe('syncEpicToBeads', () => {
		it('should sync open child issues to Beads', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'https://github.com/org/repo/issues/101', state: 'open' },
				{ id: '102', title: 'Task B', url: 'https://github.com/org/repo/issues/102', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce('101').mockResolvedValueOnce('102')

			const result = await syncService.syncEpicToBeads('100')

			expect(mockIssueProvider.getChildIssues).toHaveBeenCalledWith({ number: '100' })
			expect(mockBeadsManager.create).toHaveBeenCalledTimes(2)
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task A', { id: '101' })
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task B', { id: '102' })
			expect(result.created).toHaveLength(2)
			expect(result.skipped).toHaveLength(0)
		})

		it('should skip closed issues', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'closed' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce('101')

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.create).toHaveBeenCalledTimes(1)
			expect(result.created).toHaveLength(1)
		})

		it('should skip tasks that already exist in Beads ready list', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			const existingTasks: BeadsTask[] = [
				{ id: '101', title: 'Task A', status: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.ready.mockResolvedValue(existingTasks)
			mockBeadsManager.create.mockResolvedValueOnce('102')

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.create).toHaveBeenCalledTimes(1)
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task B', { id: '102' })
			expect(result.created).toHaveLength(1)
			expect(result.skipped).toEqual(['101'])
		})

		it('should skip tasks that already exist when create throws "already exists"', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockRejectedValueOnce(new Error('Task already exists'))

			const result = await syncService.syncEpicToBeads('100')

			expect(result.created).toHaveLength(0)
			expect(result.skipped).toEqual(['101'])
		})

		it('should sync dependencies between child issues', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce('101')
				.mockResolvedValueOnce('102')

			// Task 102 is blocked by 101
			mockIssueProvider.getDependencies
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult) // for 101
				.mockResolvedValueOnce({
					blocking: [],
					blockedBy: [{ id: '101', title: 'Task A', url: 'url', state: 'open' }],
				} as DependenciesResult) // for 102

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.addDependency).toHaveBeenCalledWith('102', '101')
			expect(result.dependenciesCreated).toBe(1)
		})

		it('should skip dependencies where blocker is not in the epic', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce('101')

			// Task 101 is blocked by issue 999 (not part of this epic)
			mockIssueProvider.getDependencies.mockResolvedValueOnce({
				blocking: [],
				blockedBy: [{ id: '999', title: 'External', url: 'url', state: 'open' }],
			} as DependenciesResult)

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.addDependency).not.toHaveBeenCalled()
			expect(result.dependenciesCreated).toBe(0)
		})

		it('should handle empty epic gracefully', async () => {
			mockIssueProvider.getChildIssues.mockResolvedValue([])

			const result = await syncService.syncEpicToBeads('100')

			expect(result.created).toHaveLength(0)
			expect(result.skipped).toHaveLength(0)
			expect(result.dependenciesCreated).toBe(0)
		})

		it('should handle ready() failure gracefully when checking existing tasks', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.ready.mockRejectedValue(new Error('No tasks'))
			mockBeadsManager.create.mockResolvedValueOnce('101')

			const result = await syncService.syncEpicToBeads('100')

			// Should still create the task since we can't check existing
			expect(result.created).toHaveLength(1)
		})

		it('should continue syncing when individual dependency fetch fails', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce('101')
				.mockResolvedValueOnce('102')

			// First dependency fetch fails, second succeeds
			mockIssueProvider.getDependencies
				.mockRejectedValueOnce(new Error('Network error'))
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult)

			const result = await syncService.syncEpicToBeads('100')

			// Should still complete without throwing
			expect(result.created).toHaveLength(2)
		})

		it('should handle OPEN state for Linear issues', async () => {
			const children: ChildIssueResult[] = [
				{ id: 'ENG-101', title: 'Task A', url: 'url', state: 'OPEN' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce('ENG-101')

			const result = await syncService.syncEpicToBeads('ENG-100')

			expect(result.created).toHaveLength(1)
		})
	})
})
