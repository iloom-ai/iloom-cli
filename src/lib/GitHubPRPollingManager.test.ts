import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { GitHubPRPollingManager } from './GitHubPRPollingManager.js'
import type { LoomMetadata, MetadataManager } from './MetadataManager.js'
import * as githubUtils from '../utils/github.js'
import * as remoteUtils from '../utils/remote.js'
import type { FinishTriggerResult } from '../types/remote.js'

// Mock external dependencies
vi.mock('../utils/github.js', () => ({
	executeGhCommand: vi.fn(),
}))

vi.mock('../utils/remote.js', () => ({
	parseGitRemotes: vi.fn(),
}))

// Helper to create mock loom metadata
function createMockLoom(overrides: Partial<LoomMetadata> = {}): LoomMetadata {
	return {
		description: 'Test loom',
		created_at: '2024-01-01T00:00:00Z',
		branchName: 'feature/test',
		worktreePath: '/path/to/worktree',
		issueType: 'pr',
		issue_numbers: [],
		pr_numbers: ['123'],
		issueTracker: 'github',
		colorHex: '#dcebff',
		sessionId: 'session-123',
		projectPath: '/path/to/project',
		issueUrls: {},
		prUrls: {},
		draftPrNumber: null,
		capabilities: [],
		parentLoom: null,
		...overrides,
	}
}

