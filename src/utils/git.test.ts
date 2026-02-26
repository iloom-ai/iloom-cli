import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseWorktreeList,
  isPRBranch,
  extractPRNumber,
  extractIssueNumber,
  isWorktreePath,
  generateWorktreePath,
  findMainWorktreePath,
  findWorktreeForBranch,
  isEmptyRepository,
  ensureRepositoryHasCommits,
  isFileTrackedByGit,
  isFileGitignored,
  isBranchMergedIntoMain,
  isRemoteBranchUpToDate,
  checkRemoteBranchStatus,
  getMergeTargetBranch,
} from './git.js'
import { execa } from 'execa'

// Mock execa for findMainWorktreePath tests
vi.mock('execa')

describe('Git Utility Functions', () => {
  describe('parseWorktreeList', () => {
    it('should parse single worktree correctly', () => {
      const output = [
        'worktree /Users/dev/myproject',
        'HEAD abc123def456789',
        'branch refs/heads/main',
        '',
      ].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        path: '/Users/dev/myproject',
        branch: 'main',
        commit: 'abc123def456789',
        bare: false,
        detached: false,
        locked: false,
      })
    })

    it('should parse multiple worktrees correctly', () => {
      const output = [
        'worktree /Users/dev/myproject',
        'HEAD abc123def456789',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/worktree-feature',
        'HEAD def456abc123456',
        'branch refs/heads/feature-branch',
        '',
      ].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(2)
      expect(result[0].branch).toBe('main')
      expect(result[1].branch).toBe('feature-branch')
    })

    it('should handle detached HEAD correctly', () => {
      const output = [
        'worktree /Users/dev/worktree-detached',
        'HEAD abc123def456789',
        'detached',
        '',
      ].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(1)
      expect(result[0].detached).toBe(true)
      expect(result[0].branch).toBe('HEAD')
      expect(result[0].commit).toBe('abc123def456789')
      expect(result[0].bare).toBe(false)
    })

    it('should handle mixed worktree states correctly', () => {
      // Test all worktree states together: bare, detached, locked, and regular
      const output = [
        'worktree /Users/dev/bare-repo',
        'bare',
        '',
        'worktree /Users/dev/detached-worktree',
        'HEAD abc123def456789',
        'detached',
        '',
        'worktree /Users/dev/locked-worktree',
        'HEAD def456abc123456',
        'locked maintenance mode',
        '',
        'worktree /Users/dev/regular-worktree',
        'HEAD 8617ccd434c3a08f1416e0bef4f49d826757035e',
        'branch refs/heads/feature/amazing-feature',
        '',
      ].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(4)

      // Bare repository
      expect(result[0].path).toBe('/Users/dev/bare-repo')
      expect(result[0].bare).toBe(true)
      expect(result[0].branch).toBe('main')
      expect(result[0].commit).toBe('')
      expect(result[0].detached).toBe(false)
      expect(result[0].locked).toBe(false)

      // Detached HEAD
      expect(result[1].path).toBe('/Users/dev/detached-worktree')
      expect(result[1].bare).toBe(false)
      expect(result[1].detached).toBe(true)
      expect(result[1].branch).toBe('HEAD')
      expect(result[1].commit).toBe('abc123def456789')
      expect(result[1].locked).toBe(false)

      // Locked worktree
      expect(result[2].path).toBe('/Users/dev/locked-worktree')
      expect(result[2].bare).toBe(false)
      expect(result[2].detached).toBe(false)
      expect(result[2].locked).toBe(true)
      expect(result[2].lockReason).toBe('maintenance mode')
      expect(result[2].commit).toBe('def456abc123456')
      expect(result[2].branch).toBe('unknown')

      // Regular worktree
      expect(result[3].path).toBe('/Users/dev/regular-worktree')
      expect(result[3].bare).toBe(false)
      expect(result[3].detached).toBe(false)
      expect(result[3].locked).toBe(false)
      expect(result[3].branch).toBe('feature/amazing-feature')
      expect(result[3].commit).toBe('8617ccd434c3a08f1416e0bef4f49d826757035e')
    })

    it('should handle bare repository correctly (real format)', () => {
      // Bare repositories don't have HEAD lines in git worktree list --porcelain output
      const output = ['worktree /Users/dev/bare-repo', 'bare', ''].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(1)
      expect(result[0].bare).toBe(true)
      expect(result[0].branch).toBe('main')
      expect(result[0].commit).toBe('') // No commit for bare repos
    })

    it('should handle mixed bare and regular worktrees correctly', () => {
      // This test covers the original bug scenario - bare repo followed by regular worktrees
      const output = [
        'worktree /Users/dev/bare-repo',
        'bare',
        '',
        'worktree /Users/dev/feat-issue-51',
        'HEAD 8617ccd434c3a08f1416e0bef4f49d826757035e',
        'branch refs/heads/feat/issue-51',
        '',
        'worktree /Users/dev/main-repo',
        'HEAD 8617ccd434c3a08f1416e0bef4f49d826757035e',
        'branch refs/heads/main',
        '',
      ].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(3)

      // Bare repository
      expect(result[0].path).toBe('/Users/dev/bare-repo')
      expect(result[0].bare).toBe(true)
      expect(result[0].branch).toBe('main')
      expect(result[0].commit).toBe('')

      // Regular worktree (the one that was failing to parse before)
      expect(result[1].path).toBe('/Users/dev/feat-issue-51')
      expect(result[1].bare).toBe(false)
      expect(result[1].branch).toBe('feat/issue-51')
      expect(result[1].commit).toBe('8617ccd434c3a08f1416e0bef4f49d826757035e')

      // Another regular worktree
      expect(result[2].path).toBe('/Users/dev/main-repo')
      expect(result[2].bare).toBe(false)
      expect(result[2].branch).toBe('main')
      expect(result[2].commit).toBe('8617ccd434c3a08f1416e0bef4f49d826757035e')
    })

    it('should handle locked worktree correctly', () => {
      const output = [
        'worktree /Users/dev/locked-worktree',
        'HEAD abc123def456789',
        'locked under maintenance',
        '',
      ].join('\n')

      const result = parseWorktreeList(output)

      expect(result).toHaveLength(1)
      expect(result[0].locked).toBe(true)
      expect(result[0].lockReason).toBe('under maintenance')
      expect(result[0].branch).toBe('unknown')
    })

    it('should handle empty output', () => {
      const result = parseWorktreeList('')
      expect(result).toHaveLength(0)
    })

    it('should handle malformed output gracefully', () => {
      const output = 'invalid output format'
      const result = parseWorktreeList(output)
      expect(result).toHaveLength(0)
    })
  })

  describe('parseWorktreeList - custom default branch', () => {
    it('should use custom default branch for bare repository when provided', () => {
      const output = ['worktree /Users/dev/bare-repo', 'bare', ''].join('\n')

      const result = parseWorktreeList(output, 'develop')

      expect(result).toHaveLength(1)
      expect(result[0].bare).toBe(true)
      expect(result[0].branch).toBe('develop')
      expect(result[0].path).toBe('/Users/dev/bare-repo')
    })

    it('should use "trunk" as default branch for bare repository', () => {
      const output = ['worktree /Users/dev/bare-repo', 'bare', ''].join('\n')

      const result = parseWorktreeList(output, 'trunk')

      expect(result[0].branch).toBe('trunk')
    })

    it('should default to "main" for bare repository when no defaultBranch provided', () => {
      const output = ['worktree /Users/dev/bare-repo', 'bare', ''].join('\n')

      // Call without defaultBranch parameter
      const result = parseWorktreeList(output)

      expect(result[0].branch).toBe('main')
    })

    it('should use custom default branch in mixed worktree scenario', () => {
      const output = [
        'worktree /Users/dev/bare-repo',
        'bare',
        '',
        'worktree /Users/dev/feature-worktree',
        'HEAD abc123',
        'branch refs/heads/feature-123',
        '',
      ].join('\n')

      const result = parseWorktreeList(output, 'develop')

      expect(result).toHaveLength(2)
      expect(result[0].branch).toBe('develop') // bare repo uses custom default
      expect(result[1].branch).toBe('feature-123') // regular worktree uses actual branch
    })

    it('should use custom default branch for bare repo with "master" as default', () => {
      const output = ['worktree /Users/dev/bare-repo', 'bare', ''].join('\n')

      const result = parseWorktreeList(output, 'master')

      expect(result[0].branch).toBe('master')
    })
  })

  describe('isPRBranch', () => {
    it('should identify PR branches correctly', () => {
      const prBranches = [
        'pr/123',
        'PR/456',
        'pull/789',
        '123-feature-name',
        '456_another_feature',
        'feature/pr123',
        'feature/pr-456',
        'hotfix/pr789',
        'hotfix/pr-101',
      ]

      prBranches.forEach(branch => {
        expect(isPRBranch(branch)).toBe(true)
      })
    })

    it('should identify non-PR branches correctly', () => {
      const nonPRBranches = [
        'main',
        'master',
        'develop',
        'feature-branch',
        'hotfix-urgent',
        'feature/new-component',
        'bugfix/issue-fix',
      ]

      nonPRBranches.forEach(branch => {
        expect(isPRBranch(branch)).toBe(false)
      })
    })
  })

  describe('extractPRNumber', () => {
    it('should extract PR numbers from various formats', () => {
      const testCases = [
        { branch: 'pr/123', expected: 123 },
        { branch: 'PR/456', expected: 456 },
        { branch: 'pull/789', expected: 789 },
        { branch: '123-feature-name', expected: 123 },
        { branch: '456_another_feature', expected: 456 },
        { branch: 'feature/pr123', expected: 123 },
        { branch: 'feature/pr-456', expected: 456 },
        { branch: 'hotfix/pr789', expected: 789 },
        { branch: 'contains-pr-101-here', expected: 101 },
      ]

      testCases.forEach(({ branch, expected }) => {
        expect(extractPRNumber(branch)).toBe(expected)
      })
    })

    it('should return null for non-PR branches', () => {
      const nonPRBranches = [
        'main',
        'master',
        'develop',
        'feature-branch',
        'hotfix-urgent',
        'feature/new-component',
      ]

      nonPRBranches.forEach(branch => {
        expect(extractPRNumber(branch)).toBeNull()
      })
    })

    it('should handle invalid PR numbers', () => {
      const invalidCases = ['pr/abc', 'pull/', 'pr/-123']

      invalidCases.forEach(branch => {
        expect(extractPRNumber(branch)).toBeNull()
      })
    })
  })

  describe('extractIssueNumber', () => {
    it('should extract issue numbers from various formats', () => {
      const testCases = [
        // New format (double underscore) - alphanumeric IDs
        { branch: 'feat/issue-ILOOM-456__new-branch', expected: 'ILOOM-456' },
        { branch: 'feat/issue-ILOOM-123__description', expected: 'ILOOM-123' },
        { branch: 'feat/issue-PROJ-789__another-new', expected: 'PROJ-789' },
        { branch: 'feat/issue-ABC-123__description', expected: 'ABC-123' },
        { branch: 'fix/issue-X-1__quick-fix', expected: 'X-1' },
        { branch: 'feat/issue-123__new-format', expected: '123' }, // Numeric ID with new format

        // Old format (single dash) - numeric IDs
        { branch: 'issue-42', expected: '42' },
        { branch: 'feat/issue-42-description', expected: '42' },
        { branch: 'ISSUE-123', expected: '123' },
        { branch: 'feat/issue-123-old-branch', expected: '123' },
        { branch: 'feat/issue-ILOOM-123', expected: 'ILOOM-123' }, // Alphanumeric in old format
        { branch: 'issue-abc', expected: 'abc' }, // Simple alphabetic ID
        { branch: 'feat/issue-abc-123', expected: 'abc-123' }, // Mixed alphanumeric ID

        // Legacy formats
        { branch: 'issue_456', expected: '456' },
        { branch: '42-feature-name', expected: '42' },
        { branch: '123-add-new-component', expected: '123' },
      ]

      testCases.forEach(({ branch, expected }) => {
        expect(extractIssueNumber(branch)).toBe(expected)
      })
    })

    it('should return null for branches without issue numbers', () => {
      const nonIssueBranches = [
        'main',
        'master',
        'develop',
        'feature-branch',
        'hotfix-urgent',
        'feature/new-component',
        'pr/123',  // PR format, not issue format
        'pull/456',
      ]

      nonIssueBranches.forEach(branch => {
        expect(extractIssueNumber(branch)).toBeNull()
      })
    })

    it('should handle invalid issue numbers', () => {
      const invalidCases = ['issue_', 'issue-']

      invalidCases.forEach(branch => {
        expect(extractIssueNumber(branch)).toBeNull()
      })
    })
  })

  describe('isWorktreePath', () => {
    it('should identify worktree paths correctly', () => {
      const worktreePaths = [
        '/Users/dev/worktrees/feature-branch',
        '/projects/worktree/pr-123',
        '/workspace123/code',
        '/workspace-456/repo',
        '/issue123/project',
        '/issue-789/app',
        '/pr123/codebase',
        '/pr-456/source',
        '/feature-worktree',
        '/branch.worktree',
      ]

      worktreePaths.forEach(path => {
        expect(isWorktreePath(path)).toBe(true)
      })
    })

    it('should identify non-worktree paths correctly', () => {
      const normalPaths = [
        '/Users/dev/myproject',
        '/home/user/code',
        '/projects/main-repo',
        '/source/application',
      ]

      normalPaths.forEach(path => {
        expect(isWorktreePath(path)).toBe(false)
      })
    })
  })

  describe('generateWorktreePath', () => {
    it('should generate worktree paths under .iloom/worktrees/', () => {
      const testCases = [
        {
          branch: 'feature-branch',
          root: '/Users/dev/project',
          expected: '/Users/dev/project/.iloom/worktrees/feature-branch',
        },
        {
          branch: 'pr/123',
          root: '/Users/dev/project',
          expected: '/Users/dev/project/.iloom/worktrees/pr-123',
        },
        {
          branch: 'feature/complex-name',
          root: '/home/user/code',
          expected: '/home/user/code/.iloom/worktrees/feature-complex-name',
        },
      ]

      testCases.forEach(({ branch, root, expected }) => {
        expect(generateWorktreePath(branch, root)).toBe(expected)
      })
    })

    it('should sanitize branch names by replacing slashes with dashes', () => {
      const testCases = [
        {
          branch: 'feature/with@special#characters',
          root: '/project',
          expected: '/project/.iloom/worktrees/feature-with@special#characters',
        },
        {
          branch: 'branch---with---dashes',
          root: '/project',
          expected: '/project/.iloom/worktrees/branch---with---dashes',
        },
        {
          branch: '-leading-and-trailing-',
          root: '/project',
          expected: '/project/.iloom/worktrees/-leading-and-trailing-',
        },
      ]

      testCases.forEach(({ branch, root, expected }) => {
        expect(generateWorktreePath(branch, root)).toBe(expected)
      })
    })

    it('should add PR suffix when isPR and prNumber provided', () => {
      const result = generateWorktreePath('feature/branch', '/project', {
        isPR: true,
        prNumber: 123,
      })
      expect(result).toBe('/project/.iloom/worktrees/feature-branch_pr_123')
    })

    it('should not add PR suffix when isPR is false', () => {
      const result = generateWorktreePath('feature/branch', '/project', {
        isPR: false,
        prNumber: 123,
      })
      expect(result).toBe('/project/.iloom/worktrees/feature-branch')
    })

    it('should handle different root directories', () => {
      expect(generateWorktreePath('issue-123', '/Users/dev/my-awesome-project', {}))
        .toBe('/Users/dev/my-awesome-project/.iloom/worktrees/issue-123')

      expect(generateWorktreePath('issue-123', '/Users/dev/my-project'))
        .toBe('/Users/dev/my-project/.iloom/worktrees/issue-123')

      expect(generateWorktreePath('issue-123', '/Users/dev/my.project-v2'))
        .toBe('/Users/dev/my.project-v2/.iloom/worktrees/issue-123')

      expect(generateWorktreePath('issue-123', '/Users/dev/p'))
        .toBe('/Users/dev/p/.iloom/worktrees/issue-123')

      expect(generateWorktreePath('issue-123', '/'))
        .toBe('/.iloom/worktrees/issue-123')
    })

    it('should apply PR suffix correctly', () => {
      const result = generateWorktreePath('issue-123', '/Users/dev/project', {
        isPR: true,
        prNumber: 456,
      })
      expect(result).toBe('/Users/dev/project/.iloom/worktrees/issue-123_pr_456')
    })

    it('should sanitize branch slashes in the path', () => {
      const result = generateWorktreePath('feature/add-login', '/Users/dev/project')
      expect(result).toBe('/Users/dev/project/.iloom/worktrees/feature-add-login')
    })
  })
})

