import { vi } from 'vitest'
import type { MockOptions } from '../types/index.js'

/**
 * Mock factory for Git CLI operations
 */
export class MockGitProvider {
  private scenarios = new Map<string, unknown>()
  private worktreeOutputs = new Map<string, string>()

  setupWorktreeScenario(scenario: MockOptions['scenario'], data?: unknown): void {
    this.scenarios.set('worktree', { scenario, data })
  }

  setupBranchScenario(scenario: MockOptions['scenario'], data?: unknown): void {
    this.scenarios.set('branch', { scenario, data })
  }

  /**
   * Setup realistic worktree list output for testing
   */
  setupWorktreeListOutput(scenario: 'empty' | 'single' | 'multiple' | 'with-pr' | 'locked'): void {
    switch (scenario) {
      case 'empty':
        this.worktreeOutputs.set('worktree-list', '')
        break
      case 'single':
        this.worktreeOutputs.set(
          'worktree-list',
          [
            'worktree /Users/dev/myproject',
            'HEAD abc123def456789',
            'branch refs/heads/main',
            '',
          ].join('\n')
        )
        break
      case 'multiple':
        this.worktreeOutputs.set(
          'worktree-list',
          [
            'worktree /Users/dev/myproject',
            'HEAD abc123def456789',
            'branch refs/heads/main',
            '',
            'worktree /Users/dev/worktree-feature-123',
            'HEAD def456abc123456',
            'branch refs/heads/feature/issue-123',
            '',
            'worktree /Users/dev/worktree-pr-456',
            'HEAD 789abc123def456',
            'branch refs/heads/pr/456',
            '',
          ].join('\n')
        )
        break
      case 'with-pr':
        this.worktreeOutputs.set(
          'worktree-list',
          [
            'worktree /Users/dev/myproject',
            'HEAD abc123def456789',
            'branch refs/heads/main',
            '',
            'worktree /Users/dev/worktree-pr-123',
            'HEAD def456abc123456',
            'branch refs/heads/pr/123',
            '',
          ].join('\n')
        )
        break
      case 'locked':
        this.worktreeOutputs.set(
          'worktree-list',
          [
            'worktree /Users/dev/myproject',
            'HEAD abc123def456789',
            'branch refs/heads/main',
            '',
            'worktree /Users/dev/worktree-locked',
            'HEAD def456abc123456',
            'locked under maintenance',
            '',
          ].join('\n')
        )
        break
    }
  }

  /**
   * Setup git status output for worktree status testing
   */
  setupStatusOutput(scenario: 'clean' | 'modified' | 'staged' | 'untracked' | 'mixed'): void {
    switch (scenario) {
      case 'clean':
        this.worktreeOutputs.set('status', '')
        break
      case 'modified':
        this.worktreeOutputs.set('status', ' M src/file1.ts\n M src/file2.ts')
        break
      case 'staged':
        this.worktreeOutputs.set('status', 'A  src/new-file.ts\nM  src/modified.ts')
        break
      case 'untracked':
        this.worktreeOutputs.set('status', '?? temp-file.txt\n?? untracked-dir/')
        break
      case 'mixed':
        this.worktreeOutputs.set(
          'status',
          ' M src/modified.ts\nA  src/new-file.ts\n?? temp.txt\nD  old-file.ts'
        )
        break
    }
  }

  /**
   * Setup branch information
   */
  setupBranchInfo(currentBranch: string, remoteBranch?: string): void {
    this.worktreeOutputs.set('current-branch', currentBranch)
    if (remoteBranch) {
      this.worktreeOutputs.set('remote-branch', remoteBranch)
    }
  }

  /**
   * Setup ahead/behind information
   */
  setupAheadBehind(ahead: number, behind: number): void {
    this.worktreeOutputs.set('ahead-behind', `${behind}\t${ahead}`)
  }

