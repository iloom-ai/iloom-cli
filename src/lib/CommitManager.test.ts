import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CommitManager } from './CommitManager.js'
import * as git from '../utils/git.js'
import * as claude from '../utils/claude.js'
import * as prompt from '../utils/prompt.js'
import * as vscode from '../utils/vscode.js'
import { getLogger } from '../utils/logger-context.js'
import { UserAbortedCommitError } from '../types/index.js'

// Mock dependencies
vi.mock('../utils/git.js')
vi.mock('../utils/claude.js')
vi.mock('../utils/prompt.js')
vi.mock('../utils/vscode.js')
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('Test commit message\n\n# comment line'),
  unlink: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('../utils/logger-context.js', () => {
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    isDebugEnabled: () => false,
  }
  return {
    getLogger: () => mockLogger,
  }
})

// Mock git status outputs for different scenarios
const mockGitStatus = {
  clean: '',
  unstagedOnly: ' M file1.ts\n?? file2.ts',
  stagedOnly: 'M  file1.ts\nA  file2.ts',
  mixed: 'MM file1.ts\n M file2.ts\nA  file3.ts',
  allTypes: 'M  staged.ts\n M unstaged.ts\nMM both.ts\nA  added.ts\nD  deleted.ts\n?? untracked.ts',
  renamedFile: 'R  old.ts -> new.ts',
  fileWithSpaces: 'M  file with spaces.ts',
}

