import { describe, it, expect } from 'vitest'
import {
  formatLoomForJson,
  formatLoomsForJson,
  formatFinishedLoomForJson,
  enrichSwarmIssues,
} from './loom-formatter.js'
import type { GitWorktree } from '../types/worktree.js'
import type { LoomMetadata } from '../lib/MetadataManager.js'

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
    it('should return true when worktree path matches mainWorktreePath', () => {
      const mainPath = '/Users/dev/projects/myapp'
      const worktree = createWorktree({ path: mainPath, branch: 'main' })
      const result = formatLoomForJson(worktree, mainPath)
      expect(result.isMainWorktree).toBe(true)
    })

    it('should return false when worktree path does not match mainWorktreePath', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-456__add-feature' })
      const result = formatLoomForJson(worktree, '/Users/dev/projects/myapp')
      expect(result.isMainWorktree).toBe(false)
    })

    it('should return false when mainWorktreePath is not provided', () => {
      const worktree = createWorktree({ path: '/Users/dev/projects/myapp', branch: 'main' })
      const result = formatLoomForJson(worktree)
      expect(result.isMainWorktree).toBe(false)
    })

    it('should correctly identify main worktree with realistic paths', () => {
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

      const mainResult = formatLoomForJson(mainWorktree, mainPath)
      const featureResult = formatLoomForJson(featureWorktree, mainPath)

      expect(mainResult.isMainWorktree).toBe(true)
      expect(featureResult.isMainWorktree).toBe(false)
    })
  })

  describe('type detection', () => {
    it('should detect PR type from _pr_N path suffix', () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__feature',
        prNumber: 456,
      })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('pr')
    })

    it('should detect issue type from issue-N branch pattern', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-123__feature' })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
    })

    it('should detect issue type from alphanumeric pattern (MARK-1)', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-MARK-1__feature' })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
    })

    it('should default to branch type when no patterns match', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
      })
      const result = formatLoomForJson(worktree)
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
      ])('should detect type for branch "%s" as "%s"', (branchName, expectedType) => {
        const worktree = createWorktree({
          path: `/Users/dev/projects/myapp-looms/${branchName}`,
          branch: branchName,
        })
        const result = formatLoomForJson(worktree)
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
      ])('should detect type for path "%s" as "%s"', (path, expectedType) => {
        const worktree = createWorktree({
          path,
          branch: 'issue-123__feature', // Branch always has issue pattern
        })
        const result = formatLoomForJson(worktree)
        expect(result.type).toBe(expectedType)
      })
    })
  })

  describe('pr_numbers extraction', () => {
    it('should extract PR number from path suffix for PR type', () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__feature',
        prNumber: 456,
      })
      const result = formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual(['456'])
    })

    it('should return empty pr_numbers for issue type', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-123__feature' })
      const result = formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual([])
    })

    it('should return empty pr_numbers for branch type', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
      })
      const result = formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual([])
    })

    it.each([
      // Various PR number sizes
      [1, '1'],
      [99, '99'],
      [123, '123'],
      [9999, '9999'],
      [99999, '99999'],
    ])('should extract PR number %d as string "%s"', (prNum, expectedStr) => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-42__feature',
        prNumber: prNum,
      })
      const result = formatLoomForJson(worktree)
      expect(result.pr_numbers).toEqual([expectedStr])
    })
  })

  describe('issue_numbers extraction', () => {
    it('should extract numeric issue number from branch for issue type', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__fix-bug' })
      const result = formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual(['42'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should extract alphanumeric issue ID (Linear-style) for issue type', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-PROJ-123__implement-feature' })
      const result = formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual(['PROJ-123'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should return empty issue_numbers for branch type', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
      })
      const result = formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should handle old format issue branch (issue-N-slug)', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-25-add-tests' })
      const result = formatLoomForJson(worktree)
      expect(result.issue_numbers).toEqual(['25'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should return empty issue_numbers for PR type (pr_numbers populated instead)', () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__feature',
        prNumber: 456,
      })
      const result = formatLoomForJson(worktree)
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
      ])('should extract issue number from "%s" as "%s"', (branchName, expectedIssue) => {
        const worktree = createRealisticWorktree({ branchName })
        const result = formatLoomForJson(worktree)
        expect(result.issue_numbers).toEqual([expectedIssue])
        expect(result.type).toBe('issue')
      })
    })
  })

  describe('field mapping', () => {
    it('should use branch as name', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__feature-test' })
      const result = formatLoomForJson(worktree)
      expect(result.name).toBe('issue-42__feature-test')
    })

    it('should use path as name when branch is empty', () => {
      const worktree = createWorktree({
        branch: '',
        path: '/Users/dev/projects/myapp-looms/orphan-worktree',
      })
      const result = formatLoomForJson(worktree)
      expect(result.name).toBe('/Users/dev/projects/myapp-looms/orphan-worktree')
    })

    it('should handle null worktreePath when bare is true', () => {
      const worktree = createWorktree({
        bare: true,
        path: '/Users/dev/projects/myapp.git',
        branch: 'main',
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull()
    })

    it('should return path as worktreePath when not bare', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__feature' })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-42__feature')
    })

    it('should return branch as branch field', () => {
      const worktree = createRealisticWorktree({ branchName: 'issue-42__my-branch' })
      const result = formatLoomForJson(worktree)
      expect(result.branch).toBe('issue-42__my-branch')
    })

    it('should return null for branch when empty', () => {
      const worktree = createWorktree({ branch: '' })
      const result = formatLoomForJson(worktree)
      expect(result.branch).toBeNull()
    })
  })

  describe('detached HEAD states', () => {
    it('should handle detached HEAD with branch set to HEAD', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp-looms/detached-state',
        branch: 'HEAD',
        commit: 'abc123def456789012345678901234567890abcd',
        detached: true,
      })
      const result = formatLoomForJson(worktree)
      expect(result.branch).toBe('HEAD')
      expect(result.name).toBe('HEAD')
      expect(result.type).toBe('branch') // No issue pattern in "HEAD"
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should handle detached HEAD from bisect operation', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'HEAD',
        commit: 'def456abc123789012345678901234567890abcd',
        detached: true,
        bare: false,
      })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('branch')
      expect(result.worktreePath).toBe('/Users/dev/projects/myapp')
    })

    it('should correctly identify main worktree even when detached', () => {
      const mainPath = '/Users/dev/projects/myapp'
      const worktree = createWorktree({
        path: mainPath,
        branch: 'HEAD',
        detached: true,
      })
      const result = formatLoomForJson(worktree, mainPath)
      expect(result.isMainWorktree).toBe(true)
    })
  })

  describe('bare repositories', () => {
    it('should set worktreePath to null for bare repository', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp.git',
        branch: 'main',
        bare: true,
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull()
      expect(result.branch).toBe('main')
      expect(result.name).toBe('main')
    })

    it('should handle bare repo with custom default branch', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp.git',
        branch: 'develop',
        bare: true,
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull()
      expect(result.branch).toBe('develop')
      expect(result.type).toBe('branch')
    })

    it('should correctly identify bare repo as main worktree when path matches', () => {
      const barePath = '/Users/dev/projects/myapp.git'
      const worktree = createWorktree({
        path: barePath,
        branch: 'main',
        bare: true,
      })
      const result = formatLoomForJson(worktree, barePath)
      expect(result.isMainWorktree).toBe(true)
      expect(result.worktreePath).toBeNull()
    })
  })

  describe('locked worktrees', () => {
    it('should handle locked worktree without reason', () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-42__in-progress',
        locked: true,
      })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
      expect(result.issue_numbers).toEqual(['42'])
      // Note: locked status is not exposed in LoomJsonOutput, but should not break formatting
    })

    it('should handle locked worktree with lock reason', () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-123__critical-fix',
        locked: true,
        lockReason: 'Locked for deployment review',
      })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('issue')
      expect(result.issue_numbers).toEqual(['123'])
      expect(result.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-123__critical-fix')
    })

    it('should handle locked PR worktree', () => {
      const worktree = createRealisticWorktree({
        branchName: 'issue-789__feature',
        prNumber: 100,
        locked: true,
        lockReason: 'PR under review',
      })
      const result = formatLoomForJson(worktree)
      expect(result.type).toBe('pr')
      expect(result.pr_numbers).toEqual(['100'])
      expect(result.issue_numbers).toEqual([])
    })
  })

  describe('edge cases and realistic git output scenarios', () => {
    it('should handle worktree with empty commit hash', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp',
        branch: 'main',
        commit: '',
      })
      const result = formatLoomForJson(worktree)
      expect(result.branch).toBe('main')
      expect(result.type).toBe('branch')
    })

    it('should handle worktree paths with spaces', () => {
      const worktree = createWorktree({
        path: '/Users/dev/My Projects/myapp-looms/issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('/Users/dev/My Projects/myapp-looms/issue-42__feature')
      expect(result.type).toBe('issue')
    })

    it('should handle worktree paths with special characters', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/my-app@2.0-looms/issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('/Users/dev/projects/my-app@2.0-looms/issue-42__feature')
    })

    it('should handle branch names with forward slashes (converted by git worktree)', () => {
      // When a branch like "feat/add-feature" is used with worktrees,
      // the path typically has the slash converted
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp-looms/feat-add-feature',
        branch: 'feat/add-feature', // Original branch name preserved
      })
      const result = formatLoomForJson(worktree)
      expect(result.branch).toBe('feat/add-feature')
      expect(result.name).toBe('feat/add-feature')
      expect(result.type).toBe('branch')
    })

    it('should handle very long branch names', () => {
      const longSlug = 'a'.repeat(100)
      const branchName = `issue-42__${longSlug}`
      const worktree = createRealisticWorktree({ branchName })
      const result = formatLoomForJson(worktree)
      expect(result.branch).toBe(branchName)
      expect(result.issue_numbers).toEqual(['42'])
    })

    it('should handle worktree with all flags set', () => {
      const worktree = createWorktree({
        path: '/Users/dev/projects/myapp.git',
        branch: 'main',
        commit: 'abc123',
        bare: true,
        detached: true,
        locked: true,
        lockReason: 'Test lock',
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBeNull() // bare=true overrides
      expect(result.branch).toBe('main')
    })

    it('should handle Windows-style paths', () => {
      const worktree = createWorktree({
        path: 'C:\\Users\\dev\\projects\\myapp-looms\\issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('C:\\Users\\dev\\projects\\myapp-looms\\issue-42__feature')
      expect(result.type).toBe('issue')
    })

    it('should handle network/UNC paths', () => {
      const worktree = createWorktree({
        path: '//server/share/projects/myapp-looms/issue-42__feature',
        branch: 'issue-42__feature',
      })
      const result = formatLoomForJson(worktree)
      expect(result.worktreePath).toBe('//server/share/projects/myapp-looms/issue-42__feature')
    })
  })
})