describe('GitHubPRPollingManager', () => {
	let mockMetadataManager: Partial<MetadataManager>
	let mockFinishFn: Mock<(prNumber: string, projectPath: string) => Promise<FinishTriggerResult>>

	beforeEach(() => {
		mockMetadataManager = {
			listAllMetadata: vi.fn(),
		}
		mockFinishFn = vi.fn()
	})

	describe('checkPRState()', () => {
		it('should return open state for open PR', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'OPEN',
				merged: false,
			})

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.checkPRState(123, 'owner/repo')

			expect(result.state).toBe('open')
			expect(result.prNumber).toBe(123)
			expect(result.repo).toBe('owner/repo')
			expect(result.error).toBeUndefined()

			expect(githubUtils.executeGhCommand).toHaveBeenCalledWith([
				'pr',
				'view',
				'123',
				'--repo',
				'owner/repo',
				'--json',
				'state,merged',
			])
		})

		it('should return closed state for closed PR', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'CLOSED',
				merged: false,
			})

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.checkPRState(456, 'owner/repo')

			expect(result.state).toBe('closed')
			expect(result.prNumber).toBe(456)
		})

		it('should return merged state for merged PR', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'MERGED',
				merged: true,
			})

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.checkPRState(789, 'owner/repo')

			expect(result.state).toBe('merged')
			expect(result.prNumber).toBe(789)
		})

		it('should return merged state when merged=true regardless of state field', async () => {
			// Edge case: GitHub sometimes returns state=CLOSED with merged=true
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'CLOSED',
				merged: true,
			})

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.checkPRState(101, 'owner/repo')

			expect(result.state).toBe('merged')
		})

		it('should handle gh CLI errors gracefully and default to open', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
				new Error('Could not resolve to a PullRequest')
			)

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.checkPRState(999, 'owner/repo')

			// Should default to 'open' on error to prevent accidental finish
			expect(result.state).toBe('open')
			expect(result.error).toBe('Could not resolve to a PullRequest')
		})
	})

	describe('extractRepoFromProjectPath()', () => {
		it('should extract repo from origin remote', async () => {
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
				{ name: 'upstream', url: 'git@github.com:other/repo.git', owner: 'other', repo: 'repo' },
			])

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.extractRepoFromProjectPath('/path/to/project')

			expect(result).toBe('owner/repo')
			expect(remoteUtils.parseGitRemotes).toHaveBeenCalledWith('/path/to/project')
		})

		it('should fall back to first remote if no origin', async () => {
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'upstream', url: 'git@github.com:other/repo.git', owner: 'other', repo: 'repo' },
			])

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.extractRepoFromProjectPath('/path/to/project')

			expect(result).toBe('other/repo')
		})

		it('should return null if no remotes found', async () => {
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([])

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.extractRepoFromProjectPath('/path/to/project')

			expect(result).toBeNull()
		})

		it('should return null on git errors', async () => {
			vi.mocked(remoteUtils.parseGitRemotes).mockRejectedValueOnce(
				new Error('not a git repository')
			)

			const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
			const result = await manager.extractRepoFromProjectPath('/not/a/repo')

			expect(result).toBeNull()
		})
	})

	describe('triggerFinish()', () => {
		it('should call custom finish function when provided', async () => {
			mockFinishFn.mockResolvedValueOnce({
				success: true,
				skipped: false,
				prNumber: 123,
				loomId: '123',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.triggerFinish('123', '/path/to/project')

			expect(result.success).toBe(true)
			expect(result.skipped).toBe(false)
			expect(mockFinishFn).toHaveBeenCalledWith('123', '/path/to/project')
		})

		it('should return skipped result when finish function returns skipped', async () => {
			mockFinishFn.mockResolvedValueOnce({
				success: false,
				skipped: true,
				skipReason: 'Uncommitted changes detected',
				prNumber: 456,
				loomId: '456',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.triggerFinish('456', '/path/to/project')

			expect(result.success).toBe(false)
			expect(result.skipped).toBe(true)
			expect(result.skipReason).toBe('Uncommitted changes detected')
		})

		it('should return error result when finish function fails', async () => {
			mockFinishFn.mockResolvedValueOnce({
				success: false,
				skipped: false,
				error: 'Finish failed',
				prNumber: 789,
				loomId: '789',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.triggerFinish('789', '/path/to/project')

			expect(result.success).toBe(false)
			expect(result.skipped).toBe(false)
			expect(result.error).toBe('Finish failed')
		})
	})

	describe('pollAndCleanup()', () => {
		it('should return empty result when no looms with PRs exist', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([])

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(0)
			expect(result.cleaned).toBe(0)
			expect(result.skipped).toBe(0)
			expect(result.errors).toEqual([])
			expect(result.timestamp).toBeInstanceOf(Date)
		})

		it('should skip looms without pr_numbers', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: [] }),
				createMockLoom({ pr_numbers: undefined as unknown as string[] }),
			])

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(0)
			expect(mockFinishFn).not.toHaveBeenCalled()
		})

		it('should skip looms without projectPath', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ projectPath: null }),
			])

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(0)
		})

		it('should check PR state for looms with PRs', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'OPEN',
				merged: false,
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(0)
			expect(mockFinishFn).not.toHaveBeenCalled() // PR still open
		})

		it('should trigger finish for closed PRs', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'CLOSED',
				merged: false,
			})
			mockFinishFn.mockResolvedValueOnce({
				success: true,
				skipped: false,
				prNumber: 123,
				loomId: '123',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(1)
			expect(mockFinishFn).toHaveBeenCalledWith('123', '/path/to/project')
		})

		it('should trigger finish for merged PRs', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['456'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'MERGED',
				merged: true,
			})
			mockFinishFn.mockResolvedValueOnce({
				success: true,
				skipped: false,
				prNumber: 456,
				loomId: '456',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(1)
		})

		it('should handle multiple looms for the same PR', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({
					pr_numbers: ['123'],
					projectPath: '/path/to/project1',
					worktreePath: '/path/to/worktree1',
				}),
				createMockLoom({
					pr_numbers: ['123'],
					projectPath: '/path/to/project1', // Same project
					worktreePath: '/path/to/worktree2',
				}),
			])
			// Both looms resolve to same repo
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValue([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			// Only one API call needed for the PR
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'CLOSED',
				merged: false,
			})
			mockFinishFn.mockResolvedValue({
				success: true,
				skipped: false,
				prNumber: 123,
				loomId: '123',
				projectPath: '/path/to/project1',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			// Only 1 unique PR checked, but finish called twice (once per loom)
			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(2)
			expect(mockFinishFn).toHaveBeenCalledTimes(2)
		})

		it('should count skipped finishes correctly', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'CLOSED',
				merged: false,
			})
			mockFinishFn.mockResolvedValueOnce({
				success: false,
				skipped: true,
				skipReason: 'Uncommitted changes',
				prNumber: 123,
				loomId: '123',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(0)
			expect(result.skipped).toBe(1)
		})

		it('should collect errors from failed finishes', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				state: 'CLOSED',
				merged: false,
			})
			mockFinishFn.mockResolvedValueOnce({
				success: false,
				skipped: false,
				error: 'Finish operation failed',
				prNumber: 123,
				loomId: '123',
				projectPath: '/path/to/project',
			})

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(0)
			expect(result.errors).toContain('Finish operation failed')
		})

		it('should handle PR check errors gracefully', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
				new Error('Network timeout')
			)

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			// PR check failed but polling continues
			expect(result.checked).toBe(1)
			expect(result.cleaned).toBe(0)
			// No finish triggered when PR state check fails (defaults to open)
			expect(mockFinishFn).not.toHaveBeenCalled()
		})

		it('should skip looms where repo cannot be determined', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([])

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			// No PRs to check because repo couldn't be determined
			expect(result.checked).toBe(0)
			expect(mockFinishFn).not.toHaveBeenCalled()
		})
	})

	describe('getUniquePRs (via pollAndCleanup)', () => {
		it('should deduplicate PRs across multiple looms', async () => {
			vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
				createMockLoom({
					pr_numbers: ['123', '456'],
					projectPath: '/path/to/project',
				}),
				createMockLoom({
					pr_numbers: ['123'], // Same PR as first loom
					projectPath: '/path/to/project',
				}),
			])
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValue([
				{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			// Two unique PRs: 123 and 456
			vi.mocked(githubUtils.executeGhCommand)
				.mockResolvedValueOnce({ state: 'OPEN', merged: false })
				.mockResolvedValueOnce({ state: 'OPEN', merged: false })

			const manager = new GitHubPRPollingManager({
				metadataManager: mockMetadataManager as MetadataManager,
				finishFn: mockFinishFn,
			})

			const result = await manager.pollAndCleanup()

			// Should check 2 unique PRs, not 3
			expect(result.checked).toBe(2)
			expect(githubUtils.executeGhCommand).toHaveBeenCalledTimes(2)
		})
	})

	describe('Rate Limit Backoff', () => {
		describe('isRateLimitError()', () => {
			it('should detect "rate limit" in error message', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				const error = new Error('API rate limit exceeded for user')
				expect(manager.isRateLimitError(error)).toBe(true)
			})

			it('should detect "secondary rate limit" in error message', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				const error = new Error('You have triggered a secondary rate limit')
				expect(manager.isRateLimitError(error)).toBe(true)
			})

			it('should detect rate limit in stderr', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				const error = Object.assign(new Error('Command failed'), {
					stderr: 'API rate limit exceeded',
				})
				expect(manager.isRateLimitError(error)).toBe(true)
			})

			it('should detect 403 with limit message', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				const error = Object.assign(new Error('HTTP 403: rate limit exceeded'), {
					stderr: '',
				})
				expect(manager.isRateLimitError(error)).toBe(true)
			})

			it('should detect "too many requests" error', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				const error = new Error('Too many requests')
				expect(manager.isRateLimitError(error)).toBe(true)
			})

			it('should detect "abuse detection" error', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				const error = new Error('You have triggered an abuse detection mechanism')
				expect(manager.isRateLimitError(error)).toBe(true)
			})

			it('should return false for non-rate-limit errors', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				expect(manager.isRateLimitError(new Error('Network timeout'))).toBe(false)
				expect(manager.isRateLimitError(new Error('Not found'))).toBe(false)
				expect(manager.isRateLimitError(new Error('Permission denied'))).toBe(false)
			})

			it('should return false for non-Error values', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				expect(manager.isRateLimitError('string error')).toBe(false)
				expect(manager.isRateLimitError(null)).toBe(false)
				expect(manager.isRateLimitError(undefined)).toBe(false)
				expect(manager.isRateLimitError(123)).toBe(false)
			})
		})

		describe('recordRateLimitError()', () => {
			it('should set backoff state on first error', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				manager.recordRateLimitError()

				const state = manager.getBackoffState()
				expect(state.isBackingOff).toBe(true)
				expect(state.consecutiveFailures).toBe(1)
				expect(state.currentBackoffSeconds).toBe(60) // Base backoff
				expect(state.backoffUntil).toBeInstanceOf(Date)
			})

			it('should use exponential backoff for consecutive errors', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				// First error: 60 seconds
				manager.recordRateLimitError()
				expect(manager.getBackoffState().currentBackoffSeconds).toBe(60)

				// Second error: 120 seconds (60 * 2)
				manager.recordRateLimitError()
				expect(manager.getBackoffState().currentBackoffSeconds).toBe(120)

				// Third error: 240 seconds (60 * 4)
				manager.recordRateLimitError()
				expect(manager.getBackoffState().currentBackoffSeconds).toBe(240)

				// Fourth error: 480 seconds (60 * 8)
				manager.recordRateLimitError()
				expect(manager.getBackoffState().currentBackoffSeconds).toBe(480)
			})

			it('should cap backoff at maximum (30 minutes)', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				// Simulate many consecutive errors
				for (let i = 0; i < 15; i++) {
					manager.recordRateLimitError()
				}

				const state = manager.getBackoffState()
				expect(state.currentBackoffSeconds).toBe(1800) // 30 minutes max
				expect(state.consecutiveFailures).toBe(15)
			})
		})

		describe('recordSuccess()', () => {
			it('should reset backoff state on success', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				// Simulate rate limit errors
				manager.recordRateLimitError()
				manager.recordRateLimitError()
				manager.recordRateLimitError()

				expect(manager.getBackoffState().consecutiveFailures).toBe(3)
				expect(manager.getBackoffState().isBackingOff).toBe(true)

				// Success should reset
				manager.recordSuccess()

				const state = manager.getBackoffState()
				expect(state.isBackingOff).toBe(false)
				expect(state.consecutiveFailures).toBe(0)
				expect(state.backoffUntil).toBeNull()
				expect(state.currentBackoffSeconds).toBe(0)
			})

			it('should be idempotent when not in backoff', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				manager.recordSuccess()
				manager.recordSuccess()

				const state = manager.getBackoffState()
				expect(state.isBackingOff).toBe(false)
				expect(state.consecutiveFailures).toBe(0)
			})
		})

		describe('isInBackoffPeriod()', () => {
			it('should return false when not in backoff', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				expect(manager.isInBackoffPeriod()).toBe(false)
			})

			it('should return true when in active backoff period', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				manager.recordRateLimitError()

				expect(manager.isInBackoffPeriod()).toBe(true)
			})

			it('should return false when backoff period has expired', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				// Directly set backoff state to simulate expired backoff
				// This avoids test isolation issues with mocking
				const backoffState = {
					isBackingOff: true,
					consecutiveFailures: 1,
					backoffUntil: new Date(Date.now() - 1000), // In the past
					currentBackoffSeconds: 60,
				};
				(manager as unknown as { backoffState: typeof backoffState }).backoffState = backoffState

				expect(manager.isInBackoffPeriod()).toBe(false)
			})
		})

		describe('getBackoffRemainingSeconds()', () => {
			it('should return 0 when not in backoff', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				expect(manager.getBackoffRemainingSeconds()).toBe(0)
			})

			it('should return remaining seconds when in backoff', () => {
				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })

				manager.recordRateLimitError()

				// Should be approximately 60 seconds (with some tolerance for test execution time)
				const remaining = manager.getBackoffRemainingSeconds()
				expect(remaining).toBeGreaterThan(55)
				expect(remaining).toBeLessThanOrEqual(60)
			})
		})

		describe('checkPRState() with rate limiting', () => {
			it('should detect rate limit errors and update backoff state', async () => {
				const rateLimitError = Object.assign(
					new Error('API rate limit exceeded'),
					{ stderr: 'rate limit' }
				)
				vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(rateLimitError)

				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
				const result = await manager.checkPRState(123, 'owner/repo')

				expect(result.state).toBe('open') // Default to open to prevent accidental finish
				expect(result.rateLimited).toBe(true)
				expect(result.error).toContain('rate limit')

				// Verify backoff state was updated
				const backoffState = manager.getBackoffState()
				expect(backoffState.isBackingOff).toBe(true)
				expect(backoffState.consecutiveFailures).toBe(1)
			})

			it('should not update backoff state for non-rate-limit errors', async () => {
				vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
					new Error('Network timeout')
				)

				const manager = new GitHubPRPollingManager({ metadataManager: mockMetadataManager as MetadataManager })
				const result = await manager.checkPRState(123, 'owner/repo')

				expect(result.state).toBe('open')
				expect(result.rateLimited).toBeUndefined()
				expect(result.error).toBe('Network timeout')

				// Verify backoff state was NOT updated
				const backoffState = manager.getBackoffState()
				expect(backoffState.isBackingOff).toBe(false)
				expect(backoffState.consecutiveFailures).toBe(0)
			})
		})

		describe('pollAndCleanup() with rate limiting', () => {
			it('should skip poll when in backoff period', async () => {
				const manager = new GitHubPRPollingManager({
					metadataManager: mockMetadataManager as MetadataManager,
					finishFn: mockFinishFn,
				})

				// Put manager into backoff state
				manager.recordRateLimitError()

				const result = await manager.pollAndCleanup()

				expect(result.rateLimited).toBe(true)
				expect(result.backoffRemainingSeconds).toBeGreaterThan(0)
				expect(result.checked).toBe(0)
				expect(mockMetadataManager.listAllMetadata).not.toHaveBeenCalled()
			})

			it('should handle rate limit error during PR check', async () => {
				vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
					createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
				])
				vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
					{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
				])
				vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
					Object.assign(new Error('API rate limit exceeded'), { stderr: 'rate limit' })
				)

				const manager = new GitHubPRPollingManager({
					metadataManager: mockMetadataManager as MetadataManager,
					finishFn: mockFinishFn,
				})

				const result = await manager.pollAndCleanup()

				expect(result.rateLimited).toBe(true)
				expect(result.errors).toContainEqual(expect.stringContaining('Rate limit'))
				expect(mockFinishFn).not.toHaveBeenCalled()
			})

			it('should skip remaining PRs after rate limit error', async () => {
				vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
					createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project1' }),
					createMockLoom({ pr_numbers: ['456'], projectPath: '/path/to/project2' }),
				])
				vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValue([
					{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
				])
				// First PR check hits rate limit
				vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
					Object.assign(new Error('API rate limit exceeded'), { stderr: 'rate limit' })
				)

				const manager = new GitHubPRPollingManager({
					metadataManager: mockMetadataManager as MetadataManager,
					finishFn: mockFinishFn,
				})

				const result = await manager.pollAndCleanup()

				expect(result.rateLimited).toBe(true)
				// Should only have made one API call (the first PR that hit rate limit)
				expect(githubUtils.executeGhCommand).toHaveBeenCalledTimes(1)
			})

			it('should reset backoff state on successful poll', async () => {
				const manager = new GitHubPRPollingManager({
					metadataManager: mockMetadataManager as MetadataManager,
					finishFn: mockFinishFn,
				})

				// Directly set backoff state to simulate previous rate limit errors (expired)
				// This avoids test isolation issues
				const initialBackoffState = {
					isBackingOff: false, // Backoff period expired
					consecutiveFailures: 2, // Had previous failures
					backoffUntil: new Date(Date.now() - 1000), // In the past
					currentBackoffSeconds: 120,
				};
				(manager as unknown as { backoffState: typeof initialBackoffState }).backoffState = initialBackoffState

				// Now do a successful poll
				vi.mocked(mockMetadataManager.listAllMetadata!).mockResolvedValueOnce([
					createMockLoom({ pr_numbers: ['123'], projectPath: '/path/to/project' }),
				])
				vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
					{ name: 'origin', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
				])
				vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
					state: 'OPEN',
					merged: false,
				})

				await manager.pollAndCleanup()

				// Backoff state should be reset
				const backoffState = manager.getBackoffState()
				expect(backoffState.isBackingOff).toBe(false)
				expect(backoffState.consecutiveFailures).toBe(0)
			})
		})
	})
})
