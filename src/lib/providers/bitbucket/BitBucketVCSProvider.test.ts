import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BitBucketVCSProvider, type BitBucketVCSConfig } from './BitBucketVCSProvider.js'
import { BitBucketApiClient } from './BitBucketApiClient.js'

// Mock the BitBucketApiClient
vi.mock('./BitBucketApiClient.js', () => ({
	BitBucketApiClient: vi.fn().mockImplementation(() => ({
		getWorkspace: vi.fn().mockReturnValue('test-workspace'),
		getRepoSlug: vi.fn().mockReturnValue('test-repo'),
		createPullRequest: vi.fn(),
		findUsersByUsername: vi.fn(),
		getCurrentUser: vi.fn(),
		listPullRequests: vi.fn(),
		getPullRequest: vi.fn(),
		addPRComment: vi.fn(),
		updatePRComment: vi.fn(),
		listPRComments: vi.fn(),
		addInlinePRComment: vi.fn(),
	})),
}))

// Mock the logger
vi.mock('../../../utils/logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

// Mock the remote parser
vi.mock('../../../utils/remote.js', () => ({
	parseGitRemotes: vi.fn().mockResolvedValue([]),
}))

describe('BitBucketVCSProvider', () => {
	let provider: BitBucketVCSProvider
	let mockClient: {
		getWorkspace: ReturnType<typeof vi.fn>
		getRepoSlug: ReturnType<typeof vi.fn>
		createPullRequest: ReturnType<typeof vi.fn>
		findUsersByUsername: ReturnType<typeof vi.fn>
		getCurrentUser: ReturnType<typeof vi.fn>
		listPullRequests: ReturnType<typeof vi.fn>
		getPullRequest: ReturnType<typeof vi.fn>
		addPRComment: ReturnType<typeof vi.fn>
		updatePRComment: ReturnType<typeof vi.fn>
		listPRComments: ReturnType<typeof vi.fn>
		addInlinePRComment: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		// Get the mock client instance
		mockClient = {
			getWorkspace: vi.fn().mockReturnValue('test-workspace'),
			getRepoSlug: vi.fn().mockReturnValue('test-repo'),
			createPullRequest: vi.fn(),
			findUsersByUsername: vi.fn(),
			getCurrentUser: vi.fn().mockResolvedValue({
				account_id: 'acc-current-user',
				display_name: 'Current User',
				nickname: 'currentuser',
			}),
			listPullRequests: vi.fn(),
			getPullRequest: vi.fn(),
			addPRComment: vi.fn(),
			updatePRComment: vi.fn(),
			listPRComments: vi.fn(),
			addInlinePRComment: vi.fn(),
		}
		vi.mocked(BitBucketApiClient).mockImplementation(() => mockClient as unknown as BitBucketApiClient)
	})

	describe('createPR with reviewers', () => {
		it('should resolve reviewer usernames and pass account IDs to createPullRequest', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['alice', 'bob'],
			}
			provider = new BitBucketVCSProvider(config)

			// Mock username resolution
			mockClient.findUsersByUsername.mockResolvedValue(
				new Map([
					['alice', 'acc-alice'],
					['bob', 'acc-bob'],
				])
			)

			// Mock PR creation
			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				description: 'Test body',
				state: 'OPEN',
				author: { display_name: 'Test', uuid: 'uuid' },
				source: { branch: { name: 'feature' } },
				destination: { branch: { name: 'main' } },
				created_on: '2024-01-01',
				updated_on: '2024-01-01',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			const result = await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// Verify findUsersByUsername was called with the configured usernames
			expect(mockClient.findUsersByUsername).toHaveBeenCalledWith(
				'test-workspace',
				['alice', 'bob']
			)

			// Verify createPullRequest was called with resolved account IDs
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				['acc-alice', 'acc-bob']
			)

			expect(result).toEqual({
				url: 'https://bitbucket.org/test/pr/123',
				number: 123,
				wasExisting: false,
			})
		})

		it('should continue with partial reviewers when some usernames cannot be resolved', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['alice', 'unknown_user'],
			}
			provider = new BitBucketVCSProvider(config)

			// Only alice resolves
			mockClient.findUsersByUsername.mockResolvedValue(
				new Map([['alice', 'acc-alice']])
			)

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// Should only pass the resolved reviewer
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				['acc-alice']
			)
		})

		it('should not pass reviewers when no usernames can be resolved', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['unknown_user'],
			}
			provider = new BitBucketVCSProvider(config)

			// No usernames resolve
			mockClient.findUsersByUsername.mockResolvedValue(new Map())

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// Should pass empty array for reviewers
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				[]
			)
		})

		it('should not resolve reviewers when none are configured', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				// No reviewers configured
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// findUsersByUsername should not be called
			expect(mockClient.findUsersByUsername).not.toHaveBeenCalled()

			// createPullRequest should be called without reviewers
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				undefined
			)
		})

		it('should not resolve reviewers when array is empty', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: [],
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// findUsersByUsername should not be called
			expect(mockClient.findUsersByUsername).not.toHaveBeenCalled()

			// createPullRequest should be called without reviewers
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				undefined
			)
		})

		it('should filter out the current user from reviewers list', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['alice', 'currentuser'], // currentuser is the PR author
			}
			provider = new BitBucketVCSProvider(config)

			// Current user has account_id 'acc-current-user' (set in beforeEach)
			mockClient.findUsersByUsername.mockResolvedValue(
				new Map([
					['alice', 'acc-alice'],
					['currentuser', 'acc-current-user'], // Same as current user
				])
			)

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// getCurrentUser should be called to get the current user's account ID
			expect(mockClient.getCurrentUser).toHaveBeenCalled()

			// createPullRequest should be called with only alice (current user filtered out)
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				['acc-alice']
			)
		})

		it('should pass all reviewers when current user is not in the list', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['alice', 'bob'],
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.findUsersByUsername.mockResolvedValue(
				new Map([
					['alice', 'acc-alice'],
					['bob', 'acc-bob'],
				])
			)

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// All reviewers should be passed (none filtered)
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				['acc-alice', 'acc-bob']
			)
		})

		it('should pass empty array when current user is the only reviewer', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['currentuser'],
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.findUsersByUsername.mockResolvedValue(
				new Map([['currentuser', 'acc-current-user']])
			)

			mockClient.createPullRequest.mockResolvedValue({
				id: 123,
				title: 'Test PR',
				links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
			})

			await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			// createPullRequest should be called with empty array (current user filtered out)
			expect(mockClient.createPullRequest).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				'Test PR',
				'Test body',
				'feature',
				'main',
				[]
			)
		})
	})

	describe('checkForExistingPR', () => {
		it('should return existing PR when found', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPullRequests.mockResolvedValue([
				{
					id: 42,
					links: { html: { href: 'https://bitbucket.org/test/repo/pull-requests/42' } },
				},
			])

			const result = await provider.checkForExistingPR('feature-branch')

			expect(result).toEqual({
				number: 42,
				url: 'https://bitbucket.org/test/repo/pull-requests/42',
			})
		})

		it('should return null when no PR exists', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPullRequests.mockResolvedValue([])

			const result = await provider.checkForExistingPR('feature-branch')

			expect(result).toBeNull()
		})

		it('should propagate 401 authentication errors', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPullRequests.mockRejectedValue(
				new Error('BitBucket API error (401): Unauthorized')
			)

			await expect(provider.checkForExistingPR('feature-branch')).rejects.toThrow(
				'BitBucket API error (401)'
			)
		})

		it('should propagate 403 forbidden errors', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPullRequests.mockRejectedValue(
				new Error('BitBucket API error (403): Forbidden')
			)

			await expect(provider.checkForExistingPR('feature-branch')).rejects.toThrow(
				'BitBucket API error (403)'
			)
		})

		it('should return null for network/other errors', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPullRequests.mockRejectedValue(
				new Error('BitBucket API request failed: ECONNREFUSED')
			)

			const result = await provider.checkForExistingPR('feature-branch')

			expect(result).toBeNull()
		})

		it('should return null for non-Error thrown values', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPullRequests.mockRejectedValue('string error')

			const result = await provider.checkForExistingPR('feature-branch')

			expect(result).toBeNull()
		})
	})

	describe('createPR return type', () => {
		it('should return PRCreationResult with url, number, and wasExisting', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.createPullRequest.mockResolvedValue({
				id: 42,
				title: 'Test PR',
				description: 'Test body',
				state: 'OPEN',
				author: { display_name: 'Test', uuid: 'uuid' },
				source: { branch: { name: 'feature' } },
				destination: { branch: { name: 'main' } },
				created_on: '2024-01-01',
				updated_on: '2024-01-01',
				links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/42' } },
			})

			const result = await provider.createPR('feature', 'Test PR', 'Test body', 'main')

			expect(result).toEqual({
				url: 'https://bitbucket.org/ws/repo/pull-requests/42',
				number: 42,
				wasExisting: false,
			})
		})
	})

	describe('createPRComment', () => {
		it('should return { id, url } from API response', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.addPRComment.mockResolvedValue({
				id: 456,
				content: { raw: 'Test comment' },
				links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-456' } },
			})

			const result = await provider.createPRComment(1, 'Test comment')

			expect(mockClient.addPRComment).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				1,
				'Test comment'
			)
			expect(result).toEqual({
				id: '456',
				url: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-456',
			})
		})
	})

	describe('updatePRComment', () => {
		it('should delegate to client.updatePRComment and return { id, url }', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.updatePRComment.mockResolvedValue({
				id: 789,
				content: { raw: 'Updated comment' },
				links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/5#comment-789' } },
			})

			const result = await provider.updatePRComment(5, '789', 'Updated comment')

			expect(mockClient.updatePRComment).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				5,
				789,
				'Updated comment'
			)
			expect(result).toEqual({
				id: '789',
				url: 'https://bitbucket.org/ws/repo/pull-requests/5#comment-789',
			})
		})
	})

	describe('updatePRComment - validation', () => {
		it('should throw when commentId is not a valid number', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			await expect(
				provider.updatePRComment(5, 'not-a-number', 'Updated comment')
			).rejects.toThrow('Invalid comment ID "not-a-number": expected a numeric value')
		})
	})

	describe('getReviewComments', () => {
		it('should call listPRComments and filter for inline comments', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPRComments.mockResolvedValue([
				{
					id: 100,
					content: { raw: 'General comment' },
					links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-100' } },
					user: { display_name: 'Alice', uuid: '{uuid-alice}' },
					created_on: '2024-01-01T00:00:00Z',
					updated_on: '2024-01-02T00:00:00Z',
					// No inline property -- this is a general comment
				},
				{
					id: 200,
					content: { raw: 'Inline comment on line 10' },
					inline: { from: null, to: 10, path: 'src/index.ts' },
					links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-200' } },
					user: { display_name: 'Bob', uuid: '{uuid-bob}' },
					created_on: '2024-01-03T00:00:00Z',
					updated_on: undefined,
				},
				{
					id: 300,
					content: { raw: 'Another inline comment' },
					inline: { from: 5, to: 15, path: 'src/utils.ts' },
					links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-300' } },
					user: null,
					created_on: '2024-01-04T00:00:00Z',
					updated_on: '2024-01-05T00:00:00Z',
				},
			])

			const result = await provider.getReviewComments(1)

			expect(mockClient.listPRComments).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				1
			)

			// Only inline comments should be returned
			expect(result).toHaveLength(2)
			expect(result[0]).toEqual({
				id: '200',
				body: 'Inline comment on line 10',
				path: 'src/index.ts',
				line: 10,
				side: null,
				author: { id: '{uuid-bob}', displayName: 'Bob' },
				createdAt: '2024-01-03T00:00:00Z',
				updatedAt: null,
				inReplyToId: null,
			})
			expect(result[1]).toEqual({
				id: '300',
				body: 'Another inline comment',
				path: 'src/utils.ts',
				line: 15,
				side: null,
				author: null,
				createdAt: '2024-01-04T00:00:00Z',
				updatedAt: '2024-01-05T00:00:00Z',
				inReplyToId: null,
			})
		})

		it('should fall back to inline.from when inline.to is null', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPRComments.mockResolvedValue([
				{
					id: 400,
					content: { raw: 'Comment with only from' },
					inline: { from: 7, to: null, path: 'src/deleted.ts' },
					links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-400' } },
					user: { display_name: 'Alice', uuid: '{uuid-alice}' },
					created_on: '2024-01-06T00:00:00Z',
					updated_on: undefined,
				},
			])

			const result = await provider.getReviewComments(1)

			expect(result).toHaveLength(1)
			expect(result[0]?.line).toBe(7)
		})

		it('should return null for line when both inline.to and inline.from are null', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPRComments.mockResolvedValue([
				{
					id: 500,
					content: { raw: 'Comment with no line info' },
					inline: { from: null, to: null, path: 'src/file.ts' },
					links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-500' } },
					user: { display_name: 'Alice', uuid: '{uuid-alice}' },
					created_on: '2024-01-07T00:00:00Z',
					updated_on: undefined,
				},
			])

			const result = await provider.getReviewComments(1)

			expect(result).toHaveLength(1)
			expect(result[0]?.line).toBeNull()
		})

		it('should return empty array when no inline comments exist', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.listPRComments.mockResolvedValue([
				{
					id: 100,
					content: { raw: 'General comment' },
					links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-100' } },
				},
			])

			const result = await provider.getReviewComments(1)

			expect(result).toHaveLength(0)
		})
	})

	describe('createReviewComment', () => {
		it('should delegate to client.addInlinePRComment', async () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)

			mockClient.addInlinePRComment.mockResolvedValue({
				id: 999,
				content: { raw: 'Review comment on line 42' },
				inline: { from: null, to: 42, path: 'src/main.ts' },
				links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/3#comment-999' } },
			})

			const result = await provider.createReviewComment(3, 'src/main.ts', 42, 'Review comment on line 42')

			expect(mockClient.addInlinePRComment).toHaveBeenCalledWith(
				'test-workspace',
				'test-repo',
				3,
				'Review comment on line 42',
				'src/main.ts',
				42
			)
			expect(result).toEqual({
				id: '999',
				url: 'https://bitbucket.org/ws/repo/pull-requests/3#comment-999',
			})
		})
	})

	describe('provider properties', () => {
		it('should have correct provider name', () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)
			expect(provider.providerName).toBe('bitbucket')
		})

		it('should not support draft PRs', () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)
			expect(provider.supportsDraftPRs).toBe(false)
		})

		it('should support forks', () => {
			const config: BitBucketVCSConfig = {
				username: 'testuser',
				apiToken: 'test-token',
			}
			provider = new BitBucketVCSProvider(config)
			expect(provider.supportsForks).toBe(true)
		})
	})
})
