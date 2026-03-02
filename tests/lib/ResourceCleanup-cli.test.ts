import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResourceCleanup } from '../../src/lib/ResourceCleanup.js'
import { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import { DatabaseManager } from '../../src/lib/DatabaseManager.js'
import { ProcessManager } from '../../src/lib/process/ProcessManager.js'
import { CLIIsolationManager } from '../../src/lib/CLIIsolationManager.js'
import type { ParsedInput } from '../../src/commands/start.js'
import type { GitWorktree } from '../../src/types/worktree.js'

vi.mock('../../src/lib/GitWorktreeManager.js')
vi.mock('../../src/lib/DatabaseManager.js')
vi.mock('../../src/lib/process/ProcessManager.js')
vi.mock('../../src/lib/CLIIsolationManager.js')

// Mock MetadataManager to prevent real file creation during tests
vi.mock('../../src/lib/MetadataManager.js', () => ({
  MetadataManager: vi.fn(() => ({
    writeMetadata: vi.fn().mockResolvedValue(undefined),
    readMetadata: vi.fn().mockResolvedValue(null),
    deleteMetadata: vi.fn().mockResolvedValue(undefined),
    archiveMetadata: vi.fn().mockResolvedValue(undefined),
    slugifyPath: vi.fn((path: string) => path.replace(/\//g, '___') + '.json'),
  })),
}))
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn()
  },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn()
  }))
}))
vi.mock('../../src/utils/git.js', () => ({
  executeGitCommand: vi.fn(),
  findMainWorktreePath: vi.fn().mockResolvedValue('/main/worktree'),
  findMainWorktreePathWithSettings: vi.fn().mockResolvedValue('/main/worktree'),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
  extractIssueNumber: vi.fn().mockReturnValue(42),
}))

// Mock port utilities (getWorkspacePort has IO dependencies)
vi.mock('../../src/utils/port.js', () => ({
  getWorkspacePort: vi.fn().mockResolvedValue(3042),
  calculatePortFromIdentifier: vi.fn().mockReturnValue(3042),
}))