describe('formatLoomsForJson', () => {
  it('should transform array of worktrees to JSON schema with correct issue/pr numbers', () => {
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

    const result = formatLoomsForJson(worktrees, mainPath)

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

  it('should return empty array for empty input', () => {
    const result = formatLoomsForJson([])
    expect(result).toEqual([])
  })

  describe('realistic multi-worktree scenarios', () => {
    it('should handle typical iloom workspace with multiple active issues', () => {
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

      const result = formatLoomsForJson(worktrees, mainPath)

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

    it('should handle mixed worktree states (detached, locked, bare)', () => {
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

      const result = formatLoomsForJson(worktrees)

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

    it('should handle worktrees without mainWorktreePath provided', () => {
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
      const result = formatLoomsForJson(worktrees)

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
    it('should correctly format finished loom with all fields populated', () => {
      const metadata = createFinishedMetadata()
      const result = formatFinishedLoomForJson(metadata)

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

    it('should use branchName for name field', () => {
      const metadata = createFinishedMetadata({
        branchName: 'issue-PROJ-123__feature-work',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.name).toBe('issue-PROJ-123__feature-work')
    })

    it('should fallback to worktreePath for name when branchName is null', () => {
      const metadata = createFinishedMetadata({
        branchName: null,
        worktreePath: '/Users/dev/projects/myapp-looms/orphan-branch',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.name).toBe('/Users/dev/projects/myapp-looms/orphan-branch')
    })

    it('should fallback to "unknown" for name when both branchName and worktreePath are null', () => {
      const metadata = createFinishedMetadata({
        branchName: null,
        worktreePath: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.name).toBe('unknown')
    })

    it('should always set worktreePath to null for finished looms', () => {
      const metadata = createFinishedMetadata({
        worktreePath: '/some/path/that/should/be/ignored',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.worktreePath).toBeNull()
    })

    it('should always set isMainWorktree to false for finished looms', () => {
      const metadata = createFinishedMetadata()
      const result = formatFinishedLoomForJson(metadata)
      expect(result.isMainWorktree).toBe(false)
    })
  })

  describe('type detection and issue/pr numbers', () => {
    it('should format finished issue loom correctly', () => {
      const metadata = createFinishedMetadata({
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('issue')
      expect(result.issue_numbers).toEqual(['42'])
      expect(result.pr_numbers).toEqual([])
    })

    it('should format finished PR loom correctly', () => {
      const metadata = createFinishedMetadata({
        branchName: 'issue-254__dotenv-flow',
        issueType: 'pr',
        issue_numbers: [],
        pr_numbers: ['255'],
        prUrls: { '255': 'https://github.com/owner/repo/pull/255' },
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('pr')
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual(['255'])
      expect(result.prUrls).toEqual({ '255': 'https://github.com/owner/repo/pull/255' })
    })

    it('should format finished branch loom correctly', () => {
      const metadata = createFinishedMetadata({
        branchName: 'feat/new-feature',
        issueType: 'branch',
        issue_numbers: [],
        pr_numbers: [],
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('branch')
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should default to branch type when issueType is null', () => {
      const metadata = createFinishedMetadata({
        issueType: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('branch')
    })

    it('should handle Linear-style alphanumeric issue numbers', () => {
      const metadata = createFinishedMetadata({
        branchName: 'issue-PROJ-123__implement-feature',
        issueType: 'issue',
        issue_numbers: ['PROJ-123'],
        issueUrls: { 'PROJ-123': 'https://linear.app/org/issue/PROJ-123' },
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual(['PROJ-123'])
      expect(result.issueUrls).toEqual({ 'PROJ-123': 'https://linear.app/org/issue/PROJ-123' })
    })

    it('should handle multiple issue numbers', () => {
      const metadata = createFinishedMetadata({
        issueType: 'issue',
        issue_numbers: ['42', 'PROJ-123', '999'],
        issueUrls: {
          '42': 'https://github.com/owner/repo/issues/42',
          'PROJ-123': 'https://linear.app/org/issue/PROJ-123',
          '999': 'https://github.com/owner/repo/issues/999',
        },
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual(['42', 'PROJ-123', '999'])
      expect(result.issueUrls).toEqual({
        '42': 'https://github.com/owner/repo/issues/42',
        'PROJ-123': 'https://linear.app/org/issue/PROJ-123',
        '999': 'https://github.com/owner/repo/issues/999',
      })
    })

    it('should handle multiple PR numbers', () => {
      const metadata = createFinishedMetadata({
        issueType: 'pr',
        issue_numbers: [],
        pr_numbers: ['100', '101'],
        prUrls: {
          '100': 'https://github.com/owner/repo/pull/100',
          '101': 'https://github.com/owner/repo/pull/101',
        },
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.pr_numbers).toEqual(['100', '101'])
      expect(result.prUrls).toEqual({
        '100': 'https://github.com/owner/repo/pull/100',
        '101': 'https://github.com/owner/repo/pull/101',
      })
    })
  })

  describe('optional field handling', () => {
    it('should handle empty description field', () => {
      const metadata = createFinishedMetadata({
        description: '',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.description).toBe('')
    })

    it('should handle null created_at', () => {
      const metadata = createFinishedMetadata({
        created_at: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.created_at).toBeNull()
    })

    it('should handle null issueTracker', () => {
      const metadata = createFinishedMetadata({
        issueTracker: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.issueTracker).toBeNull()
    })

    it('should handle null colorHex', () => {
      const metadata = createFinishedMetadata({
        colorHex: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.colorHex).toBeNull()
    })

    it('should handle null projectPath', () => {
      const metadata = createFinishedMetadata({
        projectPath: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.projectPath).toBeNull()
    })

    it('should handle empty issueUrls and prUrls', () => {
      const metadata = createFinishedMetadata({
        issueUrls: {},
        prUrls: {},
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.issueUrls).toEqual({})
      expect(result.prUrls).toEqual({})
    })

    it('should handle undefined status field with default "finished"', () => {
      const metadata = createFinishedMetadata({
        status: undefined,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.status).toBe('finished')
    })

    it('should handle null finishedAt', () => {
      const metadata = createFinishedMetadata({
        finishedAt: null,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.finishedAt).toBeNull()
    })

    it('should handle undefined finishedAt', () => {
      const metadata = createFinishedMetadata({
        finishedAt: undefined,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.finishedAt).toBeNull()
    })
  })

  describe('edge cases and legacy metadata', () => {
    it('should handle minimal legacy metadata with only required fields', () => {
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
      const result = formatFinishedLoomForJson(metadata)
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

    it('should handle empty issue_numbers and pr_numbers arrays', () => {
      const metadata = createFinishedMetadata({
        issue_numbers: [],
        pr_numbers: [],
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual([])
      expect(result.pr_numbers).toEqual([])
    })

    it('should handle branch names with special characters', () => {
      const metadata = createFinishedMetadata({
        branchName: 'feat/add-feature@v2.0-beta',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.branch).toBe('feat/add-feature@v2.0-beta')
      expect(result.name).toBe('feat/add-feature@v2.0-beta')
    })

    it('should handle very long branch names', () => {
      const longSlug = 'a'.repeat(200)
      const branchName = `issue-42__${longSlug}`
      const metadata = createFinishedMetadata({
        branchName,
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.branch).toBe(branchName)
      expect(result.name).toBe(branchName)
    })

    it('should handle finished loom with active status', () => {
      const metadata = createFinishedMetadata({
        status: 'active',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.status).toBe('active')
    })

    it('should preserve exact status value from metadata', () => {
      const metadata = createFinishedMetadata({
        status: 'finished',
      })
      const result = formatFinishedLoomForJson(metadata)
      expect(result.status).toBe('finished')
    })
  })

  describe('realistic finished loom scenarios', () => {
    it('should format finished issue loom from iloom-cli project', () => {
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
      const result = formatFinishedLoomForJson(metadata)
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

    it('should format finished PR loom', () => {
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
      const result = formatFinishedLoomForJson(metadata)
      expect(result.type).toBe('pr')
      expect(result.pr_numbers).toEqual(['255'])
      expect(result.prUrls).toEqual({ '255': 'https://github.com/acreeger/iloom-cli/pull/255' })
      expect(result.status).toBe('finished')
    })

    it('should format finished Linear-style issue loom', () => {
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
      const result = formatFinishedLoomForJson(metadata)
      expect(result.issue_numbers).toEqual(['ILOOM-42'])
      expect(result.issueUrls).toEqual({ 'ILOOM-42': 'https://linear.app/company/issue/ILOOM-42' })
      expect(result.issueTracker).toBe('linear')
    })

    it('should format finished branch loom without issue tracking', () => {
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
      const result = formatFinishedLoomForJson(metadata)
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

  it('should set isChildLoom: false when parentLoom is null', () => {
    const worktree = createWorktree()
    const result = formatLoomForJson(worktree)
    expect(result.isChildLoom).toBe(false)
    expect(result.parentLoom).toBeNull()
  })

  it('should set isChildLoom: true when parentLoom exists', () => {
    const worktree = createWorktree()
    const metadata = createMetadataWithParent()
    const result = formatLoomForJson(worktree, undefined, metadata)
    expect(result.isChildLoom).toBe(true)
  })

  it('should include parentLoom reference in output when present', () => {
    const worktree = createWorktree()
    const metadata = createMetadataWithParent()
    const result = formatLoomForJson(worktree, undefined, metadata)
    expect(result.parentLoom).toEqual({
      type: 'issue',
      identifier: '100',
      branchName: 'issue-100__parent-feature',
      worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
      databaseBranch: 'issue-100',
    })
  })

  it('should handle parentLoom without optional databaseBranch', () => {
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
    const result = formatLoomForJson(worktree, undefined, metadata)
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

  it('should set isChildLoom: false when parentLoom is null', () => {
    const metadata: LoomMetadata = {
      ...createFinishedMetadataWithParent(),
      parentLoom: null,
    }
    const result = formatFinishedLoomForJson(metadata)
    expect(result.isChildLoom).toBe(false)
    expect(result.parentLoom).toBeNull()
  })

  it('should set isChildLoom: true when parentLoom exists', () => {
    const metadata = createFinishedMetadataWithParent()
    const result = formatFinishedLoomForJson(metadata)
    expect(result.isChildLoom).toBe(true)
  })

  it('should include parentLoom reference in output when present', () => {
    const metadata = createFinishedMetadataWithParent()
    const result = formatFinishedLoomForJson(metadata)
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

  it('should return state: null when no metadata is provided', () => {
    const worktree = createWorktree()
    const result = formatLoomForJson(worktree)
    expect(result.state).toBeNull()
  })

  it('should return state: null when metadata has no state', () => {
    const worktree = createWorktree()
    const metadata = createMetadataWithState(null)
    const result = formatLoomForJson(worktree, undefined, metadata)
    expect(result.state).toBeNull()
  })

  it.each([
    'pending' as const,
    'in_progress' as const,
    'code_review' as const,
    'done' as const,
    'failed' as const,
  ])('should include state "%s" in output when set', (state) => {
    const worktree = createWorktree()
    const metadata = createMetadataWithState(state)
    const result = formatLoomForJson(worktree, undefined, metadata)
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

  it('should return state: null when metadata has no state', () => {
    const metadata = createFinishedMetadataWithState(null)
    const result = formatFinishedLoomForJson(metadata)
    expect(result.state).toBeNull()
  })

  it.each([
    'pending' as const,
    'in_progress' as const,
    'code_review' as const,
    'done' as const,
    'failed' as const,
  ])('should include state "%s" in output when set', (state) => {
    const metadata = createFinishedMetadataWithState(state)
    const result = formatFinishedLoomForJson(metadata)
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

  it('should enrich child issues with state and worktreePath from child loom metadata', () => {
    const childIssues = [
      { number: '#101', title: 'First task', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
      { number: '#102', title: 'Second task', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
    ]
    const allMetadata = [
      createChildLoomMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      createChildLoomMetadata('102', 'done', '/Users/dev/projects/myapp-looms/issue-102__child'),
    ]

    const result = enrichSwarmIssues(childIssues, allMetadata)

    expect(result).toEqual([
      {
        number: '#101',
        title: 'First task',
        url: 'https://github.com/org/repo/issues/101',
        state: 'in_progress',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
      },
      {
        number: '#102',
        title: 'Second task',
        url: 'https://github.com/org/repo/issues/102',
        state: 'done',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-102__child',
      },
    ])
  })

  it('should set state and worktreePath to null when no child loom exists', () => {
    const childIssues = [
      { number: '#101', title: 'Task without loom', body: 'body', url: 'https://github.com/org/repo/issues/101' },
    ]
    const allMetadata: LoomMetadata[] = []

    const result = enrichSwarmIssues(childIssues, allMetadata)

    expect(result).toEqual([
      {
        number: '#101',
        title: 'Task without loom',
        url: 'https://github.com/org/repo/issues/101',
        state: null,
        worktreePath: null,
      },
    ])
  })

  it('should handle Linear-style issue numbers (no # prefix)', () => {
    const childIssues = [
      { number: 'ENG-123', title: 'Linear task', body: 'body', url: 'https://linear.app/org/issue/ENG-123' },
    ]
    const allMetadata = [
      createChildLoomMetadata('ENG-123', 'code_review', '/Users/dev/projects/myapp-looms/issue-ENG-123__task'),
    ]

    const result = enrichSwarmIssues(childIssues, allMetadata)

    expect(result).toEqual([
      {
        number: 'ENG-123',
        title: 'Linear task',
        url: 'https://linear.app/org/issue/ENG-123',
        state: 'code_review',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-ENG-123__task',
      },
    ])
  })

  it('should handle mixed matched and unmatched child issues', () => {
    const childIssues = [
      { number: '#101', title: 'Matched task', body: 'body1', url: 'https://github.com/org/repo/issues/101' },
      { number: '#102', title: 'Unmatched task', body: 'body2', url: 'https://github.com/org/repo/issues/102' },
    ]
    const allMetadata = [
      createChildLoomMetadata('101', 'pending', '/Users/dev/projects/myapp-looms/issue-101__child'),
    ]

    const result = enrichSwarmIssues(childIssues, allMetadata)

    expect(result[0]?.state).toBe('pending')
    expect(result[0]?.worktreePath).toBe('/Users/dev/projects/myapp-looms/issue-101__child')
    expect(result[1]?.state).toBeNull()
    expect(result[1]?.worktreePath).toBeNull()
  })

  it('should return empty array for empty childIssues', () => {
    const result = enrichSwarmIssues([], [])
    expect(result).toEqual([])
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

  it('should include swarmIssues and dependencyMap for epic loom with child issues', () => {
    const worktree = createWorktree()
    const metadata = createEpicMetadata()
    const allMetadata = [
      createChildMetadata('101', 'in_progress', '/Users/dev/projects/myapp-looms/issue-101__child'),
      createChildMetadata('102', 'pending', '/Users/dev/projects/myapp-looms/issue-102__child'),
    ]

    const result = formatLoomForJson(worktree, undefined, metadata, allMetadata)

    expect(result.type).toBe('epic')
    expect(result.swarmIssues).toEqual([
      {
        number: '#101',
        title: 'First child',
        url: 'https://github.com/org/repo/issues/101',
        state: 'in_progress',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-101__child',
      },
      {
        number: '#102',
        title: 'Second child',
        url: 'https://github.com/org/repo/issues/102',
        state: 'pending',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-102__child',
      },
    ])
    expect(result.dependencyMap).toEqual({ '#102': ['#101'] })
  })

  it('should return empty swarmIssues for epic loom with no childIssues', () => {
    const worktree = createWorktree()
    const metadata = createEpicMetadata({ childIssues: [], dependencyMap: {} })

    const result = formatLoomForJson(worktree, undefined, metadata)

    expect(result.type).toBe('epic')
    expect(result.swarmIssues).toEqual([])
    expect(result.dependencyMap).toEqual({})
  })

  it('should not include swarmIssues or dependencyMap for non-epic looms', () => {
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

    const result = formatLoomForJson(worktree, undefined, metadata)

    expect(result.type).toBe('issue')
    expect(result.swarmIssues).toBeUndefined()
    expect(result.dependencyMap).toBeUndefined()
  })

  it('should not include swarmIssues or dependencyMap when no metadata', () => {
    const worktree = createWorktree()
    const result = formatLoomForJson(worktree)

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

  it('should include swarmIssues and dependencyMap for finished epic loom', () => {
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

    const result = formatFinishedLoomForJson(metadata, allMetadata)

    expect(result.type).toBe('epic')
    expect(result.swarmIssues).toEqual([
      {
        number: '#201',
        title: 'Finished child',
        url: 'https://github.com/org/repo/issues/201',
        state: 'done',
        worktreePath: '/Users/dev/projects/myapp-looms/issue-201__child',
      },
    ])
    expect(result.dependencyMap).toEqual({})
  })

  it('should not include swarmIssues or dependencyMap for finished non-epic loom', () => {
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

    const result = formatFinishedLoomForJson(metadata)

    expect(result.swarmIssues).toBeUndefined()
    expect(result.dependencyMap).toBeUndefined()
  })
})

describe('formatLoomsForJson - swarm issues propagation', () => {
  it('should propagate allMetadata to individual loom formatting for epic looms', () => {
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

    const result = formatLoomsForJson(
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
      },
    ])
  })
})
