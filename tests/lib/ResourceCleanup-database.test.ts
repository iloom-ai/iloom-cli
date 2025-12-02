import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ResourceCleanup } from '../../src/lib/ResourceCleanup.js'
import { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import { ProcessManager } from '../../src/lib/process/ProcessManager.js'
import { DatabaseManager } from '../../src/lib/DatabaseManager.js'
import { SettingsManager } from '../../src/lib/SettingsManager.js'
import { createMockDatabaseManager } from '../mocks/MockDatabaseProvider.js'
import type { GitWorktree } from '../../src/types/worktree.js'
import type { ParsedInput } from '../../src/commands/start.js'

// Mock dependencies
vi.mock('../../src/lib/GitWorktreeManager.js')
vi.mock('../../src/lib/process/ProcessManager.js')
vi.mock('../../src/lib/SettingsManager.js')
vi.mock('../../src/utils/git.js', () => ({
  executeGitCommand: vi.fn().mockResolvedValue(undefined),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
  findMainWorktreePath: vi.fn().mockResolvedValue('/test/main-worktree'),
  extractIssueNumber: vi.fn((branch: string) => {
    // Priority 1: New format - issue-{issueId}__
    const newMatch = branch.match(/issue-([^_]+)__/i)
    if (newMatch?.[1]) return newMatch[1]

    // Priority 2: Old format - issue-{number}- or issue-{number}$
    const oldMatch = branch.match(/issue-(\d+)(?:-|$)/i)
    if (oldMatch?.[1]) return oldMatch[1]

    // Priority 3: Legacy patterns
    const legacyMatch = branch.match(/issue_(\d+)|^(\d+)-/i)
    if (legacyMatch?.[1] || legacyMatch?.[2]) return legacyMatch[1] || legacyMatch[2]

    return null
  }),
}))

describe('ResourceCleanup - Database Integration', () => {
  let resourceCleanup: ResourceCleanup
  let mockGitWorktree: vi.Mocked<GitWorktreeManager>
  let mockProcessManager: vi.Mocked<ProcessManager>
  let mockDatabase: DatabaseManager
  let mockSettingsManager: SettingsManager

  beforeEach(() => {
    mockGitWorktree = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
    mockProcessManager = new ProcessManager() as vi.Mocked<ProcessManager>
    mockDatabase = createMockDatabaseManager()
    mockSettingsManager = {
      loadSettings: vi.fn().mockResolvedValue({}),
    } as unknown as SettingsManager

    resourceCleanup = new ResourceCleanup(
      mockGitWorktree,
      mockProcessManager,
      mockDatabase,
      undefined,
      mockSettingsManager
    )

    // Mock process manager methods
    vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3123)
    vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

    vi.clearAllMocks()
  })

  describe('cleanupDatabase', () => {
    it('should call DatabaseManager.deleteBranchIfConfigured with correct parameters', async () => {
      // GIVEN: DatabaseManager is available and configured
      const branchName = 'issue-123-test'
      const worktreePath = '/test/worktree-issue-123'
      const deletionResult = { success: true, deleted: true, notFound: false, branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(deletionResult)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      // WHEN: cleanupDatabase is called with branch name and worktree path
      const result = await resourceCleanup.cleanupDatabase(branchName, worktreePath)

      // THEN: shouldUseDatabaseBranching is called first to pre-fetch config
      expect(mockDatabase.shouldUseDatabaseBranching).toHaveBeenCalledWith(`${worktreePath}/.env`)

      // THEN: DatabaseManager.deleteBranchIfConfigured is called with branch name, shouldCleanup boolean, and isPreview
      // Note: cwd parameter is optional and may be undefined in tests
      const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe(branchName)
      expect(calls[0][1]).toBe(true) // shouldCleanup
      expect(calls[0][2]).toBe(false) // isPreview

      // THEN: Returns true when branch was deleted
      expect(result).toBe(true)
    })

    it('should return true when database cleanup succeeds with deletion', async () => {
      // GIVEN: DatabaseManager.deleteBranchIfConfigured returns deleted=true
      const deletionResult = { success: true, deleted: true, notFound: false, branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(deletionResult)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      const branchName = 'issue-123-test'
      const worktreePath = '/test/worktree-issue-123'

      // WHEN: cleanupDatabase is called
      const result = await resourceCleanup.cleanupDatabase(branchName, worktreePath)

      // THEN: Returns true
      expect(result).toBe(true)
    })

    it('should return false when database branch not found', async () => {
      // GIVEN: DatabaseManager.deleteBranchIfConfigured returns notFound=true
      const notFoundResult = { success: true, deleted: false, notFound: true, branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(notFoundResult)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      const branchName = 'issue-123-test'
      const worktreePath = '/test/worktree-issue-123'

      // WHEN: cleanupDatabase is called
      const result = await resourceCleanup.cleanupDatabase(branchName, worktreePath)

      // THEN: Returns false (nothing was deleted)
      expect(result).toBe(false)
    })

    it('should log warning and return false when DatabaseManager not available', async () => {
      // GIVEN: ResourceCleanup constructed without DatabaseManager
      const resourceCleanupWithoutDb = new ResourceCleanup(mockGitWorktree, mockProcessManager)

      const branchName = 'issue-123-test'
      const worktreePath = '/test/worktree-issue-123'

      // WHEN: cleanupDatabase is called
      const result = await resourceCleanupWithoutDb.cleanupDatabase(branchName, worktreePath)

      // THEN: Returns false without throwing
      expect(result).toBe(false)
    })

    it('should return false when database cleanup fails with error', async () => {
      // GIVEN: DatabaseManager.deleteBranchIfConfigured returns error result
      const errorResult = { success: false, deleted: false, notFound: false, error: 'Neon CLI error', branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(errorResult)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      const branchName = 'issue-123-test'
      const worktreePath = '/test/worktree-issue-123'

      // WHEN: cleanupDatabase is called
      const result = await resourceCleanup.cleanupDatabase(branchName, worktreePath)

      // THEN: Returns false without throwing (non-fatal)
      expect(result).toBe(false)
    })

    it('should handle unexpected exceptions gracefully', async () => {
      // GIVEN: DatabaseManager.deleteBranchIfConfigured throws unexpected error
      const dbError = new Error('Unexpected error')
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockRejectedValue(dbError)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      const branchName = 'issue-123-test'
      const worktreePath = '/test/worktree-issue-123'

      // WHEN: cleanupDatabase is called
      const result = await resourceCleanup.cleanupDatabase(branchName, worktreePath)

      // THEN: Returns false without throwing (non-fatal)
      expect(result).toBe(false)
    })
  })

  describe('cleanupWorktree with database cleanup', () => {
    const mockWorktree: GitWorktree = {
      path: '/test/worktree-issue-123',
      branch: 'issue-123-test',
      commit: 'abc123',
      bare: false,
      detached: false,
      locked: false,
    }

    const parsedIssue: ParsedInput = {
      type: 'issue',
      number: 123,
      originalInput: '123',
    }

    beforeEach(() => {
      // Mock worktree finding
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue()
    })

    it('should include database cleanup in operations when branch is actually deleted', async () => {
      // GIVEN: DatabaseManager returns result indicating deletion occurred
      const deletionResult = { success: true, deleted: true, notFound: false, branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(deletionResult)

      // Mock shouldUseDatabaseBranching to return true for pre-fetch
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      // WHEN: cleanupWorktree is called
      const result = await resourceCleanup.cleanupWorktree(parsedIssue, { keepDatabase: false })

      // THEN: deleteBranchIfConfigured is called with shouldCleanup = true and isPreview = false
      const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe('issue-123-test')
      expect(calls[0][1]).toBe(true) // shouldCleanup
      expect(calls[0][2]).toBe(false) // isPreview

      // THEN: Operation result indicates branch was deleted
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeDefined()
      expect(dbOperation?.success).toBe(true)
      expect(dbOperation?.message).toContain('Database branch deleted')
      expect(dbOperation?.deleted).toBe(true)
      // Should NOT contain "cleaned up" - be specific about what happened
      expect(dbOperation?.message).not.toContain('cleaned up')
    })

    it('should skip database cleanup message when branch not found', async () => {
      // GIVEN: DatabaseManager returns result indicating branch not found
      const notFoundResult = { success: true, deleted: false, notFound: true, branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(notFoundResult)

      // WHEN: cleanupWorktree is called
      const result = await resourceCleanup.cleanupWorktree(parsedIssue, { keepDatabase: false })

      // THEN: Operation result indicates branch was not found
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeDefined()
      expect(dbOperation?.success).toBe(true)
      expect(dbOperation?.message).toContain('No database branch found')
      expect(dbOperation?.deleted).toBe(false)
      expect(dbOperation?.message).not.toContain('deleted')
      expect(dbOperation?.message).not.toContain('cleaned up')
    })

    it('should handle database cleanup failure with error message', async () => {
      // GIVEN: DatabaseManager returns failure result
      const errorResult = { success: false, deleted: false, notFound: false, error: 'Neon CLI error', branchName: 'issue-123-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(errorResult)

      // WHEN: cleanupWorktree is called
      const result = await resourceCleanup.cleanupWorktree(parsedIssue, { keepDatabase: false })

      // THEN: Operation shows cleanup was skipped due to error
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeDefined()
      expect(dbOperation?.success).toBe(false) // Non-fatal, overall success
      expect(dbOperation?.message).toContain('Database cleanup failed')
      expect(dbOperation?.deleted).toBe(false)
    })

    it('should skip database cleanup when keepDatabase = true', async () => {
      // GIVEN: keepDatabase option is true
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(undefined)

      // WHEN: cleanupWorktree is called with keepDatabase
      const result = await resourceCleanup.cleanupWorktree(parsedIssue, { keepDatabase: true })

      // THEN: cleanupDatabase is not called
      expect(mockDatabase.deleteBranchIfConfigured).not.toHaveBeenCalled()

      // THEN: No database operation in results
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeUndefined()
    })

    it('should skip database cleanup in dry-run mode', async () => {
      // GIVEN: dryRun option is true
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(undefined)

      // WHEN: cleanupWorktree is called with dryRun
      const result = await resourceCleanup.cleanupWorktree(parsedIssue, { dryRun: true })

      // THEN: cleanupDatabase is not called
      expect(mockDatabase.deleteBranchIfConfigured).not.toHaveBeenCalled()

      // THEN: Operation result includes "[DRY RUN]" database cleanup message
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeDefined()
      expect(dbOperation?.message).toContain('[DRY RUN]')
    })

    it('should handle database cleanup failure gracefully (non-fatal)', async () => {
      // GIVEN: Database cleanup fails
      const dbError = new Error('Database deletion failed')
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockRejectedValue(dbError)

      // WHEN: cleanupWorktree is called
      const result = await resourceCleanup.cleanupWorktree(parsedIssue, { keepDatabase: false })

      // THEN: Cleanup fails when database cleanup fails (errors are counted)
      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toBe('Database deletion failed')

      // THEN: Database operation shows skipped (because deleteBranchIfConfigured is called but returns false)
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeDefined()
      expect(dbOperation?.success).toBe(false)
      expect(dbOperation?.message).toContain('failed')

      const worktreeOperation = result.operations.find((op) => op.type === 'worktree')
      expect(worktreeOperation?.success).toBe(true)
    })

    it('should skip database cleanup when DatabaseManager not provided', async () => {
      // GIVEN: ResourceCleanup without DatabaseManager
      const resourceCleanupWithoutDb = new ResourceCleanup(mockGitWorktree, mockProcessManager)
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue()

      // WHEN: cleanupWorktree is called
      const result = await resourceCleanupWithoutDb.cleanupWorktree(parsedIssue, {
        keepDatabase: false,
      })

      // THEN: Database operation shows skipped
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation).toBeDefined()
      expect(dbOperation?.success).toBe(true)
      expect(dbOperation?.message).toContain('skipped')
    })

    it('should cleanup database for PR worktrees', async () => {
      // GIVEN: PR worktree
      const prWorktree: GitWorktree = {
        path: '/test/worktree-feature-branch_pr_42',
        branch: 'feature-branch',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      const parsedPR: ParsedInput = {
        type: 'pr',
        number: 42,
        originalInput: 'pr/42',
      }

      vi.mocked(mockGitWorktree.findWorktreeForPR).mockResolvedValue(prWorktree)
      vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue()
      const deletionResult = { success: true, deleted: true, notFound: false, branchName: 'feature-branch' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(deletionResult)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      // WHEN: cleanupWorktree is called for PR
      const result = await resourceCleanup.cleanupWorktree(parsedPR, { keepDatabase: false })

      // THEN: Database cleanup is called with shouldCleanup = true from pre-fetch
      const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const call = calls.find(c => c[0] === 'feature-branch')
      expect(call).toBeDefined()
      expect(call![1]).toBe(true) // shouldCleanup
      expect(call![2]).toBe(false) // isPreview

      // THEN: Database operation succeeds
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation?.success).toBe(true)
      expect(dbOperation?.deleted).toBe(true)
    })

    it('should cleanup database for branch worktrees', async () => {
      // GIVEN: Branch worktree
      const branchWorktree: GitWorktree = {
        path: '/test/worktree-feature-xyz',
        branch: 'feature-xyz',
        commit: 'ghi789',
        bare: false,
        detached: false,
        locked: false,
      }

      const parsedBranch: ParsedInput = {
        type: 'branch',
        branchName: 'feature-xyz',
        originalInput: 'feature-xyz',
      }

      vi.mocked(mockGitWorktree.findWorktreeForBranch).mockResolvedValue(branchWorktree)
      vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue()
      const deletionResult = { success: true, deleted: true, notFound: false, branchName: 'feature-xyz' }
      mockDatabase.deleteBranchIfConfigured = vi.fn().mockResolvedValue(deletionResult)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      // WHEN: cleanupWorktree is called for branch
      const result = await resourceCleanup.cleanupWorktree(parsedBranch, { keepDatabase: false })

      // THEN: Database cleanup is called with shouldCleanup = true from pre-fetch
      const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const call = calls.find(c => c[0] === 'feature-xyz')
      expect(call).toBeDefined()
      expect(call![1]).toBe(true) // shouldCleanup
      expect(call![2]).toBe(false) // isPreview

      // THEN: Database operation succeeds
      const dbOperation = result.operations.find((op) => op.type === 'database')
      expect(dbOperation?.success).toBe(true)
      expect(dbOperation?.deleted).toBe(true)
    })
  })

  describe('cleanupMultipleWorktrees with database', () => {
    it('should cleanup databases for multiple worktrees', async () => {
      // GIVEN: Multiple worktrees
      const worktree1: GitWorktree = {
        path: '/test/worktree-issue-123',
        branch: 'issue-123-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const worktree2: GitWorktree = {
        path: '/test/worktree-issue-456',
        branch: 'issue-456-test',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue)
        .mockResolvedValueOnce(worktree1)
        .mockResolvedValueOnce(worktree2)
      vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue()
      const deletionResult1 = { success: true, deleted: true, notFound: false, branchName: 'issue-123-test' }
      const deletionResult2 = { success: true, deleted: true, notFound: false, branchName: 'issue-456-test' }
      mockDatabase.deleteBranchIfConfigured = vi.fn()
        .mockResolvedValueOnce(deletionResult1)
        .mockResolvedValueOnce(deletionResult2)
      mockDatabase.shouldUseDatabaseBranching = vi.fn().mockResolvedValue(true)

      // WHEN: cleanupMultipleWorktrees is called
      const results = await resourceCleanup.cleanupMultipleWorktrees(['123', '456'], {
        keepDatabase: false,
      })

      // THEN: Database cleanup is called for both worktrees with shouldCleanup = true
      const calls = vi.mocked(mockDatabase.deleteBranchIfConfigured).mock.calls
      expect(calls).toHaveLength(2)

      const call1 = calls.find(c => c[0] === 'issue-123-test')
      expect(call1).toBeDefined()
      expect(call1![1]).toBe(true) // shouldCleanup
      expect(call1![2]).toBe(false) // isPreview

      const call2 = calls.find(c => c[0] === 'issue-456-test')
      expect(call2).toBeDefined()
      expect(call2![1]).toBe(true) // shouldCleanup
      expect(call2![2]).toBe(false) // isPreview

      // THEN: Both results include database cleanup operations
      expect(results).toHaveLength(2)
      results.forEach((result) => {
        const dbOperation = result.operations.find((op) => op.type === 'database')
        expect(dbOperation).toBeDefined()
        expect(dbOperation?.success).toBe(true)
        expect(dbOperation?.deleted).toBe(true)
      })
    })
  })
})
