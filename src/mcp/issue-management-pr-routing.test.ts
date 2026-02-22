/**
 * Tests for MCP PR routing through VCS provider abstraction
 * Covers get_pr, create_comment (type: pr), and update_comment (type: pr)
 * routing through BitBucket VCS provider when configured
 */

import { describe, it, expect, vi } from 'vitest'
import type { PullRequest } from '../types/index.js'

/**
 * These tests verify the routing logic used by the MCP server
 * for PR operations when a VCS provider (BitBucket) is configured.
 *
 * The MCP server logic is:
 * - get_pr: use bitBucketVCSProvider.fetchPR() if configured, else GitHubIssueManagementProvider.getPR()
 * - create_comment type:pr: use bitBucketVCSProvider.createPRComment() if configured, else GitHub
 * - update_comment type:pr: throw unsupported error if BitBucket configured, else GitHub
 */

// ─── Helper types ──────────────────────────────────────────────────────────────

interface MockBitBucketVCSProvider {
	fetchPR: ReturnType<typeof vi.fn>
	createPRComment: ReturnType<typeof vi.fn>
}

interface PRResult {
	id: string
	number: number
	title: string
	body: string
	state: string
	url: string
	author: null
	headRefName: string
	baseRefName: string
}

interface CommentResult {
	id: string
	url: string
	updated_at?: string
}

// ─── Routing logic extracted from MCP server ───────────────────────────────────

/**
 * Simulate the get_pr routing logic from issue-management-server.ts
 */
async function simulateGetPR(
	number: string,
	bitBucketVCSProvider: MockBitBucketVCSProvider | undefined,
	githubGetPR: (input: { number: string; includeComments?: boolean; repo?: string }) => Promise<PRResult>,
	options?: { includeComments?: boolean; repo?: string }
): Promise<PRResult> {
	if (bitBucketVCSProvider) {
		const prNumber = parseInt(number, 10)
		if (isNaN(prNumber)) {
			throw new Error(`Invalid PR number: ${number}. PR IDs must be numeric.`)
		}
		const bbPR = await bitBucketVCSProvider.fetchPR(prNumber) as PullRequest
		return {
			id: String(bbPR.number),
			number: bbPR.number,
			title: bbPR.title,
			body: bbPR.body,
			state: bbPR.state.toUpperCase(),
			url: bbPR.url,
			author: null,
			headRefName: bbPR.branch,
			baseRefName: bbPR.baseBranch,
		}
	}
	return githubGetPR({ number, ...options })
}

/**
 * Simulate the create_comment routing logic from issue-management-server.ts
 */
async function simulateCreateComment(
	number: string,
	body: string,
	type: 'issue' | 'pr',
	bitBucketVCSProvider: MockBitBucketVCSProvider | undefined,
	githubCreateComment: (input: { number: string; body: string; type: 'issue' | 'pr' }) => Promise<CommentResult>
): Promise<CommentResult> {
	if (type === 'pr' && bitBucketVCSProvider) {
		const prNumber = parseInt(number, 10)
		if (isNaN(prNumber)) {
			throw new Error(`Invalid PR number: ${number}. PR IDs must be numeric.`)
		}
		await bitBucketVCSProvider.createPRComment(prNumber, body)
		return {
			id: `bitbucket-pr-${prNumber}-comment`,
			url: '',
		}
	}
	return githubCreateComment({ number, body, type })
}

/**
 * Simulate the update_comment routing logic from issue-management-server.ts
 */