describe('Git Utility Regression Tests', () => {
  describe('Bash Script Parity', () => {
    it('should match find_worktree_for_branch() behavior', () => {
      // This test ensures our TypeScript implementation matches the bash script behavior
      const worktreeOutput = [
        'worktree /Users/dev/myproject',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/worktree-feature',
        'HEAD def456',
        'branch refs/heads/feature-branch',
        '',
      ].join('\n')

      const worktrees = parseWorktreeList(worktreeOutput)
      const foundWorktree = worktrees.find(wt => wt.branch === 'feature-branch')

      // Should match bash script: find worktree with exact branch name match
      expect(foundWorktree).toBeDefined()
      expect(foundWorktree?.path).toBe('/Users/dev/worktree-feature')
      expect(foundWorktree?.branch).toBe('feature-branch')
      expect(foundWorktree?.commit).toBe('def456')
    })

    it('should match is_pr_worktree() behavior', () => {
      // Test cases that should match bash script PR detection logic
      const prTestCases = [
        { branch: 'pr/123', expected: true },
        { branch: 'pull/456', expected: true },
        { branch: '789-feature', expected: true },
        { branch: 'feature/pr-123', expected: true },
        { branch: 'main', expected: false },
        { branch: 'feature-branch', expected: false },
      ]

      prTestCases.forEach(({ branch, expected }) => {
        expect(isPRBranch(branch)).toBe(expected)
      })
    })

    it('should match get_pr_number_from_worktree() behavior', () => {
      // Test cases that should match bash script PR number extraction
      const extractionCases = [
        { branch: 'pr/123', expected: 123 },
        { branch: 'pull/456', expected: 456 },
        { branch: '789-feature-name', expected: 789 },
        { branch: 'feature/pr-101', expected: 101 },
        { branch: 'main', expected: null },
        { branch: 'feature-branch', expected: null },
      ]

      extractionCases.forEach(({ branch, expected }) => {
        expect(extractPRNumber(branch)).toBe(expected)
      })
    })
  })

  describe('findMainWorktreePath', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    describe('3-tier main branch detection', () => {
      it('should use mainBranch from options when specified', async () => {
        // Mock git worktree list output with multiple worktrees
        const mockOutput = [
          'worktree /Users/dev/repo',
          'HEAD abc123',
          'branch refs/heads/develop',
          '',
          'worktree /Users/dev/feature-worktree',
          'HEAD def456',
          'branch refs/heads/feature-1',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        const result = await findMainWorktreePath('/Users/dev/repo', { mainBranch: 'develop' })

        expect(result).toBe('/Users/dev/repo')
      })

      it('should fall back to "main" branch when options not specified', async () => {
        const mockOutput = [
          'worktree /Users/dev/main-repo',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /Users/dev/feature-worktree',
          'HEAD def456',
          'branch refs/heads/feature-1',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        const result = await findMainWorktreePath('/Users/dev/main-repo')

        expect(result).toBe('/Users/dev/main-repo')
      })

      it('should use first worktree when options not specified and no "main" branch exists', async () => {
        const mockOutput = [
          'worktree /Users/dev/master-repo',
          'HEAD abc123',
          'branch refs/heads/master',
          '',
          'worktree /Users/dev/feature-worktree',
          'HEAD def456',
          'branch refs/heads/feature-1',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        const result = await findMainWorktreePath('/Users/dev/master-repo')

        expect(result).toBe('/Users/dev/master-repo') // First entry
      })

      it('should throw error when specified mainBranch not found in worktrees', async () => {
        const mockOutput = [
          'worktree /Users/dev/repo',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        await expect(
          findMainWorktreePath('/Users/dev/repo', { mainBranch: 'develop' }),
        ).rejects.toThrow(/No worktree found with branch 'develop'/)
      })

      it('should handle repository with single worktree', async () => {
        const mockOutput = [
          'worktree /Users/dev/repo',
          'HEAD abc123',
          'branch refs/heads/trunk',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        // First worktree should be returned when no main branch exists
        const result = await findMainWorktreePath('/Users/dev/repo')
        expect(result).toBe('/Users/dev/repo')
      })

      it('should handle bare repository (first worktree)', async () => {
        const mockOutput = ['worktree /Users/dev/bare-repo', 'bare', ''].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        const result = await findMainWorktreePath('/Users/dev/bare-repo')
        expect(result).toBe('/Users/dev/bare-repo')
      })

      it('should prefer settings mainBranch over "main" branch', async () => {
        const mockOutput = [
          'worktree /Users/dev/develop-repo',
          'HEAD abc123',
          'branch refs/heads/develop',
          '',
          'worktree /Users/dev/main-repo',
          'HEAD def456',
          'branch refs/heads/main',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        // When options specify develop, should use that instead of main
        const result = await findMainWorktreePath('/Users/dev/repo', { mainBranch: 'develop' })
        expect(result).toBe('/Users/dev/develop-repo')
      })

      it('should handle empty worktree list gracefully', async () => {
        const mockOutput = ''

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        await expect(findMainWorktreePath('/Users/dev/repo')).rejects.toThrow(/No worktrees found/)
      })
    })

    describe('backward compatibility', () => {
      it('should work without options parameter (existing behavior)', async () => {
        const mockOutput = [
          'worktree /Users/dev/main-repo',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
        ].join('\n')

        vi.mocked(execa).mockResolvedValueOnce({
          stdout: mockOutput,
          stderr: '',
        } as ReturnType<typeof execa>)

        // Should work when called without options (current usage pattern)
        const result = await findMainWorktreePath('/Users/dev/main-repo')
        expect(result).toBe('/Users/dev/main-repo')
      })
    })
  })

  describe('isEmptyRepository', () => {
    it('returns true when repository has no commits (HEAD does not exist)', async () => {

      vi.mocked(execa).mockRejectedValueOnce(
        new Error('fatal: not a valid object name: \'HEAD\'')
      )

      const result = await isEmptyRepository('/test/repo')
      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'HEAD'], expect.objectContaining({ cwd: '/test/repo' }))
    })

    it('returns false when repository has at least one commit', async () => {

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123def456',
        stderr: '',
      } as ReturnType<typeof execa>)

      const result = await isEmptyRepository('/test/repo')
      expect(result).toBe(false)
      expect(execa).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'HEAD'], expect.objectContaining({ cwd: '/test/repo' }))
    })

    it('uses process.cwd() when path is not provided', async () => {

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123def456',
        stderr: '',
      } as ReturnType<typeof execa>)

      await isEmptyRepository()
      expect(execa).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'HEAD'], expect.objectContaining({ cwd: process.cwd() }))
    })
  })

  describe('ensureRepositoryHasCommits', () => {
    it('creates initial commit when repository is empty', async () => {

      // First call (isEmptyRepository check) returns error -> repo is empty
      // Second call (create initial commit) succeeds
      vi.mocked(execa)
        .mockRejectedValueOnce(new Error('fatal: not a valid object name: \'HEAD\''))
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
        } as ReturnType<typeof execa>)

      await ensureRepositoryHasCommits('/test/repo')

      expect(execa).toHaveBeenCalledTimes(2)
      // First call checks if repo is empty
      expect(execa).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--verify', 'HEAD'], expect.objectContaining({ cwd: '/test/repo' }))
      // Second call creates initial commit
      expect(execa).toHaveBeenNthCalledWith(2, 'git', ['commit', '--no-verify', '--allow-empty', '-m', 'Initial commit'], expect.objectContaining({ cwd: '/test/repo' }))
    })

    it('does nothing when repository already has commits', async () => {

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123def456',
        stderr: '',
      } as ReturnType<typeof execa>)

      await ensureRepositoryHasCommits('/test/repo')

      expect(execa).toHaveBeenCalledTimes(1)
      expect(execa).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'HEAD'], expect.objectContaining({ cwd: '/test/repo' }))
    })

    it('uses process.cwd() when path is not provided', async () => {

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123def456',
        stderr: '',
      } as ReturnType<typeof execa>)

      await ensureRepositoryHasCommits()
      expect(execa).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'HEAD'], expect.objectContaining({ cwd: process.cwd() }))
    })
  })

  describe('isFileTrackedByGit', () => {
    it('returns true for tracked files', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '.env.production',
        stderr: '',
      } as ReturnType<typeof execa>)

      const result = await isFileTrackedByGit('.env.production', '/test/repo')

      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith('git', ['ls-files', '--error-unmatch', '.env.production'], expect.objectContaining({ cwd: '/test/repo' }))
    })

    it('returns false for untracked files', async () => {
      vi.mocked(execa).mockRejectedValueOnce(new Error('error: pathspec \'.env.local\' did not match any file(s) known to git'))

      const result = await isFileTrackedByGit('.env.local', '/test/repo')

      expect(result).toBe(false)
      expect(execa).toHaveBeenCalledWith('git', ['ls-files', '--error-unmatch', '.env.local'], expect.objectContaining({ cwd: '/test/repo' }))
    })

    it('returns false for files that do not exist', async () => {
      vi.mocked(execa).mockRejectedValueOnce(new Error('fatal: pathspec \'.env.nonexistent\' did not match any files'))

      const result = await isFileTrackedByGit('.env.nonexistent', '/test/repo')

      expect(result).toBe(false)
    })

    it('uses process.cwd() when cwd is not provided', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '.env',
        stderr: '',
      } as ReturnType<typeof execa>)

      await isFileTrackedByGit('.env')

      expect(execa).toHaveBeenCalledWith('git', ['ls-files', '--error-unmatch', '.env'], expect.objectContaining({ cwd: process.cwd() }))
    })

    it('handles git command errors gracefully', async () => {
      vi.mocked(execa).mockRejectedValueOnce(new Error('pathspec \'.env.local\' did not match any files'))

      const result = await isFileTrackedByGit('.env.local', '/test/repo')

      expect(result).toBe(false)
    })
  })

  describe('isFileGitignored', () => {
    it('should return true when file is gitignored', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      const result = await isFileGitignored('.vscode/settings.json')

      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith('git', ['check-ignore', '-q', '.vscode/settings.json'], expect.objectContaining({ cwd: process.cwd() }))
    })

    it('should return false when file is NOT gitignored', async () => {
      vi.mocked(execa).mockRejectedValueOnce(new Error('exit code 1'))

      const result = await isFileGitignored('.vscode/settings.json')

      expect(result).toBe(false)
      expect(execa).toHaveBeenCalledWith('git', ['check-ignore', '-q', '.vscode/settings.json'], expect.objectContaining({ cwd: process.cwd() }))
    })

    it('should return false on git command errors', async () => {
      // Mock an ExecaError-like object (what execa actually throws)
      const execaError = Object.assign(new Error('fatal: not a git repository'), {
        exitCode: 128,
        stderr: 'fatal: not a git repository',
      })
      vi.mocked(execa).mockRejectedValueOnce(execaError)

      const result = await isFileGitignored('.vscode/settings.json')

      expect(result).toBe(false)
    })

    it('should use provided cwd parameter', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      await isFileGitignored('.vscode/settings.json', '/custom/path')

      expect(execa).toHaveBeenCalledWith('git', ['check-ignore', '-q', '.vscode/settings.json'], expect.objectContaining({ cwd: '/custom/path' }))
    })
  })

  describe('isBranchMergedIntoMain', () => {
    it('should return true when branch is merged into main', async () => {
      // git merge-base --is-ancestor exits 0 when branch IS an ancestor of main
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      const result = await isBranchMergedIntoMain('feature-branch', 'main', '/test/repo')

      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith(
        'git',
        ['merge-base', '--is-ancestor', 'feature-branch', 'main'],
        expect.objectContaining({ cwd: '/test/repo' })
      )
    })

    it('should return false when branch is NOT merged into main', async () => {
      // git merge-base --is-ancestor exits 1 when branch is NOT an ancestor of main
      vi.mocked(execa).mockRejectedValueOnce(new Error('exit code 1'))

      const result = await isBranchMergedIntoMain('feature-branch', 'main', '/test/repo')

      expect(result).toBe(false)
    })

    it('should return false when branch does not exist', async () => {
      // git merge-base --is-ancestor throws error for unknown revision
      vi.mocked(execa).mockRejectedValueOnce(
        new Error("fatal: Not a valid commit name unknown-branch")
      )

      const result = await isBranchMergedIntoMain('unknown-branch', 'main', '/test/repo')

      expect(result).toBe(false)
    })

    it('should use default main branch when not specified', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      await isBranchMergedIntoMain('feature-branch')

      expect(execa).toHaveBeenCalledWith(
        'git',
        ['merge-base', '--is-ancestor', 'feature-branch', 'main'],
        expect.objectContaining({ cwd: process.cwd() })
      )
    })

    it('should use custom main branch when specified', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      await isBranchMergedIntoMain('feature-branch', 'develop', '/test/repo')

      expect(execa).toHaveBeenCalledWith(
        'git',
        ['merge-base', '--is-ancestor', 'feature-branch', 'develop'],
        expect.objectContaining({ cwd: '/test/repo' })
      )
    })

    it('should use process.cwd() when cwd is not provided', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      await isBranchMergedIntoMain('feature-branch', 'main')

      expect(execa).toHaveBeenCalledWith(
        'git',
        ['merge-base', '--is-ancestor', 'feature-branch', 'main'],
        expect.objectContaining({ cwd: process.cwd() })
      )
    })
  })

  describe('isRemoteBranchUpToDate', () => {
    beforeEach(() => {
      vi.resetAllMocks()
    })

    it('should return true when remote branch exists and matches local', async () => {
      // Mock successful ls-remote command with output
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123\trefs/heads/feature-branch',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock local rev-parse with same commit hash
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await isRemoteBranchUpToDate('feature-branch', '/test/path')

      expect(result).toBe(true)
      expect(execa).toHaveBeenNthCalledWith(1,
        'git',
        ['ls-remote', '--heads', 'origin', 'feature-branch'],
        expect.objectContaining({ cwd: '/test/path' })
      )
      expect(execa).toHaveBeenNthCalledWith(2,
        'git',
        ['rev-parse', 'feature-branch'],
        expect.objectContaining({ cwd: '/test/path' })
      )
    })

    it('should return false when remote branch does not exist', async () => {
      // Mock ls-remote command with empty output
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await isRemoteBranchUpToDate('nonexistent-branch', '/test/path')

      expect(result).toBe(false)
      expect(execa).toHaveBeenCalledWith(
        'git',
        ['ls-remote', '--heads', 'origin', 'nonexistent-branch'],
        expect.objectContaining({ cwd: '/test/path' })
      )
    })

    it('should return false when git command fails', async () => {
      // Mock git command failure
      vi.mocked(execa).mockRejectedValueOnce(new Error('remote not found'))

      const result = await isRemoteBranchUpToDate('any-branch', '/test/path')

      expect(result).toBe(false)
      expect(execa).toHaveBeenCalledWith(
        'git',
        ['ls-remote', '--heads', 'origin', 'any-branch'],
        expect.objectContaining({ cwd: '/test/path' })
      )
    })

    it('should return false when ls-remote returns only whitespace', async () => {
      // Mock ls-remote with whitespace-only output
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '   \n  \t  ',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await isRemoteBranchUpToDate('feature-branch', '/test/path')

      expect(result).toBe(false)
    })

    it('should return false when remote and local commits do not match', async () => {
      // Mock successful ls-remote command with remote commit
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123\trefs/heads/feature-branch',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock local rev-parse with different commit hash
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'def456',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await isRemoteBranchUpToDate('feature-branch', '/test/path')

      expect(result).toBe(false)
      expect(execa).toHaveBeenCalledTimes(2)
    })

    it('should return false when local rev-parse fails', async () => {
      // Mock successful ls-remote command
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123\trefs/heads/feature-branch',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock local rev-parse failure
      vi.mocked(execa).mockRejectedValueOnce(new Error('unknown revision'))

      const result = await isRemoteBranchUpToDate('feature-branch', '/test/path')

      expect(result).toBe(false)
    })
  })

  describe('checkRemoteBranchStatus', () => {
    beforeEach(() => {
      vi.resetAllMocks()
    })

    it('should return exists=true, remoteAhead=false, localAhead=false when remote and local match', async () => {
      // Mock fetch (succeeds)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock ls-remote (returns same commit as local)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123\trefs/heads/feature-branch',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock rev-parse for local commit
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'abc123',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.exists).toBe(true)
      expect(result.remoteAhead).toBe(false)
      expect(result.localAhead).toBe(false)
      expect(result.networkError).toBe(false)
    })

    it('should return exists=true, remoteAhead=true, localAhead=false when remote is ahead of local (SAFE - no data loss)', async () => {
      // Mock fetch (succeeds)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock ls-remote (returns different commit)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'remote123\trefs/heads/feature-branch',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock rev-parse for local commit (different from remote)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'local456',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock merge-base --is-ancestor (succeeds = local is ancestor of remote = remote is ahead)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.exists).toBe(true)
      expect(result.remoteAhead).toBe(true)
      expect(result.localAhead).toBe(false)
      expect(result.networkError).toBe(false)
    })

    it('should return exists=true, remoteAhead=false, localAhead=true when local is ahead of remote (BLOCK - data loss risk)', async () => {
      // Mock fetch (succeeds)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock ls-remote (returns different commit)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'remote123\trefs/heads/feature-branch',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock rev-parse for local commit (different from remote)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'local456',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      // Mock merge-base --is-ancestor (fails = local is NOT ancestor of remote = local is ahead or diverged)
      vi.mocked(execa).mockRejectedValueOnce(new Error('exit code 1'))

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.exists).toBe(true)
      expect(result.remoteAhead).toBe(false)
      expect(result.localAhead).toBe(true)
      expect(result.networkError).toBe(false)
    })

    it('should return exists=false, localAhead=false when remote branch does not exist', async () => {
      // Mock fetch (fails for non-existent branch, but not a network error)
      vi.mocked(execa).mockRejectedValueOnce(new Error("couldn't find remote ref"))

      // Mock ls-remote (returns empty = branch doesn't exist)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as ReturnType<typeof execa>)

      const result = await checkRemoteBranchStatus('nonexistent-branch', '/test/path')

      expect(result.exists).toBe(false)
      expect(result.remoteAhead).toBe(false)
      expect(result.localAhead).toBe(false)
      expect(result.networkError).toBe(false)
    })

    it('should return networkError=true when network is unavailable during fetch', async () => {
      // Mock fetch (fails with network error)
      vi.mocked(execa).mockRejectedValueOnce(new Error('Could not resolve host: github.com'))

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.exists).toBe(false)
      expect(result.remoteAhead).toBe(false)
      expect(result.localAhead).toBe(false)
      expect(result.networkError).toBe(true)
      expect(result.errorMessage).toContain('Could not resolve host')
    })

    it('should return networkError=true when connection is refused', async () => {
      // Mock fetch (fails with connection refused)
      vi.mocked(execa).mockRejectedValueOnce(new Error('Connection refused'))

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.networkError).toBe(true)
      expect(result.localAhead).toBe(false)
      expect(result.errorMessage).toContain('Connection refused')
    })

    it('should return networkError=true when connection times out', async () => {
      // Mock fetch (fails with timeout)
      vi.mocked(execa).mockRejectedValueOnce(new Error('Connection timed out'))

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.networkError).toBe(true)
      expect(result.localAhead).toBe(false)
      expect(result.errorMessage).toContain('Connection timed out')
    })

    it('should return networkError=true when unable to access remote', async () => {
      // Mock fetch (fails with access error)
      vi.mocked(execa).mockRejectedValueOnce(new Error('unable to access the repository'))

      const result = await checkRemoteBranchStatus('feature-branch', '/test/path')

      expect(result.networkError).toBe(true)
      expect(result.localAhead).toBe(false)
      expect(result.errorMessage).toContain('unable to access')
    })
  })

  describe('findWorktreeForBranch', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('should find worktree with the specified branch checked out', async () => {
      // Mock git worktree list output with multiple worktrees
      const mockOutput = [
        'worktree /Users/dev/main-repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/parent-worktree',
        'HEAD def456',
        'branch refs/heads/test/parent-branch',
        '',
        'worktree /Users/dev/child-worktree',
        'HEAD ghi789',
        'branch refs/heads/test/child-branch',
        '',
      ].join('\n')

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: mockOutput,
        stderr: '',
      } as ReturnType<typeof execa>)

      const result = await findWorktreeForBranch('test/parent-branch', '/Users/dev/child-worktree')

      expect(result).toBe('/Users/dev/parent-worktree')
    })

    it('should find worktree for main branch', async () => {
      const mockOutput = [
        'worktree /Users/dev/main-repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/feature-worktree',
        'HEAD def456',
        'branch refs/heads/feature-1',
        '',
      ].join('\n')

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: mockOutput,
        stderr: '',
      } as ReturnType<typeof execa>)

      const result = await findWorktreeForBranch('main', '/Users/dev/feature-worktree')

      expect(result).toBe('/Users/dev/main-repo')
    })

    it('should throw error when no worktree has the branch checked out', async () => {
      const mockOutput = [
        'worktree /Users/dev/main-repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/feature-worktree',
        'HEAD def456',
        'branch refs/heads/feature-1',
        '',
      ].join('\n')

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: mockOutput,
        stderr: '',
      } as ReturnType<typeof execa>)

      await expect(
        findWorktreeForBranch('nonexistent-branch', '/Users/dev/feature-worktree')
      ).rejects.toThrow(/No worktree found with branch 'nonexistent-branch' checked out/)
    })

    it('should throw error when worktree list is empty', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
      } as ReturnType<typeof execa>)

      await expect(
        findWorktreeForBranch('main', '/some/path')
      ).rejects.toThrow(/No worktrees found in repository/)
    })

    it('should handle branches with slashes in name (child loom scenario)', async () => {
      // This is the key scenario for issue #328:
      // Child loom needs to find parent branch worktree for merge
      const mockOutput = [
        'worktree /Users/dev/main-repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/parent-loom',
        'HEAD def456',
        'branch refs/heads/fix/issue-123__parent-feature',
        '',
        'worktree /Users/dev/child-loom',
        'HEAD ghi789',
        'branch refs/heads/fix/issue-456__child-feature',
        '',
      ].join('\n')

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: mockOutput,
        stderr: '',
      } as ReturnType<typeof execa>)

      // Child loom wants to find where parent branch is checked out
      const result = await findWorktreeForBranch('fix/issue-123__parent-feature', '/Users/dev/child-loom')

      expect(result).toBe('/Users/dev/parent-loom')
    })

    it('should include available worktrees in error message for debugging', async () => {
      const mockOutput = [
        'worktree /Users/dev/main-repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/feature-worktree',
        'HEAD def456',
        'branch refs/heads/feature-1',
        '',
      ].join('\n')

      vi.mocked(execa).mockResolvedValueOnce({
        stdout: mockOutput,
        stderr: '',
      } as ReturnType<typeof execa>)

      await expect(
        findWorktreeForBranch('missing-branch', '/some/path')
      ).rejects.toThrow(/Available worktrees:.*main.*feature-1/)
    })
  })

  describe('getMergeTargetBranch', () => {
    it('should return parentLoom.branchName from metadata when present', async () => {
      const mockMetadataManager = {
        readMetadata: vi.fn().mockResolvedValue({
          parentLoom: {
            branchName: 'parent-feature-branch',
            type: 'issue',
            identifier: 123,
          },
        }),
      }
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({ mainBranch: 'main' }),
      }

      const result = await getMergeTargetBranch('/some/worktree', {
        metadataManager: mockMetadataManager as never,
        settingsManager: mockSettingsManager as never,
      })

      expect(result).toBe('parent-feature-branch')
      expect(mockMetadataManager.readMetadata).toHaveBeenCalledWith('/some/worktree')
      // Settings should not be called when parent metadata exists
      expect(mockSettingsManager.loadSettings).not.toHaveBeenCalled()
    })

    it('should fall back to configured mainBranch when no parent metadata', async () => {
      const mockMetadataManager = {
        readMetadata: vi.fn().mockResolvedValue({
          branchName: 'feature-branch',
          // No parentLoom
        }),
      }
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({ mainBranch: 'develop' }),
      }

      const result = await getMergeTargetBranch('/some/worktree', {
        metadataManager: mockMetadataManager as never,
        settingsManager: mockSettingsManager as never,
      })

      expect(result).toBe('develop')
      expect(mockMetadataManager.readMetadata).toHaveBeenCalledWith('/some/worktree')
      expect(mockSettingsManager.loadSettings).toHaveBeenCalledWith('/some/worktree')
    })

    it('should fall back to "main" when no parent metadata and no settings', async () => {
      const mockMetadataManager = {
        readMetadata: vi.fn().mockResolvedValue(null),
      }
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const result = await getMergeTargetBranch('/some/worktree', {
        metadataManager: mockMetadataManager as never,
        settingsManager: mockSettingsManager as never,
      })

      expect(result).toBe('main')
    })

    it('should handle child loom with slashed parent branch name', async () => {
      const mockMetadataManager = {
        readMetadata: vi.fn().mockResolvedValue({
          parentLoom: {
            branchName: 'feature/issue-123__parent-feature',
            type: 'issue',
            identifier: 123,
          },
        }),
      }
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({ mainBranch: 'main' }),
      }

      const result = await getMergeTargetBranch('/some/worktree', {
        metadataManager: mockMetadataManager as never,
        settingsManager: mockSettingsManager as never,
      })

      expect(result).toBe('feature/issue-123__parent-feature')
    })
  })
})
