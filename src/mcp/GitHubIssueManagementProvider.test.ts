import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubIssueManagementProvider, extractNumericIdFromUrl } from './GitHubIssueManagementProvider.js'

// Mock the github utils
vi.mock('../utils/github.js', () => ({
	executeGhCommand: vi.fn(),
	createIssueComment: vi.fn(),
	updateIssueComment: vi.fn(),
	createPRComment: vi.fn(),
	createIssue: vi.fn(),
	getIssueNodeId: vi.fn(),
	addSubIssue: vi.fn(),
	getIssueDatabaseId: vi.fn(),
	getIssueDependencies: vi.fn(),
	createIssueDependency: vi.fn(),
	removeIssueDependency: vi.fn(),
	closeGhIssue: vi.fn(),
	reopenGhIssue: vi.fn(),
	editGhIssue: vi.fn(),
}))

import {
	executeGhCommand,
	createIssue,
	getIssueNodeId,
	addSubIssue,
	getIssueDatabaseId,
	getIssueDependencies,
	createIssueDependency,
	removeIssueDependency,
	closeGhIssue,
	reopenGhIssue,
	editGhIssue,
} from '../utils/github.js'

describe('extractNumericIdFromUrl', () => {
	it('extracts numeric ID from valid GitHub issue comment URL', () => {
		const url = 'https://github.com/owner/repo/issues/123#issuecomment-3615239386'
		expect(extractNumericIdFromUrl(url)).toBe('3615239386')
	})

	it('extracts numeric ID from valid GitHub PR comment URL', () => {
		const url = 'https://github.com/owner/repo/pull/456#issuecomment-9876543210'
		expect(extractNumericIdFromUrl(url)).toBe('9876543210')
	})

	it('returns undefined when URL is undefined', () => {
		expect(extractNumericIdFromUrl(undefined)).toBeUndefined()
	})

	it('returns undefined when URL is null', () => {
		expect(extractNumericIdFromUrl(null)).toBeUndefined()
	})

	it('throws error when URL has no issuecomment fragment', () => {
		const url = 'https://github.com/owner/repo/issues/123'
		expect(() => extractNumericIdFromUrl(url)).toThrow('Cannot extract comment ID from URL')
	})

	it('throws error when URL has malformed issuecomment fragment', () => {
		const url = 'https://github.com/owner/repo/issues/123#issuecomment-'
		expect(() => extractNumericIdFromUrl(url)).toThrow('Cannot extract comment ID from URL')
	})

	it('throws error when issuecomment fragment has non-numeric ID', () => {
		const url = 'https://github.com/owner/repo/issues/123#issuecomment-abc123'
		expect(() => extractNumericIdFromUrl(url)).toThrow('Cannot extract comment ID from URL')
	})
})