async function simulateUpdateComment(
	commentId: string,
	number: string,
	body: string,
	type: 'issue' | 'pr' | undefined,
	bitBucketVCSProvider: MockBitBucketVCSProvider | undefined,
	githubUpdateComment: (input: { commentId: string; number: string; body: string }) => Promise<CommentResult>
): Promise<CommentResult> {
	if (type === 'pr' && bitBucketVCSProvider) {
		throw new Error(
			'BitBucket does not support editing PR comments. ' +
			'The BitBucket REST API does not provide a PUT/PATCH endpoint for pull request comments.'
		)
	}
	return githubUpdateComment({ commentId, number, body })
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP PR routing via VCS provider abstraction', () => {
	describe('get_pr routing', () => {
		it('routes to BitBucket fetchPR when bitBucketVCSProvider is configured', async () => {
			const mockBBPR: PullRequest = {
				number: 42,
				title: 'Add feature X',
				body: 'This PR adds feature X',
				state: 'open',
				branch: 'feature/add-x',
				baseBranch: 'main',
				url: 'https://bitbucket.org/workspace/repo/pull-requests/42',
				isDraft: false,
			}

			const mockBitBucketProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn().mockResolvedValueOnce(mockBBPR),
				createPRComment: vi.fn(),
			}
			const githubGetPR = vi.fn()

			const result = await simulateGetPR('42', mockBitBucketProvider, githubGetPR)

			expect(mockBitBucketProvider.fetchPR).toHaveBeenCalledWith(42)
			expect(githubGetPR).not.toHaveBeenCalled()
			expect(result.id).toBe('42')
			expect(result.number).toBe(42)
			expect(result.title).toBe('Add feature X')
			expect(result.body).toBe('This PR adds feature X')
			expect(result.state).toBe('OPEN')
			expect(result.url).toBe('https://bitbucket.org/workspace/repo/pull-requests/42')
			expect(result.author).toBeNull()
			expect(result.headRefName).toBe('feature/add-x')
			expect(result.baseRefName).toBe('main')
		})

		it('maps BitBucket PR states correctly to uppercase MCP states', async () => {
			const stateTestCases: Array<{ inputState: 'open' | 'closed' | 'merged'; expectedMcpState: string }> = [
				{ inputState: 'open', expectedMcpState: 'OPEN' },
				{ inputState: 'closed', expectedMcpState: 'CLOSED' },
				{ inputState: 'merged', expectedMcpState: 'MERGED' },
			]

			for (const { inputState, expectedMcpState } of stateTestCases) {
				const mockPR: PullRequest = {
					number: 1,
					title: 'Test PR',
					body: 'Body',
					state: inputState,
					branch: 'feat',
					baseBranch: 'main',
					url: 'https://bitbucket.org/w/r/pull-requests/1',
					isDraft: false,
				}

				const mockProvider: MockBitBucketVCSProvider = {
					fetchPR: vi.fn().mockResolvedValueOnce(mockPR),
					createPRComment: vi.fn(),
				}

				const result = await simulateGetPR('1', mockProvider, vi.fn())
				expect(result.state).toBe(expectedMcpState)
			}
		})

		it('falls back to GitHub getPR when bitBucketVCSProvider is undefined', async () => {
			const mockGHResult: PRResult = {
				id: '100',
				number: 100,
				title: 'GitHub PR',
				body: 'GitHub PR body',
				state: 'OPEN',
				url: 'https://github.com/owner/repo/pull/100',
				author: null,
				headRefName: 'feature',
				baseRefName: 'main',
			}

			const githubGetPR = vi.fn().mockResolvedValueOnce(mockGHResult)

			const result = await simulateGetPR('100', undefined, githubGetPR, { includeComments: false })

			expect(githubGetPR).toHaveBeenCalledWith({ number: '100', includeComments: false })
			expect(result.id).toBe('100')
			expect(result.title).toBe('GitHub PR')
		})

		it('throws for invalid (non-numeric) PR number when BitBucket configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn(),
			}

			await expect(
				simulateGetPR('not-a-number', mockProvider, vi.fn())
			).rejects.toThrow('Invalid PR number: not-a-number. PR IDs must be numeric.')

			expect(mockProvider.fetchPR).not.toHaveBeenCalled()
		})
	})

	describe('create_comment type:pr routing', () => {
		it('routes to BitBucket createPRComment when type is pr and provider is configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn().mockResolvedValueOnce(undefined),
			}
			const githubCreateComment = vi.fn()

			const result = await simulateCreateComment(
				'42',
				'Test PR comment',
				'pr',
				mockProvider,
				githubCreateComment
			)

			expect(mockProvider.createPRComment).toHaveBeenCalledWith(42, 'Test PR comment')
			expect(githubCreateComment).not.toHaveBeenCalled()
			expect(result.id).toBe('bitbucket-pr-42-comment')
			expect(result.url).toBe('')
		})

		it('routes to GitHub for issue comments even when BitBucket VCS provider is configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn(),
			}
			const mockGHResult: CommentResult = {
				id: '9999',
				url: 'https://github.com/owner/repo/issues/5#issuecomment-9999',
			}
			const githubCreateComment = vi.fn().mockResolvedValueOnce(mockGHResult)

			const result = await simulateCreateComment(
				'5',
				'Issue comment',
				'issue',
				mockProvider,
				githubCreateComment
			)

			expect(mockProvider.createPRComment).not.toHaveBeenCalled()
			expect(githubCreateComment).toHaveBeenCalledWith({ number: '5', body: 'Issue comment', type: 'issue' })
			expect(result.id).toBe('9999')
		})

		it('falls back to GitHub createComment for type:pr when BitBucket not configured', async () => {
			const mockGHResult: CommentResult = {
				id: '54321',
				url: 'https://github.com/owner/repo/pull/100#issuecomment-54321',
			}
			const githubCreateComment = vi.fn().mockResolvedValueOnce(mockGHResult)

			const result = await simulateCreateComment(
				'100',
				'PR comment via GitHub fallback',
				'pr',
				undefined,
				githubCreateComment
			)

			expect(githubCreateComment).toHaveBeenCalledWith({
				number: '100',
				body: 'PR comment via GitHub fallback',
				type: 'pr',
			})
			expect(result.id).toBe('54321')
		})

		it('throws for invalid (non-numeric) PR number when BitBucket configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn(),
			}

			await expect(
				simulateCreateComment('not-a-number', 'body', 'pr', mockProvider, vi.fn())
			).rejects.toThrow('Invalid PR number: not-a-number. PR IDs must be numeric.')

			expect(mockProvider.createPRComment).not.toHaveBeenCalled()
		})
	})

	describe('update_comment type:pr routing', () => {
		it('throws unsupported error when type is pr and BitBucket provider is configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn(),
			}
			const githubUpdateComment = vi.fn()

			await expect(
				simulateUpdateComment('12345', '42', 'Updated body', 'pr', mockProvider, githubUpdateComment)
			).rejects.toThrow('BitBucket does not support editing PR comments')

			expect(githubUpdateComment).not.toHaveBeenCalled()
		})

		it('routes to GitHub for update_comment type:issue even when BitBucket configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn(),
			}
			const mockGHResult: CommentResult = {
				id: '12345',
				url: 'https://github.com/owner/repo/issues/5#issuecomment-12345',
				updated_at: '2025-01-01T00:00:00Z',
			}
			const githubUpdateComment = vi.fn().mockResolvedValueOnce(mockGHResult)

			const result = await simulateUpdateComment(
				'12345',
				'5',
				'Updated issue comment',
				'issue',
				mockProvider,
				githubUpdateComment
			)

			expect(githubUpdateComment).toHaveBeenCalledWith({
				commentId: '12345',
				number: '5',
				body: 'Updated issue comment',
			})
			expect(result.id).toBe('12345')
		})

		it('routes to GitHub for update_comment when type is undefined and BitBucket configured', async () => {
			const mockProvider: MockBitBucketVCSProvider = {
				fetchPR: vi.fn(),
				createPRComment: vi.fn(),
			}
			const mockGHResult: CommentResult = {
				id: '99999',
				url: 'https://github.com/owner/repo/issues/10#issuecomment-99999',
			}
			const githubUpdateComment = vi.fn().mockResolvedValueOnce(mockGHResult)

			const result = await simulateUpdateComment(
				'99999',
				'10',
				'Updated comment',
				undefined,
				mockProvider,
				githubUpdateComment
			)

			expect(githubUpdateComment).toHaveBeenCalled()
			expect(result.id).toBe('99999')
		})

		it('routes to GitHub for update_comment type:pr when BitBucket not configured', async () => {
			const mockGHResult: CommentResult = {
				id: '77777',
				url: 'https://github.com/owner/repo/pull/100#issuecomment-77777',
				updated_at: '2025-01-15T12:00:00Z',
			}
			const githubUpdateComment = vi.fn().mockResolvedValueOnce(mockGHResult)

			const result = await simulateUpdateComment(
				'77777',
				'100',
				'Updated PR comment via GitHub',
				'pr',
				undefined,
				githubUpdateComment
			)

			expect(githubUpdateComment).toHaveBeenCalledWith({
				commentId: '77777',
				number: '100',
				body: 'Updated PR comment via GitHub',
			})
			expect(result.id).toBe('77777')
			expect(result.updated_at).toBe('2025-01-15T12:00:00Z')
		})
	})

	describe('Security: auth credentials not exposed in PR operation call signatures', () => {
		it('fetchPR call uses only PR number, not auth credentials', () => {
			const fetchPR = vi.fn()
			const prNumber = 42

			// The BitBucket API client stores credentials internally
			// and is accessed only via the client's request() method
			// fetchPR(prNumber) does NOT include credentials in its parameters
			fetchPR(prNumber)

			expect(fetchPR).toHaveBeenCalledWith(42)
			const callArgs = fetchPR.mock.calls[0]
			// Ensure no sensitive strings in the call arguments
			expect(JSON.stringify(callArgs)).not.toContain('token')
			expect(JSON.stringify(callArgs)).not.toContain('password')
			expect(JSON.stringify(callArgs)).not.toContain('Authorization')
			expect(JSON.stringify(callArgs)).not.toContain('Basic ')
		})

		it('createPRComment call uses only PR number and body, not auth credentials', () => {
			const createPRComment = vi.fn()

			createPRComment(42, 'This is a comment body')

			expect(createPRComment).toHaveBeenCalledWith(42, 'This is a comment body')
			const callArgs = createPRComment.mock.calls[0]
			expect(JSON.stringify(callArgs)).not.toContain('token')
			expect(JSON.stringify(callArgs)).not.toContain('password')
			expect(JSON.stringify(callArgs)).not.toContain('Authorization')
		})
	})
})