  /**
   * Create mock for executeGitCommand with realistic responses
   */
  mockExecuteGitCommand(): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((args: string[]) => {
      const command = args.join(' ')

      // Handle worktree list command
      if (command.includes('worktree list')) {
        const output = this.worktreeOutputs.get('worktree-list') ?? ''
        return Promise.resolve({
          success: true,
          message: output,
          exitCode: 0,
        })
      }

      // Handle status command
      if (command.includes('status --porcelain')) {
        const output = this.worktreeOutputs.get('status') ?? ''
        return Promise.resolve({
          success: true,
          message: output,
          exitCode: 0,
        })
      }

      // Handle current branch command
      if (command.includes('branch --show-current')) {
        const branch = this.worktreeOutputs.get('current-branch') ?? 'main'
        return Promise.resolve({
          success: true,
          message: branch,
          exitCode: 0,
        })
      }

      // Handle ahead/behind command
      if (command.includes('rev-list --left-right --count')) {
        const aheadBehind = this.worktreeOutputs.get('ahead-behind') ?? '0\t0'
        return Promise.resolve({
          success: true,
          message: aheadBehind,
          exitCode: 0,
        })
      }

      // Handle worktree add command
      if (command.includes('worktree add')) {
        const worktreeScenario = this.scenarios.get('worktree') as { scenario: string } | undefined
        if (worktreeScenario?.scenario === 'error') {
          return Promise.resolve({
            success: false,
            message: '',
            error: 'Failed to create worktree',
            exitCode: 1,
          })
        }
        return Promise.resolve({
          success: true,
          message: 'Preparing worktree',
          exitCode: 0,
        })
      }

      // Handle worktree remove command
      if (command.includes('worktree remove')) {
        const worktreeScenario = this.scenarios.get('worktree') as { scenario: string } | undefined
        if (worktreeScenario?.scenario === 'error') {
          return Promise.resolve({
            success: false,
            message: '',
            error: 'Failed to remove worktree',
            exitCode: 1,
          })
        }
        return Promise.resolve({
          success: true,
          message: 'Worktree removed',
          exitCode: 0,
        })
      }

      // Handle repository validation commands
      if (command.includes('rev-parse --git-dir')) {
        const isValid = this.scenarios.get('repo-valid') !== false
        if (isValid) {
          return Promise.resolve({
            success: true,
            message: '.git',
            exitCode: 0,
          })
        } else {
          return Promise.resolve({
            success: false,
            message: '',
            error: 'Not a git repository',
            exitCode: 1,
          })
        }
      }

      // Handle repo root command
      if (command.includes('rev-parse --show-toplevel')) {
        return Promise.resolve({
          success: true,
          message: '/Users/dev/myproject',
          exitCode: 0,
        })
      }

      // Default successful response
      return Promise.resolve({
        success: true,
        message: 'Mock git command success',
        exitCode: 0,
      })
    })
  }

  mockCommand(_command: string, response: string | Error): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation(() => {
      if (response instanceof Error) {
        throw response
      }
      return Promise.resolve({ stdout: response, stderr: '', exitCode: 0 })
    })
  }

  verifyCommandCalled(mockFn: ReturnType<typeof vi.fn>, _command: string, times = 1): void {
    // Note: This is a placeholder - actual implementation would use vitest expect
    // For now, just verify mockFn was called the correct number of times
    if (mockFn.mock.calls.length !== times) {
      throw new Error(`Expected ${times} calls, got ${mockFn.mock.calls.length}`)
    }
  }

  reset(): void {
    this.scenarios.clear()
    this.worktreeOutputs.clear()
  }
}

/**
 * Mock factory for GitHub CLI operations
 */
export class MockGitHubProvider {
  private responses = new Map<string, unknown>()

  setupIssueResponse(issueNumber: number, data: unknown): void {
    this.responses.set(`issue-${issueNumber}`, data)
  }

  setupPRResponse(prNumber: number, data: unknown): void {
    this.responses.set(`pr-${prNumber}`, data)
  }

  mockGhCommand(_command: string, response: unknown): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(response)
  }

  reset(): void {
    this.responses.clear()
  }
}

/**
 * Mock factory for Neon CLI operations
 */
export class MockNeonProvider {
  private branches = new Map<string, unknown>()

