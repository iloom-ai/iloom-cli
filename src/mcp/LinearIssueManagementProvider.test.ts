import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the linear-graphql utils module
vi.mock('../utils/linear-graphql.js', () => ({
	fetchLinearIssueByIdentifier: vi.fn(),
	createLinearCommentGraphQL: vi.fn(),
	getLinearCommentGraphQL: vi.fn(),
	updateLinearCommentGraphQL: vi.fn(),
	fetchIssueCommentsGraphQL: vi.fn(),
}))

// Mock the linear utils module (keep buildLinearIssueUrl as real implementation)
vi.mock('../utils/linear.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/linear.js')>()
	return {
		...actual,
	}
})

// Import after mocking
import { LinearIssueManagementProvider } from './LinearIssueManagementProvider.js'
import {
	fetchLinearIssueByIdentifier,
	createLinearCommentGraphQL,
	getLinearCommentGraphQL,
	updateLinearCommentGraphQL,
	fetchIssueCommentsGraphQL,
} from '../utils/linear-graphql.js'

const TEST_API_TOKEN = 'lin_api_test_token_123'

describe('LinearIssueManagementProvider', () => {
	let provider: LinearIssueManagementProvider

	beforeEach(() => {
		provider = new LinearIssueManagementProvider({ apiToken: TEST_API_TOKEN })
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

			vi.mocked(fetchLinearIssueByIdentifier).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchIssueCommentsGraphQL).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(fetchLinearIssueByIdentifier).toHaveBeenCalledWith('ENG-123', TEST_API_TOKEN)
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

			vi.mocked(fetchLinearIssueByIdentifier).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchIssueCommentsGraphQL).mockResolvedValue([])

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

			vi.mocked(fetchLinearIssueByIdentifier).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchIssueCommentsGraphQL).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(result.state).toBe('closed')
		})

		it('should skip comments when includeComments is false', async () => {
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
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			vi.mocked(fetchLinearIssueByIdentifier).mockResolvedValue(mockLinearIssue)

			const result = await provider.getIssue({ number: 'ENG-123', includeComments: false })

			expect(fetchIssueCommentsGraphQL).not.toHaveBeenCalled()
			expect(result.comments).toBeUndefined()
		})

		it('should include comments when requested', async () => {
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
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
			}

			const mockComments = [
				{
					id: 'comment-1',
					body: 'First comment',
					createdAt: '2024-01-01T10:00:00Z',
					user: { name: 'alice', displayName: 'Alice' },
				},
			]

			vi.mocked(fetchLinearIssueByIdentifier).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchIssueCommentsGraphQL).mockResolvedValue(mockComments)

			const result = await provider.getIssue({ number: 'ENG-123', includeComments: true })

			expect(fetchIssueCommentsGraphQL).toHaveBeenCalledWith('uuid-123', TEST_API_TOKEN)
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

			vi.mocked(getLinearCommentGraphQL).mockResolvedValue(mockComment)

			const result = await provider.getComment({ commentId: 'comment-uuid', number: 'ENG-123' })

			expect(getLinearCommentGraphQL).toHaveBeenCalledWith('comment-uuid', TEST_API_TOKEN)
			expect(result.id).toBe('comment-uuid')
			expect(result.body).toBe('Test comment body')
			expect(result.created_at).toBe('2024-01-01T00:00:00Z')
			expect(result.author?.displayName).toBe('Bob Smith')
		})
	})

	describe('createComment', () => {
		it('should create a comment and return result', async () => {
			const mockIssue = {
				id: 'issue-uuid-123',
				identifier: 'ENG-123',
				title: 'Test',
				description: '',
				state: { id: '1', name: 'Open', type: 'unstarted' as const },
				labels: [],
				assignee: null,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
				team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
			}

			const mockResult = {
				id: 'new-comment-uuid',
				body: 'New comment',
				createdAt: '2024-01-01T00:00:00Z',
				user: { name: 'alice' },
			}

			vi.mocked(fetchLinearIssueByIdentifier).mockResolvedValue(mockIssue)
			vi.mocked(createLinearCommentGraphQL).mockResolvedValue(mockResult)

			const result = await provider.createComment({
				number: 'ENG-123',
				body: 'New comment',
				type: 'issue',
			})

			expect(fetchLinearIssueByIdentifier).toHaveBeenCalledWith('ENG-123', TEST_API_TOKEN)
			expect(createLinearCommentGraphQL).toHaveBeenCalledWith('issue-uuid-123', 'New comment', TEST_API_TOKEN)
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

			vi.mocked(updateLinearCommentGraphQL).mockResolvedValue(mockResult)

			const result = await provider.updateComment({
				commentId: 'comment-uuid',
				number: 'ENG-123',
				body: 'Updated comment',
			})

			expect(updateLinearCommentGraphQL).toHaveBeenCalledWith('comment-uuid', 'Updated comment', TEST_API_TOKEN)
			expect(result.id).toBe('comment-uuid')
		})
	})
})
