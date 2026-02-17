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

			const url = await provider.createPR('feature', 'Test PR', 'Test body', 'main')

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

			expect(url).toBe('https://bitbucket.org/test/pr/123')
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
