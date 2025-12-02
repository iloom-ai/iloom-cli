import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LinearIssueManagementProvider } from './LinearIssueManagementProvider.js'

// Mock the linear utils module (keep buildLinearIssueUrl as real implementation)
vi.mock('../utils/linear.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/linear.js')>()
	return {
		...actual,
		fetchLinearIssue: vi.fn(),
		createLinearComment: vi.fn(),
		getLinearComment: vi.fn(),
		updateLinearComment: vi.fn(),
		executeLinearisCommand: vi.fn(),
	}
})

// Import mocked functions for assertions
import {
	fetchLinearIssue,
	createLinearComment,
	getLinearComment,
	updateLinearComment,
	executeLinearisCommand,
} from '../utils/linear.js'

describe('LinearIssueManagementProvider', () => {
	let provider: LinearIssueManagementProvider

	beforeEach(() => {
		provider = new LinearIssueManagementProvider()
	})

	describe('providerName', () => {
		it('should return "linear"', () => {
			expect(provider.providerName).toBe('linear')
		})
	})

	describe('getIssue', () => {
		it('should fetch and normalize a Linear issue', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Test Issue',
				description: 'Test description',
				state: {
					id: 'state-uuid',
					name: 'In Progress',
					type: 'started' as const,
				},
				labels: [{ name: 'bug' }],
				assignee: { name: 'john', displayName: 'John Doe' },
				// url omitted to test buildLinearIssueUrl fallback
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(executeLinearisCommand).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-123')
			expect(result.id).toBe('ENG-123')
			expect(result.title).toBe('Test Issue')
			expect(result.body).toBe('Test description')
			expect(result.state).toBe('open') // 'started' maps to 'open'
			expect(result.url).toBe('https://linear.app/issue/ENG-123/test-issue')
			expect(result.provider).toBe('linear')
			expect(result.labels).toEqual([{ name: 'bug' }])
			expect(result.assignees).toHaveLength(1)
			expect(result.assignees?.[0]?.displayName).toBe('John Doe')
		})

		it('should map completed state to closed', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Completed Issue',
				description: null,
				state: {
					id: 'state-uuid',
					name: 'Done',
					type: 'completed' as const,
				},
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(executeLinearisCommand).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(result.state).toBe('closed')
			expect(result.body).toBe('') // null description becomes empty string
		})

		it('should map canceled state to closed', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Canceled Issue',
				description: 'Was canceled',
				state: {
					id: 'state-uuid',
					name: 'Canceled',
					type: 'canceled' as const,
				},
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(executeLinearisCommand).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(result.state).toBe('closed')
		})

		it('should skip comments when includeComments is false', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Test Issue',
				description: 'Test',
				state: { id: 'state-uuid', name: 'Todo', type: 'unstarted' as const },
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)

			const result = await provider.getIssue({ number: 'ENG-123', includeComments: false })

			expect(executeLinearisCommand).not.toHaveBeenCalled()
			expect(result.comments).toBeUndefined()
		})

		it('should include comments when requested', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Test Issue',
				description: 'Test',
				state: { id: 'state-uuid', name: 'Todo', type: 'unstarted' as const },
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			const mockComments = [
				{
					id: 'comment-uuid-1',
					body: 'First comment',
					createdAt: '2024-01-01T12:00:00Z',
					user: { name: 'alice', displayName: 'Alice' },
				},
			]

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(executeLinearisCommand).mockResolvedValue(mockComments)

			const result = await provider.getIssue({ number: 'ENG-123', includeComments: true })

			expect(executeLinearisCommand).toHaveBeenCalledWith(['comments', 'list', 'ENG-123'])
			expect(result.comments).toHaveLength(1)
			expect(result.comments?.[0]?.body).toBe('First comment')
			expect(result.comments?.[0]?.author?.displayName).toBe('Alice')
		})
	})

	describe('getComment', () => {
		it('should fetch and normalize a comment', async () => {
			const mockComment = {
				id: 'comment-uuid',
				body: 'Test comment body',
				createdAt: '2024-01-01T00:00:00Z',
				user: { name: 'bob', displayName: 'Bob Smith' },
			}

			vi.mocked(getLinearComment).mockResolvedValue(mockComment)

			const result = await provider.getComment({ commentId: 'comment-uuid', number: 'ENG-123' })

			expect(getLinearComment).toHaveBeenCalledWith('comment-uuid')
			expect(result.id).toBe('comment-uuid')
			expect(result.body).toBe('Test comment body')
			expect(result.created_at).toBe('2024-01-01T00:00:00Z')
			expect(result.author?.displayName).toBe('Bob Smith')
		})
	})

	describe('createComment', () => {
		it('should create a comment and return result', async () => {
			const mockResult = {
				id: 'new-comment-uuid',
				body: 'New comment',
				createdAt: '2024-01-01T00:00:00Z',
				user: { name: 'alice' },
			}

			vi.mocked(createLinearComment).mockResolvedValue(mockResult)

			const result = await provider.createComment({
				number: 'ENG-123',
				body: 'New comment',
				type: 'issue',
			})

			expect(createLinearComment).toHaveBeenCalledWith('ENG-123', 'New comment')
			expect(result.id).toBe('new-comment-uuid')
			expect(result.created_at).toBe('2024-01-01T00:00:00Z')
		})
	})

	describe('updateComment', () => {
		it('should update a comment and return result', async () => {
			const mockResult = {
				id: 'comment-uuid',
				body: 'Updated comment',
				createdAt: '2024-01-01T00:00:00Z',
				user: { name: 'alice' },
			}

			vi.mocked(updateLinearComment).mockResolvedValue(mockResult)

			const result = await provider.updateComment({
				commentId: 'comment-uuid',
				number: 'ENG-123',
				body: 'Updated comment',
			})

			expect(updateLinearComment).toHaveBeenCalledWith('comment-uuid', 'Updated comment')
			expect(result.id).toBe('comment-uuid')
		})
	})
})
