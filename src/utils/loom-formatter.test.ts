import { describe, it, expect, vi } from 'vitest'
import {
  formatLoomForJson,
  formatLoomsForJson,
  formatFinishedLoomForJson,
  enrichSwarmIssues,
} from './loom-formatter.js'
import { readRecapFile } from './mcp.js'
import type { GitWorktree } from '../types/worktree.js'
import type { LoomMetadata } from '../lib/MetadataManager.js'

vi.mock('./mcp.js', () => ({
  resolveRecapFilePath: (wp: string) => `/mock/recaps/${wp.replace(/\//g, '___')}.json`,
  readRecapFile: vi.fn().mockResolvedValue({}),
}))

describe('formatLoomForJson', () => {
  /**
   * Factory to create realistic GitWorktree objects mimicking actual git worktree list output.
   * Default values represent a typical secondary worktree state.
   */
  const createWorktree = (overrides: Partial<GitWorktree> = {}): GitWorktree => ({
    path: '/Users/dev/projects/myapp-looms/issue-123__feature-work',
    branch: 'issue-123__feature-work',
    commit: 'abc123def456789012345678901234567890abcd',
    bare: false,
    detached: false,
    locked: false,
    ...overrides,
  })

  /**
   * Factory for creating worktrees with realistic paths that match actual git worktree output.
   * Useful for testing path-based detection (PR suffix, main worktree matching).
   */
  const createRealisticWorktree = (config: {
    basePath?: string
    projectName?: string
    branchName: string
    prNumber?: number
    commit?: string
    bare?: boolean
    detached?: boolean
    locked?: boolean
    lockReason?: string
  }): GitWorktree => {
    const basePath = config.basePath ?? '/Users/dev/projects'
    const projectName = config.projectName ?? 'myapp'

    let path = `${basePath}/${projectName}-looms/${config.branchName}`
    if (config.prNumber) {
      path = `${path}_pr_${config.prNumber}`
    }

    return {
      path,
      branch: config.branchName,
      commit: config.commit ?? 'a1b2c3d4e5f6789012345678901234567890abcd',
      bare: config.bare ?? false,
      detached: config.detached ?? false,
      locked: config.locked ?? false,
      ...(config.lockReason ? { lockReason: config.lockReason } : {}),
    }
  }

  describe('isMainWorktree detection', () => {
    it('should return true when worktree path matches mainWorktreePath', async () => {
      const mainPath = '/Users/dev/projects/myapp'
      const worktree = createWorktree({ path: mainPath, branch: 'main' })
      const result = await formatLoomForJson(worktree, mainPath)
      expect(result.isMainWorktree).toBe(true)
    })

    it('should return false when worktree path does not match mainWorktreePath', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-456__add-feature' })
      const result = await formatLoomForJson(worktree, '/Users/dev/projects/myapp')
      expect(result.isMainWorktree).toBe(false)
    })

    it('should return false when mainWorktreePath is not provided', async () => {
      const worktree = createWorktree({ path: '/Users/dev/projects/myapp', branch: 'main' })
      const result = await formatLoomForJson(worktree)
      expect(result.isMainWorktree).toBe(false)
    })

    it('should correctly identify main worktree with realistic paths', async () => {
      const mainPath = '/Users/adam/Documents/Projects/iloom-cli'
      const mainWorktree = createWorktree({
        path: mainPath,
        branch: 'main',
        commit: 'e71c676abc123def456789012345678901234567',
      })
      const featureWorktree = createRealisticWorktree({
        basePath: '/Users/adam/Documents/Projects',
        projectName: 'iloom-cli',
        branchName: 'issue-269__json-formatter',
      })

      const mainResult = await formatLoomForJson(mainWorktree, mainPath)
      const featureResult = await formatLoomForJson(featureWorktree, mainPath)

      expect(mainResult.isMainWorktree).toBe(true)
      expect(featureResult.isMainWorktree).toBe(false)
    })
  })

  describe('type detection', () => {
    it('should detect PR type from _pr_N path suffix', async () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__feature',
        prNumber: 456,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('pr')
    })

    it('should detect issue type from issue-N branch pattern', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-123__feature' })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
    })

    it('should detect issue type from alphanumeric pattern (MARK-1)', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-MARK-1__feature' })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
    })

    it('should default to branch type when no patterns match', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('branch')
    })

    describe('branch naming pattern variations', () => {
      it.each([
        // Standard issue patterns
        ['issue-42__fix-login', 'issue'],
        ['issue-1__initial-setup', 'issue'],
        ['issue-99999__large-number', 'issue'],

        // Linear-style alphanumeric IDs
        ['issue-PROJ-123__implement-feature', 'issue'],
        ['issue-ABC-1__short-prefix', 'issue'],
        ['issue-MYAPP-9999__long-id', 'issue'],

        // Old format (issue-N-slug)
        ['issue-25-add-tests', 'issue'],
        ['issue-1-init', 'issue'],

        // Conventional commit prefixes (should be 'branch' type - no issue pattern)
        ['feat/add-dark-mode', 'branch'],
        ['fix/login-bug', 'branch'],
        ['chore/update-deps', 'branch'],
        ['refactor/cleanup-code', 'branch'],
        ['docs/update-readme', 'branch'],
        ['test/add-coverage', 'branch'],
        ['hotfix/critical-bug', 'branch'],
        ['release/v1.0.0', 'branch'],

        // Main/default branches
        ['main', 'branch'],
        ['master', 'branch'],
        ['develop', 'branch'],
        ['development', 'branch'],

        // Feature branches without issue numbers
        ['feature-dark-mode', 'branch'],
        ['add-json-formatter', 'branch'],
        ['wip-testing', 'branch'],
      ])('should detect type for branch "%s" as "%s"', async (branchName, expectedType) => {
        const worktree = createWorktree({
          path: `/Users/dev/projects/myapp-looms/${branchName}`,
          branch: branchName,
        })
        const result = await formatLoomForJson(worktree)
        expect(result.type).toBe(expectedType)
      })
    })

    describe('PR detection with various path patterns', () => {
      it.each([
        // Standard PR suffix patterns
        ['/projects/myapp-looms/issue-123__feature_pr_1', 'pr'],
        ['/projects/myapp-looms/issue-456__fix-bug_pr_99', 'pr'],
        ['/projects/myapp-looms/issue-PROJ-789__new-feature_pr_1000', 'pr'],

        // Large PR numbers
        ['/projects/myapp-looms/issue-1__init_pr_99999', 'pr'],

        // No PR suffix - should be issue type
        ['/projects/myapp-looms/issue-123__feature', 'issue'],

        // Path that looks like PR but branch has issue pattern
        ['/projects/myapp-looms/issue-42__test', 'issue'],
      ])('should detect type for path "%s" as "%s"', async (path, expectedType) => {
        const worktree = createWorktree({
          path,
          branch: 'issue-123__feature', // Branch always has issue pattern
        })
        const result = await formatLoomForJson(worktree)
        expect(result.type).toBe(expectedType)
      })
    })
  })

  describe('pr_numbers extraction', () => {
    it('should extract PR number from path suffix for PR type', async () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__feature',
        prNumber: 456,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual(['456'])
    })

    it('should return empty pr_numbers for issue type', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-123__feature' })
      const result = await formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual([])
    })

    it('should return empty pr_numbers for branch type', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual([])
    })

    it.each([
      // Various PR number sizes
      [1, '1'],
      [99, '99'],
      [123, '123'],
      [9999, '9999'],
      [99999, '99999'],
    ])('should extract PR number %d as string "%s"', async (prNum, expectedStr) => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-42__feature',
        prNumber: prNum,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual([expectedStr])
    })
  })

  describe('issue_numbers extraction', () => {
    it('should extract numeric issue number from branch for issue type', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__fix-bug' })
      const result = await formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual(['42'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should extract alphanumeric issue ID (Linear-style) for issue type', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-PROJ-123__implement-feature' })
      const result = await formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual(['PROJ-123'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should return empty issue_numbers for branch type', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should handle old format issue branch (issue-N-slug)', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-25-add-tests' })
      const result = await formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual(['25'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should return empty issue_numbers for PR type (pr_numbers populated instead)', async () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__feature',
        prNumber: 456,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual(['456'])
    })

    describe('issue ID format variations', () => {
      it.each([
        // New format with double underscore
        ['issue-1__setup', '1'],
        ['issue-42__fix-bug', '42'],
        ['issue-999__large-number', '999'],
        ['issue-12345__very-large', '12345'],

        // Linear-style alphanumeric IDs
        ['issue-PROJ-1__feature', 'PROJ-1'],
        ['issue-ABC-123__work', 'ABC-123'],
        ['issue-MYAPP-9999__long', 'MYAPP-9999'],
        ['issue-XY-1__short-prefix', 'XY-1'],

        // Old format with single dash
        ['issue-1-init', '1'],
        ['issue-42-fix', '42'],
        ['issue-123-feature', '123'],
      ])('should extract issue number from "%s" as "%s"', async (branchName, expectedIssue) => {
        const worktree = createRealisticWorktree({ branchName })
        const result = await formatLoomForJson(worktree)
        expect(result.issue_numbers).toEqual([expectedIssue])
        expect(result.type).toBe('issue')
      })
    })
  })

  describe('field mapping', () => {
    it('should use branch as name', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__feature-test' })
      const result = await formatLoomForJson(worktree)
      expect(result.name).toBe('issue-42__feature-test')
    })

    it('should use path as name when branch is empty', async () => {
      const worktree = createWorktree({
        branch: '',
        path: '/Users/dev/projects/myapp-looms/orphan-worktree',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.name).toBe('/Users/dev/projects/myapp-looms/orphan-worktree')
    })

    it('should handle null worktreePath when bare is true', async () => {
      const worktree = createWorktree({
        bare: true,
        path: '/Users/dev/projects/myapp.git',
        branch: 'main',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull()
    })

    it('should return path as worktreePath when not bare', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__feature' })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-42__feature')
    })

    it('should return branch as branch field', async () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__my-branch' })
      const result = await formatLoomForJson(worktree)
      expect(result.branch).toBe('issue-42__my-branch')
    })

    it('should return null for branch when empty', async () => {
      const worktree = createWorktree({ branch: '' })
      const result = await formatLoomForJson(worktree)
      expect(result.branch).toBeNull()
    })
  })

  describe('detached HEAD states', () => {
    it('should handle detached HEAD with branch set to HEAD', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp-looms/detached-state',
        branch: 'HEAD',
        commit: 'abc123def456789012345678901234567890abcd',
        detached: true,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.branch).toBe('HEAD')
      expect(result.name).toBe('HEAD')
      expect(result.type).toBe('branch') // No issue pattern in "HEAD"
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should handle detached HEAD from bisect operation', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'HEAD',
        commit: 'def456abc123789012345678901234567890abcd',
        detached: true,
        bare: false,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('branch')
      expect(result.worktreePath).toBe('/Users/dev/projects/myapp')
    })

    it('should correctly identify main worktree even when detached', async () => {
      const mainPath = '/Users/dev/projects/myapp'
      const worktree = createWorktree({
        path: mainPath,
        branch: 'HEAD',
        detached: true,
      })
      const result = await formatLoomForJson(worktree, mainPath)
      expect(result.isMainWorktree).toBe(true)
    })
  })

  describe('bare repositories', () => {
    it('should set worktreePath to null for bare repository', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp.git',
        branch: 'main',
        bare: true,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull()
      expect(result.branch).toBe('main')
      expect(result.name).toBe('main')
    })

    it('should handle bare repo with custom default branch', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp.git',
        branch: 'develop',
        bare: true,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull()
      expect(result.branch).toBe('develop')
      expect(result.type).toBe('branch')
    })

    it('should correctly identify bare repo as main worktree when path matches', async () => {
      const barePath = '/Users/dev/projects/myapp.git'
      const worktree = createWorktree({
        path: barePath,
        branch: 'main',
        bare: true,
      })
      const result = await formatLoomForJson(worktree, barePath)
      expect(result.isMainWorktree).toBe(true)
      expect(result.worktreePath).toBeNull()
    })
  })

  describe('locked worktrees', () => {
    it('should handle locked worktree without reason', async () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-42__in-progress',
        locked: true,
      })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
      expect(result.issue_numbers).toEqual(['42'])
      // Note: locked status is not exposed in LoomJsonOutput, but should not break formatting
    })

    it('should handle locked worktree with lock reason', async () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__critical-fix',
        locked: true,
        lockReason: 'Locked for deployment review',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
      expect(result.issue_numbers).toEqual(['123'])
      expect(result.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-123__critical-fix')
    })

    it('should handle locked PR worktree', async () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-789__feature',
        prNumber: 100,
        locked: true,
        lockReason: 'PR under review',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.type).toBe('pr')
      expect(result.pr_numbers).toEqual(['100'])
      expect(result.issue_numbers).toEqual([])
    })
  })

  describe('edge cases and realistic git output scenarios', () => {
    it('should handle worktree with empty commit hash', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
        commit: '',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.branch).toBe('main')
      expect(result.type).toBe('branch')
    })

    it('should handle worktree paths with spaces', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/My Projects/myapp-looms/issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('/Users/dev/My Projects/myapp-looms/issue-42__feature')
      expect(result.type).toBe('issue')
    })

    it('should handle worktree paths with special characters', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/my-app@2.0-looms/issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('/Users/dev/projects/my-app@2.0-looms/issue-42__feature')
    })

    it('should handle branch names with forward slashes (converted by git worktree)', async () => {
      // When a branch like "feat/add-feature" is used with worktrees,
      // the path typically has the slash converted
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp-looms/feat-add-feature',
        branch: 'feat/add-feature', // Original branch name preserved
      })
      const result = await formatLoomForJson(worktree)
      expect(result.branch).toBe('feat/add-feature')
      expect(result.name).toBe('feat/add-feature')
      expect(result.type).toBe('branch')
    })

    it('should handle very long branch names', async () => {
      const longSlug = 'a'.repeat(100)
      const branchName = `issue-42__${longSlug}`
      const worktree = createRealisticWorktree({ branchName })
      const result = await formatLoomForJson(worktree)
      expect(result.branch).toBe(branchName)
      expect(result.issue_numbers).toEqual(['42'])
    })

    it('should handle worktree with all flags set', async () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp.git',
        branch: 'main',
        commit: 'abc123',
        bare: true,
        detached: true,
        locked: true,
        lockReason: 'Test lock',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull() // bare=true overrides
      expect(result.branch).toBe('main')
    })

    it('should handle Windows-style paths', async () => {
      const worktree = createWorktree({
        path: 'C:\\Users\\dev\\projects\\myapp-looms\\issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('C:\\Users\\dev\\projects\\myapp-looms\\issue-42__feature')
      expect(result.type).toBe('issue')
    })

    it('should handle network/UNC paths', async () => {
      const worktree = createWorktree({
        path: '//server/share/projects/myapp-looms/issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = await formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('//server/share/projects/myapp-looms/issue-42__feature')
    })
  })
})

