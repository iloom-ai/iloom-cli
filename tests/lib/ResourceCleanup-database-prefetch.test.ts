import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ResourceCleanup } from '../../src/lib/ResourceCleanup.js'
import { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import { DatabaseManager } from '../../src/lib/DatabaseManager.js'
import { ProcessManager } from '../../src/lib/process/ProcessManager.js'
import type { GitWorktree } from '../../src/types/worktree.js'
import type { DatabaseDeletionResult } from '../../src/types/index.js'

// Mock the logger
vi.mock('../../src/utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	},
}))

// Mock git utilities
vi.mock('../../src/utils/git.js', () => ({
	executeGitCommand: vi.fn(),
	findMainWorktreePath: vi.fn().mockResolvedValue('/test/main'),
	findMainWorktreePathWithSettings: vi.fn().mockResolvedValue('/test/main'),
	hasUncommittedChanges: vi.fn().mockResolvedValue(false),
}))

describe('ResourceCleanup - Database Cleanup with Pre-fetched Config', () => {
	let resourceCleanup: ResourceCleanup
	let mockGitWorktree: GitWorktreeManager
	let mockDatabase: DatabaseManager
	let mockProcessManager: ProcessManager

	beforeEach(() => {
		// Create mock GitWorktreeManager
		mockGitWorktree = {
			findWorktreeForIssue: vi.fn(),
			findWorktreeForPR: vi.fn(),
			findWorktreeForBranch: vi.fn(),
			removeWorktree: vi.fn().mockResolvedValue(undefined),
			isMainWorktree: vi.fn().mockResolvedValue(false),
			findWorktreesByIdentifier: vi.fn(),
		} as unknown as GitWorktreeManager

		// Create mock DatabaseManager
		mockDatabase = {
			shouldUseDatabaseBranching: vi.fn(),
			deleteBranchIfConfigured: vi.fn(),
		} as unknown as DatabaseManager

		// Create mock ProcessManager
		mockProcessManager = {
			detectDevServer: vi.fn().mockResolvedValue(null),
			terminateProcess: vi.fn(),
			verifyPortFree: vi.fn().mockResolvedValue(true),
			calculatePort: vi.fn((num: number) => 3000 + num),
		} as unknown as ProcessManager

		// Create ResourceCleanup instance
		resourceCleanup = new ResourceCleanup(
			mockGitWorktree,
			mockProcessManager,
			mockDatabase
		)

		vi.clearAllMocks()
	})

	describe('database cleanup after worktree deletion', () => {
		it('should successfully delete database branch using pre-fetched config when worktree is deleted', async () => {
			// GIVEN: Worktree with database configured
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-123',
				branch: 'issue-123-test',
				commit: 'abc123',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// GIVEN: Pre-fetch determines shouldCleanup = true
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(true)

			// GIVEN: Database deletion succeeds
			const deletionResult: DatabaseDeletionResult = {
				success: true,
				deleted: true,
				notFound: false,
				branchName: 'issue-123-test',
			}
			vi.mocked(mockDatabase.deleteBranchIfConfigured).mockResolvedValue(deletionResult)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 123,
					originalInput: '123',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Database deletion is called with pre-fetched shouldCleanup = true and isPreview = false
			const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
			expect(calls).toHaveLength(1)
			expect(calls[0][0]).toBe('issue-123-test')
			expect(calls[0][1]).toBe(true) // shouldCleanup
			expect(calls[0][2]).toBe(false) // isPreview

			// THEN: Operation result shows database was deleted
			expect(result.success).toBe(true)
			const dbOperation = result.operations.find((op) => op.type === 'database')
			expect(dbOperation).toBeDefined()
			expect(dbOperation?.success).toBe(true)
			expect(dbOperation?.deleted).toBe(true)
			expect(dbOperation?.message).toContain('deleted')
		})

		it('should skip database cleanup when pre-fetch determines no database configured', async () => {
			// GIVEN: Worktree exists but no DATABASE_URL in .env
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-456',
				branch: 'issue-456-test',
				commit: 'def456',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// GIVEN: Pre-fetch determines shouldCleanup = false
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(false)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 456,
					originalInput: '456',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Database deletion is NOT called
			expect(mockDatabase.deleteBranchIfConfigured).not.toHaveBeenCalled()

			// THEN: Operation result shows database cleanup was skipped
			expect(result.success).toBe(true)
			const dbOperation = result.operations.find((op) => op.type === 'database')
			expect(dbOperation).toBeDefined()
			expect(dbOperation?.success).toBe(true)
			expect(dbOperation?.deleted).toBe(false)
			expect(dbOperation?.message).toContain('skipped')
		})

		it('should skip database cleanup when provider is configured but env has no DATABASE_URL', async () => {
			// GIVEN: Worktree exists
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-789',
				branch: 'issue-789-test',
				commit: 'ghi789',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// GIVEN: Pre-fetch determines shouldCleanup = false (no DATABASE_URL in .env)
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(false)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 789,
					originalInput: '789',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Database cleanup is skipped
			expect(mockDatabase.deleteBranchIfConfigured).not.toHaveBeenCalled()

			// THEN: No error occurred
			expect(result.success).toBe(true)
			expect(result.errors).toHaveLength(0)
		})

		it('should handle pre-fetch failure gracefully', async () => {
			// GIVEN: Worktree exists but .env read fails during pre-fetch
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-999',
				branch: 'issue-999-test',
				commit: 'jkl999',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// GIVEN: Pre-fetch fails (e.g., permission error)
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockRejectedValue(
				new Error('Permission denied')
			)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 999,
					originalInput: '999',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Database cleanup is skipped with warning
			expect(mockDatabase.deleteBranchIfConfigured).not.toHaveBeenCalled()

			// THEN: Worktree cleanup continues successfully
			expect(result.success).toBe(true)
			expect(mockGitWorktree.removeWorktree).toHaveBeenCalled()
		})

		it('should pre-fetch config before worktree deletion and use it after', async () => {
			// GIVEN: Worktree with database configuration
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-111',
				branch: 'issue-111-test',
				commit: 'mno111',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// GIVEN: Pre-fetch stores shouldCleanup = true
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(true)

			// GIVEN: Database deletion succeeds
			const deletionResult: DatabaseDeletionResult = {
				success: true,
				deleted: true,
				notFound: false,
				branchName: 'issue-111-test',
			}
			vi.mocked(mockDatabase.deleteBranchIfConfigured).mockResolvedValue(deletionResult)

			// WHEN: Cleanup is performed
			await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 111,
					originalInput: '111',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// VERIFY: shouldUseDatabaseBranching called once during pre-fetch (before worktree removal)
			expect(mockDatabase.shouldUseDatabaseBranching).toHaveBeenCalledTimes(1)
			expect(mockDatabase.shouldUseDatabaseBranching).toHaveBeenCalledWith(
				'/test/worktrees/issue-111/.env'
			)

			// VERIFY: Worktree removal occurred
			expect(mockGitWorktree.removeWorktree).toHaveBeenCalled()

			// VERIFY: Database deletion called with boolean (not reading .env)
			const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
			expect(calls).toHaveLength(1)
			expect(calls[0][0]).toBe('issue-111-test')
			expect(calls[0][1]).toBe(true)
			expect(calls[0][2]).toBe(false) // isPreview
		})
	})

	describe('database config pre-fetch timing', () => {
		it('should pre-fetch database config before any resource deletion', async () => {
			// GIVEN: Worktree with database
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-222',
				branch: 'issue-222-test',
				commit: 'pqr222',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(true)

			const deletionResult: DatabaseDeletionResult = {
				success: true,
				deleted: true,
				notFound: false,
				branchName: 'issue-222-test',
			}
			vi.mocked(mockDatabase.deleteBranchIfConfigured).mockResolvedValue(deletionResult)

			// WHEN: Cleanup is performed
			await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 222,
					originalInput: '222',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// VERIFY: Config read happened before worktree removal
			// This is verified by the call order
			const shouldUseCall = vi.mocked(mockDatabase.shouldUseDatabaseBranching).mock.invocationCallOrder[0]
			const removeWorktreeCall = vi.mocked(mockGitWorktree.removeWorktree).mock.invocationCallOrder[0]

			expect(shouldUseCall).toBeLessThan(removeWorktreeCall!)
		})

		it('should use pre-fetched config even when provider configuration changes', async () => {
			// GIVEN: Worktree exists
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-333',
				branch: 'issue-333-test',
				commit: 'stu333',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// GIVEN: Pre-fetch succeeds (shouldCleanup = true stored)
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(true)

			// GIVEN: Database deletion succeeds with pre-fetched config
			const deletionResult: DatabaseDeletionResult = {
				success: true,
				deleted: true,
				notFound: false,
				branchName: 'issue-333-test',
			}
			vi.mocked(mockDatabase.deleteBranchIfConfigured).mockResolvedValue(deletionResult)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 333,
					originalInput: '333',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Database deletion called with shouldCleanup = true
			const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
			expect(calls).toHaveLength(1)
			expect(calls[0][0]).toBe('issue-333-test')
			expect(calls[0][1]).toBe(true)
			expect(calls[0][2]).toBe(false) // isPreview

			// THEN: Result indicates successful deletion
			expect(result.success).toBe(true)
			const dbOperation = result.operations.find((op) => op.type === 'database')
			expect(dbOperation?.deleted).toBe(true)
		})
	})

	describe('keepDatabase option', () => {
		it('should skip all database operations when keepDatabase is true', async () => {
			// GIVEN: Worktree with database
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-444',
				branch: 'issue-444-test',
				commit: 'vwx444',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)

			// WHEN: Cleanup with keepDatabase = true
			await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 444,
					originalInput: '444',
				},
				{ deleteBranch: false, keepDatabase: true }
			)

			// THEN: No database operations performed
			expect(mockDatabase.shouldUseDatabaseBranching).not.toHaveBeenCalled()
			expect(mockDatabase.deleteBranchIfConfigured).not.toHaveBeenCalled()
		})
	})

	describe('error handling in database cleanup', () => {
		it('should handle database deletion failure gracefully', async () => {
			// GIVEN: Worktree exists
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-555',
				branch: 'issue-555-test',
				commit: 'yz555',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(true)

			// GIVEN: Database deletion fails
			const deletionResult: DatabaseDeletionResult = {
				success: false,
				deleted: false,
				notFound: false,
				error: 'CLI not available',
				branchName: 'issue-555-test',
			}
			vi.mocked(mockDatabase.deleteBranchIfConfigured).mockResolvedValue(deletionResult)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 555,
					originalInput: '555',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Cleanup fails when database deletion fails (errors are counted)
			expect(result.success).toBe(false)
			expect(result.errors).toHaveLength(1)
			expect(result.errors[0].message).toBe('CLI not available')

			// THEN: Database operation marked as failed
			const dbOperation = result.operations.find((op) => op.type === 'database')
			expect(dbOperation).toBeDefined()
			expect(dbOperation?.success).toBe(false)
			expect(dbOperation?.error).toBe('CLI not available')
		})

		it('should handle database branch not found gracefully', async () => {
			// GIVEN: Worktree exists
			const worktree: GitWorktree = {
				path: '/test/worktrees/issue-666',
				branch: 'issue-666-test',
				commit: 'abc666',
			}

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(worktree)
			vi.mocked(mockDatabase.shouldUseDatabaseBranching).mockResolvedValue(true)

			// GIVEN: Database branch doesn't exist
			const deletionResult: DatabaseDeletionResult = {
				success: true,
				deleted: false,
				notFound: true,
				branchName: 'issue-666-test',
			}
			vi.mocked(mockDatabase.deleteBranchIfConfigured).mockResolvedValue(deletionResult)

			// WHEN: Cleanup is performed
			const result = await resourceCleanup.cleanupWorktree(
				{
					type: 'issue',
					number: 666,
					originalInput: '666',
				},
				{ deleteBranch: false, keepDatabase: false }
			)

			// THEN: Cleanup succeeds
			expect(result.success).toBe(true)

			// THEN: Database operation shows not found (not an error)
			const dbOperation = result.operations.find((op) => op.type === 'database')
			expect(dbOperation).toBeDefined()
			expect(dbOperation?.success).toBe(true)
			expect(dbOperation?.deleted).toBe(false)
			expect(dbOperation?.message).toContain('No database branch found')
		})
	})
})