describe('ResourceCleanup - CLI Integration', () => {
  let resourceCleanup: ResourceCleanup
  let gitWorktree: GitWorktreeManager
  let processManager: ProcessManager
  let database: DatabaseManager
  let cliIsolation: CLIIsolationManager

  beforeEach(() => {
    vi.clearAllMocks()

    gitWorktree = new GitWorktreeManager()
    processManager = new ProcessManager()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database = new DatabaseManager({} as any, {} as any)
    cliIsolation = new CLIIsolationManager()

    resourceCleanup = new ResourceCleanup(
      gitWorktree,
      processManager,
      database,
      cliIsolation
    )
  })

  describe('cleanupWorktree with CLI isolation', () => {
    it('should cleanup CLI symlinks for issue identifier', async () => {
      const parsed: ParsedInput = {
        type: 'issue',
        number: 42,
        originalInput: '42'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/issue-42',
        branch: 'issue-42',
        commit: 'abc123',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.calculatePort).mockReturnValue(3042)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(gitWorktree.removeWorktree).mockResolvedValue(undefined)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)
      vi.mocked(cliIsolation.cleanupVersionedExecutables).mockResolvedValue(['il-42', 'loom-42'])

      const result = await resourceCleanup.cleanupWorktree(parsed)

      expect(cliIsolation.cleanupVersionedExecutables).toHaveBeenCalledWith(42)
      expect(result.success).toBe(true)
      expect(result.operations).toContainEqual({
        type: 'cli-symlinks',
        success: true,
        message: 'CLI symlinks removed: 2'
      })
    })

    it('should cleanup CLI symlinks for PR identifier', async () => {
      const parsed: ParsedInput = {
        type: 'pr',
        number: 37,
        originalInput: 'pr-37'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/pr-37',
        branch: 'pr-37',
        commit: 'def456',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForPR).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.calculatePort).mockReturnValue(3037)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(gitWorktree.removeWorktree).mockResolvedValue(undefined)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)
      vi.mocked(cliIsolation.cleanupVersionedExecutables).mockResolvedValue(['tool-37'])

      const result = await resourceCleanup.cleanupWorktree(parsed)

      expect(cliIsolation.cleanupVersionedExecutables).toHaveBeenCalledWith(37)
      expect(result.success).toBe(true)
      expect(result.operations).toContainEqual({
        type: 'cli-symlinks',
        success: true,
        message: 'CLI symlinks removed: 1'
      })
    })

    it('should cleanup CLI symlinks for branch identifier', async () => {
      const parsed: ParsedInput = {
        type: 'branch',
        branchName: 'feat/new-feature',
        originalInput: 'feat/new-feature'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/feat-new-feature',
        branch: 'feat/new-feature',
        commit: 'ghi789',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForBranch).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(gitWorktree.removeWorktree).mockResolvedValue(undefined)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)
      vi.mocked(cliIsolation.cleanupVersionedExecutables).mockResolvedValue(['il-feat/new-feature'])

      const result = await resourceCleanup.cleanupWorktree(parsed)

      expect(cliIsolation.cleanupVersionedExecutables).toHaveBeenCalledWith('feat/new-feature')
      expect(result.success).toBe(true)
      expect(result.operations).toContainEqual({
        type: 'cli-symlinks',
        success: true,
        message: 'CLI symlinks removed: 1'
      })
    })

    it('should handle case with no CLI symlinks to cleanup', async () => {
      const parsed: ParsedInput = {
        type: 'issue',
        number: 99,
        originalInput: '99'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/issue-99',
        branch: 'issue-99',
        commit: 'jkl012',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.calculatePort).mockReturnValue(3099)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(gitWorktree.removeWorktree).mockResolvedValue(undefined)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)
      vi.mocked(cliIsolation.cleanupVersionedExecutables).mockResolvedValue([])

      const result = await resourceCleanup.cleanupWorktree(parsed)

      expect(result.success).toBe(true)
      expect(result.operations).toContainEqual({
        type: 'cli-symlinks',
        success: true,
        message: 'No CLI symlinks to cleanup'
      })
    })

    it('should handle CLI cleanup failures gracefully (non-fatal)', async () => {
      const parsed: ParsedInput = {
        type: 'issue',
        number: 42,
        originalInput: '42'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/issue-42',
        branch: 'issue-42',
        commit: 'abc123',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.calculatePort).mockReturnValue(3042)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(gitWorktree.removeWorktree).mockResolvedValue(undefined)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)
      vi.mocked(cliIsolation.cleanupVersionedExecutables).mockRejectedValue(
        new Error('Permission denied')
      )

      const result = await resourceCleanup.cleanupWorktree(parsed)

      // Cleanup should fail overall when CLI cleanup fails (errors are counted)
      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toBe('Permission denied')
      expect(result.operations).toContainEqual({
        type: 'cli-symlinks',
        success: false,
        message: 'CLI symlink cleanup failed (non-fatal)'
      })
    })

    it('should skip CLI cleanup if no CLI isolation manager provided', async () => {
      const resourceCleanupNoCLI = new ResourceCleanup(
        gitWorktree,
        processManager,
        database
        // No CLI isolation manager
      )

      const parsed: ParsedInput = {
        type: 'issue',
        number: 42,
        originalInput: '42'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/issue-42',
        branch: 'issue-42',
        commit: 'abc123',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.calculatePort).mockReturnValue(3042)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(gitWorktree.removeWorktree).mockResolvedValue(undefined)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)

      const result = await resourceCleanupNoCLI.cleanupWorktree(parsed)

      expect(result.success).toBe(true)
      // Should not have cli-symlinks operation
      const cliOps = result.operations.filter(op => op.type === 'cli-symlinks')
      expect(cliOps).toHaveLength(0)
    })

    it('should show dry run message for CLI cleanup', async () => {
      const parsed: ParsedInput = {
        type: 'issue',
        number: 42,
        originalInput: '42'
      }

      const mockWorktree: GitWorktree = {
        path: '/worktrees/issue-42',
        branch: 'issue-42',
        commit: 'abc123',
        prunable: '',
        locked: ''
      }

      vi.mocked(gitWorktree.findWorktreeForIssue).mockResolvedValue(mockWorktree)
      vi.mocked(processManager.calculatePort).mockReturnValue(3042)
      vi.mocked(processManager.detectDevServer).mockResolvedValue(null)
      vi.mocked(database.shouldUseDatabaseBranching).mockResolvedValue(false)

      const result = await resourceCleanup.cleanupWorktree(parsed, { dryRun: true })

      expect(result.success).toBe(true)
      expect(result.operations).toContainEqual({
        type: 'cli-symlinks',
        success: true,
        message: '[DRY RUN] Would cleanup CLI symlinks for: 42'
      })
      expect(cliIsolation.cleanupVersionedExecutables).not.toHaveBeenCalled()
    })
  })
})
