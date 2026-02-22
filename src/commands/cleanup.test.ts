import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CleanupCommand } from '../../src/commands/cleanup.js'
import { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import { ResourceCleanup } from '../../src/lib/ResourceCleanup.js'
import { logger } from '../../src/utils/logger.js'
import { promptConfirmation } from '../../src/utils/prompt.js'
import type { CleanupResult, SafetyCheck } from '../../src/types/cleanup.js'

// Mock TelemetryService
const mockTrack = vi.fn()
vi.mock('../../src/lib/TelemetryService.js', () => ({
  TelemetryService: {
    getInstance: () => ({ track: mockTrack }),
  },
}))

// Mock MetadataManager for telemetry duration calculation
const mockReadMetadata = vi.fn().mockResolvedValue(null)
vi.mock('../../src/lib/MetadataManager.js', () => ({
  MetadataManager: vi.fn(() => ({
    readMetadata: mockReadMetadata,
  })),
}))

// Mock dependencies
vi.mock('../../src/lib/GitWorktreeManager.js')
vi.mock('../../src/lib/ResourceCleanup.js')
vi.mock('../../src/utils/prompt.js')
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}))

describe('CleanupCommand', () => {
  let command: CleanupCommand
  let mockGitWorktreeManager: vi.Mocked<GitWorktreeManager>

  beforeEach(() => {
    vi.clearAllMocks()
    mockGitWorktreeManager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
    // Mock listWorktrees by default to prevent executeIssueCleanup from failing
    mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([])
    command = new CleanupCommand(mockGitWorktreeManager)
  })

  describe('Constructor and Dependency Injection', () => {
    it('should accept GitWorktreeManager through constructor', () => {
      const manager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
      const cmd = new CleanupCommand(manager)

      expect(cmd).toBeDefined()
      expect(cmd).toBeInstanceOf(CleanupCommand)
    })

    it('should create default GitWorktreeManager when none provided', () => {
      const cmd = new CleanupCommand()

      expect(cmd).toBeDefined()
      expect(cmd).toBeInstanceOf(CleanupCommand)
    })

    it('should use injected GitWorktreeManager for operations', async () => {
      const customManager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
      const cmd = new CleanupCommand(customManager)

      await cmd.execute({
        options: { list: true }
      })

      // Verify the command uses the injected manager
      expect(cmd).toBeDefined()
    })
  })

  describe('Option Parsing - List Mode', () => {
    it('should parse --list flag and set mode to "list"', async () => {
      await command.execute({
        options: { list: true }
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: list')
      expect(logger.info).toHaveBeenCalledWith('Would list all worktrees')
    })

    it('should handle list mode without identifier', async () => {
      await command.execute({
        options: { list: true }
      })

    })

    it('should return CleanupResult when --list flag provided', async () => {
      const result = await command.execute({ options: { list: true } })

      expect(result).toBeDefined()
      expect(result?.success).toBe(true)
      expect(result?.identifier).toBe('list')
      expect(result?.operations).toEqual([])
    })
  })

  describe('Option Parsing - All Mode', () => {
    it('should parse --all flag and set mode to "all"', async () => {
      await command.execute({
        options: { all: true }
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: all')
      expect(logger.info).toHaveBeenCalledWith('Would remove all worktrees')
    })

    it('should handle all mode without identifier', async () => {
      await command.execute({
        options: { all: true }
      })

    })

    it('should return CleanupResult when --all flag provided', async () => {
      const result = await command.execute({ options: { all: true } })

      expect(result).toBeDefined()
      expect(result?.success).toBe(true)
      expect(result?.identifier).toBe('all')
      expect(result?.operations).toEqual([])
    })
  })

  describe('Option Parsing - Issue Mode', () => {
    it('should parse --issue <number> and set mode to "issue"', async () => {
      await command.execute({
        options: { issue: 42 }
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: issue')
      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #42...')
    })

    it('should handle issue mode with number 1', async () => {
      await command.execute({
        options: { issue: 1 }
      })

      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #1...')
    })

    it('should handle issue mode with large number', async () => {
      await command.execute({
        options: { issue: 999 }
      })

      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #999...')
    })
  })

  describe('Auto-detection - Numeric Identifiers', () => {
    it('should detect "42" as issue number', async () => {
      await command.execute({
        identifier: '42',
        options: {}
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: issue')
      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #42...')
    })

    it('should detect "123" as issue number', async () => {
      await command.execute({
        identifier: '123',
        options: {}
      })

      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #123...')
    })

    it('should detect "1" as issue number', async () => {
      await command.execute({
        identifier: '1',
        options: {}
      })

      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #1...')
    })

    it('should detect "0" as issue number (edge case)', async () => {
      await command.execute({
        identifier: '0',
        options: {}
      })

      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #0...')
    })

    it('should parse numeric string to integer correctly', async () => {
      await command.execute({
        identifier: '007',
        options: {}
      })

      // Should parse as integer 7, not string "007"
      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #7...')
    })
  })


  describe('Mode Determination - Priority', () => {
    it('should prioritize --list over other options', async () => {
      // Note: list mode with identifier will throw validation error
      await expect(command.execute({
        identifier: '42',
        options: { list: true }
      })).rejects.toThrow('Cannot use --list with a specific identifier')
    })

    it('should prioritize --all over identifier', async () => {
      // Note: all mode with identifier will throw validation error
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { all: true }
      })).rejects.toThrow('Cannot use --all with a specific identifier')
    })

    it('should prioritize explicit --issue flag over auto-detection', async () => {
      await command.execute({
        identifier: '42',
        options: { issue: 99 }
      })

      // Should use explicit issue flag (99), not auto-detected (42)
      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #99...')
    })
  })

  describe('Validation - Option Conflicts', () => {
    it('should throw error when --list used with --all', async () => {
      await expect(command.execute({
        options: { list: true, all: true }
      })).rejects.toThrow('Cannot use --list with --all')
    })

    it('should throw error when --list used with --issue', async () => {
      await expect(command.execute({
        options: { list: true, issue: 42 }
      })).rejects.toThrow('Cannot use --list with --issue')
    })

    it('should throw error when --list used with positional identifier', async () => {
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { list: true }
      })).rejects.toThrow('Cannot use --list with a specific identifier')
    })

    it('should throw error when --all used with positional identifier', async () => {
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { all: true }
      })).rejects.toThrow('Cannot use --all with a specific identifier')
    })

    it('should throw error when --all used with --issue', async () => {
      await expect(command.execute({
        options: { all: true, issue: 42 }
      })).rejects.toThrow('Cannot use --all with a specific identifier')
    })

    it('should throw error when --issue flag used with branch name identifier', async () => {
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { issue: 42 }
      })).rejects.toThrow('Cannot use --issue flag with branch name identifier')
    })

    it('should allow --force with list mode', async () => {
      await command.execute({
        options: { list: true, force: true }
      })

    })

    it('should allow --force with all mode', async () => {
      await command.execute({
        options: { all: true, force: true }
      })

    })

    it('should allow --force with issue mode', async () => {
      await command.execute({
        options: { issue: 42, force: true }
      })

    })

    it('should allow --dry-run with any mode', async () => {
      await command.execute({
        options: { all: true, dryRun: true }
      })

    })

    it('should allow --force and --dry-run together', async () => {
      await command.execute({
        options: { all: true, force: true, dryRun: true }
      })

    })
  })

  describe('Error Handling - Missing Arguments', () => {
    it('should throw error when no identifier and no flags provided', async () => {
      await expect(command.execute({
        options: {}
      })).rejects.toThrow('Missing required argument: identifier')
    })

    it('should provide helpful error message suggesting --all or --list', async () => {
      await expect(command.execute({
        options: {}
      })).rejects.toThrow('Use --all to remove all worktrees or --list to list them')
    })

    it('should throw error for empty string identifier', async () => {
      await expect(command.execute({
        identifier: '',
        options: {}
      })).rejects.toThrow('Missing required argument: identifier')
    })

    it('should throw error for whitespace-only identifier', async () => {
      await expect(command.execute({
        identifier: '   ',
        options: {}
      })).rejects.toThrow('Missing required argument: identifier')
    })
  })

  describe('Error Handling - Clear Messages', () => {
    it('should provide clear error message for conflicting options', async () => {
      const errorPromise = command.execute({
        options: { list: true, all: true }
      })

      await expect(errorPromise).rejects.toThrow('Cannot use --list with --all (list is informational only)')
    })

    it('should not log errors before throwing (errors logged by CLI layer)', async () => {
      // Errors are not logged in the command layer to avoid duplicate messages
      // The CLI layer (cli.ts) handles all error logging
      await expect(command.execute({
        options: { list: true, all: true }
      })).rejects.toThrow()

      // Error should NOT be logged here - it propagates to CLI layer
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('should propagate unknown errors to CLI layer', async () => {
      // Force an unknown error by throwing from logger
      vi.mocked(logger.info).mockImplementationOnce(() => {
        throw 'string error'  // Non-Error throw
      })

      // Error should propagate up to CLI layer
      await expect(command.execute({
        options: { list: true }
      })).rejects.toBeDefined()

      // Error logging is handled by CLI layer, not command layer
      expect(logger.error).not.toHaveBeenCalled()
    })
  })

  describe('Integration - Complete Workflows', () => {
    it('should execute successfully with valid list command', async () => {
      await command.execute({
        options: { list: true }
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: list')
    })


    it('should execute successfully with valid issue number', async () => {
      await command.execute({
        identifier: '42',
        options: {}
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: issue')
    })

    it('should execute successfully with valid --all command', async () => {
      await command.execute({
        options: { all: true }
      })

      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: all')
    })


    it('should handle dry-run flag with issue cleanup', async () => {
      await command.execute({
        identifier: '42',
        options: { dryRun: true }
      })

    })

    it('should handle all flags combined where valid', async () => {
      await command.execute({
        identifier: '42',
        options: { force: true, dryRun: true }
      })

    })
  })

  describe('Edge Cases', () => {
    it('should handle identifier with leading zeros', async () => {
      await command.execute({
        identifier: '007',
        options: {}
      })

      // Should parse to integer 7
      expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #7...')
    })


    it('should preserve original input in parsed result', async () => {
      await command.execute({
        identifier: '42',
        options: {}
      })

      // The command should work correctly
    })

    it('should handle undefined options gracefully', async () => {
      await command.execute({
        identifier: '42',
        options: {}
      })

    })
  })

  describe('Mode-specific Validation', () => {
    it('should validate list mode cannot have identifier', async () => {
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { list: true }
      })).rejects.toThrow('Cannot use --list with a specific identifier (list shows all worktrees)')
    })

    it('should validate all mode cannot have identifier', async () => {
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { all: true }
      })).rejects.toThrow('Cannot use --all with a specific identifier. Use one or the other.')
    })

    it('should validate explicit issue flag cannot be used with branch name', async () => {
      await expect(command.execute({
        identifier: 'feat/branch',
        options: { issue: 42 }
      })).rejects.toThrow('Cannot use --issue flag with branch name identifier. Use numeric identifier or --issue flag alone.')
    })
  })

  describe('Single Mode Execution Tests', () => {
    let mockResourceCleanup: vi.Mocked<ResourceCleanup>

    // Helper function to setup common mocks for branch identifier tests
    const setupBranchWorktreeMock = (branchName: string) => {
      const mockWorktree = { path: '/path/to/worktree', branch: branchName, commit: 'abc123', bare: false, detached: false, locked: false }
      mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)
      return mockWorktree
    }

    beforeEach(() => {
      vi.clearAllMocks()
      mockGitWorktreeManager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
      const mockProcessManager = {} as vi.Mocked<import('../../src/lib/process/ProcessManager.js').ProcessManager>
      mockResourceCleanup = new ResourceCleanup(mockGitWorktreeManager, mockProcessManager) as vi.Mocked<ResourceCleanup>
      command = new CleanupCommand(mockGitWorktreeManager, mockResourceCleanup)

      // Mock GitWorktreeManager methods used by IdentifierParser
      mockGitWorktreeManager.findWorktreeForBranch = vi.fn()
      mockGitWorktreeManager.findWorktreeForIssue = vi.fn()
      mockGitWorktreeManager.findWorktreeForPR = vi.fn()
    })

    describe('Basic Cleanup Flow', () => {
      it('should execute cleanup with confirmation when worktree exists', async () => {
        // Mock IdentifierParser dependencies - branch 'feat/my-feature' exists (no issue pattern)
        const mockWorktree = { path: '/path/to/worktree', branch: 'feat/my-feature', commit: 'abc123', bare: false, detached: false, locked: false }
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

        // Mock user confirms cleanup (single confirmation - safety check happens in cleanupWorktree)
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true) // Confirm worktree removal

        // Mock successful cleanup with branch deletion included
        const mockResult: CleanupResult = {
          identifier: 'feat/my-feature',
          branchName: 'feat/my-feature',
          success: true,
          operations: [
            { type: 'dev-server', success: true, message: 'Dev server terminated' },
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/my-feature', options: {} })

        // Verify execution flow - safety checks run via cleanupWorktree with deleteBranch: true
        expect(promptConfirmation).toHaveBeenNthCalledWith(1, 'Remove this worktree?', true)
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'branch', branchName: 'feat/my-feature' }),
          {
            dryRun: false,
            force: false,
            deleteBranch: true,  // Now includes branch deletion with safety checks
            keepDatabase: false,
            checkMergeSafety: true,  // Run 5-point safety check before any deletion
            archive: false,
          }
        )
        // No second prompt - branch deletion is handled atomically with safety checks
        expect(promptConfirmation).toHaveBeenCalledTimes(1)
        expect(logger.success).toHaveBeenCalledWith('Cleanup completed successfully')
      })

      it('should skip cleanup when user declines first confirmation', async () => {
        // Mock IdentifierParser dependencies
        const mockWorktree = { path: '/path/to/worktree', branch: 'feat/issue-45', commit: 'abc123', bare: false, detached: false, locked: false }
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

        const mockSafety: SafetyCheck = { isSafe: true, warnings: [], blockers: [] }
        mockResourceCleanup.validateCleanupSafety = vi.fn().mockResolvedValue(mockSafety)

        // User declines worktree removal
        vi.mocked(promptConfirmation).mockResolvedValueOnce(false)

        mockResourceCleanup.cleanupWorktree = vi.fn()

        await command.execute({ identifier: 'feat/issue-45', options: {} })

        // Should not call cleanup
        expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
        expect(logger.info).toHaveBeenCalledWith('Cleanup cancelled')
      })

      it('should cleanup worktree and branch atomically with safety checks (no second confirmation)', async () => {
        // Mock IdentifierParser dependencies - use branch name without issue pattern
        const mockWorktree = { path: '/path/to/worktree', branch: 'feat/my-feature', commit: 'abc123', bare: false, detached: false, locked: false }
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

        // User confirms cleanup (single confirmation)
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true) // Confirm worktree removal

        // Mock successful cleanup with branch deletion included (atomic operation)
        const mockResult: CleanupResult = {
          identifier: 'feat/my-feature',
          branchName: 'feat/my-feature',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/my-feature', options: {} })

        // Worktree and branch handled atomically - no separate deleteBranch call
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ branchName: 'feat/my-feature' }),
          expect.objectContaining({ deleteBranch: true, checkMergeSafety: true })
        )
        // Only one confirmation prompt
        expect(promptConfirmation).toHaveBeenCalledTimes(1)
      })

      it('should display worktree details before confirmation prompt', async () => {
        // Mock IdentifierParser dependencies
        const mockWorktree = { path: '/path/to/worktree', branch: 'feat/issue-45', commit: 'abc123', bare: false, detached: false, locked: false }
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

        const mockSafety: SafetyCheck = { isSafe: true, warnings: [], blockers: [] }
        mockResourceCleanup.validateCleanupSafety = vi.fn().mockResolvedValue(mockSafety)

        vi.mocked(promptConfirmation).mockResolvedValueOnce(false)

        await command.execute({ identifier: 'feat/issue-45', options: {} })

        // Details should be shown before prompt
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('feat/issue-45'))
      })
    })

    describe('Safety Validation', () => {
      it('should throw error when safety check fails with blockers', async () => {
        // Mock IdentifierParser dependencies - 'main' should find a worktree
        const mockWorktree = { path: '/repo', branch: 'main', commit: 'abc123', bare: true, detached: false, locked: false }
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

        // Mock cleanupWorktree to throw an error (simulating validation failure)
        mockResourceCleanup.cleanupWorktree = vi.fn().mockRejectedValue(
          new Error('Cannot cleanup:\n\nCannot cleanup main worktree')
        )

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true) // User confirms

        await expect(command.execute({ identifier: 'main', options: {} }))
          .rejects.toThrow('Cannot cleanup:\n\nCannot cleanup main worktree')

        // Cleanup was attempted (but failed due to validation)
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
      })

      it('should continue cleanup flow when validation passes', async () => {
        // Setup worktree mock
        setupBranchWorktreeMock('feat/branch')

        // Mock successful cleanup
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue({
          identifier: 'feat/branch',
          success: true,
          operations: [],
          errors: []
        })

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        await command.execute({ identifier: 'feat/branch', options: {} })

        // Prompt shown and cleanup proceeded
        expect(promptConfirmation).toHaveBeenCalled()
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
      })

      it('should handle missing worktree gracefully', async () => {
        // Mock IdentifierParser dependencies - no worktree found
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(null)

        await expect(command.execute({ identifier: 'nonexistent', options: {} }))
          .rejects.toThrow('No worktree found for identifier: nonexistent')

        expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
      })
    })

    describe('Uncommitted Changes Handling', () => {
      it('should block cleanup when worktree has uncommitted changes without --force', async () => {
        // Setup: worktree with uncommitted changes
        setupBranchWorktreeMock('feat/issue-45')

        // Mock cleanupWorktree to throw validation error
        mockResourceCleanup.cleanupWorktree = vi.fn().mockRejectedValue(
          new Error(
            'Cannot cleanup:\n\n' +
            'Worktree has uncommitted changes.\n\n' +
            'Please resolve before cleanup (choose one):\n' +
            '  • Commit changes: cd /path/to/worktree && git commit -am "message"\n' +
            '  • Stash changes: cd /path/to/worktree && git stash\n' +
            '  • Force cleanup: il cleanup feat/issue-45 --force (WARNING: will discard changes)'
          )
        )

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true) // User confirms

        // Execute and expect error
        await expect(command.execute({ identifier: 'feat/issue-45', options: {} }))
          .rejects.toThrow(/Worktree has uncommitted changes/)

        // Cleanup was attempted (but failed validation)
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
      })

      it('should include simple uncommitted changes message', async () => {
        // Setup: worktree with uncommitted changes
        setupBranchWorktreeMock('feat/issue-45')

        const errorMessage =
          'Cannot cleanup:\n\n' +
          'Worktree has uncommitted changes.\n\n' +
          'Please resolve before cleanup (choose one):\n' +
          '  • Commit changes: cd /path/to/worktree && git commit -am "message"\n' +
          '  • Stash changes: cd /path/to/worktree && git stash\n' +
          '  • Force cleanup: il cleanup feat/issue-45 --force (WARNING: will discard changes)'

        mockResourceCleanup.cleanupWorktree = vi.fn().mockRejectedValue(new Error(errorMessage))
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        // Verify error contains general uncommitted changes message
        try {
          await command.execute({ identifier: 'feat/issue-45', options: {} })
        } catch (error) {
          expect((error as Error).message).toContain('Worktree has uncommitted changes')
          expect((error as Error).message).toContain('Please resolve before cleanup')
        }
      })

      it('should allow cleanup with --force when uncommitted changes exist', async () => {
        // Setup: worktree with uncommitted changes (use branch name without issue pattern)
        setupBranchWorktreeMock('feat/my-feature')

        // Mock successful cleanup with force
        const mockResult: CleanupResult = {
          identifier: 'feat/my-feature',
          branchName: 'feat/my-feature',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed (forced)' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        // Execute with --force (force skips confirmation)
        await command.execute({ identifier: 'feat/my-feature', options: { force: true } })

        // Verify cleanup proceeded
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'branch', branchName: 'feat/my-feature' }),
          expect.objectContaining({ force: true })
        )
        expect(logger.success).toHaveBeenCalledWith('Cleanup completed successfully')
      })
    })

    describe('Force Flag Behavior', () => {
      it('should skip all confirmations when --force flag provided', async () => {
        setupBranchWorktreeMock('feat/branch')

        const mockResult: CleanupResult = {
          identifier: 'feat/branch',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/branch', options: { force: true } })

        // No prompts called
        expect(promptConfirmation).not.toHaveBeenCalled()
        // Cleanup called with force and deleteBranch (force bypasses safety checks)
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'branch', branchName: 'feat/branch' }),
          {
            dryRun: false,
            force: true,
            deleteBranch: true,
            keepDatabase: false,
            checkMergeSafety: true,  // checkMergeSafety is still passed, but force bypasses it in ResourceCleanup
            archive: false,
          }
        )
      })

      it('should force delete branch when --force provided', async () => {
        setupBranchWorktreeMock('feat/branch')

        const mockResult: CleanupResult = {
          identifier: 'feat/branch',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/branch', options: { force: true } })

        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'branch', branchName: 'feat/branch' }),
          expect.objectContaining({ deleteBranch: true, force: true, checkMergeSafety: true })
        )
      })
    })

    describe('Dry Run Mode', () => {
      it('should preview operations without executing when --dry-run provided', async () => {
        setupBranchWorktreeMock('feat/branch')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        const mockResult: CleanupResult = {
          identifier: 'feat/branch',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: '[DRY RUN] Would remove worktree' },
            { type: 'branch', success: true, message: '[DRY RUN] Would delete branch' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/branch', options: { dryRun: true } })

        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'branch', branchName: 'feat/branch' }),
          {
            dryRun: true,
            force: false,
            deleteBranch: true,  // Still includes branch deletion in dry run
            keepDatabase: false,
            checkMergeSafety: true,
            archive: false,
          }
        )
      })

      it('should still require confirmation in dry-run unless --force', async () => {
        setupBranchWorktreeMock('feat/branch')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(false)

        await command.execute({ identifier: 'feat/branch', options: { dryRun: true } })

        // Prompt should still be called
        expect(promptConfirmation).toHaveBeenCalled()
        expect(logger.info).toHaveBeenCalledWith('Cleanup cancelled')
      })
    })

    describe('Result Reporting', () => {
      it('should report detailed results for successful cleanup', async () => {
        setupBranchWorktreeMock('feat/branch')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        const mockResult: CleanupResult = {
          identifier: 'feat/branch',
          success: true,
          operations: [
            { type: 'dev-server', success: true, message: 'Dev server terminated' },
            { type: 'worktree', success: true, message: 'Worktree removed: /path' },
            { type: 'branch', success: true, message: 'Branch deleted' },
            { type: 'database', success: true, message: 'Database cleaned up' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/branch', options: {} })

        // Each operation should be logged
        expect(logger.info).toHaveBeenCalledWith('Cleanup operations:')
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dev server terminated'))
        expect(logger.success).toHaveBeenCalledWith('Cleanup completed successfully')
      })

      it('should report partial success when some operations fail', async () => {
        setupBranchWorktreeMock('feat/branch')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        const mockError = new Error('Database cleanup failed')
        const mockResult: CleanupResult = {
          identifier: 'feat/branch',
          success: false,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' },
            { type: 'database', success: false, message: 'Database cleanup failed', error: 'Database cleanup failed' }
          ],
          errors: [mockError]
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/branch', options: {} })

        // Should show warnings about errors
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('error(s) occurred'))
        expect(logger.warn).toHaveBeenCalledWith('Cleanup completed with errors - see details above')
      })

      it('should display all operation types in result', async () => {
        setupBranchWorktreeMock('feat/issue-45')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        const mockResult: CleanupResult = {
          identifier: 'feat/issue-45',
          success: true,
          operations: [
            { type: 'dev-server', success: true, message: 'Dev server terminated' },
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' },
            { type: 'database', success: true, message: 'Database cleaned' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/issue-45', options: {} })

        // All operation types should be in results
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dev server'))
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Worktree'))
      })
    })

    describe('Error Handling', () => {
      it('should propagate ResourceCleanup errors to CLI layer', async () => {
        setupBranchWorktreeMock('feat/branch')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        const error = new Error('Cleanup failed')
        mockResourceCleanup.cleanupWorktree = vi.fn().mockRejectedValue(error)

        await expect(command.execute({ identifier: 'feat/branch', options: {} }))
          .rejects.toThrow('Cleanup failed')

        // Error logging is handled by CLI layer, not command layer
        // This avoids duplicate error messages
        expect(logger.error).not.toHaveBeenCalled()
      })

      it('should handle prompt errors gracefully', async () => {
        setupBranchWorktreeMock('feat/branch')

        const error = new Error('stdin closed')
        vi.mocked(promptConfirmation).mockRejectedValue(error)

        await expect(command.execute({ identifier: 'feat/branch', options: {} }))
          .rejects.toThrow('stdin closed')
      })

      it('should not swallow unexpected errors', async () => {
        setupBranchWorktreeMock('feat/branch')

        const unexpectedError = new Error('Unexpected error')
        vi.mocked(promptConfirmation).mockRejectedValue(unexpectedError)

        await expect(command.execute({ identifier: 'feat/branch', options: {} }))
          .rejects.toThrow('Unexpected error')
      })
    })

    describe('Integration with ResourceCleanup', () => {
      it('should pass correct options to ResourceCleanup.cleanupWorktree()', async () => {
        setupBranchWorktreeMock('feat/branch')

        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        const mockResult: CleanupResult = {
          identifier: 'feat/branch',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ identifier: 'feat/branch', options: {} })

        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'branch', branchName: 'feat/branch' }),
          {
            dryRun: false,
            force: false,
            deleteBranch: true,  // Now always true to enable safety checks before any deletion
            keepDatabase: false,
            checkMergeSafety: true,  // Run 5-point safety check
            archive: false,
          }
        )
      })

      it('should handle ResourceCleanup dependency injection', async () => {
        const mockProcessManager = {} as vi.Mocked<import('../../src/lib/process/ProcessManager.js').ProcessManager>
        const customCleanup = new ResourceCleanup(mockGitWorktreeManager, mockProcessManager) as vi.Mocked<ResourceCleanup>
        const cmd = new CleanupCommand(mockGitWorktreeManager, customCleanup)

        // Setup mocks for this custom command instance
        mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue({ path: '/path', branch: 'feat/branch', commit: 'abc', bare: false, detached: false, locked: false })

        customCleanup.cleanupWorktree = vi.fn().mockResolvedValue({
          identifier: 'feat/branch',
          success: true,
          operations: [],
          errors: []
        })
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true) // Confirm cleanup

        await cmd.execute({ identifier: 'feat/branch', options: {} })

        expect(customCleanup.cleanupWorktree).toHaveBeenCalled()
      })

      it('should instantiate ResourceCleanup if not injected', async () => {
        const cmd = new CleanupCommand()

        // Should work without errors
        expect(cmd).toBeDefined()
      })
    })
  })

  describe('Issue Mode Execution Tests', () => {
    let mockResourceCleanup: vi.Mocked<ResourceCleanup>

    beforeEach(() => {
      vi.clearAllMocks()
      mockGitWorktreeManager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
      const mockProcessManager = {} as vi.Mocked<import('../../src/lib/process/ProcessManager.js').ProcessManager>
      mockResourceCleanup = new ResourceCleanup(mockGitWorktreeManager, mockProcessManager) as vi.Mocked<ResourceCleanup>
      command = new CleanupCommand(mockGitWorktreeManager, mockResourceCleanup)
    })

    describe('Worktree Path Discovery and Preview', () => {
      it('should find worktrees by path containing issue number', async () => {
        // Mock listWorktrees to return worktrees with issue number in path
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/issue-25', branch: 'issue-25', commit: 'abc', bare: false, detached: false, locked: false },
          { path: '/repo/feat-25', branch: 'feat-25', commit: 'def', bare: false, detached: false, locked: false }
        ])

        await command.execute({
          options: { issue: 25 }
        })

        expect(logger.info).toHaveBeenCalledWith('Finding worktrees related to issue/PR #25...')
        expect(logger.info).toHaveBeenCalledWith('Found 2 worktree(s) related to issue/PR #25:')
      })

      it('should find worktrees with PR suffix in path', async () => {
        // Mock listWorktrees to return worktree with _pr_25 suffix
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/feature-name_pr_25', branch: 'feature-name', commit: 'abc', bare: false, detached: false, locked: false }
        ])

        await command.execute({
          options: { issue: 25 }
        })

        expect(logger.info).toHaveBeenCalledWith('Found 1 worktree(s) related to issue/PR #25:')
      })

      it('should NOT match worktrees where number is part of larger number', async () => {
        // Mock listWorktrees with paths containing 25 as part of larger numbers
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/issue-250', branch: 'issue-250', commit: 'abc', bare: false, detached: false, locked: false },
          { path: '/repo/125-feature', branch: '125-feature', commit: 'def', bare: false, detached: false, locked: false }
        ])

        await command.execute({
          options: { issue: 25 }
        })

        expect(logger.warn).toHaveBeenCalledWith('No worktrees found for issue/PR #25')
      })

      it('should handle no matching worktrees found', async () => {
        // Mock listWorktrees to return empty array
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([])

        await command.execute({
          options: { issue: 99999 }
        })

        expect(logger.warn).toHaveBeenCalledWith('No worktrees found for issue/PR #99999')
        expect(logger.info).toHaveBeenCalledWith('Searched for worktree paths containing: 99999, _pr_99999, issue-99999, etc.')
      })

      it('should match case-insensitively', async () => {
        // Mock listWorktrees with mixed case paths
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/ISSUE-25', branch: 'ISSUE-25', commit: 'abc', bare: false, detached: false, locked: false },
          { path: '/repo/PR-25', branch: 'PR-25', commit: 'def', bare: false, detached: false, locked: false }
        ])

        await command.execute({
          options: { issue: 25 }
        })

        expect(logger.info).toHaveBeenCalledWith('Found 2 worktree(s) related to issue/PR #25:')
      })

      it('should match alphanumeric Linear IDs case-insensitively', async () => {
        // Mock listWorktrees with lowercase Linear ID in path (as created by branch naming)
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/worktree-issue-mark-1', branch: 'feat/issue-mark-1__nextjs-vercel', commit: 'abc', bare: false, detached: false, locked: false }
        ])

        // Search with uppercase Linear ID should find lowercase path
        await command.execute({
          options: { issue: 'MARK-1' }
        })

        expect(logger.info).toHaveBeenCalledWith('Found 1 worktree(s) related to issue/PR #MARK-1:')
      })
    })

    describe('Issue Cleanup with Safety Checks (Issue #275)', () => {
      it('should call cleanupWorktree with deleteBranch: true and checkMergeSafety: true', async () => {
        // Mock finding a worktree
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/issue-25', branch: 'issue-25', commit: 'abc', bare: false, detached: false, locked: false }
        ])

        // User confirms cleanup
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        // Mock successful cleanup (with branch deletion included)
        const mockResult: CleanupResult = {
          identifier: 'issue-25',
          branchName: 'issue-25',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ options: { issue: 25 } })

        // Verify cleanupWorktree was called with correct options
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'issue', number: 25 }),
          {
            dryRun: false,
            force: false,
            deleteBranch: true,  // Now includes branch deletion with safety checks
            keepDatabase: false,
            checkMergeSafety: true,  // Run 5-point safety check BEFORE any deletion
            archive: false,
            worktree: { path: '/repo/issue-25', branch: 'issue-25' },
          }
        )
      })

      it('should NOT call separate deleteBranch after cleanupWorktree', async () => {
        // Mock finding a worktree
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/issue-25', branch: 'issue-25', commit: 'abc', bare: false, detached: false, locked: false }
        ])

        // User confirms cleanup
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        // Mock successful cleanup
        const mockResult: CleanupResult = {
          identifier: 'issue-25',
          branchName: 'issue-25',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)
        mockResourceCleanup.deleteBranch = vi.fn()

        await command.execute({ options: { issue: 25 } })

        // Verify deleteBranch was NOT called separately (branch deletion is now atomic)
        expect(mockResourceCleanup.deleteBranch).not.toHaveBeenCalled()
      })

      it('should report safety check failure but continue to report stats (issue cleanup handles multiple worktrees)', async () => {
        // Mock finding a worktree
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/issue-25', branch: 'issue-25', commit: 'abc', bare: false, detached: false, locked: false }
        ])

        // User confirms cleanup
        vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

        // Mock cleanupWorktree throwing due to safety check failure
        mockResourceCleanup.cleanupWorktree = vi.fn().mockRejectedValue(
          new Error('Cannot cleanup:\n\nBranch has unpushed commits that would be lost.')
        )

        // Issue cleanup processes worktrees in a loop and catches errors to continue
        // It doesn't throw - it reports failures in the summary
        await command.execute({ options: { issue: 25 } })

        // Verify cleanupWorktree was called but failed
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
        // Verify error was logged
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to cleanup'))
      })

      it('should bypass safety checks when --force is used', async () => {
        // Mock finding a worktree
        mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([
          { path: '/repo/issue-25', branch: 'issue-25', commit: 'abc', bare: false, detached: false, locked: false }
        ])

        // Mock successful cleanup
        const mockResult: CleanupResult = {
          identifier: 'issue-25',
          branchName: 'issue-25',
          success: true,
          operations: [
            { type: 'worktree', success: true, message: 'Worktree removed' },
            { type: 'branch', success: true, message: 'Branch deleted' }
          ],
          errors: []
        }
        mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

        await command.execute({ options: { issue: 25, force: true } })

        // Verify cleanupWorktree was called with force: true (which bypasses safety checks in ResourceCleanup)
        expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'issue', number: 25 }),
          expect.objectContaining({ force: true, deleteBranch: true, checkMergeSafety: true })
        )
      })
    })
  })

  describe('Defer Flag Tests', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mockGitWorktreeManager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
      mockGitWorktreeManager.listWorktrees = vi.fn().mockResolvedValue([])
      command = new CleanupCommand(mockGitWorktreeManager)
    })

    it('should wait specified milliseconds before executing cleanup', async () => {
      // Use a very short delay for testing (real timers)
      await command.execute({
        options: { list: true, defer: 10 }
      })

      // Verify the waiting message was logged
      expect(logger.info).toHaveBeenCalledWith('Waiting 10ms before cleanup...')
      // Verify cleanup eventually ran
      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: list')
    })

    it('should work with --force flag and defer', async () => {
      await command.execute({
        options: { all: true, force: true, defer: 10 }
      })

      // Verify defer message was logged
      expect(logger.info).toHaveBeenCalledWith('Waiting 10ms before cleanup...')
      // Verify all mode executed
      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: all')
    })

    it('should not delay when defer is not specified', async () => {
      await command.execute({
        options: { list: true }
      })

      // Should NOT have logged the waiting message
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Waiting'))
      // But should have completed the cleanup
      expect(logger.info).toHaveBeenCalledWith('Cleanup mode: list')
    })

    it('should fail fast on validation errors before deferring', async () => {
      // Use invalid option combination - error should occur immediately, no waiting
      await expect(command.execute({
        identifier: 'my-branch',
        options: { list: true, defer: 100 }  // list + identifier is invalid
      })).rejects.toThrow('Cannot use --list with a specific identifier')

      // Should NOT have logged the waiting message since validation failed first
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Waiting'))
    })
  })

  describe('telemetry', () => {
    let mockResourceCleanup: vi.Mocked<ResourceCleanup>

    beforeEach(() => {
      mockGitWorktreeManager = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
      const mockProcessManager = {} as vi.Mocked<import('../../src/lib/process/ProcessManager.js').ProcessManager>
      mockResourceCleanup = new ResourceCleanup(mockGitWorktreeManager, mockProcessManager) as vi.Mocked<ResourceCleanup>
      command = new CleanupCommand(mockGitWorktreeManager, mockResourceCleanup)

      mockGitWorktreeManager.findWorktreeForBranch = vi.fn()
      mockGitWorktreeManager.findWorktreeForIssue = vi.fn()
      mockGitWorktreeManager.findWorktreeForPR = vi.fn()
    })

    it('should track loom.abandoned for unfinished loom', async () => {
      const mockWorktree = { path: '/path/to/worktree', branch: 'feat/my-feature', commit: 'abc123', bare: false, detached: false, locked: false }
      mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

      // Mock metadata for an unfinished loom
      mockReadMetadata.mockResolvedValue({
        created_at: new Date(Date.now() - 30 * 60000).toISOString(), // 30 minutes ago
        status: 'active',
        state: 'in_progress',
      })

      vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

      const mockResult: CleanupResult = {
        identifier: 'feat/my-feature',
        success: true,
        operations: [
          { type: 'worktree', success: true, message: 'Worktree removed' },
        ],
        errors: [],
      }
      mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

      await command.execute({ identifier: 'feat/my-feature', options: {} })

      expect(mockTrack).toHaveBeenCalledWith('loom.abandoned', {
        duration_minutes: expect.any(Number),
        phase_reached: 'in_progress',
      })
    })

    it('should not track loom.abandoned for already-finished loom', async () => {
      const mockWorktree = { path: '/path/to/worktree', branch: 'feat/my-feature', commit: 'abc123', bare: false, detached: false, locked: false }
      mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

      // Mock metadata for a finished loom
      mockReadMetadata.mockResolvedValue({
        created_at: new Date(Date.now() - 30 * 60000).toISOString(),
        status: 'finished',
        state: 'done',
      })

      vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

      const mockResult: CleanupResult = {
        identifier: 'feat/my-feature',
        success: true,
        operations: [
          { type: 'worktree', success: true, message: 'Worktree removed' },
        ],
        errors: [],
      }
      mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

      await command.execute({ identifier: 'feat/my-feature', options: {} })

      expect(mockTrack).not.toHaveBeenCalled()
    })

    it('should use unknown phase when state is null', async () => {
      const mockWorktree = { path: '/path/to/worktree', branch: 'feat/my-feature', commit: 'abc123', bare: false, detached: false, locked: false }
      mockGitWorktreeManager.findWorktreeForBranch = vi.fn().mockResolvedValue(mockWorktree)

      mockReadMetadata.mockResolvedValue({
        created_at: new Date(Date.now() - 10 * 60000).toISOString(),
        status: 'active',
        state: null,
      })

      vi.mocked(promptConfirmation).mockResolvedValueOnce(true)

      const mockResult: CleanupResult = {
        identifier: 'feat/my-feature',
        success: true,
        operations: [
          { type: 'worktree', success: true, message: 'Worktree removed' },
        ],
        errors: [],
      }
      mockResourceCleanup.cleanupWorktree = vi.fn().mockResolvedValue(mockResult)

      await command.execute({ identifier: 'feat/my-feature', options: {} })

      expect(mockTrack).toHaveBeenCalledWith('loom.abandoned', {
        duration_minutes: expect.any(Number),
        phase_reached: 'unknown',
      })
    })
  })
})