  setupBranchResponse(branchName: string, data: unknown): void {
    this.branches.set(branchName, data)
  }

  mockNeonCommand(_operation: string, response: unknown): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(response)
  }

  reset(): void {
    this.branches.clear()
  }
}

/**
 * Mock factory for Claude CLI operations
 */
export class MockClaudeProvider {
  private contexts = new Map<string, unknown>()

  setupContextResponse(contextId: string, data: unknown): void {
    this.contexts.set(contextId, data)
  }

  mockClaudeCommand(_command: string, response: unknown): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(response)
  }

  reset(): void {
    this.contexts.clear()
  }
}

/**
 * Mock factory for file system operations
 */
export class MockFileSystem {
  private files = new Map<string, string>()
  private directories = new Set<string>()

  setupFile(path: string, content: string): void {
    this.files.set(path, content)
  }

  setupDirectory(path: string): void {
    this.directories.add(path)
  }

  mockReadFile(_path: string, content?: string): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(content ?? this.files.get(_path) ?? '')
  }

  mockWriteFile(_path: string): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((filePath: string, data: string) => {
      this.files.set(filePath, data)
      return Promise.resolve()
    })
  }

  setupEnvFile(path: string, variables: Record<string, string>): void {
    const content = Object.entries(variables)
      .map(([key, value]) => `${key}="${value}"`)
      .join('\n')
    this.files.set(path, content)
  }

  mockPathExists(path: string): ReturnType<typeof vi.fn> {
    return vi
      .fn()
      .mockResolvedValue(
        this.files.has(path) || this.directories.has(path)
      )
  }

  mockCopyFile(): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((src: string, dest: string) => {
      const content = this.files.get(src)
      if (!content) throw new Error(`Source file ${src} not found`)
      this.files.set(dest, content)
      return Promise.resolve()
    })
  }

  getFileContent(path: string): string | undefined {
    return this.files.get(path)
  }

  reset(): void {
    this.files.clear()
    this.directories.clear()
  }
}

/**
 * Test fixtures with realistic data
 */
export class TestFixtures {
  static readonly SAMPLE_ISSUE = {
    number: 25,
    title: 'Add user authentication',
    body: 'Implement OAuth login flow with GitHub',
    state: 'open' as const,
    labels: ['enhancement', 'auth'],
    assignees: ['acreeger'],
    url: 'https://github.com/acreeger/iloom-cli/issues/25',
  }

  static readonly SAMPLE_PR = {
    number: 30,
    title: 'Fix API timeout bug',
    body: 'Increase timeout for slow API responses',
    state: 'open' as const,
    branch: 'fix/api-timeout',
    baseBranch: 'main',
    url: 'https://github.com/acreeger/iloom-cli/pull/30',
    isDraft: false,
  }

  static readonly SAMPLE_WORKTREE = {
    path: '/tmp/test-workspace-25',
    branch: 'feat/issue-25__add-auth',
    commit: 'abc123',
    isPR: false,
    issueNumber: 25,
    port: 3025,
  }

  static async createTemporaryRepo(): Promise<string> {
    // Implementation would create actual temporary git repo for integration tests
    return '/tmp/test-repo-' + Date.now()
  }

  static async createWorkspaceScenario(type: 'issue' | 'pr' | 'custom'): Promise<unknown> {
    switch (type) {
      case 'issue':
        return {
          workspace: this.SAMPLE_WORKTREE,
          issue: this.SAMPLE_ISSUE,
        }
      case 'pr':
        return {
          workspace: { ...this.SAMPLE_WORKTREE, isPR: true, prNumber: 30 },
          pr: this.SAMPLE_PR,
        }
      default:
        return {}
    }
  }
}

/**
 * Centralized mock factory management
 */
export class MockFactories {
  static git = new MockGitProvider()
  static github = new MockGitHubProvider()
  static neon = new MockNeonProvider()
  static claude = new MockClaudeProvider()
  static filesystem = new MockFileSystem()

  static resetAll(): void {
    this.git.reset()
    this.github.reset()
    this.neon.reset()
    this.claude.reset()
    this.filesystem.reset()
  }
}