describe('GitHubIssueManagementProvider', () => {
	let provider: GitHubIssueManagementProvider

	beforeEach(() => {
		provider = new GitHubIssueManagementProvider()
	})

	describe('issuePrefix', () => {
		it('should return "#" for GitHub provider', () => {
			expect(provider.issuePrefix).toBe('#')
		})
	})

	describe('getIssue', () => {
		it('returns comments with numeric IDs extracted from URLs', async () => {
			const mockResponse = {
				number: 123,
				title: 'Test Issue',
				body: 'Issue body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/issues/123',
				author: { login: 'testuser' },
				comments: [
					{
						id: 'IC_kwDOPvp_cc7Xe_ri', // GraphQL node ID (should be ignored)
						author: { login: 'commenter1' },
						body: 'First comment',
						createdAt: '2025-01-01T00:00:00Z',
						url: 'https://github.com/owner/repo/issues/123#issuecomment-3615239386',
					},
					{
						id: 'IC_kwDOPvp_cc7Xe_rj', // GraphQL node ID (should be ignored)
						author: { login: 'commenter2' },
						body: 'Second comment',
						createdAt: '2025-01-02T00:00:00Z',
						url: 'https://github.com/owner/repo/issues/123#issuecomment-3615239387',
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getIssue({ number: '123' })

			expect(result.comments).toHaveLength(2)
			// Verify numeric IDs are extracted from URLs, not GraphQL node IDs
			expect(result.comments![0].id).toBe('3615239386')
			expect(result.comments![1].id).toBe('3615239387')
		})

		it('handles issues without comments', async () => {
			const mockResponse = {
				number: 123,
				title: 'Test Issue',
				body: 'Issue body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/issues/123',
				author: { login: 'testuser' },
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getIssue({ number: '123', includeComments: false })

			expect(result.comments).toBeUndefined()
		})

		it('throws error when comment URL is missing issuecomment fragment', async () => {
			const mockResponse = {
				number: 123,
				title: 'Test Issue',
				body: 'Issue body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/issues/123',
				author: { login: 'testuser' },
				comments: [
					{
						id: 'IC_kwDOPvp_cc7Xe_ri',
						author: { login: 'commenter1' },
						body: 'Bad comment',
						createdAt: '2025-01-01T00:00:00Z',
						url: 'https://github.com/owner/repo/issues/123', // Missing #issuecomment fragment
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			await expect(provider.getIssue({ number: '123' })).rejects.toThrow(
				'Cannot extract comment ID from URL'
			)
		})

		it('falls back to comment.id when url is undefined (older gh CLI)', async () => {
			const mockResponse = {
				number: 123,
				title: 'Test Issue',
				body: 'Issue body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/issues/123',
				author: { login: 'testuser' },
				comments: [
					{
						id: 12345678,
						author: { login: 'commenter1' },
						body: 'Comment without url field',
						createdAt: '2025-01-01T00:00:00Z',
						// url is missing - simulates older gh CLI (e.g. v2.4.0)
					},
					{
						id: 87654321,
						author: { login: 'commenter2' },
						body: 'Another comment without url',
						createdAt: '2025-01-02T00:00:00Z',
						// url is missing
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getIssue({ number: '123' })

			expect(result.comments).toHaveLength(2)
			// Falls back to stringified comment.id
			expect(result.comments![0].id).toBe('12345678')
			expect(result.comments![1].id).toBe('87654321')
		})

		it('uses url extraction for some comments and fallback for others', async () => {
			const mockResponse = {
				number: 123,
				title: 'Test Issue',
				body: 'Issue body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/issues/123',
				author: { login: 'testuser' },
				comments: [
					{
						id: 11111111,
						author: { login: 'commenter1' },
						body: 'Comment with url',
						createdAt: '2025-01-01T00:00:00Z',
						url: 'https://github.com/owner/repo/issues/123#issuecomment-99999999',
					},
					{
						id: 22222222,
						author: { login: 'commenter2' },
						body: 'Comment without url',
						createdAt: '2025-01-02T00:00:00Z',
						// url is missing
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getIssue({ number: '123' })

			expect(result.comments).toHaveLength(2)
			// First comment: extracted from URL
			expect(result.comments![0].id).toBe('99999999')
			// Second comment: fallback to comment.id
			expect(result.comments![1].id).toBe('22222222')
		})

		it('passes --repo flag when repo parameter is provided', async () => {
			const mockResponse = {
				number: 456,
				title: 'External Issue',
				body: 'Issue from another repo',
				state: 'OPEN',
				url: 'https://github.com/other-owner/other-repo/issues/456',
				author: { login: 'testuser' },
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			await provider.getIssue({ number: '456', repo: 'other-owner/other-repo', includeComments: false })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'issue',
				'view',
				'456',
				'--json',
				'body,title,labels,assignees,milestone,author,state,number,url',
				'--repo',
				'other-owner/other-repo',
			])
		})

		it('does not pass --repo flag when repo parameter is undefined', async () => {
			const mockResponse = {
				number: 789,
				title: 'Local Issue',
				body: 'Issue from current repo',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/issues/789',
				author: { login: 'testuser' },
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			await provider.getIssue({ number: '789', includeComments: false })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'issue',
				'view',
				'789',
				'--json',
				'body,title,labels,assignees,milestone,author,state,number,url',
			])
		})
	})

	describe('getComment', () => {
		it('uses explicit repo path when repo parameter is provided', async () => {
			const mockResponse = {
				id: 123456,
				body: 'Comment body',
				user: { login: 'commenter' },
				created_at: '2025-01-01T00:00:00Z',
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			await provider.getComment({ commentId: '123456', number: '1', repo: 'other-owner/other-repo' })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'api',
				'repos/other-owner/other-repo/issues/comments/123456',
				'--jq',
				'{id: .id, body: .body, user: .user, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, reactions: .reactions}',
			])
		})

		it('uses :owner/:repo placeholder when repo parameter is undefined', async () => {
			const mockResponse = {
				id: 789012,
				body: 'Local comment body',
				user: { login: 'localcommenter' },
				created_at: '2025-01-02T00:00:00Z',
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			await provider.getComment({ commentId: '789012', number: '2' })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'api',
				'repos/:owner/:repo/issues/comments/789012',
				'--jq',
				'{id: .id, body: .body, user: .user, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, reactions: .reactions}',
			])
		})
	})

	describe('createIssue', () => {
		it('should create an issue with title and body', async () => {
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 456,
				url: 'https://github.com/owner/repo/issues/456',
			})

			const result = await provider.createIssue({
				title: 'New Issue',
				body: 'Issue description',
			})

			expect(createIssue).toHaveBeenCalledWith('New Issue', 'Issue description', { labels: undefined, repo: undefined })
			expect(result.id).toBe('456')
			expect(result.url).toBe('https://github.com/owner/repo/issues/456')
			expect(result.number).toBe(456)
		})

		it('should create an issue with optional labels', async () => {
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 789,
				url: 'https://github.com/owner/repo/issues/789',
			})

			const result = await provider.createIssue({
				title: 'Labeled Issue',
				body: 'Issue with labels',
				labels: ['bug', 'priority:high'],
			})

			expect(createIssue).toHaveBeenCalledWith('Labeled Issue', 'Issue with labels', {
				labels: ['bug', 'priority:high'],
				repo: undefined,
			})
			expect(result.id).toBe('789')
			expect(result.number).toBe(789)
		})

		it('should ignore teamKey parameter', async () => {
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 101,
				url: 'https://github.com/owner/repo/issues/101',
			})

			const result = await provider.createIssue({
				title: 'Issue with teamKey',
				body: 'Body',
				teamKey: 'ENG', // Should be ignored for GitHub
			})

			expect(createIssue).toHaveBeenCalledWith('Issue with teamKey', 'Body', { labels: undefined, repo: undefined })
			expect(result.id).toBe('101')
		})

		it('should pass repo parameter to createIssue when provided', async () => {
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 42,
				url: 'https://github.com/other-owner/other-repo/issues/42',
			})

			const result = await provider.createIssue({
				title: 'Issue in another repo',
				body: 'Body',
				repo: 'other-owner/other-repo',
			})

			expect(createIssue).toHaveBeenCalledWith('Issue in another repo', 'Body', {
				labels: undefined,
				repo: 'other-owner/other-repo',
			})
			expect(result.id).toBe('42')
			expect(result.url).toBe('https://github.com/other-owner/other-repo/issues/42')
		})

		it('should pass repo parameter with labels when both are provided', async () => {
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 55,
				url: 'https://github.com/other-owner/other-repo/issues/55',
			})

			const result = await provider.createIssue({
				title: 'Labeled issue in another repo',
				body: 'Body with labels',
				labels: ['enhancement'],
				repo: 'other-owner/other-repo',
			})

			expect(createIssue).toHaveBeenCalledWith('Labeled issue in another repo', 'Body with labels', {
				labels: ['enhancement'],
				repo: 'other-owner/other-repo',
			})
			expect(result.id).toBe('55')
		})
	})

	describe('createChildIssue', () => {
		it('should create child issue and link to parent', async () => {
			// Mock getIssueNodeId for parent
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6PARENT')
			// Mock createIssue to return child issue
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 124,
				url: 'https://github.com/owner/repo/issues/124',
			})
			// Mock getIssueNodeId for child
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6CHILD')
			// Mock addSubIssue GraphQL mutation
			vi.mocked(addSubIssue).mockResolvedValueOnce(undefined)

			const result = await provider.createChildIssue({
				parentId: '123',
				title: 'Child Issue',
				body: 'Child issue description',
			})

			// Verify parent node ID was fetched
			expect(getIssueNodeId).toHaveBeenNthCalledWith(1, 123, undefined)
			// Verify child issue was created
			expect(createIssue).toHaveBeenCalledWith('Child Issue', 'Child issue description', { labels: undefined, repo: undefined })
			// Verify child node ID was fetched
			expect(getIssueNodeId).toHaveBeenNthCalledWith(2, 124, undefined)
			// Verify sub-issue link was created
			expect(addSubIssue).toHaveBeenCalledWith('I_kwDOPvp_cc6PARENT', 'I_kwDOPvp_cc6CHILD')
			// Verify result
			expect(result.id).toBe('124')
			expect(result.url).toBe('https://github.com/owner/repo/issues/124')
			expect(result.number).toBe(124)
		})

		it('should create child issue with labels', async () => {
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6PARENT')
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 125,
				url: 'https://github.com/owner/repo/issues/125',
			})
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6CHILD')
			vi.mocked(addSubIssue).mockResolvedValueOnce(undefined)

			const result = await provider.createChildIssue({
				parentId: '123',
				title: 'Labeled Child',
				body: 'Body with labels',
				labels: ['bug', 'priority:high'],
			})

			expect(createIssue).toHaveBeenCalledWith('Labeled Child', 'Body with labels', {
				labels: ['bug', 'priority:high'],
				repo: undefined,
			})
			expect(result.id).toBe('125')
		})

		it('should throw error when parent issue number is invalid', async () => {
			await expect(
				provider.createChildIssue({
					parentId: 'invalid',
					title: 'Child Issue',
					body: 'Body',
				})
			).rejects.toThrow('Invalid GitHub parent issue number: invalid. GitHub issue IDs must be numeric.')

			expect(getIssueNodeId).not.toHaveBeenCalled()
			expect(createIssue).not.toHaveBeenCalled()
		})

		it('should throw error when parent issue not found', async () => {
			vi.mocked(getIssueNodeId).mockRejectedValueOnce(new Error('Could not find issue 999'))

			await expect(
				provider.createChildIssue({
					parentId: '999',
					title: 'Child Issue',
					body: 'Body',
				})
			).rejects.toThrow('Could not find issue 999')

			expect(getIssueNodeId).toHaveBeenCalledWith(999, undefined)
			expect(createIssue).not.toHaveBeenCalled()
		})

		it('should throw error when addSubIssue mutation fails', async () => {
			// Note: Child issue will exist but not be linked if this fails
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6PARENT')
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 126,
				url: 'https://github.com/owner/repo/issues/126',
			})
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6CHILD')
			vi.mocked(addSubIssue).mockRejectedValueOnce(new Error('GraphQL mutation failed'))

			await expect(
				provider.createChildIssue({
					parentId: '123',
					title: 'Child Issue',
					body: 'Body',
				})
			).rejects.toThrow('GraphQL mutation failed')

			// All steps before addSubIssue should have been called
			expect(getIssueNodeId).toHaveBeenCalledTimes(2)
			expect(createIssue).toHaveBeenCalled()
			expect(addSubIssue).toHaveBeenCalled()
		})

		it('should ignore teamKey parameter', async () => {
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6PARENT')
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 127,
				url: 'https://github.com/owner/repo/issues/127',
			})
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOPvp_cc6CHILD')
			vi.mocked(addSubIssue).mockResolvedValueOnce(undefined)

			const result = await provider.createChildIssue({
				parentId: '123',
				title: 'Child with teamKey',
				body: 'Body',
				teamKey: 'ENG', // Should be ignored for GitHub
			})

			expect(createIssue).toHaveBeenCalledWith('Child with teamKey', 'Body', { labels: undefined, repo: undefined })
			expect(result.id).toBe('127')
		})

		it('should pass repo parameter to getIssueNodeId and createIssue when provided', async () => {
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOOther_cc6PARENT')
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 50,
				url: 'https://github.com/other-owner/other-repo/issues/50',
			})
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOOther_cc6CHILD')
			vi.mocked(addSubIssue).mockResolvedValueOnce(undefined)

			const result = await provider.createChildIssue({
				parentId: '100',
				title: 'Child in another repo',
				body: 'Child body',
				repo: 'other-owner/other-repo',
			})

			// Verify repo is passed to getIssueNodeId for parent
			expect(getIssueNodeId).toHaveBeenNthCalledWith(1, 100, 'other-owner/other-repo')
			// Verify repo is passed to createIssue
			expect(createIssue).toHaveBeenCalledWith('Child in another repo', 'Child body', {
				labels: undefined,
				repo: 'other-owner/other-repo',
			})
			// Verify repo is passed to getIssueNodeId for child
			expect(getIssueNodeId).toHaveBeenNthCalledWith(2, 50, 'other-owner/other-repo')
			// Verify sub-issue link was created
			expect(addSubIssue).toHaveBeenCalledWith('I_kwDOOther_cc6PARENT', 'I_kwDOOther_cc6CHILD')
			// Verify result
			expect(result.id).toBe('50')
			expect(result.url).toBe('https://github.com/other-owner/other-repo/issues/50')
		})

		it('should pass repo parameter with labels when both are provided', async () => {
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOOther_cc6PARENT2')
			vi.mocked(createIssue).mockResolvedValueOnce({
				number: 60,
				url: 'https://github.com/other-owner/other-repo/issues/60',
			})
			vi.mocked(getIssueNodeId).mockResolvedValueOnce('I_kwDOOther_cc6CHILD2')
			vi.mocked(addSubIssue).mockResolvedValueOnce(undefined)

			const result = await provider.createChildIssue({
				parentId: '200',
				title: 'Labeled child in another repo',
				body: 'Child body with labels',
				labels: ['bug', 'urgent'],
				repo: 'other-owner/other-repo',
			})

			expect(getIssueNodeId).toHaveBeenNthCalledWith(1, 200, 'other-owner/other-repo')
			expect(createIssue).toHaveBeenCalledWith('Labeled child in another repo', 'Child body with labels', {
				labels: ['bug', 'urgent'],
				repo: 'other-owner/other-repo',
			})
			expect(result.id).toBe('60')
		})
	})

	describe('getPR', () => {
		it('returns PR details with normalized structure', async () => {
			const mockResponse = {
				number: 42,
				title: 'Test PR',
				body: 'PR description',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/pull/42',
				author: { login: 'testuser' },
				headRefName: 'feature-branch',
				baseRefName: 'main',
				files: [
					{ path: 'src/foo.ts', additions: 10, deletions: 5 },
				],
				commits: [
					{
						oid: 'abc123',
						messageHeadline: 'Initial commit',
						authors: [{ name: 'Test User', email: 'test@example.com' }],
					},
				],
				comments: [
					{
						id: 'PC_kwDOPvp_cc5ABC',
						author: { login: 'reviewer' },
						body: 'LGTM',
						createdAt: '2025-01-01T00:00:00Z',
						url: 'https://github.com/owner/repo/pull/42#issuecomment-123456789',
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getPR({ number: '42' })

			expect(result.id).toBe('42')
			expect(result.number).toBe(42)
			expect(result.title).toBe('Test PR')
			expect(result.body).toBe('PR description')
			expect(result.state).toBe('OPEN')
			expect(result.url).toBe('https://github.com/owner/repo/pull/42')
			expect(result.headRefName).toBe('feature-branch')
			expect(result.baseRefName).toBe('main')
			expect(result.author).toEqual({
				id: 'testuser',
				displayName: 'testuser',
				login: 'testuser',
			})
			expect(result.files).toEqual([
				{ path: 'src/foo.ts', additions: 10, deletions: 5 },
			])
			expect(result.commits).toEqual([
				{
					oid: 'abc123',
					messageHeadline: 'Initial commit',
					author: {
						id: 'test@example.com',
						displayName: 'Test User',
						name: 'Test User',
						email: 'test@example.com',
					},
				},
			])
			expect(result.comments).toHaveLength(1)
			expect(result.comments![0].id).toBe('123456789')
			expect(result.comments![0].body).toBe('LGTM')
		})

		it('falls back to comment.id when url is undefined in PR comments (older gh CLI)', async () => {
			const mockResponse = {
				number: 42,
				title: 'Test PR',
				body: 'PR description',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/pull/42',
				author: { login: 'testuser' },
				headRefName: 'feature-branch',
				baseRefName: 'main',
				comments: [
					{
						id: 55555555,
						author: { login: 'reviewer' },
						body: 'Review comment without url',
						createdAt: '2025-01-01T00:00:00Z',
						// url is missing - simulates older gh CLI
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getPR({ number: '42' })

			expect(result.comments).toHaveLength(1)
			// Falls back to stringified comment.id
			expect(result.comments![0].id).toBe('55555555')
			expect(result.comments![0].body).toBe('Review comment without url')
		})

		it('handles PRs without comments', async () => {
			const mockResponse = {
				number: 43,
				title: 'Test PR',
				body: 'PR body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/pull/43',
				author: { login: 'testuser' },
				headRefName: 'feature',
				baseRefName: 'main',
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getPR({ number: '43', includeComments: false })

			expect(result.comments).toBeUndefined()
		})

		it('passes --repo flag when repo parameter is provided', async () => {
			const mockResponse = {
				number: 100,
				title: 'External PR',
				body: 'PR from another repo',
				state: 'OPEN',
				url: 'https://github.com/other-owner/other-repo/pull/100',
				author: { login: 'testuser' },
				headRefName: 'feature',
				baseRefName: 'main',
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			await provider.getPR({ number: '100', repo: 'other-owner/other-repo', includeComments: false })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'pr',
				'view',
				'100',
				'--json',
				'number,title,body,state,url,author,headRefName,baseRefName,files,commits',
				'--repo',
				'other-owner/other-repo',
			])
		})

		it('throws error for invalid PR number', async () => {
			await expect(provider.getPR({ number: 'not-a-number' })).rejects.toThrow(
				'Invalid GitHub PR number: not-a-number. GitHub PR IDs must be numeric.'
			)
		})

		it('handles PR with commits missing authors', async () => {
			const mockResponse = {
				number: 50,
				title: 'Test PR',
				body: 'PR body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/pull/50',
				author: { login: 'testuser' },
				headRefName: 'feature',
				baseRefName: 'main',
				commits: [
					{
						oid: 'def456',
						messageHeadline: 'Commit without author',
						authors: [],
					},
				],
			}

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getPR({ number: '50', includeComments: false })

			expect(result.commits).toEqual([
				{
					oid: 'def456',
					messageHeadline: 'Commit without author',
					author: null,
				},
			])
		})
	})

	describe('getReviewComments', () => {
		it('returns review comments with file path, line number, and body', async () => {
			const mockResponse = [
				{
					id: 1001,
					body: 'This needs refactoring',
					path: 'src/foo.ts',
					line: 42,
					side: 'RIGHT',
					user: { login: 'reviewer1' },
					created_at: '2025-01-01T00:00:00Z',
					updated_at: '2025-01-01T01:00:00Z',
					in_reply_to_id: null,
					pull_request_review_id: 5000,
				},
				{
					id: 1002,
					body: 'Good catch',
					path: 'src/bar.ts',
					line: 10,
					side: 'LEFT',
					user: { login: 'reviewer2' },
					created_at: '2025-01-02T00:00:00Z',
					updated_at: null,
					in_reply_to_id: null,
					pull_request_review_id: 5001,
				},
			]

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getReviewComments({ number: '42' })

			expect(result).toHaveLength(2)
			expect(result[0]).toEqual({
				id: '1001',
				body: 'This needs refactoring',
				path: 'src/foo.ts',
				line: 42,
				side: 'RIGHT',
				author: { id: 'reviewer1', displayName: 'reviewer1', login: 'reviewer1' },
				createdAt: '2025-01-01T00:00:00Z',
				updatedAt: '2025-01-01T01:00:00Z',
				inReplyToId: null,
				pullRequestReviewId: 5000,
			})
			expect(result[1].id).toBe('1002')
			expect(result[1].path).toBe('src/bar.ts')
		})

		it('filters by reviewId when provided', async () => {
			const mockResponse = [
				{
					id: 2001,
					body: 'Comment from review A',
					path: 'src/a.ts',
					line: 1,
					side: 'RIGHT',
					user: { login: 'reviewer' },
					created_at: '2025-01-01T00:00:00Z',
					updated_at: null,
					in_reply_to_id: null,
					pull_request_review_id: 100,
				},
				{
					id: 2002,
					body: 'Comment from review B',
					path: 'src/b.ts',
					line: 5,
					side: 'RIGHT',
					user: { login: 'reviewer' },
					created_at: '2025-01-01T00:00:00Z',
					updated_at: null,
					in_reply_to_id: null,
					pull_request_review_id: 200,
				},
			]

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getReviewComments({ number: '42', reviewId: '100' })

			expect(result).toHaveLength(1)
			expect(result[0].id).toBe('2001')
			expect(result[0].pullRequestReviewId).toBe(100)
		})

		it('handles empty review comments', async () => {
			vi.mocked(executeGhCommand).mockResolvedValueOnce([])

			const result = await provider.getReviewComments({ number: '42' })

			expect(result).toEqual([])
		})

		it('passes repo to API path when provided', async () => {
			vi.mocked(executeGhCommand).mockResolvedValueOnce([])

			await provider.getReviewComments({ number: '42', repo: 'other-owner/other-repo' })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'api',
				'repos/other-owner/other-repo/pulls/42/comments',
				'--paginate',
				'--jq',
				expect.any(String),
			])
		})

		it('uses :owner/:repo placeholder when repo is not provided', async () => {
			vi.mocked(executeGhCommand).mockResolvedValueOnce([])

			await provider.getReviewComments({ number: '42' })

			expect(executeGhCommand).toHaveBeenCalledWith([
				'api',
				'repos/:owner/:repo/pulls/42/comments',
				'--paginate',
				'--jq',
				expect.any(String),
			])
		})

		it('throws error for non-numeric PR number', async () => {
			await expect(provider.getReviewComments({ number: 'not-a-number' })).rejects.toThrow(
				'Invalid GitHub PR number: not-a-number. GitHub PR IDs must be numeric.'
			)
		})

		it('throws error for non-numeric review ID', async () => {
			vi.mocked(executeGhCommand).mockResolvedValueOnce([])

			await expect(provider.getReviewComments({ number: '42', reviewId: 'abc' })).rejects.toThrow(
				'Invalid review ID: abc. Review IDs must be numeric.'
			)
		})

		it('uses --paginate flag in gh api call', async () => {
			vi.mocked(executeGhCommand).mockResolvedValueOnce([])

			await provider.getReviewComments({ number: '42' })

			const callArgs = vi.mocked(executeGhCommand).mock.calls[0][0]
			expect(callArgs).toContain('--paginate')
		})

		it('normalizes in_reply_to_id to string', async () => {
			const mockResponse = [
				{
					id: 3001,
					body: 'Reply comment',
					path: 'src/foo.ts',
					line: 42,
					side: 'RIGHT',
					user: { login: 'reviewer' },
					created_at: '2025-01-01T00:00:00Z',
					updated_at: null,
					in_reply_to_id: 3000,
					pull_request_review_id: 500,
				},
			]

			vi.mocked(executeGhCommand).mockResolvedValueOnce(mockResponse)

			const result = await provider.getReviewComments({ number: '42' })

			expect(result[0].inReplyToId).toBe('3000')
		})
	})

	describe('createDependency', () => {
		it('should create dependency between two issues', async () => {
			vi.mocked(getIssueDatabaseId).mockResolvedValueOnce(123456789)
			vi.mocked(createIssueDependency).mockResolvedValueOnce(undefined)

			await provider.createDependency({
				blockingIssue: '100',
				blockedIssue: '200',
			})

			// Gets database ID of blocking issue (100)
			// GitHub API: POST /issues/{blocked}/dependencies/blocked_by with body issue_id={blocking_db_id}
			expect(getIssueDatabaseId).toHaveBeenCalledWith(100, undefined)
			// Creates dependency: path uses blocked issue (200), body uses blocking issue DB ID
			expect(createIssueDependency).toHaveBeenCalledWith(200, 123456789, undefined)
		})

		it('should pass repo parameter when provided', async () => {
			vi.mocked(getIssueDatabaseId).mockResolvedValueOnce(987654321)
			vi.mocked(createIssueDependency).mockResolvedValueOnce(undefined)

			await provider.createDependency({
				blockingIssue: '50',
				blockedIssue: '60',
				repo: 'other-owner/other-repo',
			})

			// Gets database ID of blocking issue (50)
			expect(getIssueDatabaseId).toHaveBeenCalledWith(50, 'other-owner/other-repo')
			// Creates dependency: path uses blocked issue (60), body uses blocking issue DB ID
			expect(createIssueDependency).toHaveBeenCalledWith(60, 987654321, 'other-owner/other-repo')
		})

		it('should throw error for invalid blocking issue number', async () => {
			await expect(
				provider.createDependency({
					blockingIssue: 'invalid',
					blockedIssue: '200',
				})
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(getIssueDatabaseId).not.toHaveBeenCalled()
		})

		it('should throw error for invalid blocked issue number', async () => {
			await expect(
				provider.createDependency({
					blockingIssue: '100',
					blockedIssue: 'invalid',
				})
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(getIssueDatabaseId).not.toHaveBeenCalled()
		})
	})

	describe('getDependencies', () => {
		it('should return blocking issues when direction is blocking', async () => {
			vi.mocked(getIssueDependencies).mockResolvedValueOnce([
				{ id: '200', databaseId: 200200200, title: 'Blocked Issue', url: 'https://github.com/owner/repo/issues/200', state: 'open' },
			])

			const result = await provider.getDependencies({
				number: '100',
				direction: 'blocking',
			})

			expect(getIssueDependencies).toHaveBeenCalledWith(100, 'blocking', undefined)
			expect(result.blocking).toHaveLength(1)
			expect(result.blocking[0].id).toBe('200')
			expect(result.blockedBy).toHaveLength(0)
		})

		it('should return blocked_by issues when direction is blocked_by', async () => {
			vi.mocked(getIssueDependencies).mockResolvedValueOnce([
				{ id: '50', databaseId: 5050505, title: 'Blocking Issue', url: 'https://github.com/owner/repo/issues/50', state: 'open' },
			])

			const result = await provider.getDependencies({
				number: '100',
				direction: 'blocked_by',
			})

			expect(getIssueDependencies).toHaveBeenCalledWith(100, 'blocked_by', undefined)
			expect(result.blockedBy).toHaveLength(1)
			expect(result.blockedBy[0].id).toBe('50')
			expect(result.blocking).toHaveLength(0)
		})

		it('should return both directions when direction is both', async () => {
			vi.mocked(getIssueDependencies)
				.mockResolvedValueOnce([
					{ id: '200', databaseId: 200200200, title: 'Blocked Issue', url: 'https://github.com/owner/repo/issues/200', state: 'open' },
				])
				.mockResolvedValueOnce([
					{ id: '50', databaseId: 5050505, title: 'Blocking Issue', url: 'https://github.com/owner/repo/issues/50', state: 'open' },
				])

			const result = await provider.getDependencies({
				number: '100',
				direction: 'both',
			})

			expect(getIssueDependencies).toHaveBeenCalledWith(100, 'blocking', undefined)
			expect(getIssueDependencies).toHaveBeenCalledWith(100, 'blocked_by', undefined)
			expect(result.blocking).toHaveLength(1)
			expect(result.blockedBy).toHaveLength(1)
		})

		it('should pass repo parameter when provided', async () => {
			vi.mocked(getIssueDependencies).mockResolvedValueOnce([])

			await provider.getDependencies({
				number: '100',
				direction: 'blocking',
				repo: 'other-owner/other-repo',
			})

			expect(getIssueDependencies).toHaveBeenCalledWith(100, 'blocking', 'other-owner/other-repo')
		})

		it('should throw error for invalid issue number', async () => {
			await expect(
				provider.getDependencies({
					number: 'invalid',
					direction: 'both',
				})
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(getIssueDependencies).not.toHaveBeenCalled()
		})
	})

	describe('removeDependency', () => {
		it('should remove dependency between two issues', async () => {
			vi.mocked(getIssueDatabaseId).mockResolvedValueOnce(123456789)
			vi.mocked(removeIssueDependency).mockResolvedValueOnce(undefined)

			await provider.removeDependency({
				blockingIssue: '100',
				blockedIssue: '200',
			})

			// Gets database ID of blocking issue (100)
			// GitHub API: DELETE /issues/{blocked}/dependencies/blocked_by with body issue_id={blocking_db_id}
			expect(getIssueDatabaseId).toHaveBeenCalledWith(100, undefined)
			// Removes dependency: path uses blocked issue (200), body uses blocking issue DB ID
			expect(removeIssueDependency).toHaveBeenCalledWith(200, 123456789, undefined)
		})

		it('should pass repo parameter when provided', async () => {
			vi.mocked(getIssueDatabaseId).mockResolvedValueOnce(987654321)
			vi.mocked(removeIssueDependency).mockResolvedValueOnce(undefined)

			await provider.removeDependency({
				blockingIssue: '50',
				blockedIssue: '60',
				repo: 'other-owner/other-repo',
			})

			// Gets database ID of blocking issue (50)
			expect(getIssueDatabaseId).toHaveBeenCalledWith(50, 'other-owner/other-repo')
			// Removes dependency: path uses blocked issue (60), body uses blocking issue DB ID
			expect(removeIssueDependency).toHaveBeenCalledWith(60, 987654321, 'other-owner/other-repo')
		})

		it('should throw error for invalid blocking issue number', async () => {
			await expect(
				provider.removeDependency({
					blockingIssue: 'invalid',
					blockedIssue: '200',
				})
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(getIssueDatabaseId).not.toHaveBeenCalled()
		})

		it('should throw error for invalid blocked issue number', async () => {
			await expect(
				provider.removeDependency({
					blockingIssue: '100',
					blockedIssue: 'invalid',
				})
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(getIssueDatabaseId).not.toHaveBeenCalled()
		})
	})

	describe('closeIssue', () => {
		it('calls closeGhIssue with correct args', async () => {
			vi.mocked(closeGhIssue).mockResolvedValueOnce(undefined)

			await provider.closeIssue({ number: '123' })

			expect(closeGhIssue).toHaveBeenCalledWith(123, undefined)
		})

		it('passes --repo when repo is provided', async () => {
			vi.mocked(closeGhIssue).mockResolvedValueOnce(undefined)

			await provider.closeIssue({ number: '456', repo: 'other-owner/other-repo' })

			expect(closeGhIssue).toHaveBeenCalledWith(456, 'other-owner/other-repo')
		})

		it('throws on invalid issue number', async () => {
			await expect(
				provider.closeIssue({ number: 'invalid' })
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(closeGhIssue).not.toHaveBeenCalled()
		})
	})

	describe('reopenIssue', () => {
		it('calls reopenGhIssue with correct args', async () => {
			vi.mocked(reopenGhIssue).mockResolvedValueOnce(undefined)

			await provider.reopenIssue({ number: '123' })

			expect(reopenGhIssue).toHaveBeenCalledWith(123, undefined)
		})

		it('passes --repo when repo is provided', async () => {
			vi.mocked(reopenGhIssue).mockResolvedValueOnce(undefined)

			await provider.reopenIssue({ number: '456', repo: 'other-owner/other-repo' })

			expect(reopenGhIssue).toHaveBeenCalledWith(456, 'other-owner/other-repo')
		})

		it('throws on invalid issue number', async () => {
			await expect(
				provider.reopenIssue({ number: 'invalid' })
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(reopenGhIssue).not.toHaveBeenCalled()
		})
	})

	describe('editIssue', () => {
		it('calls editGhIssue with title', async () => {
			vi.mocked(editGhIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: '123', title: 'New Title' })

			expect(editGhIssue).toHaveBeenCalledWith(123, { title: 'New Title' }, undefined)
		})

		it('calls editGhIssue with body', async () => {
			vi.mocked(editGhIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: '123', body: 'New Body' })

			expect(editGhIssue).toHaveBeenCalledWith(123, { body: 'New Body' }, undefined)
		})

		it('calls editGhIssue with labels', async () => {
			vi.mocked(editGhIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: '123', labels: ['bug', 'enhancement'] })

			expect(editGhIssue).toHaveBeenCalledWith(123, { labels: ['bug', 'enhancement'] }, undefined)
		})

		it('handles state change to closed via closeIssue', async () => {
			vi.mocked(closeGhIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: '123', state: 'closed' })

			expect(closeGhIssue).toHaveBeenCalledWith(123, undefined)
			expect(editGhIssue).not.toHaveBeenCalled()
		})

		it('handles state change to open via reopenIssue', async () => {
			vi.mocked(reopenGhIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: '123', state: 'open' })

			expect(reopenGhIssue).toHaveBeenCalledWith(123, undefined)
			expect(editGhIssue).not.toHaveBeenCalled()
		})

		it('handles state change with field updates', async () => {
			vi.mocked(closeGhIssue).mockResolvedValueOnce(undefined)
			vi.mocked(editGhIssue).mockResolvedValueOnce(undefined)

			await provider.editIssue({ number: '123', state: 'closed', title: 'Updated Title' })

			expect(closeGhIssue).toHaveBeenCalledWith(123, undefined)
			expect(editGhIssue).toHaveBeenCalledWith(123, { title: 'Updated Title' }, undefined)
		})

		it('throws on invalid issue number', async () => {
			await expect(
				provider.editIssue({ number: 'invalid', title: 'New Title' })
			).rejects.toThrow('Invalid GitHub issue number: invalid. GitHub issue IDs must be numeric.')

			expect(editGhIssue).not.toHaveBeenCalled()
		})
	})
})
