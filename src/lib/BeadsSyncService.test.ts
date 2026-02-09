import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BeadsSyncService, toBeadsId, fromBeadsId } from './BeadsSyncService.js'
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

import { logger } from '../utils/logger.js'

const TEST_PREFIX = 'iloom-test-project'

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
		list: vi.fn().mockResolvedValue([]),
		claim: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		releaseClaim: vi.fn().mockResolvedValue(undefined),
	}
}

function createMockIssueProvider(): {
	[K in keyof IssueManagementProvider]: K extends 'providerName' | 'issuePrefix' ? string : ReturnType<typeof vi.fn>
} {
	return {
		providerName: 'github',
		issuePrefix: '#',
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
			TEST_PREFIX,
		)
	})

	describe('syncEpicToBeads', () => {
		it('should sync open child issues to Beads with repo-prefixed IDs', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'https://github.com/org/repo/issues/101', state: 'open' },
				{ id: '102', title: 'Task B', url: 'https://github.com/org/repo/issues/102', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			const result = await syncService.syncEpicToBeads('100')

			expect(mockIssueProvider.getChildIssues).toHaveBeenCalledWith({ number: '100' })
			expect(mockBeadsManager.create).toHaveBeenCalledTimes(2)
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task A', { id: `${TEST_PREFIX}-101` })
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task B', { id: `${TEST_PREFIX}-102` })
			expect(result.created).toHaveLength(2)
			expect(result.skipped).toHaveLength(0)
		})

		it('should skip closed issues', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'closed' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce(`${TEST_PREFIX}-101`)

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.create).toHaveBeenCalledTimes(1)
			expect(result.created).toHaveLength(1)
		})

		it('should skip tasks that already exist in Beads task list', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			const existingTasks: BeadsTask[] = [
				{ id: `${TEST_PREFIX}-101`, title: 'Task A', status: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.list.mockResolvedValue(existingTasks)
			mockBeadsManager.create.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.create).toHaveBeenCalledTimes(1)
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task B', { id: `${TEST_PREFIX}-102` })
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

		it('should sync dependencies between child issues with repo-prefixed IDs', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			// Task 102 is blocked by 101
			mockIssueProvider.getDependencies
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult) // for 101
				.mockResolvedValueOnce({
					blocking: [],
					blockedBy: [{ id: '101', title: 'Task A', url: 'url', state: 'open' }],
				} as DependenciesResult) // for 102

			const result = await syncService.syncEpicToBeads('100')

			expect(mockBeadsManager.addDependency).toHaveBeenCalledWith(
				`${TEST_PREFIX}-102`,
				`${TEST_PREFIX}-101`,
			)
			expect(result.dependenciesCreated).toBe(1)
		})

		it('should skip dependencies where blocker is not in the epic', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce(`${TEST_PREFIX}-101`)

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

		it('should handle list() failure gracefully when checking existing tasks', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.list.mockRejectedValue(new Error('No tasks'))
			mockBeadsManager.create.mockResolvedValueOnce(`${TEST_PREFIX}-101`)

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
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			// First dependency fetch fails, second succeeds
			mockIssueProvider.getDependencies
				.mockRejectedValueOnce(new Error('Network error'))
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult)

			const result = await syncService.syncEpicToBeads('100')

			// Should still complete without throwing
			expect(result.created).toHaveLength(2)
		})

		it('should handle OPEN state for Linear issues (no prefix needed)', async () => {
			const children: ChildIssueResult[] = [
				{ id: 'ENG-101', title: 'Task A', url: 'url', state: 'OPEN' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			// Linear IDs already have prefix-hash format, so no repo prefix is added
			mockBeadsManager.create.mockResolvedValueOnce('ENG-101')

			const result = await syncService.syncEpicToBeads('ENG-100')

			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task A', { id: 'ENG-101' })
			expect(result.created).toHaveLength(1)
		})

		it('should use the prefix passed via constructor for all task IDs', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			await syncService.syncEpicToBeads('100')

			// Both tasks should use the constructor-provided prefix
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task A', { id: `${TEST_PREFIX}-101` })
			expect(mockBeadsManager.create).toHaveBeenCalledWith('Task B', { id: `${TEST_PREFIX}-102` })
		})

		it('should log user-visible output for child issue count', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
				{ id: '103', title: 'Task C', url: 'url', state: 'closed' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			await syncService.syncEpicToBeads('100')

			expect(logger.info).toHaveBeenCalledWith('   Found 2 open child issues')
		})

		it('should log user-visible output for each created task', async () => {
			const children: ChildIssueResult[] = [
				{ id: '54', title: 'Set up monorepo workspace structure', url: 'url', state: 'open' },
				{ id: '55', title: 'Configure authentication', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-54`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-55`)

			await syncService.syncEpicToBeads('50')

			expect(logger.info).toHaveBeenCalledWith('   Creating task: #54 - Set up monorepo workspace structure')
			expect(logger.info).toHaveBeenCalledWith('   Creating task: #55 - Configure authentication')
		})

		it('should log user-visible output for dependencies', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)

			mockIssueProvider.getDependencies
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult)
				.mockResolvedValueOnce({
					blocking: [],
					blockedBy: [{ id: '101', title: 'Task A', url: 'url', state: 'open' }],
				} as DependenciesResult)

			await syncService.syncEpicToBeads('100')

			expect(logger.info).toHaveBeenCalledWith('   Linking dependency: #102 depends on #101')
		})

		it('should log DAG summary with correct counts', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
				{ id: '102', title: 'Task B', url: 'url', state: 'open' },
				{ id: '103', title: 'Task C', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create
				.mockResolvedValueOnce(`${TEST_PREFIX}-101`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-102`)
				.mockResolvedValueOnce(`${TEST_PREFIX}-103`)

			mockIssueProvider.getDependencies
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult)
				.mockResolvedValueOnce({
					blocking: [],
					blockedBy: [{ id: '101', title: 'Task A', url: 'url', state: 'open' }],
				} as DependenciesResult)
				.mockResolvedValueOnce({
					blocking: [],
					blockedBy: [{ id: '101', title: 'Task A', url: 'url', state: 'open' }],
				} as DependenciesResult)

			await syncService.syncEpicToBeads('100')

			expect(logger.info).toHaveBeenCalledWith('   DAG ready: 3 tasks, 2 dependencies')
		})

		it('should use singular forms when counts are 1', async () => {
			const children: ChildIssueResult[] = [
				{ id: '101', title: 'Task A', url: 'url', state: 'open' },
			]
			mockIssueProvider.getChildIssues.mockResolvedValue(children)
			mockBeadsManager.create.mockResolvedValueOnce(`${TEST_PREFIX}-101`)

			mockIssueProvider.getDependencies
				.mockResolvedValueOnce({ blocking: [], blockedBy: [] } as DependenciesResult)

			await syncService.syncEpicToBeads('100')

			expect(logger.info).toHaveBeenCalledWith('   Found 1 open child issue')
			expect(logger.info).toHaveBeenCalledWith('   DAG ready: 1 task, 0 dependencies')
		})
	})

	describe('toBeadsId', () => {
		it('should prefix numeric GitHub issue IDs with the given prefix', () => {
			expect(toBeadsId('101', TEST_PREFIX)).toBe(`${TEST_PREFIX}-101`)
			expect(toBeadsId('42', TEST_PREFIX)).toBe(`${TEST_PREFIX}-42`)
		})

		it('should not prefix IDs that already start with the prefix', () => {
			expect(toBeadsId(`${TEST_PREFIX}-42`, TEST_PREFIX)).toBe(`${TEST_PREFIX}-42`)
		})

		it('should not prefix IDs already in prefix-hash format (e.g., Linear)', () => {
			expect(toBeadsId('ENG-101', TEST_PREFIX)).toBe('ENG-101')
		})
	})

	describe('fromBeadsId', () => {
		it('should strip the prefix from Beads IDs', () => {
			expect(fromBeadsId(`${TEST_PREFIX}-101`, TEST_PREFIX)).toBe('101')
			expect(fromBeadsId(`${TEST_PREFIX}-42`, TEST_PREFIX)).toBe('42')
		})

		it('should not strip non-matching prefixes', () => {
			expect(fromBeadsId('ENG-101', TEST_PREFIX)).toBe('ENG-101')
			expect(fromBeadsId('other-repo-101', TEST_PREFIX)).toBe('other-repo-101')
		})

		it('should return plain IDs unchanged', () => {
			expect(fromBeadsId('101', TEST_PREFIX)).toBe('101')
		})
	})
})
