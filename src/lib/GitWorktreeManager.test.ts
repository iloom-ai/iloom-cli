import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import fs from 'fs-extra'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { MockFactories } from '../test-utils/mock-factories.js'
import * as gitUtils from '../utils/git.js'
import type { SettingsManager } from './SettingsManager.js'

// Mock the git utils module
vi.mock('../utils/git.js', () => ({
  executeGitCommand: vi.fn(),
  parseWorktreeList: vi.fn(),
  isPRBranch: vi.fn(),
  extractPRNumber: vi.fn(),
  generateWorktreePath: vi.fn(),
  isValidGitRepo: vi.fn(),
  getCurrentBranch: vi.fn(),
  getRepoRoot: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  getDefaultBranch: vi.fn(),
  findMainWorktreePathWithSettings: vi.fn(),
}))

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    remove: vi.fn(),
  },
  pathExists: vi.fn(),
  remove: vi.fn(),
}))

describe('GitWorktreeManager', () => {
  let manager: GitWorktreeManager
  let mockSettingsManager: SettingsManager
  const mockRepoPath = '/test/repo'

  beforeEach(() => {
    manager = new GitWorktreeManager(mockRepoPath)
    mockSettingsManager = {
      loadSettings: vi.fn().mockResolvedValue({}),
      getProtectedBranches: vi.fn().mockResolvedValue(['main', 'master', 'develop']),
    } as unknown as SettingsManager
    MockFactories.resetAll()
    vi.clearAllMocks()
  })

  describe('listWorktrees', () => {
    it('should list worktrees successfully', async () => {
      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-feature',
          branch: 'feature-branch',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock worktree output')

      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.listWorktrees()

      expect(result).toEqual(mockWorktrees)
      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(['worktree', 'list', '--porcelain'], {
        cwd: mockRepoPath,
      })
      expect(gitUtils.parseWorktreeList).toHaveBeenCalledWith('mock worktree output')
    })

    it('should include porcelain flag when requested', async () => {
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([])

      await manager.listWorktrees({ porcelain: true })

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(['worktree', 'list', '--porcelain'], {
        cwd: mockRepoPath,
      })
    })

    it('should include verbose flag when requested', async () => {
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([])

      await manager.listWorktrees({ verbose: true })

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-v'], {
        cwd: mockRepoPath,
      })
    })

    it('should throw error when git command fails', async () => {
      vi.mocked(gitUtils.executeGitCommand).mockRejectedValue(
        new Error('Git command failed: Git command failed')
      )

      await expect(manager.listWorktrees()).rejects.toThrow('Git command failed')
    })
  })

  describe('findWorktreeForBranch', () => {
    it('should find worktree for existing branch', async () => {
      const targetWorktree = {
        path: '/test/worktree-feature',
        branch: 'feature-branch',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForBranch('feature-branch')

      expect(result).toEqual(targetWorktree)
    })

    it('should return null for non-existent branch', async () => {
      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForBranch('non-existent')

      expect(result).toBeNull()
    })
  })

  describe('isPRWorktree', () => {
    it('should identify PR worktree correctly', () => {
      const worktree = {
        path: '/test/worktree-pr-123',
        branch: 'pr/123',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.isPRBranch).mockReturnValue(true)

      const result = manager.isPRWorktree(worktree)

      expect(result).toBe(true)
      expect(gitUtils.isPRBranch).toHaveBeenCalledWith('pr/123')
    })

    it('should identify non-PR worktree correctly', () => {
      const worktree = {
        path: '/test/worktree-feature',
        branch: 'feature-branch',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.isPRBranch).mockReturnValue(false)

      const result = manager.isPRWorktree(worktree)

      expect(result).toBe(false)
      expect(gitUtils.isPRBranch).toHaveBeenCalledWith('feature-branch')
    })
  })

  describe('getPRNumberFromWorktree', () => {
    it('should extract PR number correctly', () => {
      const worktree = {
        path: '/test/worktree-pr-123',
        branch: 'pr/123',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.extractPRNumber).mockReturnValue(123)

      const result = manager.getPRNumberFromWorktree(worktree)

      expect(result).toBe(123)
      expect(gitUtils.extractPRNumber).toHaveBeenCalledWith('pr/123')
    })

    it('should return null for non-PR worktree', () => {
      const worktree = {
        path: '/test/worktree-feature',
        branch: 'feature-branch',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.extractPRNumber).mockReturnValue(null)

      const result = manager.getPRNumberFromWorktree(worktree)

      expect(result).toBeNull()
      expect(gitUtils.extractPRNumber).toHaveBeenCalledWith('feature-branch')
    })
  })

  describe('createWorktree', () => {
    it('should create worktree successfully', async () => {
      const options = {
        path: '/test/new-worktree',
        branch: 'new-feature',
        createBranch: true,
        baseBranch: 'main',
      }

      vi.mocked(fs.pathExists).mockResolvedValue(false)
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree created successfully')

      const result = await manager.createWorktree(options)

      expect(result).toBe(path.resolve('/test/new-worktree'))
      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'add', '-b', 'new-feature', path.resolve('/test/new-worktree'), 'main'],
        { cwd: mockRepoPath }
      )
    })

    it('should throw when branch name is missing', async () => {
      const options = {
        path: '/test/new-worktree',
        branch: '',
      }

      await expect(manager.createWorktree(options)).rejects.toThrow('Branch name is required')
    })

    it('should throw when path exists and force is false', async () => {
      const options = {
        path: '/test/existing-path',
        branch: 'new-feature',
      }

      vi.mocked(fs.pathExists).mockResolvedValue(true)

      await expect(manager.createWorktree(options)).rejects.toThrow('Path already exists')
    })

    it('should remove existing path when force is true', async () => {
      const options = {
        path: '/test/existing-path',
        branch: 'new-feature',
        force: true,
      }

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.remove).mockResolvedValue()
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree created')

      const result = await manager.createWorktree(options)

      expect(result).toBe(path.resolve('/test/existing-path'))
      expect(fs.remove).toHaveBeenCalledWith(path.resolve('/test/existing-path'))
    })

    it('should create worktree from existing branch', async () => {
      const options = {
        path: '/test/new-worktree',
        branch: 'existing-branch',
        createBranch: false,
      }

      vi.mocked(fs.pathExists).mockResolvedValue(false)
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree created')

      await manager.createWorktree(options)

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'add', path.resolve('/test/new-worktree'), 'existing-branch'],
        { cwd: mockRepoPath }
      )
    })
  })

  describe('removeWorktree', () => {
    it('should remove worktree successfully', async () => {
      const worktreePath = '/test/worktree-feature'
      const mockWorktrees = [
        {
          path: worktreePath,
          branch: 'feature-branch',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree removed')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)
      vi.mocked(gitUtils.hasUncommittedChanges).mockResolvedValue(false)

      await manager.removeWorktree(worktreePath)

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'remove', worktreePath],
        {
          cwd: mockRepoPath,
        }
      )
    })

    it('should throw when worktree not found', async () => {
      const worktreePath = '/test/non-existent'

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([])

      await expect(manager.removeWorktree(worktreePath)).rejects.toThrow('Worktree not found')
    })

    it('should throw when worktree has uncommitted changes without force', async () => {
      const worktreePath = '/test/worktree-feature'
      const mockWorktrees = [
        {
          path: worktreePath,
          branch: 'feature-branch',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)
      vi.mocked(gitUtils.hasUncommittedChanges).mockResolvedValue(true)

      await expect(manager.removeWorktree(worktreePath)).rejects.toThrow('uncommitted changes')
    })

    it('should perform dry run when requested', async () => {
      const worktreePath = '/test/worktree-feature'
      const mockWorktrees = [
        {
          path: worktreePath,
          branch: 'feature-branch',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.removeWorktree(worktreePath, { dryRun: true })

      expect(result).toContain('Would perform')
    })

    it('should remove directory when removeDirectory option is true', async () => {
      const worktreePath = '/test/worktree-feature'
      const mockWorktrees = [
        {
          path: worktreePath,
          branch: 'feature-branch',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree removed')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)
      vi.mocked(gitUtils.hasUncommittedChanges).mockResolvedValue(false)
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.remove).mockResolvedValue()

      await manager.removeWorktree(worktreePath, { removeDirectory: true })

      expect(fs.remove).toHaveBeenCalledWith(worktreePath)
    })

    it('should use porcelain format consistently for worktree lookup', async () => {
      const worktreePath = '/test/worktree-feature'
      const mockWorktrees = [
        {
          path: worktreePath,
          branch: 'feature-branch',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      // Mock the git command execution for porcelain output
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree removed')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)
      vi.mocked(gitUtils.hasUncommittedChanges).mockResolvedValue(false)

      await manager.removeWorktree(worktreePath)

      // Verify that listWorktrees was called with porcelain: true
      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'list', '--porcelain'],
        { cwd: mockRepoPath }
      )

      // Verify worktree removal was attempted
      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'remove', worktreePath],
        { cwd: mockRepoPath }
      )
    })
  })

  describe('validateWorktree', () => {
    it('should validate healthy worktree', async () => {
      const worktreePath = '/test/worktree-feature'
      const mockWorktrees = [
        {
          path: worktreePath,
          branch: 'feature-branch',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(gitUtils.isValidGitRepo).mockResolvedValue(true)
      vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('feature-branch')
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.validateWorktree(worktreePath)

      expect(result.isValid).toBe(true)
      expect(result.issues).toHaveLength(0)
      expect(result.existsOnDisk).toBe(true)
      expect(result.isValidRepo).toBe(true)
      expect(result.hasValidBranch).toBe(true)
    })

    it('should identify missing directory', async () => {
      const worktreePath = '/test/missing-worktree'

      vi.mocked(fs.pathExists).mockResolvedValue(false)
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([])

      const result = await manager.validateWorktree(worktreePath)

      expect(result.isValid).toBe(false)
      expect(result.issues).toContain('Worktree directory does not exist on disk')
      expect(result.issues).toContain('Worktree is not registered with Git')
      expect(result.existsOnDisk).toBe(false)
    })

    it('should identify invalid Git repository', async () => {
      const worktreePath = '/test/invalid-repo'

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(gitUtils.isValidGitRepo).mockResolvedValue(false)
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([])

      const result = await manager.validateWorktree(worktreePath)

      expect(result.isValid).toBe(false)
      expect(result.issues).toContain('Directory is not a valid Git repository')
      expect(result.isValidRepo).toBe(false)
    })
  })

  describe('getWorktreeStatus', () => {
    it('should get worktree status successfully', async () => {
      const worktreePath = '/test/worktree-feature'

      vi.mocked(gitUtils.executeGitCommand)
        .mockResolvedValueOnce(' M file1.txt\n?? file2.txt\nA  file3.txt')
        .mockResolvedValueOnce('0\t1')

      vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('feature-branch')

      const result = await manager.getWorktreeStatus(worktreePath)

      expect(result.modified).toBe(1)
      expect(result.untracked).toBe(1)
      expect(result.staged).toBe(1)
      expect(result.hasChanges).toBe(true)
      expect(result.branch).toBe('feature-branch')
      expect(result.detached).toBe(false)
      expect(result.behind).toBe(0)
      expect(result.ahead).toBe(1)
    })

    it('should handle empty status', async () => {
      const worktreePath = '/test/clean-worktree'

      vi.mocked(gitUtils.executeGitCommand)
        .mockResolvedValueOnce('')
        .mockRejectedValueOnce(new Error('No upstream'))

      vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('main')

      const result = await manager.getWorktreeStatus(worktreePath)

      expect(result.modified).toBe(0)
      expect(result.untracked).toBe(0)
      expect(result.staged).toBe(0)
      expect(result.hasChanges).toBe(false)
      expect(result.branch).toBe('main')
      expect(result.ahead).toBe(0)
      expect(result.behind).toBe(0)
    })
  })

  describe('generateWorktreePath', () => {
    it('should generate worktree path', () => {
      const branchName = 'feature-branch'
      const expectedPath = '/expected/path'

      vi.mocked(gitUtils.generateWorktreePath).mockReturnValue(expectedPath)

      const result = manager.generateWorktreePath(branchName)

      expect(result).toBe(expectedPath)
      expect(gitUtils.generateWorktreePath).toHaveBeenCalledWith(branchName, mockRepoPath, undefined)
    })

    it('should use custom root when provided', () => {
      const branchName = 'feature-branch'
      const customRoot = '/custom/root'
      const expectedPath = '/custom/path'

      vi.mocked(gitUtils.generateWorktreePath).mockReturnValue(expectedPath)

      const result = manager.generateWorktreePath(branchName, customRoot)

      expect(result).toBe(expectedPath)
      expect(gitUtils.generateWorktreePath).toHaveBeenCalledWith(branchName, customRoot, undefined)
    })
  })

  describe('isRepoReady', () => {
    it('should return true for valid repository', async () => {
      vi.mocked(gitUtils.getRepoRoot).mockResolvedValue('/test/repo')

      const result = await manager.isRepoReady()

      expect(result).toBe(true)
    })

    it('should return false for invalid repository', async () => {
      vi.mocked(gitUtils.getRepoRoot).mockResolvedValue(null)

      const result = await manager.isRepoReady()

      expect(result).toBe(false)
    })

    it('should return false when getRepoRoot throws', async () => {
      vi.mocked(gitUtils.getRepoRoot).mockRejectedValue(new Error('Git error'))

      const result = await manager.isRepoReady()

      expect(result).toBe(false)
    })
  })

  describe('getRepoInfo', () => {
    it('should get repository information', async () => {
      vi.mocked(gitUtils.getRepoRoot).mockResolvedValue('/test/repo')
      vi.mocked(gitUtils.getDefaultBranch).mockResolvedValue('main')
      vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('feature-branch')

      const result = await manager.getRepoInfo()

      expect(result.root).toBe('/test/repo')
      expect(result.defaultBranch).toBe('main')
      expect(result.currentBranch).toBe('feature-branch')
    })
  })

  describe('pruneWorktrees', () => {
    it('should prune stale worktrees', async () => {
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Pruned worktrees')

      await manager.pruneWorktrees()

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(['worktree', 'prune', '-v'], {
        cwd: mockRepoPath,
      })
    })
  })

  describe('lockWorktree', () => {
    it('should lock worktree without reason', async () => {
      const worktreePath = '/test/worktree'

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree locked')

      await manager.lockWorktree(worktreePath)

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(['worktree', 'lock', worktreePath], {
        cwd: mockRepoPath,
      })
    })

    it('should lock worktree with reason', async () => {
      const worktreePath = '/test/worktree'
      const reason = 'Under maintenance'

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree locked')

      await manager.lockWorktree(worktreePath, reason)

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'lock', worktreePath, '--reason', reason],
        { cwd: mockRepoPath }
      )
    })
  })

  describe('unlockWorktree', () => {
    it('should unlock worktree', async () => {
      const worktreePath = '/test/worktree'

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('Worktree unlocked')

      await manager.unlockWorktree(worktreePath)

      expect(gitUtils.executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'unlock', worktreePath],
        {
          cwd: mockRepoPath,
        }
      )
    })
  })

  describe('sanitizeBranchName', () => {
    it('should replace slashes with dashes', () => {
      const result = manager.sanitizeBranchName('feature/my-branch')
      expect(result).toBe('feature-my-branch')
    })

    it('should handle complex branch names', () => {
      const result = manager.sanitizeBranchName('feature/ISSUE-123/add_new@feature!')
      expect(result).toBe('feature-issue-123-add-new-feature')
    })

    it('should collapse multiple dashes', () => {
      const result = manager.sanitizeBranchName('feature///branch')
      expect(result).toBe('feature-branch')
    })

    it('should remove leading and trailing dashes', () => {
      const result = manager.sanitizeBranchName('-feature-branch-')
      expect(result).toBe('feature-branch')
    })

    it('should convert to lowercase', () => {
      const result = manager.sanitizeBranchName('FEATURE/Branch')
      expect(result).toBe('feature-branch')
    })

    it('should handle branch names with underscores', () => {
      const result = manager.sanitizeBranchName('feature_branch_name')
      expect(result).toBe('feature-branch-name')
    })

    it('should handle branch names with dots', () => {
      const result = manager.sanitizeBranchName('release/v1.2.3')
      expect(result).toBe('release-v1-2-3')
    })

    it('should handle already sanitized branch names', () => {
      const result = manager.sanitizeBranchName('feature-branch')
      expect(result).toBe('feature-branch')
    })
  })

  describe('generateWorktreePath with PR suffix', () => {
    it('should add PR suffix when specified', () => {
      vi.mocked(gitUtils.generateWorktreePath).mockReturnValue('/test/parent/feature-branch_pr_123')

      const result = manager.generateWorktreePath('feature/branch', undefined, {
        isPR: true,
        prNumber: 123
      })

      expect(result).toBe('/test/parent/feature-branch_pr_123')
      expect(gitUtils.generateWorktreePath).toHaveBeenCalledWith(
        'feature/branch',
        mockRepoPath,
        { isPR: true, prNumber: 123 }
      )
    })

    it('should not add PR suffix for regular branches', () => {
      vi.mocked(gitUtils.generateWorktreePath).mockReturnValue('/test/parent/feature-branch')

      const result = manager.generateWorktreePath('feature/branch')

      expect(result).toBe('/test/parent/feature-branch')
      expect(gitUtils.generateWorktreePath).toHaveBeenCalledWith(
        'feature/branch',
        mockRepoPath,
        undefined
      )
    })

    it('should handle PR suffix with custom root', () => {
      vi.mocked(gitUtils.generateWorktreePath).mockReturnValue('/custom/root/hotfix-123_pr_456')

      const result = manager.generateWorktreePath('hotfix/123', '/custom/root', {
        isPR: true,
        prNumber: 456
      })

      expect(result).toBe('/custom/root/hotfix-123_pr_456')
      expect(gitUtils.generateWorktreePath).toHaveBeenCalledWith(
        'hotfix/123',
        '/custom/root',
        { isPR: true, prNumber: 456 }
      )
    })
  })

  describe('findWorktreeForIssue', () => {
    it('should find worktree matching issue-{N} pattern', async () => {
      const targetWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
        {
          path: '/test/worktree-issue-390',
          branch: 'issue-390',
          commit: 'ghi789',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(39)

      expect(result).toEqual(targetWorktree)
    })

    it('should find worktree matching issue-{N}-{suffix} pattern', async () => {
      const targetWorktree = {
        path: '/test/worktree-issue-39-interactive-prompts',
        branch: 'issue-39-interactive-prompts',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(39)

      expect(result).toEqual(targetWorktree)
    })

    it('should not match partial issue numbers', async () => {
      const mockWorktrees = [
        {
          path: '/test/worktree-issue-123',
          branch: 'issue-123',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-issue-12',
          branch: 'issue-12',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-issue-1',
          branch: 'issue-1',
          commit: 'ghi789',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(12)

      expect(result).toEqual(mockWorktrees[1])
      expect(result?.branch).toBe('issue-12')
    })

    it('should return null when no matching worktree found', async () => {
      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-feature',
          branch: 'feature-branch',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(99)

      expect(result).toBeNull()
    })

    it('should handle single digit issue numbers correctly', async () => {
      const targetWorktree = {
        path: '/test/worktree-issue-5',
        branch: 'issue-5',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        targetWorktree,
        {
          path: '/test/worktree-issue-50',
          branch: 'issue-50',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-issue-500',
          branch: 'issue-500',
          commit: 'ghi789',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(5)

      expect(result).toEqual(targetWorktree)
      expect(result?.branch).toBe('issue-5')
    })

    it('should find worktree with issue number after slash (like feat/issue-44-feature)', async () => {
      const targetWorktree = {
        path: '/test/worktree-feat-issue-44',
        branch: 'feat/issue-44-worktree-cleanup',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
        {
          path: '/test/worktree-tissue',
          branch: 'tissue-44', // Should NOT match
          commit: 'ghi789',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(44)

      expect(result).toEqual(targetWorktree)
      expect(result?.branch).toBe('feat/issue-44-worktree-cleanup')
    })

    it('should find worktree with issue number after dash or underscore', async () => {
      const dashTargetWorktree = {
        path: '/test/worktree-feat-issue-44',
        branch: 'feat-issue-44-cleanup',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const underscoreTargetWorktree = {
        path: '/test/worktree-bugfix-issue-55',
        branch: 'bugfix_issue-55',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      // Test dash separator
      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([dashTargetWorktree])

      const dashResult = await manager.findWorktreeForIssue(44)
      expect(dashResult).toEqual(dashTargetWorktree)
      expect(dashResult?.branch).toBe('feat-issue-44-cleanup')

      // Test underscore separator
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue([underscoreTargetWorktree])

      const underscoreResult = await manager.findWorktreeForIssue(55)
      expect(underscoreResult).toEqual(underscoreTargetWorktree)
      expect(underscoreResult?.branch).toBe('bugfix_issue-55')
    })

    it('should not match issue number when not at start or after slash', async () => {
      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-tissue',
          branch: 'tissue-44', // Should NOT match
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-myissue',
          branch: 'myissue-44', // Should NOT match
          commit: 'ghi789',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForIssue(44)

      expect(result).toBeNull()
    })
  })

  describe('isMainWorktree', () => {
    it('should return true when worktree path matches findMainWorktreePathWithSettings result', async () => {
      const mainWorktree = {
        path: '/test/repo',
        branch: 'main',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.findMainWorktreePathWithSettings).mockResolvedValue('/test/repo')

      const result = await manager.isMainWorktree(mainWorktree, mockSettingsManager)

      expect(result).toBe(true)
      expect(gitUtils.findMainWorktreePathWithSettings).toHaveBeenCalledWith(mainWorktree.path, mockSettingsManager)
    })

    it('should return false when worktree path does not match main worktree path', async () => {
      const featureWorktree = {
        path: '/test/worktree-feature',
        branch: 'feature-branch',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.findMainWorktreePathWithSettings).mockResolvedValue('/test/repo')

      const result = await manager.isMainWorktree(featureWorktree, mockSettingsManager)

      expect(result).toBe(false)
      expect(gitUtils.findMainWorktreePathWithSettings).toHaveBeenCalledWith(featureWorktree.path, mockSettingsManager)
    })

    it('should correctly identify main vs non-main worktrees', async () => {
      const mainWorktree = {
        path: '/test/repo',
        branch: 'main',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const featureWorktree1 = {
        path: '/test/worktree-1',
        branch: 'feature-1',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      const featureWorktree2 = {
        path: '/test/worktree-2',
        branch: 'feature-2',
        commit: 'ghi789',
        bare: false,
        detached: false,
        locked: false,
      }

      // All calls return the main worktree path
      vi.mocked(gitUtils.findMainWorktreePathWithSettings).mockResolvedValue('/test/repo')

      const result0 = await manager.isMainWorktree(mainWorktree, mockSettingsManager)
      const result1 = await manager.isMainWorktree(featureWorktree1, mockSettingsManager)
      const result2 = await manager.isMainWorktree(featureWorktree2, mockSettingsManager)

      expect(result0).toBe(true)
      expect(result1).toBe(false)
      expect(result2).toBe(false)
    })

    it('should pass settingsManager to findMainWorktreePathWithSettings', async () => {
      const worktree = {
        path: '/test/repo',
        branch: 'main',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.findMainWorktreePathWithSettings).mockResolvedValue('/test/repo')

      await manager.isMainWorktree(worktree, mockSettingsManager)

      expect(gitUtils.findMainWorktreePathWithSettings).toHaveBeenCalledWith('/test/repo', mockSettingsManager)
    })

    it('should use worktree path for settings lookup', async () => {
      const worktree = {
        path: '/custom/path/worktree',
        branch: 'feature',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(gitUtils.findMainWorktreePathWithSettings).mockResolvedValue('/custom/path/main')

      const result = await manager.isMainWorktree(worktree, mockSettingsManager)

      expect(result).toBe(false)
      expect(gitUtils.findMainWorktreePathWithSettings).toHaveBeenCalledWith('/custom/path/worktree', mockSettingsManager)
    })
  })

  describe('findWorktreeForPR', () => {
    it('should find worktree by PR branch name', async () => {
      const targetWorktree = {
        path: '/test/worktree-feat-test-feature',
        branch: 'feat/test-feature',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForPR(42, 'feat/test-feature')

      expect(result).toEqual(targetWorktree)
    })

    it('should find worktree by path pattern with _pr_ suffix', async () => {
      const targetWorktree = {
        path: '/test/parent/feat-test-feature_pr_42',
        branch: 'feat/test-feature',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForPR(42, 'feat/test-feature')

      expect(result).toEqual(targetWorktree)
    })

    it('should prioritize exact branch name match over path pattern', async () => {
      const exactMatchWorktree = {
        path: '/test/parent/feat-test',
        branch: 'feat/test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const pathMatchWorktree = {
        path: '/test/parent/different-branch_pr_42',
        branch: 'different/branch',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [pathMatchWorktree, exactMatchWorktree]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForPR(42, 'feat/test')

      expect(result).toEqual(exactMatchWorktree)
    })

    it('should return null when PR branch not found', async () => {
      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/worktree-feature',
          branch: 'feature-branch',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForPR(99, 'nonexistent-branch')

      expect(result).toBeNull()
    })

    it('should handle complex PR branch names with slashes', async () => {
      const targetWorktree = {
        path: '/test/parent/feat-new-awesome-feature_pr_123',
        branch: 'feat/new/awesome-feature',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      const mockWorktrees = [
        {
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
        targetWorktree,
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForPR(123, 'feat/new/awesome-feature')

      expect(result).toEqual(targetWorktree)
    })

    it('should not match PR number in path for different PR', async () => {
      const mockWorktrees = [
        {
          path: '/test/parent/feat-test_pr_42',
          branch: 'feat/test',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/test/parent/fix-bug_pr_100',
          branch: 'fix/bug',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(gitUtils.executeGitCommand).mockResolvedValue('mock output')
      vi.mocked(gitUtils.parseWorktreeList).mockReturnValue(mockWorktrees)

      const result = await manager.findWorktreeForPR(99, 'feat/other')

      expect(result).toBeNull()
    })
  })
})
