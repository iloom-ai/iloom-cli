import { describe, it, expect, vi } from 'vitest'
import { EpicDetector } from './EpicDetector.js'
import type { IssueManagementProvider } from '../mcp/types.js'
import type { Issue } from '../types/index.js'

// Mock logger
vi.mock('../utils/logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	}),
}))

function createMockIssue(overrides: Partial<Issue> = {}): Issue {
	return {
		number: 42,
		title: 'Test Epic',
		body: 'An epic issue',
		state: 'open',
		labels: [],
		assignees: [],
		url: 'https://github.com/owner/repo/issues/42',
		...overrides,
	}
}

function createMockProvider(overrides: Partial<IssueManagementProvider> = {}): IssueManagementProvider {
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
		...overrides,
	}
}

describe('EpicDetector', () => {
	describe('detect', () => {
		it('returns isEpic=false when issue has no iloom-epic label', async () => {
			const provider = createMockProvider()
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['bug', 'enhancement'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(false)
			expect(result.totalChildren).toBe(0)
			expect(provider.getChildIssues).not.toHaveBeenCalled()
		})

		it('detects iloom-epic label case-insensitively', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: '1', title: 'Child 1', url: 'https://example.com/1', state: 'open' },
				]),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['ILOOM-EPIC'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(true)
		})

		it('returns isEpic=false with warning when epic has no child issues', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([]),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(false)
			expect(result.warning).toContain('no child issues')
		})

		it('returns isEpic=false with warning when all children are closed', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: '1', title: 'Child 1', url: 'https://example.com/1', state: 'closed' },
					{ id: '2', title: 'Child 2', url: 'https://example.com/2', state: 'closed' },
				]),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(false)
			expect(result.warning).toContain('all child issues are closed')
		})

		it('returns isEpic=true with correct ready/blocked counts', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: '1', title: 'Child 1', url: 'https://example.com/1', state: 'open' },
					{ id: '2', title: 'Child 2', url: 'https://example.com/2', state: 'open' },
					{ id: '3', title: 'Child 3', url: 'https://example.com/3', state: 'open' },
				]),
				getDependencies: vi.fn()
					.mockResolvedValueOnce({ blocking: [], blockedBy: [] }) // Child 1: no blockers
					.mockResolvedValueOnce({ blocking: [], blockedBy: [{ id: '1', title: 'Child 1', url: '', state: 'open' }] }) // Child 2: blocked by 1
					.mockResolvedValueOnce({ blocking: [], blockedBy: [{ id: '2', title: 'Child 2', url: '', state: 'open' }] }), // Child 3: blocked by 2
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(true)
			expect(result.totalChildren).toBe(3)
			expect(result.readyChildren).toBe(1) // Only Child 1 is ready
			expect(result.blockedChildren).toBe(2) // Child 2 and 3 are blocked
			expect(result.hasDependencies).toBe(true)
		})

		it('warns when epic has children but no dependencies', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: '1', title: 'Child 1', url: 'https://example.com/1', state: 'open' },
					{ id: '2', title: 'Child 2', url: 'https://example.com/2', state: 'open' },
				]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(true)
			expect(result.hasDependencies).toBe(false)
			expect(result.readyChildren).toBe(2)
			expect(result.blockedChildren).toBe(0)
			expect(result.warning).toContain('no dependencies')
			expect(result.warning).toContain('parallel')
		})

		it('treats children as ready when dependency fetch fails', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: '1', title: 'Child 1', url: 'https://example.com/1', state: 'open' },
				]),
				getDependencies: vi.fn().mockRejectedValue(new Error('API error')),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(true)
			expect(result.readyChildren).toBe(1)
			expect(result.blockedChildren).toBe(0)
		})

		it('returns isEpic=false with warning when child fetch fails', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockRejectedValue(new Error('API error')),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(false)
			expect(result.warning).toContain('could not be fetched')
		})

		it('ignores closed blockers when determining if child is blocked', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: '1', title: 'Child 1', url: 'https://example.com/1', state: 'open' },
				]),
				getDependencies: vi.fn().mockResolvedValue({
					blocking: [],
					blockedBy: [{ id: '99', title: 'Closed blocker', url: '', state: 'closed' }],
				}),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, '42')

			expect(result.isEpic).toBe(true)
			expect(result.readyChildren).toBe(1)
			expect(result.blockedChildren).toBe(0)
			expect(result.hasDependencies).toBe(true) // Still has deps, just all closed
		})

		it('handles Linear OPEN state variant', async () => {
			const provider = createMockProvider({
				getChildIssues: vi.fn().mockResolvedValue([
					{ id: 'ENG-1', title: 'Child 1', url: 'https://linear.app/1', state: 'OPEN' },
				]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
			})
			const detector = new EpicDetector(provider)
			const issue = createMockIssue({ labels: ['iloom-epic'] })

			const result = await detector.detect(issue, 'ENG-42')

			expect(result.isEpic).toBe(true)
			expect(result.totalChildren).toBe(1)
		})
	})
})