describe('formatLoomsForJson', () => {
  it('should transform array of worktrees to JSON schema with correct issue/pr numbers', async () => {
    const mainPath = '/Users/dev/projects/myapp'
    const worktrees: GitWorktree[] = [
      {
        path: '/Users/dev/projects/myapp-looms/issue-1__feature',
        branch: 'issue-1__feature',
        commit: 'abc123def456789012345678901234567890abcd',
        bare: false,
        detached: false,
        locked: false,
      },
      {
        path: mainPath,
        branch: 'main',
        commit: 'def456abc123789012345678901234567890abcd',
        bare: false,
        detached: false,
        locked: false,
      },
      {
        path: '/Users/dev/projects/myapp-looms/issue-42__feature_pr_99',
        branch: 'issue-42__feature',
        commit: 'ghi789abc123def456789012345678901234abcd',
        bare: false,
        detached: false,
        locked: false,
      },
    ]

    const result = await formatLoomsForJson(worktrees, mainPath)

    expect(result).toHaveLength(3)
    // Issue type - issue_numbers populated, pr_numbers empty, not main
    expect(result[0].name).toBe('issue-1__feature')
    expect(result[0].type).toBe('issue')
    expect(result[0].issue_numbers).toEqual(['1'])
    expect(result[0].pr_numbers).toEqual([])
    expect(result[0].isMainWorktree).toBe(false)
    // Branch type (main) - both empty, IS main worktree
    expect(result[1].name).toBe('main')
    expect(result[1].type).toBe('branch')
    expect(result[1].issue_numbers).toEqual([])
    expect(result[1].pr_numbers).toEqual([])
    expect(result[1].isMainWorktree).toBe(true)
    // PR type - pr_numbers populated, issue_numbers empty, not main
    expect(result[2].name).toBe('issue-42__feature')
    expect(result[2].type).toBe('pr')
    expect(result[2].issue_numbers).toEqual([])
    expect(result[2].pr_numbers).toEqual(['99'])
    expect(result[2].isMainWorktree).toBe(false)
  })

  it('should return empty array for empty input', async () => {
    const result = await formatLoomsForJson([])
    expect(result).toEqual([])
  })

  describe('realistic multi-worktree scenarios', () => {
    it('should handle typical iloom workspace with multiple active issues', async () => {
      const mainPath = '/Users/adam/Documents/Projects/iloom-cli'
      const worktrees: GitWorktree[] = [
        // Main worktree
        {
          path: mainPath,
          branch: 'main',
          commit: 'e71c676abc123def456789012345678901234567',
          bare: false,
          detached: false,
          locked: false,
        },
        // Active issue worktree
        {
          path: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-269__json-formatter',
          branch: 'issue-269__json-formatter',
          commit: 'bee253dabc123def456789012345678901234567',
          bare: false,
          detached: false,
          locked: false,
        },
        // PR worktree
        {
          path: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-254__dotenv-flow_pr_255',
          branch: 'issue-254__dotenv-flow',
          commit: 'aa52504abc123def456789012345678901234567',
          bare: false,
          detached: false,
          locked: false,
        },
        // Linear-style issue
        {
          path: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-ILOOM-42__new-feature',
          branch: 'issue-ILOOM-42__new-feature',
          commit: 'acc379babc123def456789012345678901234567',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      const result = await formatLoomsForJson(worktrees, mainPath)

      expect(result).toHaveLength(4)

      // Main worktree
      expect(result[0]).toEqual({
        name: 'main',
        worktreePath: mainPath,
        branch: 'main',
        type: 'branch',
        issue_numbers: [],
        pr_numbers: [],
        isMainWorktree: true,
        description: null,
        created_at: null,
        issueTracker: null,
        colorHex: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        capabilities: [],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })

      // Issue worktree
      expect(result[1]).toEqual({
        name: 'issue-269__json-formatter',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-269__json-formatter',
        branch: 'issue-269__json-formatter',
        type: 'issue',
        issue_numbers: ['269'],
        pr_numbers: [],
        isMainWorktree: false,
        description: null,
        created_at: null,
        issueTracker: null,
        colorHex: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        capabilities: [],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })

      // PR worktree
      expect(result[2]).toEqual({
        name: 'issue-254__dotenv-flow',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-254__dotenv-flow_pr_255',
        branch: 'issue-254__dotenv-flow',
        type: 'pr',
        issue_numbers: [],
        pr_numbers: ['255'],
        isMainWorktree: false,
        description: null,
        created_at: null,
        issueTracker: null,
        colorHex: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        capabilities: [],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })

      // Linear-style issue
      expect(result[3]).toEqual({
        name: 'issue-ILOOM-42__new-feature',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-ILOOM-42__new-feature',
        branch: 'issue-ILOOM-42__new-feature',
        type: 'issue',
        issue_numbers: ['ILOOM-42'],
        pr_numbers: [],
        isMainWorktree: false,
        description: null,
        created_at: null,
        issueTracker: null,
        colorHex: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        capabilities: [],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })
    })

    it('should handle mixed worktree states (detached, locked, bare)', async () => {
      const worktrees: GitWorktree[] = [
        // Main bare repo
        {
          path: '/Users/dev/projects/myapp.git',
          branch: 'main',
          commit: 'abc123',
          bare: true,
          detached: false,
          locked: false,
        },
        // Detached HEAD worktree
        {
          path: '/Users/dev/projects/myapp-looms/bisect-test',
          branch: 'HEAD',
          commit: 'def456',
          bare: false,
          detached: true,
          locked: false,
        },
        // Locked issue worktree
        {
          path: '/Users/dev/projects/myapp-looms/issue-100__critical',
          branch: 'issue-100__critical',
          commit: 'ghi789',
          bare: false,
          detached: false,
          locked: true,
          lockReason: 'Under review',
        },
      ]

      const result = await formatLoomsForJson(worktrees)

      expect(result).toHaveLength(3)

      // Bare repo - worktreePath null
      expect(result[0].worktreePath).toBeNull()
      expect(result[0].type).toBe('branch')

      // Detached - has path, type is branch
      expect(result[1].worktreePath).toBe('/Users/dev/projects/myapp-looms/bisect-test')
      expect(result[1].type).toBe('branch')
      expect(result[1].branch).toBe('HEAD')

      // Locked - still formatted normally
      expect(result[2].type).toBe('issue')
      expect(result[2].issue_numbers).toEqual(['100'])
    })

    it('should handle worktrees without mainWorktreePath provided', async () => {
      const worktrees: GitWorktree[] = [
        {
          path: '/Users/dev/projects/myapp',
          branch: 'main',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
        {
          path: '/Users/dev/projects/myapp-looms/issue-1__feature',
          branch: 'issue-1__feature',
          commit: 'def456',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      // No mainWorktreePath provided
      const result = await formatLoomsForJson(worktrees)

      expect(result).toHaveLength(2)
      // All should have isMainWorktree: false when not provided
      expect(result[0].isMainWorktree).toBe(false)
      expect(result[1].isMainWorktree).toBe(false)
    })
  })
})

describe('formatFinishedLoomForJson', () => {
  /**
   * Factory to create realistic LoomMetadata objects for finished looms
   */
  const createFinishedMetadata = (overrides: Partial<LoomMetadata> = {}): LoomMetadata => ({
    description: 'Add JSON formatter support',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-269__json-formatter',
    worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-269__json-formatter',
    issueType: 'issue',
    issue_numbers: ['269'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-abc123',
    projectPath: '/Users/adam/Documents/Projects/iloom-cli',
    issueUrls: { '269': 'https://github.com/owner/repo/issues/269' },
    prUrls: {},
    draftPrNumber: null,
    capabilities: [],
    parentLoom: null,
    status: 'finished',
    finishedAt: '2024-01-20T15:45:00.000Z',
    ...overrides,
  })

  describe('field mapping', () => {
    it('should correctly format finished loom with all fields populated', async () => {
      const metadata = createFinishedMetadata()
      const result = await formatFinishedLoomForJson(metadata)

      expect(result).toEqual({
        name: 'issue-269__json-formatter',
        worktreePath: null,
        branch: 'issue-269__json-formatter',
        type: 'issue',
        issue_numbers: ['269'],
        pr_numbers: [],
        isMainWorktree: false,
        description: 'Add JSON formatter support',
        created_at: '2024-01-15T10:30:00.000Z',
        issueTracker: 'github',
        colorHex: '#dcebff',
        projectPath: '/Users/adam/Documents/Projects/iloom-cli',
        issueUrls: { '269': 'https://github.com/owner/repo/issues/269' },
        prUrls: {},
        status: 'finished',
        finishedAt: '2024-01-20T15:45:00.000Z',
        capabilities: [],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })
    })

    it('should use branchName for name field', async () => {
      const metadata = createFinishedMetadata({
        branchName: 'issue-PROJ-123__feature-work',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.name).toBe('issue-PROJ-123__feature-work')
    })

    it('should fallback to worktreePath for name when branchName is null', async () => {
      const metadata = createFinishedMetadata({
        branchName: null,
        worktreePath: '/Users/dev/projects/myapp-looms/orphan-branch',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.name).toBe('/Users/dev/projects/myapp-looms/orphan-branch')
    })

    it('should fallback to "unknown" for name when both branchName and worktreePath are null', async () => {
      const metadata = createFinishedMetadata({
        branchName: null,
        worktreePath: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.name).toBe('unknown')
    })

    it('should always set worktreePath to null for finished looms', async () => {
      const metadata = createFinishedMetadata({
        worktreePath: '/some/path/that/should/be/ignored',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.worktreePath).toBeNull()
    })

    it('should always set isMainWorktree to false for finished looms', async () => {
      const metadata = createFinishedMetadata()
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.isMainWorktree).toBe(false)
    })
  })

  describe('type detection and issue/pr numbers', () => {
    it('should format finished issue loom correctly', async () => {
      const metadata = createFinishedMetadata({
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('issue')
      expect(result.issue_numbers).toEqual(['42'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should format finished PR loom correctly', async () => {
      const metadata = createFinishedMetadata({
        branchName: 'issue-254__dotenv-flow',
        issueType: 'pr',
        issue_numbers: [],
        pr_numbers: ['255'],
        prUrls: { '255': 'https://github.com/owner/repo/pull/255' },
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('pr')
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual(['255'])
      expect(result.prUrls).toEqual({ '255': 'https://github.com/owner/repo/pull/255' })
    })

    it('should format finished branch loom correctly', async () => {
      const metadata = createFinishedMetadata({
        branchName: 'feat/new-feature',
        issueType: 'branch',
        issue_numbers: [],
        pr_numbers: [],
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('branch')
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should default to branch type when issueType is null', async () => {
      const metadata = createFinishedMetadata({
        issueType: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('branch')
    })

    it('should handle Linear-style alphanumeric issue numbers', async () => {
      const metadata = createFinishedMetadata({
        branchName: 'issue-PROJ-123__implement-feature',
        issueType: 'issue',
        issue_numbers: ['PROJ-123'],
        issueUrls: { 'PROJ-123': 'https://linear.app/org/issue/PROJ-123' },
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual(['PROJ-123'])
      expect(result.issueUrls).toEqual({ 'PROJ-123': 'https://linear.app/org/issue/PROJ-123' })
    })

    it('should handle multiple issue numbers', async () => {
      const metadata = createFinishedMetadata({
        issueType: 'issue',
        issue_numbers: ['42', 'PROJ-123', '999'],
        issueUrls: {
          '42': 'https://github.com/owner/repo/issues/42',
          'PROJ-123': 'https://linear.app/org/issue/PROJ-123',
          '999': 'https://github.com/owner/repo/issues/999',
        },
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual(['42', 'PROJ-123', '999'])
      expect(result.issueUrls).toEqual({
        '42': 'https://github.com/owner/repo/issues/42',
        'PROJ-123': 'https://linear.app/org/issue/PROJ-123',
        '999': 'https://github.com/owner/repo/issues/999',
      })
    })

    it('should handle multiple PR numbers', async () => {
      const metadata = createFinishedMetadata({
        issueType: 'pr',
        issue_numbers: [],
        pr_numbers: ['100', '101'],
        prUrls: {
          '100': 'https://github.com/owner/repo/pull/100',
          '101': 'https://github.com/owner/repo/pull/101',
        },
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.pr_numbers).toEqual(['100', '101'])
      expect(result.prUrls).toEqual({
        '100': 'https://github.com/owner/repo/pull/100',
        '101': 'https://github.com/owner/repo/pull/101',
      })
    })
  })

  describe('optional field handling', () => {
    it('should handle empty description field', async () => {
      const metadata = createFinishedMetadata({
        description: '',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.description).toBe('')
    })

    it('should handle null created_at', async () => {
      const metadata = createFinishedMetadata({
        created_at: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.created_at).toBeNull()
    })

    it('should handle null issueTracker', async () => {
      const metadata = createFinishedMetadata({
        issueTracker: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.issueTracker).toBeNull()
    })

    it('should handle null colorHex', async () => {
      const metadata = createFinishedMetadata({
        colorHex: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.colorHex).toBeNull()
    })

    it('should handle null projectPath', async () => {
      const metadata = createFinishedMetadata({
        projectPath: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.projectPath).toBeNull()
    })

    it('should handle empty issueUrls and prUrls', async () => {
      const metadata = createFinishedMetadata({
        issueUrls: {},
        prUrls: {},
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.issueUrls).toEqual({})
      expect(result.prUrls).toEqual({})
    })

    it('should handle undefined status field with default "finished"', async () => {
      const metadata = createFinishedMetadata({
        status: undefined,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.status).toBe('finished')
    })

    it('should handle null finishedAt', async () => {
      const metadata = createFinishedMetadata({
        finishedAt: null,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.finishedAt).toBeNull()
    })

    it('should handle undefined finishedAt', async () => {
      const metadata = createFinishedMetadata({
        finishedAt: undefined,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.finishedAt).toBeNull()
    })
  })

  describe('edge cases and legacy metadata', () => {
    it('should handle minimal legacy metadata with only required fields', async () => {
      const metadata: LoomMetadata = {
        description: 'Legacy loom',
        created_at: null,
        branchName: 'old-branch',
        worktreePath: null,
        issueType: null,
        issue_numbers: [],
        pr_numbers: [],
        issueTracker: null,
        colorHex: null,
        sessionId: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        capabilities: [],
        parentLoom: null,
        status: 'finished',
        finishedAt: null,
      }
      const result = await formatFinishedLoomForJson(metadata)
      expect(result).toEqual({
        name: 'old-branch',
        worktreePath: null,
        branch: 'old-branch',
        type: 'branch',
        issue_numbers: [],
        pr_numbers: [],
        isMainWorktree: false,
        description: 'Legacy loom',
        created_at: null,
        issueTracker: null,
        colorHex: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        status: 'finished',
        finishedAt: null,
        capabilities: [],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })
    })

    it('should handle empty issue_numbers and pr_numbers arrays', async () => {
      const metadata = createFinishedMetadata({
        issue_numbers: [],
        pr_numbers: [],
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should handle branch names with special characters', async () => {
      const metadata = createFinishedMetadata({
        branchName: 'feat/add-feature@v2.0-beta',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.branch).toBe('feat/add-feature@v2.0-beta')
      expect(result.name).toBe('feat/add-feature@v2.0-beta')
    })

    it('should handle very long branch names', async () => {
      const longSlug = 'a'.repeat(200)
      const branchName = `issue-42__${longSlug}`
      const metadata = createFinishedMetadata({
        branchName,
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.branch).toBe(branchName)
      expect(result.name).toBe(branchName)
    })

    it('should handle finished loom with active status', async () => {
      const metadata = createFinishedMetadata({
        status: 'active',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.status).toBe('active')
    })

    it('should preserve exact status value from metadata', async () => {
      const metadata = createFinishedMetadata({
        status: 'finished',
      })
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.status).toBe('finished')
    })
  })

  describe('realistic finished loom scenarios', () => {
    it('should format finished issue loom from iloom-cli project', async () => {
      const metadata: LoomMetadata = {
        description: 'Add JSON formatter support to il list command',
        created_at: '2024-01-15T10:30:00.000Z',
        branchName: 'issue-269__json-formatter',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-269__json-formatter',
        issueType: 'issue',
        issue_numbers: ['269'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#dcebff',
        sessionId: 'session-abc123',
        projectPath: '/Users/adam/Documents/Projects/iloom-cli',
        issueUrls: { '269': 'https://github.com/acreeger/iloom-cli/issues/269' },
        prUrls: {},
        draftPrNumber: null,
        capabilities: ['cli'],
        parentLoom: null,
        status: 'finished',
        finishedAt: '2024-01-20T15:45:00.000Z',
      }
      const result = await formatFinishedLoomForJson(metadata)
      expect(result).toEqual({
        name: 'issue-269__json-formatter',
        worktreePath: null,
        branch: 'issue-269__json-formatter',
        type: 'issue',
        issue_numbers: ['269'],
        pr_numbers: [],
        isMainWorktree: false,
        description: 'Add JSON formatter support to il list command',
        created_at: '2024-01-15T10:30:00.000Z',
        issueTracker: 'github',
        colorHex: '#dcebff',
        projectPath: '/Users/adam/Documents/Projects/iloom-cli',
        issueUrls: { '269': 'https://github.com/acreeger/iloom-cli/issues/269' },
        prUrls: {},
        status: 'finished',
        finishedAt: '2024-01-20T15:45:00.000Z',
        capabilities: ['cli'],
        state: null,
        isChildLoom: false,
        parentLoom: null,
      })
    })

    it('should format finished PR loom', async () => {
      const metadata: LoomMetadata = {
        description: 'Implement dotenv-flow integration',
        created_at: '2024-01-10T08:00:00.000Z',
        branchName: 'issue-254__dotenv-flow',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-254__dotenv-flow_pr_255',
        issueType: 'pr',
        issue_numbers: [],
        pr_numbers: ['255'],
        issueTracker: 'github',
        colorHex: '#ffe0b2',
        sessionId: 'session-def456',
        projectPath: '/Users/adam/Documents/Projects/iloom-cli',
        issueUrls: {},
        prUrls: { '255': 'https://github.com/acreeger/iloom-cli/pull/255' },
        draftPrNumber: null,
        capabilities: ['cli'],
        parentLoom: null,
        status: 'finished',
        finishedAt: '2024-01-18T12:30:00.000Z',
      }
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('pr')
      expect(result.pr_numbers).toEqual(['255'])
      expect(result.prUrls).toEqual({ '255': 'https://github.com/acreeger/iloom-cli/pull/255' })
      expect(result.status).toBe('finished')
    })

    it('should format finished Linear-style issue loom', async () => {
      const metadata: LoomMetadata = {
        description: 'Implement new reporting feature',
        created_at: '2024-01-12T14:20:00.000Z',
        branchName: 'issue-ILOOM-42__reporting-feature',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/issue-ILOOM-42__reporting-feature',
        issueType: 'issue',
        issue_numbers: ['ILOOM-42'],
        pr_numbers: [],
        issueTracker: 'linear',
        colorHex: '#c9f0ff',
        sessionId: 'session-ghi789',
        projectPath: '/Users/adam/Documents/Projects/iloom-cli',
        issueUrls: { 'ILOOM-42': 'https://linear.app/company/issue/ILOOM-42' },
        prUrls: {},
        draftPrNumber: null,
        capabilities: ['cli'],
        parentLoom: null,
        status: 'finished',
        finishedAt: '2024-01-22T09:15:00.000Z',
      }
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual(['ILOOM-42'])
      expect(result.issueUrls).toEqual({ 'ILOOM-42': 'https://linear.app/company/issue/ILOOM-42' })
      expect(result.issueTracker).toBe('linear')
    })

    it('should format finished branch loom without issue tracking', async () => {
      const metadata: LoomMetadata = {
        description: 'Experimental feature branch',
        created_at: '2024-01-08T16:45:00.000Z',
        branchName: 'feat/experimental-feature',
        worktreePath: '/Users/adam/Documents/Projects/iloom-cli-looms/feat-experimental-feature',
        issueType: 'branch',
        issue_numbers: [],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#e1bee7',
        sessionId: 'session-jkl012',
        projectPath: '/Users/adam/Documents/Projects/iloom-cli',
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        capabilities: ['cli'],
        parentLoom: null,
        status: 'finished',
        finishedAt: '2024-01-25T11:00:00.000Z',
      }
      const result = await formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('branch')
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
      expect(result.branch).toBe('feat/experimental-feature')
    })
  })
})

describe('formatLoomForJson - child loom fields', () => {
  const createWorktree = (overrides: Partial<GitWorktree> = {}): GitWorktree => ({
    path: '/Users/dev/projects/myapp-looms/issue-101__sub-task',
    branch: 'issue-101__sub-task',
    commit: 'abc123def456789012345678901234567890abcd',
    bare: false,
    detached: false,
    locked: false,
    ...overrides,
  })

  const createMetadataWithParent = (): LoomMetadata => ({
    description: 'Sub-task for parent issue',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-101__sub-task',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-101__sub-task',
    issueType: 'issue',
    issue_numbers: ['101'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-abc123',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: { '101': 'https://github.com/owner/repo/issues/101' },
    prUrls: {},
    draftPrNumber: null,
    capabilities: [],
    parentLoom: {
      type: 'issue',
      identifier: '100',
      branchName: 'issue-100__parent-feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
      databaseBranch: 'issue-100',
    },
  })

  it('should set isChildLoom: false when parentLoom is null', async () => {
    const worktree = createWorktree()
    const result = await formatLoomForJson(worktree)
    expect(result.isChildLoom).toBe(false)
    expect(result.parentLoom).toBeNull()
  })

  it('should set isChildLoom: true when parentLoom exists', async () => {
    const worktree = createWorktree()
    const metadata = createMetadataWithParent()
    const result = await formatLoomForJson(worktree, undefined, metadata)
    expect(result.isChildLoom).toBe(true)
  })

  it('should include parentLoom reference in output when present', async () => {
    const worktree = createWorktree()
    const metadata = createMetadataWithParent()
    const result = await formatLoomForJson(worktree, undefined, metadata)
    expect(result.parentLoom).toEqual({
      type: 'issue',
      identifier: '100',
      branchName: 'issue-100__parent-feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
      databaseBranch: 'issue-100',
    })
  })

  it('should handle parentLoom without optional databaseBranch', async () => {
    const worktree = createWorktree()
    const metadata: LoomMetadata = {
      ...createMetadataWithParent(),
      parentLoom: {
        type: 'issue',
        identifier: '100',
        branchName: 'issue-100__parent-feature',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
      },
    }
    const result = await formatLoomForJson(worktree, undefined, metadata)
    expect(result.isChildLoom).toBe(true)
    expect(result.parentLoom?.databaseBranch).toBeUndefined()
  })
})

describe('formatFinishedLoomForJson - child loom fields', () => {
  const createFinishedMetadataWithParent = (): LoomMetadata => ({
    description: 'Finished sub-task',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-101__sub-task',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-101__sub-task',
    issueType: 'issue',
    issue_numbers: ['101'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-abc123',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: { '101': 'https://github.com/owner/repo/issues/101' },
    prUrls: {},
    draftPrNumber: null,
    capabilities: [],
    parentLoom: {
      type: 'issue',
      identifier: '100',
      branchName: 'issue-100__parent-feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
    },
    status: 'finished',
    finishedAt: '2024-01-20T15:45:00.000Z',
  })

  it('should set isChildLoom: false when parentLoom is null', async () => {
    const metadata: LoomMetadata = {
      ...createFinishedMetadataWithParent(),
      parentLoom: null,
    }
    const result = await formatFinishedLoomForJson(metadata)
    expect(result.isChildLoom).toBe(false)
    expect(result.parentLoom).toBeNull()
  })

  it('should set isChildLoom: true when parentLoom exists', async () => {
    const metadata = createFinishedMetadataWithParent()
    const result = await formatFinishedLoomForJson(metadata)
    expect(result.isChildLoom).toBe(true)
  })

  it('should include parentLoom reference in output when present', async () => {
    const metadata = createFinishedMetadataWithParent()
    const result = await formatFinishedLoomForJson(metadata)
    expect(result.parentLoom).toEqual({
      type: 'issue',
      identifier: '100',
      branchName: 'issue-100__parent-feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
    })
  })
})

describe('formatLoomForJson - swarm state field', () => {
  const createWorktree = (overrides: Partial<GitWorktree> = {}): GitWorktree => ({
    path: '/Users/dev/projects/myapp-looms/issue-101__sub-task',
    branch: 'issue-101__sub-task',
    commit: 'abc123def456789012345678901234567890abcd',
    bare: false,
    detached: false,
    locked: false,
    ...overrides,
  })

  const createMetadataWithState = (state: LoomMetadata['state']): LoomMetadata => ({
    description: 'Swarm task',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-101__sub-task',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-101__sub-task',
    issueType: 'issue',
    issueKey: null,
    issue_numbers: ['101'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-abc123',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: { '101': 'https://github.com/owner/repo/issues/101' },
    prUrls: {},
    draftPrNumber: null,
    oneShot: null,
    capabilities: [],
    state,
    parentLoom: null,
  })

  it('should return state: null when no metadata is provided', async () => {
    const worktree = createWorktree()
    const result = await formatLoomForJson(worktree)
    expect(result.state).toBeNull()
  })

  it('should return state: null when metadata has no state', async () => {
    const worktree = createWorktree()
    const metadata = createMetadataWithState(null)
    const result = await formatLoomForJson(worktree, undefined, metadata)
    expect(result.state).toBeNull()
  })

  it.each([
    'pending' as const,
    'in_progress' as const,
    'code_review' as const,
    'done' as const,
    'failed' as const,
  ])('should include state "%s" in output when set', async (state) => {
    const worktree = createWorktree()
    const metadata = createMetadataWithState(state)
    const result = await formatLoomForJson(worktree, undefined, metadata)
    expect(result.state).toBe(state)
  })
})

describe('formatFinishedLoomForJson - swarm state field', () => {
  const createFinishedMetadataWithState = (state: LoomMetadata['state']): LoomMetadata => ({
    description: 'Finished swarm task',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-101__sub-task',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-101__sub-task',
    issueType: 'issue',
    issueKey: null,
    issue_numbers: ['101'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-abc123',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: { '101': 'https://github.com/owner/repo/issues/101' },
    prUrls: {},
    draftPrNumber: null,
    oneShot: null,
    capabilities: [],
    state,
    parentLoom: null,
    status: 'finished',
    finishedAt: '2024-01-20T15:45:00.000Z',
  })

  it('should return state: null when metadata has no state', async () => {
    const metadata = createFinishedMetadataWithState(null)
    const result = await formatFinishedLoomForJson(metadata)
    expect(result.state).toBeNull()
  })

  it.each([
    'pending' as const,
    'in_progress' as const,
    'code_review' as const,
    'done' as const,
    'failed' as const,
  ])('should include state "%s" in output when set', async (state) => {
    const metadata = createFinishedMetadataWithState(state)
    const result = await formatFinishedLoomForJson(metadata)
    expect(result.state).toBe(state)
  })
})

// ============================================================================
// Swarm Issues and Dependency Map Tests
// ============================================================================

describe('enrichSwarmIssues', () => {
  const createChildLoomMetadata = (
    issueNumber: string,
    state: LoomMetadata['state'],
    worktreePath: string | null,
  ): LoomMetadata => ({
    description: `Child issue ${issueNumber}`,
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: `issue-${issueNumber}__child-task`,
    worktreePath,
    issueType: 'issue',
    issueKey: null,
    issue_numbers: [issueNumber],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-child',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: {},
    prUrls: {},
    draftPrNumber: null,
    oneShot: null,
    capabilities: [],
    state,
    childIssueNumbers: [],
    parentLoom: {
      type: 'epic',
      identifier: '100',
      branchName: 'issue-100__epic',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__epic',
    },
    childIssues: [],
    dependencyMap: {},
  })

  it('should enrich child issues with state and worktreePath from child loom metadata', async () => {
    const childIssues = [
      { number: '#101', title: 'First task', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
      { number: '#102', title: 'Second task', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
    ]
    const allMetadata = [
      createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      createChildLoomMetadata('102', 'done', '/Users/dev/projects/myapp-looms/issue-102__child'),
    ]

    const result = await enrichSwarmIssues(childIssues, allMetadata)

    expect(result).toEqual([
      {
        number: '#101',
        title: 'First task',
        url: 'https://github.com/org/repo/issues/101',
        state: 'in_progress',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
        complexity: null,
      },
      {
        number: '#102',
        title: 'Second task',
        url: 'https://github.com/org/repo/issues/102',
        state: 'done',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-102__child',
        complexity: null,
      },
    ])
  })

  it('should set state and worktreePath to null when no child loom exists', async () => {
    const childIssues = [
      { number: '#101', title: 'Task without loom', body: 'body', url: 'https://github.com/org/repo/issues/101' },
    ]
    const allMetadata: LoomMetadata[] = []

    const result = await enrichSwarmIssues(childIssues, allMetadata)

    expect(result).toEqual([
      {
        number: '#101',
        title: 'Task without loom',
        url: 'https://github.com/org/repo/issues/101',
        state: null,
        worktreePath: null,
        complexity: null,
      },
    ])
  })

  it('should handle Linear-style issue numbers (no # prefix)', async () => {
    const childIssues = [
      { number: 'ENG-123', title: 'Linear task', body: 'body', url: 'https://linear.app/org/issue/ENG-123' },
    ]
    const allMetadata = [
      createChildLoomMetadata('ENG-123', 'code_review', '/Users/dev/projects/myapp-looms/issue-ENG-123__task'),
    ]

    const result = await enrichSwarmIssues(childIssues, allMetadata)

    expect(result).toEqual([
      {
        number: 'ENG-123',
        title: 'Linear task',
        url: 'https://linear.app/org/issue/ENG-123',
        state: 'code_review',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-ENG-123__task',
        complexity: null,
      },
    ])
  })

  it('should handle mixed matched and unmatched child issues', async () => {
    const childIssues = [
      { number: '#101', title: 'Matched task', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
      { number: '#102', title: 'Unmatched task', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
    ]
    const allMetadata = [
      createChildLoomMetadata('101', 'pending', '/Users/dev/projects/myapp-looms/issue-101__child'),
    ]

    const result = await enrichSwarmIssues(childIssues, allMetadata)

    expect(result[0]?.state).toBe('pending')
    expect(result[0]?.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-101__child')
    expect(result[0]?.complexity).toBeNull()
    expect(result[1]?.state).toBeNull()
    expect(result[1]?.worktreePath).toBeNull()
    expect(result[1]?.complexity).toBeNull()
  })

  it('should return empty array for empty childIssues', async () => {
    const result = await enrichSwarmIssues([], [])
    expect(result).toEqual([])
  })

  it('should fall back to finished metadata when child loom is not in active metadata', async () => {
    const childIssues = [
      { number: '#101', title: 'Cleaned up task', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
      { number: '#102', title: 'Still active task', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
    ]
    // Only #102 is active
    const activeMetadata = [
      createChildLoomMetadata('102', 'in_progress', '/Users/dev/projects/myapp-looms/issue-102__child'),
    ]
    // #101 was cleaned up/archived and exists in finished metadata
    const finishedMetadata: LoomMetadata[] = [
      {
        ...createChildLoomMetadata('101', 'done', '/Users/dev/projects/myapp-looms/issue-101__child'),
        status: 'finished',
        finishedAt: '2024-01-20T15:45:00.000Z',
      },
    ]

    const result = await enrichSwarmIssues(childIssues, activeMetadata, finishedMetadata)

    expect(result).toEqual([
      {
        number: '#101',
        title: 'Cleaned up task',
        url: 'https://github.com/org/repo/issues/101',
        state: 'done',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
        complexity: null,
      },
      {
        number: '#102',
        title: 'Still active task',
        url: 'https://github.com/org/repo/issues/102',
        state: 'in_progress',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-102__child',
        complexity: null,
      },
    ])
  })

  it('should prefer active metadata over finished metadata for the same issue', async () => {
    const childIssues = [
      { number: '#101', title: 'Task', body: 'body', url: 'https://github.com/org/repo/issues/101' },
    ]
    const activeMetadata = [
      createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__active'),
    ]
    const finishedMetadata: LoomMetadata[] = [
      {
        ...createChildLoomMetadata('101', 'done', '/Users/dev/projects/myapp-looms/issue-101__finished'),
        status: 'finished',
        finishedAt: '2024-01-20T15:45:00.000Z',
      },
    ]

    const result = await enrichSwarmIssues(childIssues, activeMetadata, finishedMetadata)

    // Active metadata should take precedence
    expect(result[0]?.state).toBe('in_progress')
    expect(result[0]?.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-101__active')
  })

  describe('project-scoped filtering', () => {
    const createMetaForProject = (
      issueNumber: string,
      state: LoomMetadata['state'],
      worktreePath: string,
      projectPath: string,
    ): LoomMetadata => ({
      ...createChildLoomMetadata(issueNumber, state, worktreePath),
      projectPath,
    })

    it('should only match metadata from the same project, preventing cross-project collisions', async () => {
      const childIssues = [
        { number: '#2', title: 'Resume builder task', body: 'body', url: 'https://github.com/org/resume-builder/issues/2' },
      ]
      // Same issue number (#2) exists in both projects
      const allMetadata = [
        createMetaForProject('2', 'in_progress', '/projects/resume-builder-looms/issue-2__task', '/projects/resume-builder'),
        createMetaForProject('2', 'done', '/projects/real-estate-looms/issue-2__task', '/projects/real-estate'),
      ]

      const result = await enrichSwarmIssues(childIssues, allMetadata, undefined, '/projects/resume-builder')

      expect(result[0]?.state).toBe('in_progress')
      expect(result[0]?.worktreePath).toBe('/projects/resume-builder-looms/issue-2__task')
    })

    it('should scope finished metadata by project too', async () => {
      const childIssues = [
        { number: '#3', title: 'Task three', body: 'body', url: 'https://github.com/org/project-a/issues/3' },
      ]
      // No active metadata for project-a issue #3
      const activeMetadata = [
        createMetaForProject('3', 'in_progress', '/projects/project-b-looms/issue-3__work', '/projects/project-b'),
      ]
      // But finished metadata has both projects
      const finishedMetadata: LoomMetadata[] = [
        {
          ...createMetaForProject('3', 'done', '/projects/project-a-looms/issue-3__done', '/projects/project-a'),
          status: 'finished',
          finishedAt: '2024-01-20T00:00:00.000Z',
        },
        {
          ...createMetaForProject('3', 'failed', '/projects/project-b-looms/issue-3__failed', '/projects/project-b'),
          status: 'finished',
          finishedAt: '2024-01-21T00:00:00.000Z',
        },
      ]

      const result = await enrichSwarmIssues(childIssues, activeMetadata, finishedMetadata, '/projects/project-a')

      // Should fall back to project-a's finished metadata, not project-b's active or finished
      expect(result[0]?.state).toBe('done')
      expect(result[0]?.worktreePath).toBe('/projects/project-a-looms/issue-3__done')
    })

    it('should fall back to unscoped behavior when projectPath is null', async () => {
      const childIssues = [
        { number: '#5', title: 'Legacy task', body: 'body', url: 'https://github.com/org/repo/issues/5' },
      ]
      const allMetadata = [
        createMetaForProject('5', 'pending', '/projects/some-project-looms/issue-5__work', '/projects/some-project'),
      ]

      // null projectPath => no filtering, matches any project
      const result = await enrichSwarmIssues(childIssues, allMetadata, undefined, null)

      expect(result[0]?.state).toBe('pending')
      expect(result[0]?.worktreePath).toBe('/projects/some-project-looms/issue-5__work')
    })

    it('should fall back to unscoped behavior when projectPath is undefined', async () => {
      const childIssues = [
        { number: '#5', title: 'Legacy task', body: 'body', url: 'https://github.com/org/repo/issues/5' },
      ]
      const allMetadata = [
        createMetaForProject('5', 'pending', '/projects/some-project-looms/issue-5__work', '/projects/some-project'),
      ]

      // undefined projectPath => no filtering
      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.state).toBe('pending')
    })

    it('should handle realpathSync errors gracefully (falls back to original path)', async () => {
      // When realpathSync throws (e.g., path doesn't exist), resolvePathSafe falls back to original.
      // This means paths that differ only in symlinks but don't resolve will still compare by string.
      const childIssues = [
        { number: '#7', title: 'Test', body: 'body', url: 'https://github.com/org/repo/issues/7' },
      ]
      const allMetadata = [
        createMetaForProject('7', 'in_progress', '/projects/project-a-looms/issue-7__work', '/projects/project-a'),
      ]

      // Same string path => matches even if realpathSync can't resolve
      const result = await enrichSwarmIssues(childIssues, allMetadata, undefined, '/projects/project-a')

      expect(result[0]?.state).toBe('in_progress')
      expect(result[0]?.worktreePath).toBe('/projects/project-a-looms/issue-7__work')
    })

    it('should exclude metadata entries with null projectPath when scoping is active', async () => {
      const childIssues = [
        { number: '#10', title: 'Test', body: 'body', url: 'https://github.com/org/repo/issues/10' },
      ]
      // Metadata with null projectPath (legacy) should be excluded when scoping is active
      const allMetadata: LoomMetadata[] = [
        {
          ...createChildLoomMetadata('10', 'in_progress', '/projects/legacy-looms/issue-10__work'),
          projectPath: null,
        },
      ]

      const result = await enrichSwarmIssues(childIssues, allMetadata, undefined, '/projects/my-project')

      // Legacy entry (null projectPath) should NOT match when we're scoping
      expect(result[0]?.state).toBeNull()
      expect(result[0]?.worktreePath).toBeNull()
    })
  })

  describe('complexity enrichment', () => {
    it('should read complexity from recap file for children with worktreePaths', async () => {
      const childIssues = [
        { number: '#101', title: 'First task', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
        { number: '#102', title: 'Second task', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
      ]
      const allMetadata = [
        createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
        createChildLoomMetadata('102', 'done', '/Users/dev/projects/myapp-looms/issue-102__child'),
      ]
      vi.mocked(readRecapFile)
        .mockResolvedValueOnce({ complexity: { level: 'simple', reason: 'Single file change' } })
        .mockResolvedValueOnce({})

      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.complexity).toEqual({ level: 'simple', reason: 'Single file change' })
      expect(result[1]?.complexity).toBeNull()
    })

    it('should set complexity to null when recap file has no complexity', async () => {
      const childIssues = [
        { number: '#101', title: 'Task', body: 'body', url: 'https://github.com/org/repo/issues/101' },
      ]
      const allMetadata = [
        createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      ]
      vi.mocked(readRecapFile).mockResolvedValue({})

      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.complexity).toBeNull()
    })

    it('should set complexity to null when child has no worktreePath', async () => {
      const childIssues = [
        { number: '#101', title: 'Task without loom', body: 'body', url: 'https://github.com/org/repo/issues/101' },
      ]
      const allMetadata: LoomMetadata[] = []

      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.complexity).toBeNull()
      expect(readRecapFile).not.toHaveBeenCalled()
    })

    it('should include complexity with only level when reason is not provided', async () => {
      const childIssues = [
        { number: '#101', title: 'Task', body: 'body', url: 'https://github.com/org/repo/issues/101' },
      ]
      const allMetadata = [
        createChildLoomMetadata('101', 'pending', '/Users/dev/projects/myapp-looms/issue-101__child'),
      ]
      vi.mocked(readRecapFile).mockResolvedValue({
        complexity: { level: 'trivial' },
      })

      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.complexity).toEqual({ level: 'trivial' })
    })

    it('should exclude timestamp from complexity data', async () => {
      const childIssues = [
        { number: '#101', title: 'Task', body: 'body', url: 'https://github.com/org/repo/issues/101' },
      ]
      const allMetadata = [
        createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      ]
      vi.mocked(readRecapFile).mockResolvedValue({
        complexity: { level: 'complex', reason: 'Many changes', timestamp: '2024-01-01T00:00:00Z' },
      })

      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.complexity).toEqual({ level: 'complex', reason: 'Many changes' })
      expect(result[0]?.complexity).not.toHaveProperty('timestamp')
    })

    it('should gracefully handle recap file read errors', async () => {
      const childIssues = [
        { number: '#101', title: 'Task', body: 'body', url: 'https://github.com/org/repo/issues/101' },
      ]
      const allMetadata = [
        createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      ]
      vi.mocked(readRecapFile).mockRejectedValue(new Error('File read error'))

      const result = await enrichSwarmIssues(childIssues, allMetadata)

      expect(result[0]?.complexity).toBeNull()
    })
  })
})

describe('formatLoomForJson - swarmIssues and dependencyMap for epic looms', () => {
  const createWorktree = (overrides: Partial<GitWorktree> = {}): GitWorktree => ({
    path: '/Users/dev/projects/myapp-looms/issue-100__epic-feature',
    branch: 'issue-100__epic-feature',
    commit: 'abc123def456789012345678901234567890abcd',
    bare: false,
    detached: false,
    locked: false,
    ...overrides,
  })

  const createEpicMetadata = (overrides: Partial<LoomMetadata> = {}): LoomMetadata => ({
    description: 'Epic feature',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-100__epic-feature',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-100__epic-feature',
    issueType: 'epic',
    issueKey: null,
    issue_numbers: ['100'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-epic',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: { '100': 'https://github.com/org/repo/issues/100' },
    prUrls: {},
    draftPrNumber: null,
    oneShot: null,
    capabilities: [],
    state: null,
    childIssueNumbers: ['101', '102'],
    parentLoom: null,
    childIssues: [
      { number: '#101', title: 'First child', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
      { number: '#102', title: 'Second child', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
    ],
    dependencyMap: { '#102': ['#101'] },
    ...overrides,
  })

  const createChildMetadata = (
    issueNumber: string,
    state: LoomMetadata['state'],
    worktreePath: string,
  ): LoomMetadata => ({
    description: `Child ${issueNumber}`,
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: `issue-${issueNumber}__child`,
    worktreePath,
    issueType: 'issue',
    issueKey: null,
    issue_numbers: [issueNumber],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-child',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: {},
    prUrls: {},
    draftPrNumber: null,
    oneShot: null,
    capabilities: [],
    state,
    childIssueNumbers: [],
    parentLoom: {
      type: 'epic',
      identifier: '100',
      branchName: 'issue-100__epic-feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__epic-feature',
    },
    childIssues: [],
    dependencyMap: {},
  })

  it('should include swarmIssues and dependencyMap for epic loom with child issues', async () => {
    const worktree = createWorktree()
    const metadata = createEpicMetadata()
    const allMetadata = [
      createChildMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      createChildMetadata('102', 'pending', '/Users/dev/projects/myapp-looms/issue-102__child'),
    ]

    const result = await formatLoomForJson(worktree, undefined, metadata, allMetadata)

    expect(result.type).toBe('epic')
    expect(result.swarmIssues).toEqual([
      {
        number: '#101',
        title: 'First child',
        url: 'https://github.com/org/repo/issues/101',
        state: 'in_progress',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
        complexity: null,
      },
      {
        number: '#102',
        title: 'Second child',
        url: 'https://github.com/org/repo/issues/102',
        state: 'pending',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-102__child',
        complexity: null,
      },
    ])
    expect(result.dependencyMap).toEqual({ '#102': ['#101'] })
  })

  it('should return empty swarmIssues for epic loom with no childIssues', async () => {
    const worktree = createWorktree()
    const metadata = createEpicMetadata({ childIssues: [], dependencyMap: {} })

    const result = await formatLoomForJson(worktree, undefined, metadata)

    expect(result.type).toBe('epic')
    expect(result.swarmIssues).toEqual([])
    expect(result.dependencyMap).toEqual({})
  })

  it('should not include swarmIssues or dependencyMap for non-epic looms', async () => {
    const worktree = createWorktree({
      path: '/Users/dev/projects/myapp-looms/issue-42__feature',
      branch: 'issue-42__feature',
    })
    const metadata: LoomMetadata = {
      description: 'Regular issue',
      created_at: '2024-01-15T10:30:00.000Z',
      branchName: 'issue-42__feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-42__feature',
      issueType: 'issue',
      issueKey: null,
      issue_numbers: ['42'],
      pr_numbers: [],
      issueTracker: 'github',
      colorHex: '#dcebff',
      sessionId: 'session-abc',
      projectPath: '/Users/dev/projects/myapp',
      issueUrls: {},
      prUrls: {},
      draftPrNumber: null,
      oneShot: null,
      capabilities: [],
      state: null,
      childIssueNumbers: [],
      parentLoom: null,
      childIssues: [],
      dependencyMap: {},
    }

    const result = await formatLoomForJson(worktree, undefined, metadata)

    expect(result.type).toBe('issue')
    expect(result.swarmIssues).toBeUndefined()
    expect(result.dependencyMap).toBeUndefined()
  })

  it('should not include swarmIssues or dependencyMap when no metadata', async () => {
    const worktree = createWorktree()
    const result = await formatLoomForJson(worktree)

    expect(result.swarmIssues).toBeUndefined()
    expect(result.dependencyMap).toBeUndefined()
  })
})

describe('formatFinishedLoomForJson - swarmIssues and dependencyMap for epic looms', () => {
  const createFinishedEpicMetadata = (overrides: Partial<LoomMetadata> = {}): LoomMetadata => ({
    description: 'Finished epic',
    created_at: '2024-01-15T10:30:00.000Z',
    branchName: 'issue-200__finished-epic',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-200__finished-epic',
    issueType: 'epic',
    issueKey: null,
    issue_numbers: ['200'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-epic',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: {},
    prUrls: {},
    draftPrNumber: null,
    oneShot: null,
    capabilities: [],
    state: 'done',
    childIssueNumbers: ['201'],
    parentLoom: null,
    childIssues: [
      { number: '#201', title: 'Finished child', body: 'body', url: 'https://github.com/org/repo/issues/201' },
    ],
    dependencyMap: {},
    status: 'finished',
    finishedAt: '2024-01-20T15:45:00.000Z',
    ...overrides,
  })

  it('should include swarmIssues and dependencyMap for finished epic loom', async () => {
    const metadata = createFinishedEpicMetadata()
    const allMetadata: LoomMetadata[] = [
      {
        description: 'Active child',
        created_at: '2024-01-15T10:30:00.000Z',
        branchName: 'issue-201__child',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-201__child',
        issueType: 'issue',
        issueKey: null,
        issue_numbers: ['201'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#dcebff',
        sessionId: 'session-child',
        projectPath: '/Users/dev/projects/myapp',
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        oneShot: null,
        capabilities: [],
        state: 'done',
        childIssueNumbers: [],
        parentLoom: null,
        childIssues: [],
        dependencyMap: {},
      },
    ]

    const result = await formatFinishedLoomForJson(metadata, allMetadata)

    expect(result.type).toBe('epic')
    expect(result.swarmIssues).toEqual([
      {
        number: '#201',
        title: 'Finished child',
        url: 'https://github.com/org/repo/issues/201',
        state: 'done',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-201__child',
        complexity: null,
      },
    ])
    expect(result.dependencyMap).toEqual({})
  })

  it('should not include swarmIssues or dependencyMap for finished non-epic loom', async () => {
    const metadata: LoomMetadata = {
      description: 'Finished issue',
      created_at: '2024-01-15T10:30:00.000Z',
      branchName: 'issue-42__feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-42__feature',
      issueType: 'issue',
      issueKey: null,
      issue_numbers: ['42'],
      pr_numbers: [],
      issueTracker: 'github',
      colorHex: '#dcebff',
      sessionId: 'session-abc',
      projectPath: '/Users/dev/projects/myapp',
      issueUrls: {},
      prUrls: {},
      draftPrNumber: null,
      oneShot: null,
      capabilities: [],
      state: null,
      childIssueNumbers: [],
      parentLoom: null,
      childIssues: [],
      dependencyMap: {},
      status: 'finished',
      finishedAt: '2024-01-20T15:45:00.000Z',
    }

    const result = await formatFinishedLoomForJson(metadata)

    expect(result.swarmIssues).toBeUndefined()
    expect(result.dependencyMap).toBeUndefined()
  })
})

describe('formatLoomsForJson - swarm issues propagation', () => {
  it('should propagate allMetadata to individual loom formatting for epic looms', async () => {
    const mainPath = '/Users/dev/projects/myapp'
    const epicWorktree: GitWorktree = {
      path: '/Users/dev/projects/myapp-looms/issue-100__epic',
      branch: 'issue-100__epic',
      commit: 'abc123',
      bare: false,
      detached: false,
      locked: false,
    }

    const epicMetadata: LoomMetadata = {
      description: 'Epic',
      created_at: '2024-01-15T10:30:00.000Z',
      branchName: 'issue-100__epic',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__epic',
      issueType: 'epic',
      issueKey: null,
      issue_numbers: ['100'],
      pr_numbers: [],
      issueTracker: 'github',
      colorHex: '#dcebff',
      sessionId: 'session-epic',
      projectPath: mainPath,
      issueUrls: {},
      prUrls: {},
      draftPrNumber: null,
      oneShot: null,
      capabilities: [],
      state: null,
      childIssueNumbers: ['101'],
      parentLoom: null,
      childIssues: [
        { number: '#101', title: 'Child', body: 'body', url: 'https://github.com/org/repo/issues/101' },
      ],
      dependencyMap: {},
    }

    const childMetadata: LoomMetadata = {
      description: 'Child',
      created_at: '2024-01-15T10:30:00.000Z',
      branchName: 'issue-101__child',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
      issueType: 'issue',
      issueKey: null,
      issue_numbers: ['101'],
      pr_numbers: [],
      issueTracker: 'github',
      colorHex: '#dcebff',
      sessionId: 'session-child',
      projectPath: mainPath,
      issueUrls: {},
      prUrls: {},
      draftPrNumber: null,
      oneShot: null,
      capabilities: [],
      state: 'in_progress',
      childIssueNumbers: [],
      parentLoom: {
        type: 'epic',
        identifier: '100',
        branchName: 'issue-100__epic',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-100__epic',
      },
      childIssues: [],
      dependencyMap: {},
    }

    const metadataMap = new Map<string, LoomMetadata | null>()
    metadataMap.set(epicWorktree.path, epicMetadata)

    const result = await formatLoomsForJson(
      [epicWorktree],
      mainPath,
      metadataMap,
      [epicMetadata, childMetadata],
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.swarmIssues).toEqual([
      {
        number: '#101',
        title: 'Child',
        url: 'https://github.com/org/repo/issues/101',
        state: 'in_progress',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
        complexity: null,
      },
    ])
  })
})
