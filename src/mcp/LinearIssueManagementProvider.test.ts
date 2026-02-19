import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LinearIssueManagementProvider } from './LinearIssueManagementProvider.js'

// Mock the linear utils module
vi.mock('../utils/linear.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/linear.js')>()
	return {
		...actual,
		fetchLinearIssue: vi.fn(),
		createLinearComment: vi.fn(),
		getLinearComment: vi.fn(),
		updateLinearComment: vi.fn(),
		fetchLinearIssueComments: vi.fn(),
		createLinearIssue: vi.fn(),
		createLinearChildIssue: vi.fn(),
		createLinearIssueRelation: vi.fn(),
		getLinearIssueDependencies: vi.fn(),
		findLinearIssueRelation: vi.fn(),
		deleteLinearIssueRelation: vi.fn(),
		updateLinearIssueState: vi.fn(),
		editLinearIssue: vi.fn(),
	}
})

// Import mocked functions for assertions
import {
	fetchLinearIssue,
	createLinearComment,
	getLinearComment,
	updateLinearComment,
	fetchLinearIssueComments,
	createLinearIssue,
	createLinearChildIssue,
	createLinearIssueRelation,
	getLinearIssueDependencies,
	findLinearIssueRelation,
	deleteLinearIssueRelation,
	updateLinearIssueState,
	editLinearIssue,
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

	describe('issuePrefix', () => {
		it('should return empty string for Linear provider', () => {
			expect(provider.issuePrefix).toBe('')
		})
	})

	describe('getIssue', () => {
		it('should fetch and normalize a Linear issue', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Test Issue',
				description: 'Test description',
				state: 'In Progress',
				url: 'https://linear.app/issue/ENG-123/test-issue',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchLinearIssueComments).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-123')
			expect(result.id).toBe('ENG-123')
			expect(result.title).toBe('Test Issue')
			expect(result.body).toBe('Test description')
			expect(result.state).toBe('open')
			expect(result.url).toBe('https://linear.app/issue/ENG-123/test-issue')
			expect(result.provider).toBe('linear')
		})

		it('should map completed state to closed', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Completed Issue',
				state: 'Done',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchLinearIssueComments).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(result.state).toBe('closed')
			expect(result.body).toBe('') // no description becomes empty string
		})

		it('should map canceled state to closed', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Canceled Issue',
				description: 'Was canceled',
				state: 'Canceled',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchLinearIssueComments).mockResolvedValue([])

			const result = await provider.getIssue({ number: 'ENG-123' })

			expect(result.state).toBe('closed')
		})

		it('should skip comments when includeComments is false', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Test Issue',
				description: 'Test',
				state: 'Todo',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			}

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)

			const result = await provider.getIssue({ number: 'ENG-123', includeComments: false })

			expect(fetchLinearIssueComments).not.toHaveBeenCalled()
			expect(result.comments).toBeUndefined()
		})

		it('should include comments when requested', async () => {
			const mockLinearIssue = {
				id: 'uuid-123',
				identifier: 'ENG-123',
				title: 'Test Issue',
				description: 'Test',
				state: 'Todo',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			}

			const mockComments = [
				{
					id: 'comment-uuid-1',
					body: 'First comment',
					createdAt: '2024-01-01T12:00:00Z',
					updatedAt: '2024-01-01T12:00:00Z',
					url: 'https://linear.app/comment/1',
				},
			]

			vi.mocked(fetchLinearIssue).mockResolvedValue(mockLinearIssue)
			vi.mocked(fetchLinearIssueComments).mockResolvedValue(mockComments)

			const result = await provider.getIssue({ number: 'ENG-123', includeComments: true })

			expect(fetchLinearIssueComments).toHaveBeenCalledWith('ENG-123')
			expect(result.comments).toHaveLength(1)
			expect(result.comments?.[0]?.body).toBe('First comment')
			expect(result.comments?.[0]?.author).toBeNull() // SDK doesn't return author
		})
	})

	describe('getComment', () => {
		it('should fetch and normalize a comment', async () => {
			const mockComment = {
				id: 'comment-uuid',
				body: 'Test comment body',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
				url: 'https://linear.app/comment/uuid',
			}

			vi.mocked(getLinearComment).mockResolvedValue(mockComment)

			const result = await provider.getComment({ commentId: 'comment-uuid', number: 'ENG-123' })

			expect(getLinearComment).toHaveBeenCalledWith('comment-uuid')
			expect(result.id).toBe('comment-uuid')
			expect(result.body).toBe('Test comment body')
			expect(result.created_at).toBe('2024-01-01T00:00:00Z')
			expect(result.author).toBeNull() // SDK doesn't return author
		})
	})

	describe('createComment', () => {
		it('should create a comment and return result', async () => {
			const mockResult = {
				id: 'new-comment-uuid',
				body: 'New comment',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
				url: 'https://linear.app/comment/new-comment-uuid',
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

		it('should convert HTML details/summary to Linear format', async () => {
			const mockResult = {
				id: 'new-comment-uuid',
				body: 'Converted comment',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
				url: 'https://linear.app/comment/new-comment-uuid',
			}

			vi.mocked(createLinearComment).mockResolvedValue(mockResult)

			const htmlBody = `Test plan:
<details>
<summary>Phase 1</summary>
- Step 1
- Step 2
</details>`

			await provider.createComment({
				number: 'ENG-123',
				body: htmlBody,
				type: 'issue',
			})

			// Verify the HTML was converted to Linear's collapsible format
			expect(createLinearComment).toHaveBeenCalledWith(
				'ENG-123',
				`Test plan:
+++ Phase 1

- Step 1
- Step 2

+++`
			)
		})

		it('should pass through body without details blocks unchanged', async () => {
			const mockResult = {
				id: 'new-comment-uuid',
				body: 'Regular comment',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
				url: 'https://linear.app/comment/new-comment-uuid',
			}

			vi.mocked(createLinearComment).mockResolvedValue(mockResult)

			const regularBody = 'Just a regular comment with **markdown**'

			await provider.createComment({
				number: 'ENG-123',
				body: regularBody,
				type: 'issue',
			})

			// Should pass through unchanged
			expect(createLinearComment).toHaveBeenCalledWith('ENG-123', regularBody)
		})
	})

	describe('updateComment', () => {
		it('should update a comment and return result', async () => {
			const mockResult = {
				id: 'comment-uuid',
				body: 'Updated comment',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				url: 'https://linear.app/comment/comment-uuid',
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

		it('should convert HTML details/summary to Linear format when updating', async () => {
			const mockResult = {
				id: 'comment-uuid',
				body: 'Updated with converted HTML',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				url: 'https://linear.app/comment/comment-uuid',
			}

			vi.mocked(updateLinearComment).mockResolvedValue(mockResult)

			const htmlBody = `Updated plan:
<details>
<summary>New Phase</summary>
New content here
</details>`

			await provider.updateComment({
				commentId: 'comment-uuid',
				number: 'ENG-123',
				body: htmlBody,
			})

			// Verify the HTML was converted to Linear's collapsible format
			expect(updateLinearComment).toHaveBeenCalledWith(
				'comment-uuid',
				`Updated plan:
+++ New Phase

New content here

+++`
			)
		})

		it('should pass through update body without details blocks unchanged', async () => {
			const mockResult = {
				id: 'comment-uuid',
				body: 'Regular update',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
				url: 'https://linear.app/comment/comment-uuid',
			}

			vi.mocked(updateLinearComment).mockResolvedValue(mockResult)

			const regularBody = 'Regular update with **markdown**'

			await provider.updateComment({
				commentId: 'comment-uuid',
				number: 'ENG-123',
				body: regularBody,
			})

			// Should pass through unchanged
			expect(updateLinearComment).toHaveBeenCalledWith('comment-uuid', regularBody)
		})
	})

	describe('createIssue', () => {
		it('should create an issue with title, body, and teamKey', async () => {
			vi.mocked(createLinearIssue).mockResolvedValue({
				identifier: 'ENG-456',
				url: 'https://linear.app/team/issue/ENG-456/new-issue',
			})

			const result = await provider.createIssue({
				title: 'New Issue',
				body: 'Issue description',
				teamKey: 'ENG',
			})

			expect(createLinearIssue).toHaveBeenCalledWith('New Issue', 'Issue description', 'ENG', undefined)
			expect(result.id).toBe('ENG-456')
			expect(result.url).toBe('https://linear.app/team/issue/ENG-456/new-issue')
			expect(result.number).toBeUndefined() // Linear doesn't use numeric issue numbers
		})

		it('should create an issue with labels', async () => {
			vi.mocked(createLinearIssue).mockResolvedValue({
				identifier: 'ENG-789',
				url: 'https://linear.app/team/issue/ENG-789/labeled-issue',
			})

			const result = await provider.createIssue({
				title: 'Labeled Issue',
				body: 'Issue with labels',
				teamKey: 'ENG',
				labels: ['bug', 'priority:high'],
			})

			expect(createLinearIssue).toHaveBeenCalledWith('Labeled Issue', 'Issue with labels', 'ENG', ['bug', 'priority:high'])
			expect(result.id).toBe('ENG-789')
		})

		it('should throw error when teamKey is missing', async () => {
			await expect(
				provider.createIssue({
					title: 'Issue without team',
					body: 'Body',
				})
			).rejects.toThrow('teamKey is required for Linear issue creation')

			expect(createLinearIssue).not.toHaveBeenCalled()
		})
	})

	describe('createChildIssue', () => {
		it('should create child issue with parentId', async () => {
			// Mock fetchLinearIssue to return parent with UUID
			vi.mocked(fetchLinearIssue).mockResolvedValueOnce({
				id: 'parent-uuid-123',
				identifier: 'ENG-123',
				title: 'Parent Issue',
				state: 'In Progress',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			})
			// Mock createLinearChildIssue to return child issue
			vi.mocked(createLinearChildIssue).mockResolvedValueOnce({
				identifier: 'ENG-124',
				url: 'https://linear.app/issue/ENG-124/child-issue',
			})

			const result = await provider.createChildIssue({
				parentId: 'ENG-123',
				title: 'Child Issue',
				body: 'Child issue description',
				teamKey: 'ENG',
			})

			// Verify parent issue was fetched
			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-123')
			// Verify createLinearChildIssue was called with parent's UUID (not identifier)
			expect(createLinearChildIssue).toHaveBeenCalledWith(
				'Child Issue',
				'Child issue description',
				'ENG',
				'parent-uuid-123', // UUID, not identifier
				undefined
			)
			// Verify result
			expect(result.id).toBe('ENG-124')
			expect(result.url).toBe('https://linear.app/issue/ENG-124/child-issue')
			expect(result.number).toBeUndefined() // Linear doesn't use numeric issue numbers
		})

		it('should create child issue with labels', async () => {
			vi.mocked(fetchLinearIssue).mockResolvedValueOnce({
				id: 'parent-uuid-123',
				identifier: 'ENG-123',
				title: 'Parent Issue',
				state: 'In Progress',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			})
			vi.mocked(createLinearChildIssue).mockResolvedValueOnce({
				identifier: 'ENG-125',
				url: 'https://linear.app/issue/ENG-125/labeled-child',
			})

			const result = await provider.createChildIssue({
				parentId: 'ENG-123',
				title: 'Labeled Child Issue',
				body: 'Body with labels',
				teamKey: 'ENG',
				labels: ['bug', 'priority:high'],
			})

			expect(createLinearChildIssue).toHaveBeenCalledWith(
				'Labeled Child Issue',
				'Body with labels',
				'ENG',
				'parent-uuid-123',
				['bug', 'priority:high']
			)
			expect(result.id).toBe('ENG-125')
		})

		it('should throw error when parent issue not found', async () => {
			vi.mocked(fetchLinearIssue).mockRejectedValueOnce(new Error('Issue ENG-999 not found'))

			await expect(
				provider.createChildIssue({
					parentId: 'ENG-999',
					title: 'Child Issue',
					body: 'Body',
					teamKey: 'ENG',
				})
			).rejects.toThrow('Issue ENG-999 not found')

			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-999')
			expect(createLinearChildIssue).not.toHaveBeenCalled()
		})

		it('should use teamKey from parent issue identifier when not provided', async () => {
			vi.mocked(fetchLinearIssue).mockResolvedValueOnce({
				id: 'parent-uuid-123',
				identifier: 'ENG-123',
				title: 'Parent Issue',
				state: 'In Progress',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			})
			vi.mocked(createLinearChildIssue).mockResolvedValueOnce({
				identifier: 'ENG-126',
				url: 'https://linear.app/issue/ENG-126/child-no-team',
			})

			const result = await provider.createChildIssue({
				parentId: 'ENG-123',
				title: 'Child without explicit teamKey',
				body: 'Body',
				// teamKey not provided - should extract "ENG" from parent identifier
			})

			// Team key should be extracted from parent identifier "ENG-123" -> "ENG"
			expect(createLinearChildIssue).toHaveBeenCalledWith(
				'Child without explicit teamKey',
				'Body',
				'ENG',
				'parent-uuid-123',
				undefined
			)
			expect(result.id).toBe('ENG-126')
		})

		it('should throw error when teamKey cannot be determined', async () => {
			vi.mocked(fetchLinearIssue).mockResolvedValueOnce({
				id: 'parent-uuid-123',
				identifier: 'X-1', // Single letter prefix - won't match regex
				title: 'Parent Issue',
				state: 'In Progress',
				url: 'https://linear.app/issue/X-1',
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			})

			await expect(
				provider.createChildIssue({
					parentId: 'X-1', // Won't match team key regex (requires 2+ letters)
					title: 'Child Issue',
					body: 'Body',
					// teamKey not provided and can't be extracted
				})
			).rejects.toThrow('teamKey is required for Linear child issue creation')

			expect(fetchLinearIssue).toHaveBeenCalledWith('X-1')
			expect(createLinearChildIssue).not.toHaveBeenCalled()
		})
	})

	describe('createDependency', () => {
		it('should create blocking relation between two issues', async () => {
			vi.mocked(fetchLinearIssue)
				.mockResolvedValueOnce({
					id: 'blocking-uuid',
					identifier: 'ENG-100',
					title: 'Blocking Issue',
					state: 'In Progress',
					url: 'https://linear.app/issue/ENG-100',
					createdAt: '2024-01-01T00:00:00Z',
					updatedAt: '2024-01-02T00:00:00Z',
				})
				.mockResolvedValueOnce({
					id: 'blocked-uuid',
					identifier: 'ENG-200',
					title: 'Blocked Issue',
					state: 'In Progress',
					url: 'https://linear.app/issue/ENG-200',
					createdAt: '2024-01-01T00:00:00Z',
					updatedAt: '2024-01-02T00:00:00Z',
				})
			vi.mocked(createLinearIssueRelation).mockResolvedValueOnce(undefined)

			await provider.createDependency({
				blockingIssue: 'ENG-100',
				blockedIssue: 'ENG-200',
			})

			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-100')
			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-200')
			expect(createLinearIssueRelation).toHaveBeenCalledWith('blocking-uuid', 'blocked-uuid')
		})

		it('should throw error when blocking issue not found', async () => {
			vi.mocked(fetchLinearIssue).mockRejectedValueOnce(new Error('Issue ENG-999 not found'))

			await expect(
				provider.createDependency({
					blockingIssue: 'ENG-999',
					blockedIssue: 'ENG-200',
				})
			).rejects.toThrow('Issue ENG-999 not found')

			expect(createLinearIssueRelation).not.toHaveBeenCalled()
		})
	})

	describe('getDependencies', () => {
		it('should return blocking issues when direction is blocking', async () => {
			vi.mocked(getLinearIssueDependencies).mockResolvedValueOnce({
				blocking: [
					{ id: 'ENG-200', title: 'Blocked Issue', url: 'https://linear.app/issue/ENG-200', state: 'In Progress' },
				],
				blockedBy: [],
			})

			const result = await provider.getDependencies({
				number: 'ENG-100',
				direction: 'blocking',
			})

			expect(getLinearIssueDependencies).toHaveBeenCalledWith('ENG-100', 'blocking')
			expect(result.blocking).toHaveLength(1)
			expect(result.blocking[0].id).toBe('ENG-200')
			expect(result.blockedBy).toHaveLength(0)
		})

		it('should return blocked_by issues when direction is blocked_by', async () => {
			vi.mocked(getLinearIssueDependencies).mockResolvedValueOnce({
				blocking: [],
				blockedBy: [
					{ id: 'ENG-50', title: 'Blocking Issue', url: 'https://linear.app/issue/ENG-50', state: 'In Progress' },
				],
			})

			const result = await provider.getDependencies({
				number: 'ENG-100',
				direction: 'blocked_by',
			})

			expect(getLinearIssueDependencies).toHaveBeenCalledWith('ENG-100', 'blocked_by')
			expect(result.blockedBy).toHaveLength(1)
			expect(result.blockedBy[0].id).toBe('ENG-50')
			expect(result.blocking).toHaveLength(0)
		})

		it('should return both directions when direction is both', async () => {
			vi.mocked(getLinearIssueDependencies).mockResolvedValueOnce({
				blocking: [
					{ id: 'ENG-200', title: 'Blocked Issue', url: 'https://linear.app/issue/ENG-200', state: 'In Progress' },
				],
				blockedBy: [
					{ id: 'ENG-50', title: 'Blocking Issue', url: 'https://linear.app/issue/ENG-50', state: 'In Progress' },
				],
			})

			const result = await provider.getDependencies({
				number: 'ENG-100',
				direction: 'both',
			})

			expect(getLinearIssueDependencies).toHaveBeenCalledWith('ENG-100', 'both')
			expect(result.blocking).toHaveLength(1)
			expect(result.blockedBy).toHaveLength(1)
		})
	})

	describe('removeDependency', () => {
		it('should remove blocking relation between two issues', async () => {
			vi.mocked(findLinearIssueRelation).mockResolvedValueOnce('relation-uuid')
			vi.mocked(deleteLinearIssueRelation).mockResolvedValueOnce(undefined)

			await provider.removeDependency({
				blockingIssue: 'ENG-100',
				blockedIssue: 'ENG-200',
			})

			expect(findLinearIssueRelation).toHaveBeenCalledWith('ENG-100', 'ENG-200')
			expect(deleteLinearIssueRelation).toHaveBeenCalledWith('relation-uuid')
		})

		it('should throw error when relation not found', async () => {
			vi.mocked(findLinearIssueRelation).mockResolvedValueOnce(null)

			await expect(
				provider.removeDependency({
					blockingIssue: 'ENG-100',
					blockedIssue: 'ENG-200',
				})
			).rejects.toThrow('No blocking dependency found from ENG-100 to ENG-200')

			expect(deleteLinearIssueRelation).not.toHaveBeenCalled()
		})
	})

	describe('closeIssue', () => {
		it('calls updateLinearIssueState with Done', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValueOnce(undefined)

			await provider.closeIssue({ number: 'ENG-123' })

			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'Done')
		})
	})

	describe('reopenIssue', () => {
		it('calls updateLinearIssueState with Todo', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValueOnce(undefined)

			await provider.reopenIssue({ number: 'ENG-123' })

			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'Todo')
		})
	})

	describe('editIssue', () => {
		it('updates title via editLinearIssue', async () => {
			vi.mocked(editLinearIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: 'ENG-123', title: 'New Title' })

			expect(editLinearIssue).toHaveBeenCalledWith('ENG-123', { title: 'New Title' })
		})

		it('updates description via editLinearIssue', async () => {
			vi.mocked(editLinearIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: 'ENG-123', body: 'New Body' })

			expect(editLinearIssue).toHaveBeenCalledWith('ENG-123', { description: 'New Body' })
		})

		it('handles state change to closed via closeIssue', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: 'ENG-123', state: 'closed' })

			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'Done')
			expect(editLinearIssue).not.toHaveBeenCalled()
		})

		it('handles state change to open via reopenIssue', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: 'ENG-123', state: 'open' })

			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'Todo')
			expect(editLinearIssue).not.toHaveBeenCalled()
		})

		it('handles state change with field updates', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValueOnce(undefined)
			vi.mocked(editLinearIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: 'ENG-123', state: 'closed', title: 'Updated Title' })

			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'Done')
			expect(editLinearIssue).toHaveBeenCalledWith('ENG-123', { title: 'Updated Title' })
		})
	})
})