describe('CommitManager', () => {
  let manager: CommitManager
  const mockWorktreePath = '/mock/worktree/path'

  beforeEach(() => {
    manager = new CommitManager()
    vi.clearAllMocks()
    // Default to 'edit' action to maintain backward compatibility with existing tests
    // that expect the editor flow (git commit -e -m)
    vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
    // Default VSCode mocks - not running in VSCode by default
    vi.mocked(vscode.isRunningInVSCode).mockReturnValue(false)
    vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(false)
    // Default Cursor mocks - not running in Cursor by default
    vi.mocked(vscode.isRunningInCursor).mockReturnValue(false)
    vi.mocked(vscode.isCursorAvailable).mockResolvedValue(false)
    // Default Antigravity mocks - not running in Antigravity by default
    vi.mocked(vscode.isRunningInAntigravity).mockReturnValue(false)
    vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Git Status Parsing', () => {
    it('should parse unstaged files from git status --porcelain output', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.unstagedOnly)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.unstagedFiles).toEqual(['file1.ts', 'file2.ts'])
      expect(result.stagedFiles).toEqual([])
      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should parse staged files from git status --porcelain output', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.stagedOnly)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toEqual(['file1.ts', 'file2.ts'])
      expect(result.unstagedFiles).toEqual([])
      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should parse mixed staged and unstaged files', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.mixed)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toEqual(['file1.ts', 'file3.ts'])
      expect(result.unstagedFiles).toEqual(['file1.ts', 'file2.ts'])
      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should return empty arrays when repository is clean', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.clean)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toEqual([])
      expect(result.unstagedFiles).toEqual([])
      expect(result.hasUncommittedChanges).toBe(false)
    })

    it('should handle all git status codes (M, A, D, R, C, ??)', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.allTypes)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toEqual(['staged.ts', 'both.ts', 'added.ts', 'deleted.ts'])
      expect(result.unstagedFiles).toEqual(['unstaged.ts', 'both.ts', 'untracked.ts'])
      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should correctly parse filenames with spaces', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.fileWithSpaces)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toEqual(['file with spaces.ts'])
    })

    it('should handle renamed files (R status)', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(mockGitStatus.renamedFile)
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toContain('old.ts -> new.ts')
    })

    it('should categorize untracked files (??) as unstaged', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('?? untracked.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.unstagedFiles).toContain('untracked.ts')
      expect(result.stagedFiles).toEqual([])
    })

    it('should throw when git command fails', async () => {
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Git command failed'))

      await expect(manager.detectUncommittedChanges(mockWorktreePath)).rejects.toThrow(
        'Git command failed'
      )
    })
  })

  describe('Uncommitted Change Detection', () => {
    it('should detect uncommitted changes when files are unstaged', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(' M file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should detect uncommitted changes when files are staged', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should detect uncommitted changes when files are mixed', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('MM file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.hasUncommittedChanges).toBe(true)
    })

    it('should return hasUncommittedChanges=false when repository is clean', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.hasUncommittedChanges).toBe(false)
    })

    it('should populate unstagedFiles array correctly', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce(' M file1.ts\n M file2.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.unstagedFiles).toEqual(['file1.ts', 'file2.ts'])
    })

    it('should populate stagedFiles array correctly', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file1.ts\nA  file2.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.stagedFiles).toEqual(['file1.ts', 'file2.ts'])
    })

    it('should get current branch name', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('feature-branch')

      const result = await manager.detectUncommittedChanges(mockWorktreePath)

      expect(result.currentBranch).toBe('feature-branch')
    })

    it('should execute git command in correct worktree path', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      await manager.detectUncommittedChanges(mockWorktreePath)

      expect(git.executeGitCommand).toHaveBeenCalledWith(['status', '--porcelain'], {
        cwd: mockWorktreePath,
      })
    })
  })

  describe('Commit Message Generation', () => {
    it('should generate WIP message with issue number and Fixes trailer', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issueNumber: 123,
        issuePrefix: '#',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #123\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should use empty prefix for Linear issues', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issueNumber: 'ENG-123',
        issuePrefix: '',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue ENG-123\n\nFixes ENG-123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should use # prefix by default (GitHub)', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issueNumber: 456,
        issuePrefix: '#',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #456\n\nFixes #456'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should generate WIP message without issue number when none provided', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should use custom message when provided in options', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        message: 'Custom commit message',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'Custom commit message'],
        { cwd: mockWorktreePath }
      )
    })

    it('should format message with proper newlines', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issueNumber: 456,
        issuePrefix: '#',
        dryRun: false,
      })

      const commitCall = vi.mocked(git.executeGitCommand).mock.calls.find(
        (call) => call[0][0] === 'commit'
      )
      const message = commitCall?.[0][3]
      expect(message).toContain('\n\n')
    })

    it('should handle edge cases (very large issue numbers)', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issueNumber: 999999999,
        issuePrefix: '#',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #999999999\n\nFixes #999999999'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })
  })

  describe('Auto-Staging and Commit', () => {
    it('should stage all changes with git add -A', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(['add', '-A'], {
        cwd: mockWorktreePath,
      })
    })

    it('should commit with generated message', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should commit with custom message when provided', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        message: 'Test message',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(['commit', '-m', 'Test message'], {
        cwd: mockWorktreePath,
      })
    })

    it('should throw when git add fails', async () => {
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Add failed'))

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        'Add failed'
      )
    })

    it('should throw when git commit fails', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Commit failed'))

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        'Commit failed'
      )
    })

    it('should handle empty commit scenario gracefully', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(
        new Error('nothing to commit, working tree clean')
      )

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).resolves.not.toThrow()
    })

    it('should call git add before git commit', async () => {
      const callOrder: string[] = []
      vi.mocked(git.executeGitCommand).mockImplementation(async (args) => {
        callOrder.push(args[0])
        return ''
      })

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const addIndex = callOrder.indexOf('add')
      const commitIndex = callOrder.indexOf('commit')
      expect(addIndex).toBeLessThan(commitIndex)
    })

    it('should execute commands in correct worktree path', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const calls = vi.mocked(git.executeGitCommand).mock.calls
      const addCall = calls.find(call => call[0][0] === 'add')
      const commitCall = calls.find(call => call[0][0] === 'commit')

      expect(addCall?.[1]).toEqual({ cwd: mockWorktreePath })
      expect(commitCall?.[1]).toEqual({ cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 })
    })
  })

  describe('Dry-Run Mode', () => {
    it('should detect changes without staging in dry-run mode', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true })

      const gitCalls = vi.mocked(git.executeGitCommand).mock.calls
      const hasAddCall = gitCalls.some((call) => call[0][0] === 'add')
      const hasCommitCall = gitCalls.some((call) => call[0][0] === 'commit')

      expect(hasAddCall).toBe(false)
      expect(hasCommitCall).toBe(false)
    })

    it('should log what would be executed in dry-run mode', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true, issueNumber: 123 })

      expect(getLogger().info).toHaveBeenCalledWith('[DRY RUN] Would run: git add -A')
      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would commit with message:')
      )
    })

    it('should not call git add in dry-run mode', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true })

      const addCalls = vi.mocked(git.executeGitCommand).mock.calls.filter(
        (call) => call[0][0] === 'add'
      )
      expect(addCalls).toHaveLength(0)
    })

    it('should not call git commit in dry-run mode', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true })

      const commitCalls = vi.mocked(git.executeGitCommand).mock.calls.filter(
        (call) => call[0][0] === 'commit'
      )
      expect(commitCalls).toHaveLength(0)
    })

    it('should return accurate status information in dry-run mode', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('M  file.ts')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('main')

      await expect(
        manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true })
      ).resolves.not.toThrow()
    })
  })

  describe('Error Handling', () => {
    it('should handle git status command failure', async () => {
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Status failed'))

      await expect(manager.detectUncommittedChanges(mockWorktreePath)).rejects.toThrow(
        'Status failed'
      )
    })

    it('should handle git add command failure', async () => {
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Add failed'))

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        'Add failed'
      )
    })

    it('should handle git commit command failure', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Commit failed'))

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        'Commit failed'
      )
    })

    it('should handle "nothing to commit" scenario gracefully', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(
        new Error('nothing to commit, working tree clean')
      )

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).resolves.not.toThrow()
    })

    it('should not swallow unexpected errors', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(new Error('Unexpected error'))

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        'Unexpected error'
      )
    })

    it('should throw specific error for pre-commit hook rejection', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(
        new Error('The commit failed because the pre-commit hook exited with code 1')
      )

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        'pre-commit hook'
      )
    })
  })

  describe('Claude Commit Message Generation', () => {
    beforeEach(() => {
      // Mock Claude CLI availability by default
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
    })

    it('should generate commit message using Claude when available', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add user authentication with JWT tokens')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(claude.launchClaude).toHaveBeenCalled()
      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Add user authentication with JWT tokens'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should include "Fixes #N" trailer when issue number provided', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Fix navigation bug in sidebar menu')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      const commitCall = vi.mocked(git.executeGitCommand).mock.calls.find(
        (call) => call[0][0] === 'commit'
      )
      expect(commitCall?.[0][3]).toContain('Fixes #123')
    })

    it('should include "Fixes TEAM-123" trailer for Linear issues with empty prefix', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Fix navigation bug in sidebar menu')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 'ENG-456', issuePrefix: '', dryRun: false })

      const commitCall = vi.mocked(git.executeGitCommand).mock.calls.find(
        (call) => call[0][0] === 'commit'
      )
      expect(commitCall?.[0][3]).toContain('Fixes ENG-456')
      expect(commitCall?.[0][3]).not.toContain('Fixes #ENG-456')
    })

    it('should pass worktree path to Claude via addDir option', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add feature')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const claudeCall = vi.mocked(claude.launchClaude).mock.calls[0]
      expect(claudeCall[1]).toEqual(
        expect.objectContaining({
          addDir: mockWorktreePath,
        })
      )
    })

    it('should use headless mode for Claude execution', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add feature')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const claudeCall = vi.mocked(claude.launchClaude).mock.calls[0]
      expect(claudeCall[1]).toEqual(
        expect.objectContaining({
          headless: true,
        })
      )
    })

    it('should the correct model', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add feature')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const claudeCall = vi.mocked(claude.launchClaude).mock.calls[0]
      expect(claudeCall[1]).toEqual(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
        })
      )
    })

    it('should use structured XML prompt format', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add feature')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const claudeCall = vi.mocked(claude.launchClaude).mock.calls[0]
      const prompt = claudeCall[0]
      expect(prompt).toContain('<Task>')
      expect(prompt).toContain('<Requirements>')
      expect(prompt).toContain('<Output>')
    })
  })

  describe('Claude Integration - Fallback Behavior', () => {
    it('should fallback to simple message when Claude CLI unavailable', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(claude.launchClaude).not.toHaveBeenCalled()
      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #123\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should fallback when Claude returns empty string', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockResolvedValue('')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #123\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should use Claude message even when it contains error keywords', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockResolvedValue('Error: API rate limit exceeded')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Error: API rate limit exceeded\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should use Claude message even when it contains "prompt too long"', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockResolvedValue('Error: prompt is too long for this model')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Error: prompt is too long for this model\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should fallback when Claude throws exception', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockRejectedValue(new Error('Claude CLI error'))
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #123\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should never fail commit due to Claude issues', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockRejectedValue(new Error('Claude CLI error'))
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await expect(
        manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })
      ).resolves.not.toThrow()
    })
  })

  describe('Claude Output Acceptance', () => {
    beforeEach(() => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
    })

    it('should accept message containing "error"', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('error in processing')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'error in processing\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should accept message containing "Error"', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Error: something failed')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Error: something failed\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should accept message containing "API"', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('API call failed')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'API call failed\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should accept valid message with "error" in context (e.g., "Fix error handling")', async () => {
      // This now works correctly since we removed error pattern validation
      vi.mocked(claude.launchClaude).mockResolvedValue('Fix error handling in auth module')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      // Should now use Claude's message instead of falling back
      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Fix error handling in auth module\n\nFixes #123'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should accept message with proper imperative mood', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add user authentication with JWT')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Add user authentication with JWT'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })
  })

  describe('Dry-Run Mode - Claude Integration', () => {
    it('should NOT call Claude in dry-run mode', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true })

      expect(claude.launchClaude).not.toHaveBeenCalled()
    })

    it('should log what would be executed in dry-run mode', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true, issueNumber: 123 })

      expect(getLogger().info).toHaveBeenCalledWith('[DRY RUN] Would run: git add -A')
      expect(getLogger().info).toHaveBeenCalledWith(
        '[DRY RUN] Would generate commit message with Claude (if available)'
      )
      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would commit with message:')
      )
    })

    it('should not consume API resources in dry-run mode', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: true })

      // Verify no Claude or git commands were executed
      expect(claude.detectClaudeCli).not.toHaveBeenCalled()
      expect(claude.launchClaude).not.toHaveBeenCalled()
      expect(git.executeGitCommand).not.toHaveBeenCalled()
    })
  })

  describe('Integration with Existing CommitManager', () => {
    beforeEach(() => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
    })

    it('should maintain backward compatibility - custom message override', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        message: 'Custom commit message',
        dryRun: false,
      })

      expect(claude.launchClaude).not.toHaveBeenCalled()
      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'Custom commit message'],
        { cwd: mockWorktreePath }
      )
    })

    it('should work with issue number flow', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Fix bug in navigation')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issueNumber: 123, issuePrefix: '#', dryRun: false })

      const claudeCall = vi.mocked(claude.launchClaude).mock.calls[0]
      const prompt = claudeCall[0]
      expect(prompt).toContain('issue #123')

      const commitCall = vi.mocked(git.executeGitCommand).mock.calls.find(
        (call) => call[0][0] === 'commit'
      )
      expect(commitCall?.[0][3]).toContain('Fixes #123')
    })

    it('should stage changes before generating message', async () => {
      const callOrder: string[] = []
      vi.mocked(claude.launchClaude).mockImplementation(async () => {
        callOrder.push('claude')
        return 'Add feature'
      })
      vi.mocked(git.executeGitCommand).mockImplementation(async (args) => {
        callOrder.push(args[0])
        return ''
      })

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      const addIndex = callOrder.indexOf('add')
      const claudeIndex = callOrder.indexOf('claude')
      expect(addIndex).toBeLessThan(claudeIndex)
    })

    it('should preserve existing error handling (nothing to commit)', async () => {
      vi.mocked(claude.launchClaude).mockResolvedValue('Add feature')
      vi.mocked(git.executeGitCommand).mockResolvedValueOnce('')
      vi.mocked(git.executeGitCommand).mockRejectedValueOnce(
        new Error('nothing to commit, working tree clean')
      )

      await expect(
        manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })
      ).resolves.not.toThrow()
    })
  })

  describe('commitChanges with skipVerify option', () => {
    beforeEach(() => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
    })

    it('should include --no-verify flag when skipVerify is true (no editor review)', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        noReview: true,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'WIP: Auto-commit uncommitted changes', '--no-verify'],
        { cwd: mockWorktreePath }
      )
    })

    it('should include --no-verify flag when skipVerify is true (with editor review)', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes', '--no-verify'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should NOT include --no-verify flag when skipVerify is false', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: false,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should NOT include --no-verify flag when skipVerify is undefined', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should log warning when --no-verify flag is used', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        dryRun: false,
      })

      expect(getLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping pre-commit hooks')
      )
    })

    it('should not log warning when skipVerifySilent is true', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        skipVerifySilent: true,
        dryRun: false,
      })

      expect(getLogger().warn).not.toHaveBeenCalled()
    })

    it('should log correct dry-run message when skipVerify is true', async () => {

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        dryRun: true,
      })

      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would commit with message --no-verify:')
      )
    })

    it('should include --no-verify flag with custom message', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        skipVerify: true,
        message: 'Custom message',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'Custom message', '--no-verify'],
        { cwd: mockWorktreePath }
      )
    })

    it('should include --no-verify flag with issue number', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        issueNumber: 123,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit for issue #123\n\nFixes #123', '--no-verify'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should include --no-verify flag with Claude-generated message', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockResolvedValue('Add authentication feature')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        skipVerify: true,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'Add authentication feature', '--no-verify'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })
  })

  describe('Commit Message Prompt Flow', () => {
    beforeEach(() => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
    })

    it('should call promptCommitAction with generated message when noReview=false', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('accept')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(prompt.promptCommitAction).toHaveBeenCalledWith('WIP: Auto-commit uncommitted changes')
    })

    it('should use direct commit (no editor) when user selects "accept"', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('accept')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath }
      )
    })

    it('should open git editor when user selects "edit"', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should throw UserAbortedCommitError when user selects "abort"', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('abort')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })).rejects.toThrow(
        UserAbortedCommitError
      )
    })

    it('should not call promptCommitAction when noReview=true', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', noReview: true, dryRun: false })

      expect(prompt.promptCommitAction).not.toHaveBeenCalled()
    })

    it('should not call promptCommitAction when custom message provided', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { message: 'Custom message', dryRun: false })

      expect(prompt.promptCommitAction).not.toHaveBeenCalled()
    })

    it('should pass Claude-generated message to prompt', async () => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claude.launchClaude).mockResolvedValue('Add user authentication')
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('accept')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

      expect(prompt.promptCommitAction).toHaveBeenCalledWith('Add user authentication')
    })

    it('should include --no-verify flag when skipVerify=true and user accepts', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('accept')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', skipVerify: true, dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'WIP: Auto-commit uncommitted changes', '--no-verify'],
        { cwd: mockWorktreePath }
      )
    })

    it('should include --no-verify flag when skipVerify=true and user edits', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', skipVerify: true, dryRun: false })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes', '--no-verify'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })
  })

  describe('VSCode Editor Integration', () => {
    // Import mocked modules for assertions
    let fsPromises: typeof import('node:fs/promises')
    let execaMock: typeof import('execa')

    beforeEach(async () => {
      fsPromises = await import('node:fs/promises')
      execaMock = await import('execa')
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
    })

    describe('when running in VSCode terminal', () => {
      beforeEach(() => {
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(true)
      })

      it('should use VSCode editor flow when VSCode CLI is available', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Edited commit message\n\n# comment')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should write initial commit message file
        expect(fsPromises.writeFile).toHaveBeenCalled()
        // Should invoke VSCode with --wait flag
        expect(execaMock.execa).toHaveBeenCalledWith(
          'code',
          ['--wait', expect.stringContaining('.COMMIT_EDITMSG')],
          expect.objectContaining({ cwd: mockWorktreePath, stdio: 'inherit' })
        )
        // Should commit with -F flag using the file
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-F', expect.stringContaining('.COMMIT_EDITMSG')],
          { cwd: mockWorktreePath }
        )
        // Should clean up the file
        expect(fsPromises.unlink).toHaveBeenCalled()
      })

      it('should strip comment lines from edited message', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Line 1\n# comment\nLine 2')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // The final writeFile should have stripped comments
        const writeFileCalls = vi.mocked(fsPromises.writeFile).mock.calls
        const finalWrite = writeFileCalls[writeFileCalls.length - 1]
        expect(finalWrite[1]).toBe('Line 1\nLine 2')
      })

      it('should throw UserAbortedCommitError when message is empty after stripping comments', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(fsPromises.readFile).mockResolvedValue('# only comments\n# here')

        await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false }))
          .rejects.toThrow(UserAbortedCommitError)
      })

      it('should fall back to git editor when VSCode CLI is unavailable', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(false)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should NOT use execa for VSCode
        expect(execaMock.execa).not.toHaveBeenCalled()
        // Should use standard git commit -e flow
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
          { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
        )
      })

      it('should NOT affect accept flow', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(prompt.promptCommitAction).mockResolvedValue('accept')
        vi.mocked(git.executeGitCommand).mockResolvedValue('')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Accept flow should NOT use VSCode editor
        expect(execaMock.execa).not.toHaveBeenCalled()
        // Should use direct commit with -m flag
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-m', 'WIP: Auto-commit uncommitted changes'],
          { cwd: mockWorktreePath }
        )
      })

      it('should include --no-verify flag when skipVerify=true', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { skipVerify: true, dryRun: false })

        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-F', expect.stringContaining('.COMMIT_EDITMSG'), '--no-verify'],
          { cwd: mockWorktreePath }
        )
      })

      it('should clean up commit message file even on error', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(fsPromises.readFile).mockResolvedValue('# only comments')

        await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false }))
          .rejects.toThrow()

        // Should still clean up
        expect(fsPromises.unlink).toHaveBeenCalled()
      })
    })

    describe('when NOT running in VSCode terminal', () => {
      beforeEach(() => {
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(false)
      })

      it('should use standard git editor flow', async () => {
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true) // Even if CLI available
        vi.mocked(git.executeGitCommand).mockResolvedValue('')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should NOT use VSCode editor
        expect(execaMock.execa).not.toHaveBeenCalled()
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
          { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
        )
      })

      it('should NOT call isVSCodeAvailable when not running in VSCode', async () => {
        vi.mocked(git.executeGitCommand).mockResolvedValue('')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        expect(vscode.isVSCodeAvailable).not.toHaveBeenCalled()
      })
    })
  })

  describe('Cursor Editor Integration', () => {
    // Import mocked modules for assertions
    let fsPromises: typeof import('node:fs/promises')
    let execaMock: typeof import('execa')

    beforeEach(async () => {
      fsPromises = await import('node:fs/promises')
      execaMock = await import('execa')
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      // Reset Cursor mocks - default to not running in Cursor
      vi.mocked(vscode.isRunningInCursor).mockReturnValue(false)
      vi.mocked(vscode.isCursorAvailable).mockResolvedValue(false)
    })

    describe('when running in Cursor terminal', () => {
      beforeEach(() => {
        vi.mocked(vscode.isRunningInCursor).mockReturnValue(true)
      })

      it('should use Cursor editor flow when Cursor CLI is available', async () => {
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Edited commit message\n\n# comment')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should write initial commit message file
        expect(fsPromises.writeFile).toHaveBeenCalled()
        // Should invoke Cursor with --wait flag
        expect(execaMock.execa).toHaveBeenCalledWith(
          'cursor',
          ['--wait', expect.stringContaining('.COMMIT_EDITMSG')],
          expect.objectContaining({ cwd: mockWorktreePath, stdio: 'inherit' })
        )
        // Should commit with -F flag using the file
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-F', expect.stringContaining('.COMMIT_EDITMSG')],
          { cwd: mockWorktreePath }
        )
        // Should clean up the file
        expect(fsPromises.unlink).toHaveBeenCalled()
      })

      it('should take precedence over VSCode detection (Cursor may set TERM_PROGRAM=vscode)', async () => {
        // Both Cursor and VSCode detection would return true
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(true)
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should use Cursor, not VSCode
        expect(execaMock.execa).toHaveBeenCalledWith(
          'cursor',
          expect.any(Array),
          expect.any(Object)
        )
        // Should NOT have called VSCode
        expect(execaMock.execa).not.toHaveBeenCalledWith(
          'code',
          expect.any(Array),
          expect.any(Object)
        )
      })

      it('should fall back to VSCode when Cursor CLI is unavailable but VSCode is available', async () => {
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(false)
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(true)
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should use VSCode instead
        expect(execaMock.execa).toHaveBeenCalledWith(
          'code',
          expect.any(Array),
          expect.any(Object)
        )
      })

      it('should fall back to git editor when neither Cursor nor VSCode CLI is available', async () => {
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(false)
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(false)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should NOT use execa for editors
        expect(execaMock.execa).not.toHaveBeenCalled()
        // Should use standard git commit -e flow
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
          { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
        )
      })

      it('should include --no-verify flag when skipVerify=true', async () => {
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { skipVerify: true, dryRun: false })

        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-F', expect.stringContaining('.COMMIT_EDITMSG'), '--no-verify'],
          { cwd: mockWorktreePath }
        )
      })

      it('should throw UserAbortedCommitError when message is empty after stripping comments', async () => {
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(fsPromises.readFile).mockResolvedValue('# only comments\n# here')

        await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false }))
          .rejects.toThrow(UserAbortedCommitError)
      })

      it('should clean up commit message file even on error', async () => {
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(fsPromises.readFile).mockResolvedValue('# only comments')

        await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false }))
          .rejects.toThrow()

        // Should still clean up
        expect(fsPromises.unlink).toHaveBeenCalled()
      })
    })
  })

  describe('Antigravity Editor Integration', () => {
    // Import mocked modules for assertions
    let fsPromises: typeof import('node:fs/promises')
    let execaMock: typeof import('execa')

    beforeEach(async () => {
      fsPromises = await import('node:fs/promises')
      execaMock = await import('execa')
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      // Reset Antigravity mocks - default to not running in Antigravity
      vi.mocked(vscode.isRunningInAntigravity).mockReturnValue(false)
      vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(false)
    })

    describe('when running in Antigravity terminal', () => {
      beforeEach(() => {
        vi.mocked(vscode.isRunningInAntigravity).mockReturnValue(true)
      })

      it('should use Antigravity editor flow when Antigravity CLI is available', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Edited commit message\n\n# comment')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should write initial commit message file
        expect(fsPromises.writeFile).toHaveBeenCalled()
        // Should invoke Antigravity with --wait flag
        expect(execaMock.execa).toHaveBeenCalledWith(
          'agy',
          ['--wait', expect.stringContaining('.COMMIT_EDITMSG')],
          expect.objectContaining({ cwd: mockWorktreePath, stdio: 'inherit' })
        )
        // Should commit with -F flag using the file
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-F', expect.stringContaining('.COMMIT_EDITMSG')],
          { cwd: mockWorktreePath }
        )
        // Should clean up the file
        expect(fsPromises.unlink).toHaveBeenCalled()
      })

      it('should take precedence over Cursor and VSCode detection', async () => {
        // All three running/available to true
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(true)
        vi.mocked(vscode.isRunningInCursor).mockReturnValue(true)
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(true)
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should use Antigravity, not Cursor or VSCode
        expect(execaMock.execa).toHaveBeenCalledWith(
          'agy',
          expect.any(Array),
          expect.any(Object)
        )
        // Should NOT have called Cursor
        expect(execaMock.execa).not.toHaveBeenCalledWith(
          'cursor',
          expect.any(Array),
          expect.any(Object)
        )
        // Should NOT have called VSCode
        expect(execaMock.execa).not.toHaveBeenCalledWith(
          'code',
          expect.any(Array),
          expect.any(Object)
        )
      })

      it('should fall back to Cursor when Antigravity CLI unavailable but Cursor available', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(false)
        vi.mocked(vscode.isRunningInCursor).mockReturnValue(true)
        vi.mocked(vscode.isCursorAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should use Cursor instead
        expect(execaMock.execa).toHaveBeenCalledWith(
          'cursor',
          expect.any(Array),
          expect.any(Object)
        )
      })

      it('should fall back to VSCode when both Antigravity and Cursor unavailable', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(false)
        vi.mocked(vscode.isRunningInCursor).mockReturnValue(false)
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(true)
        vi.mocked(vscode.isVSCodeAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should use VSCode instead
        expect(execaMock.execa).toHaveBeenCalledWith(
          'code',
          expect.any(Array),
          expect.any(Object)
        )
      })

      it('should fall back to git editor when no IDE CLI available', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(false)
        vi.mocked(vscode.isRunningInCursor).mockReturnValue(false)
        vi.mocked(vscode.isRunningInVSCode).mockReturnValue(false)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')

        await manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false })

        // Should NOT use execa for editors
        expect(execaMock.execa).not.toHaveBeenCalled()
        // Should use standard git commit -e flow
        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
          { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
        )
      })

      it('should include --no-verify flag when skipVerify=true', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(true)
        vi.mocked(git.executeGitCommand).mockResolvedValue('')
        vi.mocked(fsPromises.readFile).mockResolvedValue('Test message')

        await manager.commitChanges(mockWorktreePath, { skipVerify: true, dryRun: false })

        expect(git.executeGitCommand).toHaveBeenCalledWith(
          ['commit', '-F', expect.stringContaining('.COMMIT_EDITMSG'), '--no-verify'],
          { cwd: mockWorktreePath }
        )
      })

      it('should throw UserAbortedCommitError when message is empty after stripping comments', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(true)
        vi.mocked(fsPromises.readFile).mockResolvedValue('# only comments\n# here')

        await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false }))
          .rejects.toThrow(UserAbortedCommitError)
      })

      it('should clean up commit message file even on error', async () => {
        vi.mocked(vscode.isAntigravityAvailable).mockResolvedValue(true)
        vi.mocked(fsPromises.readFile).mockResolvedValue('# only comments')

        await expect(manager.commitChanges(mockWorktreePath, { issuePrefix: '#', dryRun: false }))
          .rejects.toThrow()

        // Should still clean up
        expect(fsPromises.unlink).toHaveBeenCalled()
      })
    })
  })

  describe('Commit Timeout Configuration', () => {
    beforeEach(() => {
      vi.mocked(claude.detectClaudeCli).mockResolvedValue(false)
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('accept')
    })

    it('should pass custom timeout to executeGitCommand when timeout option is provided', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        noReview: true,
        timeout: 120000,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, timeout: 120000 }
      )
    })

    it('should not include timeout in options when timeout is undefined', async () => {
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        noReview: true,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, timeout: undefined }
      )
    })

    it('should use at least 300000ms for interactive editor even when configured timeout is lower', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        timeout: 180000,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })

    it('should use configured timeout for interactive editor when larger than 300000ms', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        timeout: 600000,
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 600000 }
      )
    })

    it('should use 300000ms fallback when timeout not provided for interactive editing', async () => {
      vi.mocked(prompt.promptCommitAction).mockResolvedValue('edit')
      vi.mocked(git.executeGitCommand).mockResolvedValue('')

      await manager.commitChanges(mockWorktreePath, {
        issuePrefix: '#',
        dryRun: false,
      })

      expect(git.executeGitCommand).toHaveBeenCalledWith(
        ['commit', '-e', '-m', 'WIP: Auto-commit uncommitted changes'],
        { cwd: mockWorktreePath, stdio: 'inherit', timeout: 300000 }
      )
    })
  })
})
