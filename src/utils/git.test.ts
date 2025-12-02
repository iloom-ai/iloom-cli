import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseWorktreeList,
  isPRBranch,
  extractPRNumber,
  extractIssueNumber,
  isWorktreePath,
  generateWorktreePath,
  findMainWorktreePath,
  isEmptyRepository,
  ensureRepositoryHasCommits,
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
    it('should generate valid worktree paths with empty prefix (legacy behavior)', () => {
      const testCases = [
        {
          branch: 'feature-branch',
          root: '/Users/dev/project',
          expected: '/Users/dev/feature-branch',
        },
        {
          branch: 'pr/123',
          root: '/Users/dev/project',
          expected: '/Users/dev/pr-123',
        },
        {
          branch: 'feature/complex-name',
          root: '/home/user/code',
          expected: '/home/user/feature-complex-name',
        },
      ]

      testCases.forEach(({ branch, root, expected }) => {
        expect(generateWorktreePath(branch, root, { prefix: '' })).toBe(expected)
      })
    })

    it('should sanitize branch names properly with empty prefix', () => {
      const testCases = [
        {
          branch: 'feature/with@special#characters',
          root: '/project',
          expected: '/feature-with@special#characters',
        },
        {
          branch: 'branch---with---dashes',
          root: '/project',
          expected: '/branch---with---dashes',
        },
        {
          branch: '-leading-and-trailing-',
          root: '/project',
          expected: '/-leading-and-trailing-',
        },
      ]

      testCases.forEach(({ branch, root, expected }) => {
        expect(generateWorktreePath(branch, root, { prefix: '' })).toBe(expected)
      })
    })

    it('should add PR suffix when options provided with empty prefix', () => {
      const result = generateWorktreePath('feature/branch', '/project', {
        isPR: true,
        prNumber: 123,
        prefix: ''
      })
      expect(result).toBe('/feature-branch_pr_123')
    })

    it('should not add PR suffix when isPR is false with empty prefix', () => {
      const result = generateWorktreePath('feature/branch', '/project', {
        isPR: false,
        prNumber: 123,
        prefix: ''
      })
      expect(result).toBe('/feature-branch')
    })

    describe('with prefix support', () => {
      describe('custom prefix scenarios', () => {
        it('should apply custom prefix before branch name with auto-appended separator', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'worktrees'
          })
          expect(result).toBe('/Users/dev/worktrees-issue-123')
        })

        it('should preserve prefix ending with dash separator', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'worktrees-'
          })
          expect(result).toBe('/Users/dev/worktrees-issue-123')
        })

        it('should preserve prefix ending with underscore separator', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'worktrees_'
          })
          expect(result).toBe('/Users/dev/worktrees_issue-123')
        })

        it('should handle nested directory prefix with forward slashes', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'temp/looms'
          })
          expect(result).toBe('/Users/dev/temp/looms-issue-123')
        })

        it('should handle prefix ending with forward slash', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'worktrees/'
          })
          expect(result).toBe('/Users/dev/worktrees/issue-123')
        })

        it('should handle empty string prefix (no prefix mode)', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: ''
          })
          expect(result).toBe('/Users/dev/issue-123')
        })

        it('should handle prefix with multiple levels of nesting', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'workspace/temp/looms'
          })
          expect(result).toBe('/Users/dev/workspace/temp/looms-issue-123')
        })

        it('should handle nested directory with custom prefix separator (trailing hyphen)', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'looms/myprefix-'
          })
          expect(result).toBe('/Users/dev/looms/myprefix-issue-123')
        })

        it('should handle nested directory with custom prefix separator (trailing underscore)', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            prefix: 'looms/myprefix_'
          })
          expect(result).toBe('/Users/dev/looms/myprefix_issue-123')
        })
      })

      describe('default prefix calculation', () => {
        it('should calculate default prefix from repo basename when prefix undefined', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/my-awesome-project', {})
          expect(result).toBe('/Users/dev/my-awesome-project-looms/issue-123')
        })

        it('should use default when no options provided', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/my-project')
          expect(result).toBe('/Users/dev/my-project-looms/issue-123')
        })

        it('should handle repo names with special characters in default calculation', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/my.project-v2')
          expect(result).toBe('/Users/dev/my.project-v2-looms/issue-123')
        })

        it('should handle single-character repo name', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/p')
          expect(result).toBe('/Users/dev/p-looms/issue-123')
        })

        it('should fallback to "looms" when basename is empty', () => {
          const result = generateWorktreePath('issue-123', '/')
          expect(result).toBe('/looms/issue-123')
        })
      })

      describe('PR suffix with prefix', () => {
        it('should apply both custom prefix and PR suffix', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            isPR: true,
            prNumber: 456,
            prefix: 'work'
          })
          expect(result).toBe('/Users/dev/work-issue-123_pr_456')
        })

        it('should apply both default prefix and PR suffix', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            isPR: true,
            prNumber: 456
          })
          expect(result).toBe('/Users/dev/project-looms/issue-123_pr_456')
        })

        it('should handle PR suffix with empty prefix', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            isPR: true,
            prNumber: 456,
            prefix: ''
          })
          expect(result).toBe('/Users/dev/issue-123_pr_456')
        })

        it('should handle nested prefix with PR suffix', () => {
          const result = generateWorktreePath('issue-123', '/Users/dev/project', {
            isPR: true,
            prNumber: 456,
            prefix: 'temp/work/'
          })
          expect(result).toBe('/Users/dev/temp/work/issue-123_pr_456')
        })
      })

      describe('branch name sanitization with prefix', () => {
        it('should sanitize branch slashes and apply custom prefix', () => {
          const result = generateWorktreePath('feature/add-login', '/Users/dev/project', {
            prefix: 'work'
          })
          expect(result).toBe('/Users/dev/work-feature-add-login')
        })

        it('should sanitize branch slashes and apply default prefix', () => {
          const result = generateWorktreePath('feature/add-login', '/Users/dev/project')
          expect(result).toBe('/Users/dev/project-looms/feature-add-login')
        })

        it('should sanitize branch slashes with nested directory prefix', () => {
          const result = generateWorktreePath('feature/add-login', '/Users/dev/project', {
            prefix: 'temp/work/'
          })
          expect(result).toBe('/Users/dev/temp/work/feature-add-login')
        })
      })
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
})
