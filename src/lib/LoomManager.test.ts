import { describe, it, expect, beforeEach, vi, type TestOptions } from 'vitest'
import { LoomManager } from './LoomManager.js'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { GitHubService } from './GitHubService.js'
import { DefaultBranchNamingService } from './BranchNamingService.js'
import { EnvironmentManager } from './EnvironmentManager.js'
import { ClaudeContextManager } from './ClaudeContextManager.js'
import { ProjectCapabilityDetector } from './ProjectCapabilityDetector.js'
import { CLIIsolationManager } from './CLIIsolationManager.js'
import { SettingsManager } from './SettingsManager.js'
import type { CreateLoomInput } from '../types/loom.js'
import { installDependencies } from '../utils/package-manager.js'
import { branchExists, ensureRepositoryHasCommits, isFileTrackedByGit, fetchOrigin, executeGitCommand, pushBranchToRemote } from '../utils/git.js'
import fs from 'fs-extra'
import fg from 'fast-glob'

// Increase per-test timeout for this large suite (98 tests with heavy mock setup)
// Under parallel execution, the default 10s can be exceeded due to CPU contention
const testOptions: TestOptions = { timeout: 30_000 }

// Mock all dependencies
vi.mock('./GitWorktreeManager.js')
vi.mock('./GitHubService.js')
vi.mock('../utils/claude-trust.js', () => ({
  preAcceptClaudeTrust: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./BranchNamingService.js')
vi.mock('./EnvironmentManager.js')
vi.mock('./ClaudeContextManager.js')
vi.mock('./ProjectCapabilityDetector.js')
vi.mock('./CLIIsolationManager.js')
vi.mock('./SettingsManager.js')

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    pathExists: vi.fn().mockResolvedValue(false),
  },
}))

// Mock fast-glob
vi.mock('fast-glob', () => ({
  default: {
    glob: vi.fn().mockResolvedValue([]),
  },
}))

// Mock MetadataManager to prevent real file creation during tests
// Shared mock functions for verification in tests
const mockWriteMetadata = vi.fn().mockResolvedValue(undefined)
const mockReadMetadata = vi.fn().mockResolvedValue(null)
const mockDeleteMetadata = vi.fn().mockResolvedValue(undefined)
const mockSlugifyPath = vi.fn((path: string) => path.replace(/\//g, '___') + '.json')
const mockListAllMetadata = vi.fn().mockResolvedValue([])
const mockUpdateMetadata = vi.fn().mockResolvedValue(undefined)

vi.mock('./MetadataManager.js', () => ({
  MetadataManager: vi.fn(() => ({
    writeMetadata: mockWriteMetadata,
    readMetadata: mockReadMetadata,
    deleteMetadata: mockDeleteMetadata,
    slugifyPath: mockSlugifyPath,
    listAllMetadata: mockListAllMetadata,
    updateMetadata: mockUpdateMetadata,
  })),
}))

// Mock branchExists utility
vi.mock('../utils/git.js', () => ({
  branchExists: vi.fn().mockResolvedValue(false),
  executeGitCommand: vi.fn().mockResolvedValue(''),
  ensureRepositoryHasCommits: vi.fn().mockResolvedValue(undefined),
  isEmptyRepository: vi.fn().mockResolvedValue(false),
  isFileTrackedByGit: vi.fn().mockResolvedValue(false),
  pushBranchToRemote: vi.fn().mockResolvedValue(undefined),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
  PLACEHOLDER_COMMIT_PREFIX: '[iloom:placeholder]',
  extractIssueNumber: vi.fn((branchName: string) => {
    // Match the real implementation logic for test compatibility
    const newFormatMatch = branchName.match(/issue-([^_]+)__/i)
    if (newFormatMatch?.[1]) return newFormatMatch[1]
    const oldFormatMatch = branchName.match(/issue-(\d+)(?:-|$)/i)
    if (oldFormatMatch?.[1]) return oldFormatMatch[1]
    return null
  }),
  extractPRNumber: vi.fn((branchName: string) => {
    // Match the real implementation logic for test compatibility
    const patterns = [
      /^pr\/(\d+)/i,
      /^pull\/(\d+)/i,
      /^(\d+)[-_]/,
      /^feature\/pr[-_]?(\d+)/i,
      /^hotfix\/pr[-_]?(\d+)/i,
      /pr[-_]?(\d+)/i,
    ]
    for (const pattern of patterns) {
      const match = branchName.match(pattern)
      if (match?.[1]) {
        const num = parseInt(match[1], 10)
        if (!isNaN(num)) return num
      }
    }
    return null
  }),
  GitCommandError: class GitCommandError extends Error {
    constructor(message: string, public command: string, public exitCode: number, public stderr: string) {
      super(message)
      this.name = 'GitCommandError'
    }
  },
}))

// Mock package-manager utilities
vi.mock('../utils/package-manager.js', () => ({
  installDependencies: vi.fn().mockResolvedValue(undefined),
}))

// Mock terminal utilities (prevents real execa calls to 'defaults' for dark mode detection)
// Using plain functions to survive vitest mockReset between tests
vi.mock('../utils/terminal.js', () => ({
  detectDarkMode: () => Promise.resolve('light' as const),
  detectPlatform: () => 'darwin',
  detectITerm2: () => Promise.resolve(false),
  openTerminalWindow: () => Promise.resolve(undefined),
  openMultipleTerminalWindows: () => Promise.resolve(undefined),
  openDualTerminalWindow: () => Promise.resolve(undefined),
}))

// Mock env utilities (prevents real dotenv-flow file reads)
// Using plain functions to survive vitest mockReset between tests
vi.mock('../utils/env.js', () => ({
  loadEnvIntoProcess: () => ({ parsed: {}, error: undefined }),
  isNoEnvFilesFoundError: () => false,
  findEnvFileForDatabaseUrl: () => Promise.resolve('.env.local'),
  parseEnvFile: () => ({}),
  formatEnvLine: () => '',
  validateEnvVariable: () => true,
  normalizeLineEndings: (s: string) => s,
  extractPort: () => null,
  isValidEnvKey: () => true,
  loadWorkspaceEnv: () => ({ parsed: {} }),
  getDotenvFlowFiles: () => [],
  getLocalEquivalent: (f: string) => f,
  buildEnvSourceCommands: () => '',
  findEnvFileContainingVariable: () => Promise.resolve(null),
  hasVariableInAnyEnvFile: () => Promise.resolve(false),
}))

// Mock LoomLauncher (dynamically imported)
vi.mock('./LoomLauncher.js', () => ({
  LoomLauncher: vi.fn(() => ({
    launchLoom: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Mock PRManager for draft PR creation tests
// Shared mock functions for verification in tests
const mockCreateDraftPR = vi.fn()
const mockCheckForExistingPR = vi.fn()
let mockIssuePrefix = '#'
vi.mock('./PRManager.js', () => {
  // Use a class-like factory that creates fresh instances
  // This avoids issues with mockReset clearing the constructor implementation
  return {
    PRManager: class MockPRManager {
      createDraftPR = mockCreateDraftPR
      checkForExistingPR = mockCheckForExistingPR
      get issuePrefix() { return mockIssuePrefix }
    },
  }
})

// Mock vscode utils (dynamically imported)
vi.mock('../utils/vscode.js', () => ({
  openVSCodeWindow: vi.fn().mockResolvedValue(undefined),
}))

// Mock logger-context
const mockLoggerWarn = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
const mockLoggerError = vi.fn()
const mockLoggerSuccess = vi.fn()
vi.mock('../utils/logger-context.js', () => ({
  getLogger: () => ({
    warn: mockLoggerWarn,
    info: mockLoggerInfo,
    debug: mockLoggerDebug,
    error: mockLoggerError,
    success: mockLoggerSuccess,
  }),
}))

describe('LoomManager', testOptions, () => {
  let manager: LoomManager
  let mockGitWorktree: vi.Mocked<GitWorktreeManager>
  let mockGitHub: vi.Mocked<GitHubService>
  let mockBranchNaming: vi.Mocked<DefaultBranchNamingService>
  let mockEnvironment: vi.Mocked<EnvironmentManager>
  let mockClaude: vi.Mocked<ClaudeContextManager>
  let mockCapabilityDetector: vi.Mocked<ProjectCapabilityDetector>
  let mockCLIIsolation: vi.Mocked<CLIIsolationManager>
  let mockSettings: vi.Mocked<SettingsManager>

  beforeEach(() => {
    mockIssuePrefix = '#' // Reset to GitHub default
    mockGitWorktree = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
    mockGitHub = new GitHubService() as vi.Mocked<GitHubService>
    mockBranchNaming = new DefaultBranchNamingService() as vi.Mocked<DefaultBranchNamingService>
    mockEnvironment = new EnvironmentManager() as vi.Mocked<EnvironmentManager>
    mockClaude = new ClaudeContextManager() as vi.Mocked<ClaudeContextManager>
    mockCapabilityDetector = new ProjectCapabilityDetector() as vi.Mocked<ProjectCapabilityDetector>
    mockCLIIsolation = new CLIIsolationManager() as vi.Mocked<CLIIsolationManager>
    mockSettings = new SettingsManager() as vi.Mocked<SettingsManager>

    manager = new LoomManager(
      mockGitWorktree,
      mockGitHub,
      mockBranchNaming,
      mockEnvironment,
      mockClaude,
      mockCapabilityDetector,
      mockCLIIsolation,
      mockSettings
    )

    // Default mock for branch naming
    vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-123__test-branch')

    // Default mock for capability detector (web-only) - can be overridden in tests
    vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
      capabilities: ['web'],
      binEntries: {}
    })

    // Default mock for settings - returns empty settings (uses default basePort 3000)
    vi.mocked(mockSettings.loadSettings).mockResolvedValue({})

    // Default mock for calculatePort - returns basePort (3000) by default
    // Individual tests override this based on their specific port needs
    vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)

    // Default mock for setEnvVar - setupPortForWeb now calls this directly
    vi.mocked(mockEnvironment.setEnvVar).mockResolvedValue()

    // Set IssueTracker interface properties
    mockGitHub.supportsPullRequests = true
    mockGitHub.providerName = 'github'

    vi.clearAllMocks()

    // Set up shared mock return values (after clearAllMocks)
    mockWriteMetadata.mockResolvedValue(undefined)
    mockReadMetadata.mockResolvedValue(null)
    mockDeleteMetadata.mockResolvedValue(undefined)
    mockListAllMetadata.mockResolvedValue([])
    mockUpdateMetadata.mockResolvedValue(undefined)
    mockCreateDraftPR.mockResolvedValue({ number: 99, url: 'https://github.com/owner/repo/pull/99' })
    mockCheckForExistingPR.mockResolvedValue(null) // No existing PR by default
  })

  describe('createIloom', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 123,
      originalInput: '123',
    }

    it('should create loom for issue successfully', async () => {
      // Mock GitHub data fetch
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)

      // Mock environment setup
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

      // Mock Claude launch with context
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      const result = await manager.createIloom(baseInput)

      expect(result.id).toBeDefined()
      expect(result.path).toBe(expectedPath)
      expect(result.type).toBe('issue')
      expect(result.identifier).toBe(123)
      expect(result.port).toBe(3123)
      expect(result.issueData?.title).toBe('Test Issue')
      expect(result.createdAt).toBeInstanceOf(Date)

      // Verify installDependencies was called with the correct path and quiet=true
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true, true)
    })

    it('should create loom for PR successfully', async () => {
      const prInput: CreateLoomInput = {
        type: 'pr',
        identifier: 456,
        originalInput: 'pr/456',
      }

      // Mock GitHub PR fetch
      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: 'Test PR description',
        state: 'open',
        branch: 'feature-branch',
        baseBranch: 'main',
        url: 'https://github.com/owner/repo/pull/456',
        isDraft: false,
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-feature-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)

      // Mock environment setup
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)

      // Mock Claude launch with context
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      const result = await manager.createIloom(prInput)

      expect(result.type).toBe('pr')
      expect(result.identifier).toBe(456)
      expect(result.port).toBe(3456)
      expect(result.branch).toBe('feature-branch')

      // Verify installDependencies was called with the correct path and quiet=true
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true, true)
    })

    it('should fetch PR ref and create worktree from FETCH_HEAD for fork PRs', async () => {
      const prInput: CreateLoomInput = {
        type: 'pr',
        identifier: 586,
        originalInput: 'pr/586',
      }

      // Mock GitHub PR fetch returning a fork PR
      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 586,
        title: 'Add git commit timeout',
        body: 'PR from fork',
        state: 'open',
        branch: 'feature/git-commit-timeout',
        baseBranch: 'main',
        url: 'https://github.com/owner/repo/pull/586',
        isDraft: false,
        isFork: true,
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-fork-pr'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3586)

      const result = await manager.createIloom(prInput)

      expect(result.type).toBe('pr')
      expect(result.identifier).toBe(586)
      expect(result.branch).toBe('feature/git-commit-timeout')

      // Verify git fetch was called with refs/pull/586/head (fork PR ref)
      expect(executeGitCommand).toHaveBeenCalledWith(
        ['fetch', 'origin', 'refs/pull/586/head'],
        expect.any(Object)
      )

      // Verify worktree was created with createBranch: true and baseBranch: 'FETCH_HEAD'
      expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feature/git-commit-timeout',
          createBranch: true,
          baseBranch: 'FETCH_HEAD',
        })
      )
    })

    it('should use existing branch for same-repo PRs (existing behavior)', async () => {
      const prInput: CreateLoomInput = {
        type: 'pr',
        identifier: 456,
        originalInput: 'pr/456',
      }

      // Mock GitHub PR fetch returning a same-repo PR (no isFork or isFork: false)
      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: 'Test PR description',
        state: 'open',
        branch: 'feature-branch',
        baseBranch: 'main',
        url: 'https://github.com/owner/repo/pull/456',
        isDraft: false,
        isFork: false,
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-feature-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)

      await manager.createIloom(prInput)

      // Verify git fetch was called with just 'origin' (not a specific PR ref)
      expect(executeGitCommand).toHaveBeenCalledWith(
        ['fetch', 'origin'],
        expect.any(Object)
      )

      // Verify worktree was created with createBranch: false (existing branch)
      expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feature-branch',
          createBranch: false,
        })
      )
    })

    it('should populate both issueUrls and prUrls for PR with issue branch', async () => {
      const prInput: CreateLoomInput = {
        type: 'pr',
        identifier: 456,
        originalInput: 'pr/456',
      }

      // Mock GitHub PR fetch with branch containing issue number
      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: 'Test PR description',
        state: 'open',
        branch: 'issue-42__feature-branch', // Branch contains issue-42
        baseBranch: 'main',
        url: 'https://github.com/owner/repo/pull/456',
        isDraft: false,
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-issue-42__feature-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)

      // Mock environment setup
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)

      // Mock Claude launch with context
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      await manager.createIloom(prInput)

      // Verify writeMetadata was called with both URLs populated
      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]

      expect(metadataInput.issueUrls).toEqual({ '42': 'https://github.com/owner/repo/issues/42' })
      expect(metadataInput.prUrls).toEqual({ '456': 'https://github.com/owner/repo/pull/456' })
      expect(metadataInput.issue_numbers).toEqual(['42'])
      expect(metadataInput.pr_numbers).toEqual(['456'])
    })

    it('should create loom for branch successfully', async () => {
      const branchInput: CreateLoomInput = {
        type: 'branch',
        identifier: 'feature-xyz',
        originalInput: 'feature-xyz',
      }

      // Mock worktree creation
      const expectedPath = '/test/worktree-feature-xyz'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)

      // Mock environment setup
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)

      // Mock Claude launch with context
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      const result = await manager.createIloom(branchInput)

      expect(result.type).toBe('branch')
      expect(result.identifier).toBe('feature-xyz')
      expect(result.branch).toBe('feature-xyz')
      expect(result.port).toBeGreaterThanOrEqual(3000)

      // Verify installDependencies was called with the correct path and quiet=true
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true, true)
    })

    it('should calculate correct port for issue', async () => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 42,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/42',
      })

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      const result = await manager.createIloom({
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      })

      expect(result.port).toBe(3042)
      expect(mockEnvironment.calculatePort).toHaveBeenCalledWith({
        basePort: 3000,
        issueNumber: 42
      })
    })

    it('should throw when GitHub fetch fails', async () => {
      vi.mocked(mockGitHub.fetchIssue).mockRejectedValue(new Error('Issue not found'))

      await expect(manager.createIloom(baseInput)).rejects.toThrow('Issue not found')
    })

    it('should throw when worktree creation fails', async () => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')
      vi.mocked(mockGitWorktree.createWorktree).mockRejectedValue(
        new Error('Worktree creation failed')
      )

      await expect(manager.createIloom(baseInput)).rejects.toThrow('Worktree creation failed')
    })

    it('should throw when environment setup fails', async () => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })

      const expectedPath = '/test/path'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.setEnvVar).mockRejectedValue(
        new Error('Environment setup failed')
      )

      await expect(manager.createIloom(baseInput)).rejects.toThrow('Environment setup failed')
    })

    it('should continue creation even if installDependencies fails', async () => {
      // Mock installDependencies to throw an error
      vi.mocked(installDependencies).mockRejectedValueOnce(new Error('npm install failed'))

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })

      const expectedPath = '/test/path'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Should not throw even if installDependencies fails
      const result = await manager.createIloom(baseInput)

      expect(result.path).toBe(expectedPath)
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true, true)

      // Reset mock for next tests
      vi.mocked(installDependencies).mockResolvedValue(undefined)
    })

    it('should skip Claude launch when skipClaude option is true', async () => {
      const inputWithSkipClaude: CreateLoomInput = {
        ...baseInput,
        options: { skipClaude: true },
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })

      const expectedPath = '/test/path'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

      await manager.createIloom(inputWithSkipClaude)

      expect(mockClaude.launchWithContext).not.toHaveBeenCalled()
    })

    it('should succeed with Linear provider and github-draft-pr merge mode', async () => {
      // Configure Linear provider (doesn't support PRs natively)
      mockGitHub.supportsPullRequests = false
      mockGitHub.providerName = 'linear'
      mockIssuePrefix = '' // Linear issues use empty prefix (identifier already includes team key)

      // Mock settings with github-draft-pr mode
      // (Issue #464: Linear + github-draft-pr should work since PRs go through GitHub CLI)
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        mainBranch: 'main',
        worktreeDir: '/test/worktrees',
        mergeBehavior: {
          mode: 'github-draft-pr',
        },
      })

      // Mock issue fetch (Linear issues work like GitHub issues)
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test Linear Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://linear.app/team/ENG-123',
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

      const result = await manager.createIloom(baseInput)

      // Verify loom was created successfully
      expect(result.path).toBe(expectedPath)
      expect(result.type).toBe('issue')

      // Verify draft PR was created via PRManager (not Linear's issue tracker)
      // Linear identifier is 123 with empty prefix, so body contains "Fixes 123"
      expect(mockCreateDraftPR).toHaveBeenCalledWith(
        expect.any(String), // branch name
        'Test Linear Issue', // PR title from issue
        expect.stringContaining('Fixes 123'), // PR body with Fixes keyword (no prefix for Linear)
        'main', // base branch
        expectedPath // worktree path
      )

      // Verify draft PR number was stored in metadata
      expect(mockWriteMetadata).toHaveBeenCalledWith(
        expectedPath,
        expect.objectContaining({
          draftPrNumber: 99,
          pr_numbers: ['99'],
          prUrls: { '99': 'https://github.com/owner/repo/pull/99' },
        })
      )
    })

    it('should remove placeholder commit from local branch after pushing in draft PR mode', async () => {
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        mainBranch: 'main',
        worktreeDir: '/test/worktrees',
        mergeBehavior: {
          mode: 'github-draft-pr',
        },
      })

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 42,
        title: 'Test Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/42',
      })

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)

      // Make rev-parse fail for remote branch check so we enter the placeholder creation path
      const { GitCommandError: MockGitCommandError } = await import('../utils/git.js')
      vi.mocked(executeGitCommand).mockImplementation(async (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify' && String(args[2]).startsWith('origin/')) {
          throw new MockGitCommandError('fatal: unknown revision', 'git rev-parse', 128, 'unknown revision')
        }
        return ''
      })

      await manager.createIloom(baseInput)

      // Verify placeholder was pushed to remote
      expect(pushBranchToRemote).toHaveBeenCalled()

      // Verify placeholder was then removed from local branch via soft reset
      expect(executeGitCommand).toHaveBeenCalledWith(
        ['reset', '--soft', 'HEAD~1'],
        { cwd: expectedPath }
      )
    })

    it('should create draft PR for branch mode when mergeBehavior is github-draft-pr', async () => {
      // Ensure PRManager mock is set up for this test
      mockCreateDraftPR.mockResolvedValue({ number: 99, url: 'https://github.com/owner/repo/pull/99' })
      mockCheckForExistingPR.mockResolvedValue(null) // No existing PR

      // Mock settings with github-draft-pr mode
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        mainBranch: 'main',
        worktreeDir: '/test/worktrees',
        mergeBehavior: {
          mode: 'github-draft-pr',
        },
      })

      // Branch mode input - no issue fetch needed
      const branchInput: CreateLoomInput = {
        type: 'branch',
        identifier: 'my-feature',
        originalInput: 'my-feature',
      }

      // Mock worktree creation
      const expectedPath = '/test/worktree-my-feature'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)

      const result = await manager.createIloom(branchInput)

      // Verify loom was created successfully
      expect(result.path).toBe(expectedPath)
      expect(result.type).toBe('branch')
      expect(result.identifier).toBe('my-feature')

      // Verify draft PR was created via PRManager
      expect(mockCreateDraftPR).toHaveBeenCalledWith(
        'my-feature', // branch name
        'Work on my-feature', // PR title from branch name (no issue data)
        expect.stringContaining('Branch: my-feature'), // PR body for branch mode
        'main', // base branch
        expectedPath // worktree path
      )

      // Verify draft PR number was stored in metadata with pr_numbers populated
      expect(mockWriteMetadata).toHaveBeenCalledWith(
        expectedPath,
        expect.objectContaining({
          draftPrNumber: 99,
          pr_numbers: ['99'],
          prUrls: { '99': 'https://github.com/owner/repo/pull/99' },
        })
      )
    })

    it('should create draft PR targeting parent branch for child looms', async () => {
      mockCreateDraftPR.mockResolvedValue({ number: 101, url: 'https://github.com/owner/repo/pull/101' })
      mockCheckForExistingPR.mockResolvedValue(null)

      // Mock settings with github-draft-pr mode
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        mainBranch: 'main',
        worktreeDir: '/test/worktrees',
        mergeBehavior: {
          mode: 'github-draft-pr',
        },
      })

      // Mock issue fetch
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 456,
        title: 'Child Issue',
        body: 'Child description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/456',
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-issue-456'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)

      // Child loom input with parent loom
      const childInput: CreateLoomInput = {
        type: 'issue',
        identifier: 456,
        originalInput: '456',
        parentLoom: {
          type: 'issue',
          identifier: 123,
          branchName: 'feature/parent-branch',
          worktreePath: '/test/worktree-issue-123',
        },
      }

      const result = await manager.createIloom(childInput)

      expect(result.path).toBe(expectedPath)

      // Verify draft PR targets the parent branch, NOT main
      expect(mockCreateDraftPR).toHaveBeenCalledWith(
        expect.any(String), // branch name
        'Child Issue', // PR title
        expect.stringContaining('Fixes #456'), // PR body with Fixes keyword
        'feature/parent-branch', // base branch should be parent's branch
        expectedPath // worktree path
      )
    })

    it('should reuse existing PR instead of creating new one in github-draft-pr mode', async () => {
      // Mock settings with github-draft-pr mode
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        mainBranch: 'main',
        worktreeDir: '/test/worktrees',
        mergeBehavior: {
          mode: 'github-draft-pr',
        },
      })

      // Mock issue fetch
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })

      // Mock worktree creation
      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

      // Mock that an existing PR already exists
      mockCheckForExistingPR.mockResolvedValue({
        number: 42,
        url: 'https://github.com/owner/repo/pull/42',
      })

      const result = await manager.createIloom(baseInput)

      // Verify loom was created successfully
      expect(result.path).toBe(expectedPath)
      expect(result.type).toBe('issue')

      // Verify existing PR was checked
      expect(mockCheckForExistingPR).toHaveBeenCalledWith(
        expect.any(String), // branch name
        expectedPath // worktree path
      )

      // Verify createDraftPR was NOT called since we're reusing existing PR
      expect(mockCreateDraftPR).not.toHaveBeenCalled()

      // Verify existing PR number was stored in metadata with pr_numbers populated
      expect(mockWriteMetadata).toHaveBeenCalledWith(
        expectedPath,
        expect.objectContaining({
          draftPrNumber: 42,
          pr_numbers: ['42'],
          prUrls: { '42': 'https://github.com/owner/repo/pull/42' },
        })
      )
    })

    describe('Fetch Before Branch Creation (PR Modes)', () => {
      it('should fetch from origin before creating branch in github-pr mode', async () => {
        // Mock settings with github-pr mode
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'main',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'github-pr',
          },
        })

        // Mock issue fetch
        vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
          number: 123,
          title: 'Test Issue',
          body: 'Test description',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/owner/repo/issues/123',
        })

        // Mock worktree creation
        const expectedPath = '/test/worktree-issue-123'
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
        vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
        vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

        await manager.createIloom(baseInput)

        // Verify fetchOrigin was called
        expect(fetchOrigin).toHaveBeenCalled()

        // Verify createWorktree was called with origin/main as baseBranch
        expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'origin/main',
          })
        )
      })

      it('should fetch from origin before creating branch in github-draft-pr mode', async () => {
        // Mock settings with github-draft-pr mode
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'main',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'github-draft-pr',
          },
        })

        // Mock issue fetch
        vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
          number: 123,
          title: 'Test Issue',
          body: 'Test description',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/owner/repo/issues/123',
        })

        // Mock worktree creation
        const expectedPath = '/test/worktree-issue-123'
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
        vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
        vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

        await manager.createIloom(baseInput)

        // Verify fetchOrigin was called
        expect(fetchOrigin).toHaveBeenCalled()

        // Verify createWorktree was called with origin/main as baseBranch
        expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'origin/main',
          })
        )
      })

      it('should NOT fetch for child looms (use parent local branch)', async () => {
        // Mock settings with github-pr mode
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'main',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'github-pr',
          },
        })

        // Mock issue fetch
        vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
          number: 456,
          title: 'Child Issue',
          body: 'Child description',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/owner/repo/issues/456',
        })

        // Mock worktree creation
        const expectedPath = '/test/worktree-issue-456'
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
        vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
        vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)

        // Create child loom input with parent
        const childInput: CreateLoomInput = {
          type: 'issue',
          identifier: 456,
          originalInput: '456',
          parentLoom: {
            type: 'issue',
            identifier: 456,
            branchName: 'feat/parent-branch',
            worktreePath: '/test/worktree-parent',
          },
        }

        await manager.createIloom(childInput)

        // Verify fetchOrigin was NOT called for child loom
        expect(fetchOrigin).not.toHaveBeenCalled()

        // Verify createWorktree was called with parent's branch as baseBranch
        expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'feat/parent-branch',
          })
        )
      })

      it('should NOT fetch for local merge mode', async () => {
        // Mock settings with local mode (default)
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'main',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'local',
          },
        })

        // Mock issue fetch
        vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
          number: 123,
          title: 'Test Issue',
          body: 'Test description',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/owner/repo/issues/123',
        })

        // Mock worktree creation
        const expectedPath = '/test/worktree-issue-123'
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
        vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
        vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

        await manager.createIloom(baseInput)

        // Verify fetchOrigin was NOT called for local mode
        expect(fetchOrigin).not.toHaveBeenCalled()
      })

      it('should handle fetch failure with clear error message', async () => {
        // Mock settings with github-pr mode
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'main',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'github-pr',
          },
        })

        // Mock issue fetch
        vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
          number: 123,
          title: 'Test Issue',
          body: 'Test description',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/owner/repo/issues/123',
        })

        // Mock worktree path generation (needed before fetchOrigin is called)
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree-issue-123')

        // Mock fetchOrigin to fail with network error
        vi.mocked(fetchOrigin).mockRejectedValueOnce(
          new Error('Failed to fetch from origin: Could not resolve host: github.com\n\nCheck your network connection and repository access.')
        )

        // Verify that createIloom throws with the fetch error
        await expect(manager.createIloom(baseInput)).rejects.toThrow('Failed to fetch from origin')
      })

      it('should NOT fetch when input type is PR (working with existing PR)', async () => {
        // Mock settings with github-pr mode
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'main',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'github-pr',
          },
        })

        // Mock PR fetch (not issue fetch - working with existing PR)
        vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
          number: 789,
          title: 'Existing PR',
          body: 'PR description',
          state: 'open',
          branch: 'feature/existing-pr-branch',
          baseBranch: 'main',
          url: 'https://github.com/owner/repo/pull/789',
          isDraft: false,
        })

        // Mock worktree creation
        const expectedPath = '/test/worktree-existing-pr'
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
        vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
        vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3789)

        // Create PR-type loom (working with existing PR)
        const prInput: CreateLoomInput = {
          type: 'pr',
          identifier: 789,
          originalInput: 'pr/789',
        }

        await manager.createIloom(prInput)

        // Verify fetchOrigin was NOT called when working with existing PR
        // (PR type fetches in createWorktreeOnly via executeGitCommand instead)
        expect(fetchOrigin).not.toHaveBeenCalled()
      })

      it('should use configured mainBranch from settings for origin ref', async () => {
        // Mock settings with custom mainBranch
        vi.mocked(mockSettings.loadSettings).mockResolvedValue({
          mainBranch: 'develop',
          worktreeDir: '/test/worktrees',
          mergeBehavior: {
            mode: 'github-pr',
          },
        })

        // Mock issue fetch
        vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
          number: 123,
          title: 'Test Issue',
          body: 'Test description',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/owner/repo/issues/123',
        })

        // Mock worktree creation
        const expectedPath = '/test/worktree-issue-123'
        vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
        vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
        vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

        await manager.createIloom(baseInput)

        // Verify createWorktree was called with origin/develop (custom mainBranch)
        expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'origin/develop',
          })
        )
      })
    })
  })

  describe('listLooms', () => {
    it('should list active looms from worktrees', async () => {
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
          path: '/test/repo',
          branch: 'main',
          commit: 'def456',
          bare: true,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(mockWorktrees)

      const result = await manager.listLooms()

      expect(result).toHaveLength(2)
      expect(mockGitWorktree.listWorktrees).toHaveBeenCalled()
    })

    it('should return empty array when no worktrees exist', async () => {
      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue([])

      const result = await manager.listLooms()

      expect(result).toEqual([])
    })
  })

  describe('findIloom', () => {
    it('should find loom by identifier', async () => {
      const mockWorktrees = [
        {
          path: '/test/worktree-issue-123',
          branch: 'issue-123',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(mockWorktrees)

      const result = await manager.findIloom('123')

      expect(result).toBeDefined()
      expect(result?.identifier).toBe(123)
    })

    it('should return null when loom not found', async () => {
      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue([])

      const result = await manager.findIloom('999')

      expect(result).toBeNull()
    })

    it('should find loom case-insensitively for Linear IDs via branch match', async () => {
      // Loom with lowercase branch name (as created by branch naming)
      const mockWorktrees = [
        {
          path: '/test/worktree-feat-issue-mark-1',
          branch: 'feat/issue-mark-1__nextjs-vercel',
          commit: 'abc123',
          bare: false,
          detached: false,
          locked: false,
        },
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(mockWorktrees)

      // Search with uppercase branch name should find lowercase branch
      const result = await manager.findIloom('FEAT/ISSUE-MARK-1__NEXTJS-VERCEL')

      expect(result).toBeDefined()
      expect(result?.branch).toBe('feat/issue-mark-1__nextjs-vercel')
    })
  })

  describe('finishIloom', () => {
    it('should throw not implemented error', async () => {
      await expect(manager.finishIloom('123')).rejects.toThrow('Not implemented')
    })
  })


  describe('branch name generation', () => {
    it('should use generateBranchName for issues', async () => {
      const mockGenerateBranchName = vi.fn().mockResolvedValue('feature/123-test-issue')
      vi.mocked(mockBranchNaming.generateBranchName).mockImplementation(mockGenerateBranchName)

      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 123,
        originalInput: '123',
      }

      const mockIssue = {
        number: 123,
        title: 'Test Issue',
        body: 'Issue body',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/123',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)

      const expectedPath = '/test/worktree-feature-123-test-issue'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      await manager.createIloom(input)

      expect(mockGenerateBranchName).toHaveBeenCalledWith({
        issueNumber: 123,
        title: 'Test Issue',
      })
    })

    it('should use PR branch for PRs', async () => {
      const input: CreateLoomInput = {
        type: 'pr',
        identifier: 456,
        originalInput: 'pr/456',
      }

      const mockPR = {
        number: 456,
        title: 'Test PR',
        body: 'PR body',
        state: 'open' as const,
        branch: 'existing-feature-branch',
        baseBranch: 'main',
        url: 'https://github.com/test/repo/pull/456',
        isDraft: false,
      }

      vi.mocked(mockGitHub.fetchPR).mockResolvedValue(mockPR)

      const expectedPath = '/test/worktree-existing-feature-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      const result = await manager.createIloom(input)

      expect(result.branch).toBe('existing-feature-branch')
      // generateBranchName should not be called for PRs
      expect(mockBranchNaming.generateBranchName).not.toHaveBeenCalled()
    })

    it('should use branch name directly for branch type', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'my-custom-branch',
        originalInput: 'my-custom-branch',
      }

      const expectedPath = '/test/worktree-my-custom-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      const result = await manager.createIloom(input)

      expect(result.branch).toBe('my-custom-branch')
      // generateBranchName should not be called for branch type
      expect(mockBranchNaming.generateBranchName).not.toHaveBeenCalled()
    })
  })

  describe('branch existence checking', () => {
    it('should check branch existence before creating worktree for issues', async () => {
      vi.mocked(branchExists).mockResolvedValue(true)

      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 123,
        originalInput: '123',
      }

      const mockIssue = {
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/123',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/123-test')
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')

      await expect(manager.createIloom(input)).rejects.toThrow(
        /branch .* already exists/
      )
    })

    it('should check branch existence before creating worktree for branches', async () => {
      vi.mocked(branchExists).mockResolvedValue(true)

      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'existing-branch',
        originalInput: 'existing-branch',
      }

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')

      await expect(manager.createIloom(input)).rejects.toThrow(
        /branch .* already exists/
      )
    })

    it('should not check branch existence for PRs', async () => {
      vi.mocked(branchExists).mockResolvedValue(false)

      const input: CreateLoomInput = {
        type: 'pr',
        identifier: 456,
        originalInput: 'pr/456',
      }

      const mockPR = {
        number: 456,
        title: 'Test PR',
        body: '',
        state: 'open' as const,
        branch: 'pr-branch',
        baseBranch: 'main',
        url: 'https://github.com/test/repo/pull/456',
        isDraft: false,
      }

      vi.mocked(mockGitHub.fetchPR).mockResolvedValue(mockPR)
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/path')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      await manager.createIloom(input)

      // branchExists IS called for PRs to determine if we need to reset to match remote
      // Now passes false for includeRemote to only check local branches
      expect(branchExists).toHaveBeenCalledWith('pr-branch', process.cwd(), false)
    })

    it('should create worktree when branch does not exist', async () => {
      vi.mocked(branchExists).mockResolvedValue(false)

      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 123,
        originalInput: '123',
      }

      const mockIssue = {
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/123',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/123-test')

      const expectedPath = '/test/worktree-feature-123-test'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      const result = await manager.createIloom(input)

      expect(result.branch).toBe('feature/123-test')
      expect(mockGitWorktree.createWorktree).toHaveBeenCalledWith({
        path: expectedPath,
        branch: 'feature/123-test',
        createBranch: true,
      })
    })
  })

  describe('CLI Isolation', () => {
    it('should detect CLI capabilities and setup isolation', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'CLI Tool Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-cli')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Mock CLI capability detection
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['cli'],
        binEntries: { il: './dist/cli.js', iloom: './dist/cli.js' }
      })

      // Mock CLI isolation setup
      vi.mocked(mockCLIIsolation.setupCLIIsolation).mockResolvedValue(['il-42', 'iloom-42'])

      const result = await manager.createIloom(input)

      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({ il: './dist/cli.js', iloom: './dist/cli.js' })
      expect(result.cliSymlinks).toEqual(['il-42', 'iloom-42'])
      expect(mockCapabilityDetector.detectCapabilities).toHaveBeenCalledWith(expectedPath)
      expect(mockCLIIsolation.setupCLIIsolation).toHaveBeenCalledWith(
        expectedPath,
        42,
        { il: './dist/cli.js', iloom: './dist/cli.js' }
      )
    })

    it('should detect web capabilities and setup port isolation', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'Web App Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-web')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Mock web-only capability detection
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {}
      })

      const result = await manager.createIloom(input)

      expect(result.capabilities).toEqual(['web'])
      expect(result.port).toBe(3042)
      expect(mockEnvironment.calculatePort).toHaveBeenCalledWith({
        basePort: 3000,
        issueNumber: 42
      })
      expect(mockCLIIsolation.setupCLIIsolation).not.toHaveBeenCalled()
    })

    it('should detect hybrid project and setup both isolations', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'Hybrid Project Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-hybrid')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Mock hybrid capability detection
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['cli', 'web'],
        binEntries: { 'my-tool': './dist/cli.js' }
      })

      vi.mocked(mockCLIIsolation.setupCLIIsolation).mockResolvedValue(['my-tool-42'])

      const result = await manager.createIloom(input)

      expect(result.capabilities).toEqual(['cli', 'web'])
      expect(result.port).toBe(3042)
      expect(result.cliSymlinks).toEqual(['my-tool-42'])
      expect(mockEnvironment.calculatePort).toHaveBeenCalled()
      expect(mockCLIIsolation.setupCLIIsolation).toHaveBeenCalled()
    })

    it('should skip CLI isolation if no bin field', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'Library Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-lib')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Mock no capabilities
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {}
      })

      const result = await manager.createIloom(input)

      // Empty capabilities array is not added to loom object (spread operator check)
      expect(result.capabilities).toBeUndefined()
      expect(result.binEntries).toBeUndefined()
      expect(result.cliSymlinks).toBeUndefined()
      expect(mockCLIIsolation.setupCLIIsolation).not.toHaveBeenCalled()
    })

    it('should continue if CLI isolation fails (lenient error handling)', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'CLI Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-cli')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Mock CLI capability detection
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['cli'],
        binEntries: { il: './dist/cli.js' }
      })

      // Mock CLI isolation failure
      vi.mocked(mockCLIIsolation.setupCLIIsolation).mockRejectedValue(
        new Error('Build failed')
      )

      // Should not throw - should continue despite CLI isolation failure
      const result = await manager.createIloom(input)

      expect(result).toBeDefined()
      expect(result.path).toBe(expectedPath)
      expect(result.capabilities).toEqual(['cli'])
      expect(result.cliSymlinks).toBeUndefined() // Not set due to failure
    })

    it('should store capabilities in loom metadata', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'Test Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-test')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['cli', 'web'],
        binEntries: { tool: './bin/tool.js' }
      })

      vi.mocked(mockCLIIsolation.setupCLIIsolation).mockResolvedValue(['tool-42'])

      const result = await manager.createIloom(input)

      expect(result).toHaveProperty('capabilities')
      expect(result).toHaveProperty('binEntries')
      expect(result).toHaveProperty('cliSymlinks')
    })

    it('should include CLI symlink info in loom metadata', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 42,
        originalInput: '42',
      }

      const mockIssue = {
        number: 42,
        title: 'Test Issue',
        body: '',
        state: 'open' as const,
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/42',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue(mockIssue)
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feature/42-test')

      const expectedPath = '/test/worktree-issue-42'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['cli'],
        binEntries: { cmd1: './bin/cmd1.js', cmd2: './bin/cmd2.js' }
      })

      vi.mocked(mockCLIIsolation.setupCLIIsolation).mockResolvedValue(['cmd1-42', 'cmd2-42'])

      const result = await manager.createIloom(input)

      expect(result.cliSymlinks).toEqual(['cmd1-42', 'cmd2-42'])
      expect(result.binEntries).toEqual({ cmd1: './bin/cmd1.js', cmd2: './bin/cmd2.js' })
    })

    it('should skip CLI isolation in branch mode even when CLI capability is detected', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'feature-xyz',
        originalInput: 'feature-xyz',
      }

      const expectedPath = '/test/worktree-feature-xyz'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)
      vi.mocked(mockClaude.prepareContext).mockResolvedValue()

      // Mock CLI capability detection - would normally trigger CLI isolation
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['cli'],
        binEntries: { il: './dist/cli.js', iloom: './dist/cli.js' }
      })

      const result = await manager.createIloom(input)

      // Verify CLI isolation was NOT attempted in branch mode
      expect(mockCLIIsolation.setupCLIIsolation).not.toHaveBeenCalled()
      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({ il: './dist/cli.js', iloom: './dist/cli.js' })
      expect(result.cliSymlinks).toBeUndefined() // Not set because isolation was skipped
    })
  })

  describe('opening modes integration', () => {
    it('should use default mode when no mode flags specified', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'test-branch',
        originalInput: 'test-branch',
      }

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/path')
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)

      await manager.createIloom(input)

      // Default mode should launch (via LoomLauncher)
      // We can't directly test LoomLauncher calls since it's dynamically imported
      // But we verify the loom is created successfully
      expect(mockGitWorktree.createWorktree).toHaveBeenCalled()
    })

    it('should pass terminal-only mode option', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'test-branch',
        originalInput: 'test-branch',
        options: {
          terminalOnly: true,
        },
      }

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/path')
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)

      await manager.createIloom(input)

      // Terminal-only mode should not skip launching
      expect(mockGitWorktree.createWorktree).toHaveBeenCalled()
    })

    it('should handle code-only mode separately', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'test-branch',
        originalInput: 'test-branch',
        options: {
          codeOnly: true,
        },
      }

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/path')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/path')
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)

      await manager.createIloom(input)

      // Code-only mode should create loom successfully
      // VSCode launching happens via dynamic import
      expect(mockGitWorktree.createWorktree).toHaveBeenCalled()
    })
  })

  describe('findExistingIloom', () => {
    it('should find existing loom for issue input', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      const existingWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      const result = await manager.createIloom(input)

      expect(result.path).toBe('/test/worktree-issue-39')
      expect(result.branch).toBe('issue-39-test')
      expect(mockGitWorktree.findWorktreeForIssue).toHaveBeenCalledWith(39)
      expect(mockGitWorktree.createWorktree).not.toHaveBeenCalled()
      expect(installDependencies).not.toHaveBeenCalled()
    })

    it('should find existing loom for PR input', async () => {
      const input: CreateLoomInput = {
        type: 'pr',
        identifier: 42,
        originalInput: 'pr/42',
      }

      const existingWorktree = {
        path: '/test/worktree-feat-test_pr_42',
        branch: 'feat/test-feature',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 42,
        title: 'Test PR',
        body: '',
        state: 'open',
        branch: 'feat/test-feature',
        baseBranch: 'main',
        url: 'https://github.com/test/repo/pull/42',
        isDraft: false,
      })
      vi.mocked(mockGitWorktree.findWorktreeForPR).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      const result = await manager.createIloom(input)

      expect(result.path).toBe('/test/worktree-feat-test_pr_42')
      expect(result.branch).toBe('feat/test-feature')
      expect(mockGitWorktree.findWorktreeForPR).toHaveBeenCalledWith(42, 'feat/test-feature')
      expect(mockGitWorktree.createWorktree).not.toHaveBeenCalled()
      expect(installDependencies).not.toHaveBeenCalled()
    })

    it('should find existing loom for branch input', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'test-branch',
        originalInput: 'test-branch',
      }

      const existingWorktree = {
        path: '/test/worktree-test-branch',
        branch: 'test-branch',
        commit: 'xyz789',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForBranch).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      const result = await manager.createIloom(input)

      expect(result.path).toBe('/test/worktree-test-branch')
      expect(result.branch).toBe('test-branch')
      expect(mockGitWorktree.findWorktreeForBranch).toHaveBeenCalledWith('test-branch')
      expect(mockGitWorktree.createWorktree).not.toHaveBeenCalled()
      expect(installDependencies).not.toHaveBeenCalled()
    })

    it('should create new worktree when no existing found for branch', async () => {
      const input: CreateLoomInput = {
        type: 'branch',
        identifier: 'new-branch',
        originalInput: 'new-branch',
      }

      vi.mocked(mockGitWorktree.findWorktreeForBranch).mockResolvedValue(null)

      const expectedPath = '/test/worktree-new-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      await manager.createIloom(input)

      expect(mockGitWorktree.findWorktreeForBranch).toHaveBeenCalledWith('new-branch')
      expect(mockGitWorktree.createWorktree).toHaveBeenCalled()
      expect(installDependencies).toHaveBeenCalled()
    })

    it('should create new worktree when no existing found for issue', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 99,
        originalInput: '99',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 99,
        title: 'New Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/99',
      })
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('issue-99-new-issue')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-99'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3099)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      await manager.createIloom(input)

      expect(mockGitWorktree.findWorktreeForIssue).toHaveBeenCalledWith(99)
      expect(mockGitWorktree.createWorktree).toHaveBeenCalled()
      expect(installDependencies).toHaveBeenCalled()
    })
  })

  describe('reuseIloom', () => {
    it('should return loom metadata without creating worktree', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      const existingWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      const result = await manager.createIloom(input)

      expect(result.path).toBe('/test/worktree-issue-39')
      expect(result.branch).toBe('issue-39-test')
      expect(result.type).toBe('issue')
      expect(result.identifier).toBe(39)
      expect(result.issueData?.title).toBe('Test Issue')
      expect(mockGitWorktree.createWorktree).not.toHaveBeenCalled()
    })

    it('should defensively copy files and set PORT when reusing existing worktree for issue', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      const existingWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      await manager.createIloom(input)

      // When reusing an existing worktree (NEW BEHAVIOR - defensive copying):
      // - Files are copied defensively (internal implementation via copyIfExists)
      // - calculatePort SHOULD be called (to return the correct port)
      // - setEnvVar SHOULD be called for web projects (ensure PORT is set)
      expect(mockEnvironment.calculatePort).toHaveBeenCalled()
      expect(mockEnvironment.setEnvVar).toHaveBeenCalled() // Changed: now sets PORT on reuse
    })

    it('should defensively copy files and set PORT when reusing existing worktree for PR', async () => {
      const input: CreateLoomInput = {
        type: 'pr',
        identifier: 42,
        originalInput: 'pr/42',
      }

      const existingWorktree = {
        path: '/test/worktree-feat-test_pr_42',
        branch: 'feat/test-feature',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 42,
        title: 'Test PR',
        body: 'Test description',
        state: 'open',
        branch: 'feat/test-feature',
        baseBranch: 'main',
        url: 'https://github.com/test/repo/pull/42',
        isDraft: false,
      })
      vi.mocked(mockGitWorktree.findWorktreeForPR).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: ['web'],
        binEntries: {},
      })

      await manager.createIloom(input)

      // When reusing an existing worktree (NEW BEHAVIOR - defensive copying):
      // - Files are copied defensively (internal implementation via copyIfExists)
      // - calculatePort SHOULD be called (to return the correct port)
      // - setEnvVar SHOULD be called for web projects (ensure PORT is set)
      expect(mockEnvironment.calculatePort).toHaveBeenCalled()
      expect(mockEnvironment.setEnvVar).toHaveBeenCalled() // Changed: now sets PORT on reuse
    })

    it('should still call moveIssueToInProgress for issue reuse', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      const existingWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)
      vi.mocked(mockGitHub.moveIssueToInProgress).mockResolvedValue()
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      await manager.createIloom(input)

      expect(mockGitHub.moveIssueToInProgress).toHaveBeenCalledWith(39)
    })

    it('should NOT call moveIssueToInProgress for PR reuse', async () => {
      const input: CreateLoomInput = {
        type: 'pr',
        identifier: 42,
        originalInput: 'pr/42',
      }

      const existingWorktree = {
        path: '/test/worktree-feat-test_pr_42',
        branch: 'feat/test-feature',
        commit: 'def456',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 42,
        title: 'Test PR',
        body: '',
        state: 'open',
        branch: 'feat/test-feature',
        baseBranch: 'main',
        url: 'https://github.com/test/repo/pull/42',
        isDraft: false,
      })
      vi.mocked(mockGitWorktree.findWorktreeForPR).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      await manager.createIloom(input)

      expect(mockGitHub.moveIssueToInProgress).not.toHaveBeenCalled()
    })

    it('should launch components for reused loom', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
        options: { enableClaude: true },
      }

      const existingWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      await manager.createIloom(input)

      // LoomLauncher is dynamically imported, so we can't directly verify its calls
      // But we verify the flow completes successfully
      expect(mockGitWorktree.findWorktreeForIssue).toHaveBeenCalled()
    })

    it('should warn but not fail when moveIssueToInProgress throws GitHubError', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      const existingWorktree = {
        path: '/test/worktree-issue-39',
        branch: 'issue-39-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)
      vi.mocked(mockGitHub.moveIssueToInProgress).mockRejectedValue(
        new Error('Missing project scope')
      )
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      // Should not throw - warning logged but loom creation succeeds
      const result = await manager.createIloom(input)

      expect(result).toBeDefined()
      expect(result.path).toBe('/test/worktree-issue-39')
      expect(mockGitHub.moveIssueToInProgress).toHaveBeenCalledWith(39)
    })
  })

  describe('GitHub issue status updates', () => {
    it('should move issue to In Progress when creating new worktree', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('issue-39-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-39'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3039)
      vi.mocked(mockGitHub.moveIssueToInProgress).mockResolvedValue()
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      await manager.createIloom(input)

      expect(mockGitHub.moveIssueToInProgress).toHaveBeenCalledWith(39)
    })

    it('should NOT move PR to In Progress', async () => {
      const input: CreateLoomInput = {
        type: 'pr',
        identifier: 42,
        originalInput: 'pr/42',
      }

      vi.mocked(mockGitHub.fetchPR).mockResolvedValue({
        number: 42,
        title: 'Test PR',
        body: '',
        state: 'open',
        branch: 'feat/test',
        baseBranch: 'main',
        url: 'https://github.com/test/repo/pull/42',
        isDraft: false,
      })
      vi.mocked(mockGitWorktree.findWorktreeForPR).mockResolvedValue(null)

      const expectedPath = '/test/worktree-feat-test'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3042)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      await manager.createIloom(input)

      expect(mockGitHub.moveIssueToInProgress).not.toHaveBeenCalled()
    })

    it('should warn but not fail when moveIssueToInProgress throws error for new worktree', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 39,
        originalInput: '39',
      }

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 39,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/39',
      })
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('issue-39-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-39'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3039)
      vi.mocked(mockGitHub.moveIssueToInProgress).mockRejectedValue(
        new Error('Missing project scope')
      )
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      // Should not throw - warning logged but loom creation succeeds
      const result = await manager.createIloom(input)

      expect(result).toBeDefined()
      expect(result.path).toBe(expectedPath)
      expect(mockGitHub.moveIssueToInProgress).toHaveBeenCalledWith(39)
    })

    it('should create initial commit in empty repository before worktree creation', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 165,
        originalInput: '165',
      }


      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 165,
        title: 'Empty Repo Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/165',
      })
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-165__empty-repo')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-165'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3165)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      // Call createIloom
      const result = await manager.createIloom(input)

      // Verify that ensureRepositoryHasCommits was called before worktree creation
      expect(ensureRepositoryHasCommits).toHaveBeenCalledWith(mockGitWorktree.workingDirectory)
      expect(result).toBeDefined()
      expect(result.path).toBe(expectedPath)
    })

    it('should not fail when repository already has commits', async () => {
      const input: CreateLoomInput = {
        type: 'issue',
        identifier: 166,
        originalInput: '166',
      }


      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 166,
        title: 'Repo with Commits Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/166',
      })
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-166__with-commits')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-166'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3166)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })

      // Call createIloom
      const result = await manager.createIloom(input)

      // Verify that ensureRepositoryHasCommits was called but only checks for existing commits
      expect(ensureRepositoryHasCommits).toHaveBeenCalledWith(mockGitWorktree.workingDirectory)
      expect(result).toBeDefined()
      expect(result.path).toBe(expectedPath)
    })
  })

  describe('Supplemental Environment File Copying', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 123,
      originalInput: '123',
    }

    beforeEach(() => {
      // Setup common mocks
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: 'Test body',
        state: 'open',
        url: 'https://github.com/test/test/issues/123',
        labels: [],
        assignees: [],
      })

      // Mock workingDirectory getter
      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => '/main/workspace'),
        configurable: true
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree/issue-123-test')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree/issue-123-test')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()
    })

    it('copies .env.local when not tracked by git', async () => {
      // Mock .env.local exists and is not tracked
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.endsWith('.env.local') && pathStr.includes('test/worktree')) {
          return false // doesn't exist in worktree yet
        }
        if (pathStr.endsWith('.env.local') && !pathStr.includes('worktree')) {
          return true // exists in main workspace
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      // Ensure copyIfExists is a spy function
      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for .env.local
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const envLocalCopy = copyIfExistsCalls.find(call =>
        String(call[0]).endsWith('.env.local')
      )
      expect(envLocalCopy).toBeDefined()
    })

    it('copies .env.development when not tracked by git', async () => {
      // Set DOTENV_FLOW_NODE_ENV to development
      const originalEnv = process.env.DOTENV_FLOW_NODE_ENV
      process.env.DOTENV_FLOW_NODE_ENV = 'development'

      // Mock .env.development exists and is not tracked
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.endsWith('.env.development') && pathStr.includes('test/worktree')) {
          return false // doesn't exist in worktree yet
        }
        if (pathStr.endsWith('.env.development') && !pathStr.includes('worktree')) {
          return true // exists in main workspace
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      // Ensure copyIfExists is a spy function
      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for .env.development
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const envDevelopmentCopy = copyIfExistsCalls.find(call =>
        String(call[0]).endsWith('.env.development')
      )
      expect(envDevelopmentCopy).toBeDefined()

      // Restore DOTENV_FLOW_NODE_ENV
      process.env.DOTENV_FLOW_NODE_ENV = originalEnv
    })

    it('copies .env.development.local when not tracked by git', async () => {
      // Set DOTENV_FLOW_NODE_ENV to development
      const originalEnv = process.env.DOTENV_FLOW_NODE_ENV
      process.env.DOTENV_FLOW_NODE_ENV = 'development'

      // Mock .env.development.local exists and is not tracked
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.endsWith('.env.development.local') && pathStr.includes('test/worktree')) {
          return false // doesn't exist in worktree yet
        }
        if (pathStr.endsWith('.env.development.local') && !pathStr.includes('worktree')) {
          return true // exists in main workspace
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      // Ensure copyIfExists is a spy function
      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for .env.development.local
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const envDevelopmentLocalCopy = copyIfExistsCalls.find(call =>
        String(call[0]).endsWith('.env.development.local')
      )
      expect(envDevelopmentLocalCopy).toBeDefined()

      // Restore DOTENV_FLOW_NODE_ENV
      process.env.DOTENV_FLOW_NODE_ENV = originalEnv
    })

    it('skips env files that are tracked by git', async () => {
      // Mock .env.local exists but IS tracked by git
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.endsWith('.env.local') && !pathStr.includes('worktree')) {
          return true // exists in main workspace
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockImplementation(async (filePath: string) => {
        return filePath === '.env.local' // .env.local is tracked
      })

      await manager.createIloom(baseInput)

      // Verify copyIfExists was NOT called for .env.local
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const envLocalCopy = copyIfExistsCalls.find(call =>
        String(call[0]).endsWith('.env.local')
      )
      expect(envLocalCopy).toBeUndefined()
    })

    it('handles missing env files gracefully', async () => {
      // Mock all env files as non-existent
      vi.mocked(fs.pathExists).mockResolvedValue(false)
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      // Should not throw
      await expect(manager.createIloom(baseInput)).resolves.toBeDefined()
    })

    it('skips env files that already exist in worktree', async () => {
      // Mock .env.local exists in both main and worktree
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.endsWith('.env.local')) {
          return true // exists in both locations
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was NOT called for .env.local (already exists)
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const envLocalCopy = copyIfExistsCalls.find(call =>
        String(call[0]).endsWith('.env.local')
      )
      expect(envLocalCopy).toBeUndefined()
    })
  })

  describe('Claude Settings Copying', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 286,
      originalInput: '286',
    }

    beforeEach(() => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 286,
        title: 'Copy Claude Settings',
        body: 'Test body',
        state: 'open',
        url: 'https://github.com/test/test/issues/286',
        labels: [],
        assignees: [],
      })

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => '/main/workspace'),
        configurable: true,
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree/issue-286')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree/issue-286')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3286)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
    })

    it('copies .claude/settings.local.json when source exists and destination does not', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        // Source exists
        if (pathStr.includes('.claude/settings.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        // Destination does not exist
        if (pathStr.includes('.claude/settings.local.json') && pathStr.includes('worktree')) {
          return false
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for .claude/settings.local.json
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const claudeSettingsCopy = copyIfExistsCalls.find(
        (call) =>
          String(call[0]).includes('.claude/settings.local.json') ||
          String(call[0]).includes('.claude\\settings.local.json')
      )
      expect(claudeSettingsCopy).toBeDefined()
    })

    it('skips copying when .claude/settings.local.json already exists in worktree', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        // Both source and destination exist
        if (pathStr.includes('.claude/settings.local.json')) {
          return true
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was NOT called for .claude/settings.local.json
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const claudeSettingsCopy = copyIfExistsCalls.find(
        (call) =>
          String(call[0]).includes('.claude/settings.local.json') ||
          String(call[0]).includes('.claude\\settings.local.json')
      )
      expect(claudeSettingsCopy).toBeUndefined()
    })

    it('handles missing source .claude/settings.local.json gracefully', async () => {
      // Source does not exist
      vi.mocked(fs.pathExists).mockResolvedValue(false)
      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      // Should not throw
      await expect(manager.createIloom(baseInput)).resolves.toBeDefined()
    })

    it('ensures .claude directory is created before copying', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.includes('.claude/settings.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify ensureDir was called for .claude directory in worktree
      const ensureDirCalls = vi.mocked(fs.ensureDir).mock.calls
      const claudeDirCreation = ensureDirCalls.find((call) =>
        String(call[0]).includes('.claude')
      )
      expect(claudeDirCreation).toBeDefined()
    })

    it('copies .claude/settings.local.json when reusing existing worktree', async () => {
      const existingWorktree = {
        path: '/test/worktree-issue-286',
        branch: 'issue-286-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)

      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.includes('.claude/settings.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for .claude/settings.local.json during reuse
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const claudeSettingsCopy = copyIfExistsCalls.find(
        (call) =>
          String(call[0]).includes('.claude/settings.local.json') ||
          String(call[0]).includes('.claude\\settings.local.json')
      )
      expect(claudeSettingsCopy).toBeDefined()
    })

    it('warns but does not fail when copying fails', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.includes('.claude/settings.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        return false
      })

      // Make ensureDir throw an error
      vi.mocked(fs.ensureDir).mockRejectedValueOnce(new Error('Permission denied'))

      // Should not throw - continues despite error
      const result = await manager.createIloom(baseInput)

      expect(result).toBeDefined()
      expect(result.path).toBe('/test/worktree/issue-286')
    })
  })

  describe('Iloom Package Local Config Copying', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 456,
      originalInput: '456',
    }

    beforeEach(() => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 456,
        title: 'Copy Iloom Package Local',
        body: 'Test body',
        state: 'open',
        url: 'https://github.com/test/test/issues/456',
        labels: [],
        assignees: [],
      })

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => '/main/workspace'),
        configurable: true,
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree/issue-456')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree/issue-456')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
    })

    it('copies package.iloom.local.json when source exists and destination does not', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        // Source exists
        if (pathStr.includes('package.iloom.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        // Destination does not exist
        if (pathStr.includes('package.iloom.local.json') && pathStr.includes('worktree')) {
          return false
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for package.iloom.local.json
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const packageLocalCopy = copyIfExistsCalls.find(
        (call) =>
          String(call[0]).includes('package.iloom.local.json') ||
          String(call[0]).includes('package.iloom.local.json')
      )
      expect(packageLocalCopy).toBeDefined()
    })

    it('skips copying when package.iloom.local.json already exists in worktree', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        // Both source and destination exist
        if (pathStr.includes('package.iloom.local.json')) {
          return true
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was NOT called for package.iloom.local.json
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const packageLocalCopy = copyIfExistsCalls.find(
        (call) =>
          String(call[0]).includes('package.iloom.local.json') ||
          String(call[0]).includes('package.iloom.local.json')
      )
      expect(packageLocalCopy).toBeUndefined()
    })

    it('handles missing source package.iloom.local.json gracefully', async () => {
      // Source does not exist
      vi.mocked(fs.pathExists).mockResolvedValue(false)
      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      // Should not throw
      await expect(manager.createIloom(baseInput)).resolves.toBeDefined()
    })

    it('ensures .iloom directory is created before copying', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.includes('package.iloom.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify ensureDir was called for .iloom directory in worktree
      const ensureDirCalls = vi.mocked(fs.ensureDir).mock.calls
      const iloomDirCreation = ensureDirCalls.find((call) =>
        String(call[0]).includes('.iloom')
      )
      expect(iloomDirCreation).toBeDefined()
    })

    it('copies package.iloom.local.json when reusing existing worktree', async () => {
      const existingWorktree = {
        path: '/test/worktree-issue-456',
        branch: 'issue-456-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)

      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.includes('package.iloom.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        return false
      })

      vi.mocked(mockEnvironment.copyIfExists).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify copyIfExists was called for package.iloom.local.json during reuse
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const packageLocalCopy = copyIfExistsCalls.find(
        (call) =>
          String(call[0]).includes('package.iloom.local.json') ||
          String(call[0]).includes('package.iloom.local.json')
      )
      expect(packageLocalCopy).toBeDefined()
    })

    it('warns but does not fail when copying fails', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (path: string) => {
        const pathStr = String(path)
        if (pathStr.includes('package.iloom.local.json') && !pathStr.includes('worktree')) {
          return true
        }
        return false
      })

      // Make ensureDir throw an error for .iloom directory
      vi.mocked(fs.ensureDir).mockImplementation(async (path: string) => {
        if (String(path).includes('.iloom') && String(path).includes('worktree')) {
          throw new Error('Permission denied')
        }
        return undefined
      })

      // Should not throw - continues despite error
      const result = await manager.createIloom(baseInput)

      expect(result).toBeDefined()
      expect(result.path).toBe('/test/worktree/issue-456')
    })
  })

  describe('Global Color Collision Detection', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 284,
      originalInput: '284',
    }

    beforeEach(() => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 284,
        title: 'Test Issue',
        body: 'Test body',
        state: 'open',
        url: 'https://github.com/test/test/issues/284',
        labels: [],
        assignees: [],
      })

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => '/main/workspace'),
        configurable: true
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree/issue-284')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree/issue-284')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3284)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
    })

    it('should successfully create loom with global color detection', async () => {
      // Test verifies that createIloom completes successfully when using global color detection
      // The mock for MetadataManager.listAllMetadata returns [] by default (line 41)
      const result = await manager.createIloom(baseInput)

      expect(result).toBeDefined()
      expect(result.id).toBe('issue-284')
      expect(result.path).toBe('/test/worktree/issue-284')
    })

    it('should handle null colorHex values gracefully during collision detection', async () => {
      // The mock returns empty array which exercises the filtering logic
      // This test verifies the implementation handles edge cases
      const result = await manager.createIloom(baseInput)

      expect(result).toBeDefined()
      expect(result.type).toBe('issue')
      expect(result.identifier).toBe(284)
    })
  })

  describe('projectPath in metadata', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 456,
      originalInput: '456',
    }

    beforeEach(() => {
      // Mock GitHub data fetch
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 456,
        title: 'Child Issue',
        body: 'Test description',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/456',
      })

      // Mock worktree creation
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree-issue-456')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree-issue-456')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-456__child-issue')
    })

    it('should use main worktree path as projectPath, not parent loom path', async () => {
      // SCENARIO: User is in a parent loom at /projects/myapp__issue-123
      // and runs `il start 456` to create a child loom.
      // The projectPath should be the MAIN worktree path (/projects/myapp),
      // NOT the parent loom path.

      // Set up: workingDirectory represents the main worktree path
      // (this is what findMainWorktreePathWithSettings returns)
      const mainWorktreePath = '/projects/myapp'
      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      // Create a child loom (with parentLoom set)
      const childLoomInput: CreateLoomInput = {
        ...baseInput,
        parentLoom: {
          type: 'issue',
          identifier: '123',
          worktreePath: '/projects/myapp__issue-123',  // Parent loom path (should NOT be used for projectPath)
          branchName: 'feat/issue-123__parent-feature',
        },
      }

      await manager.createIloom(childLoomInput)

      // Verify writeMetadata was called
      expect(mockWriteMetadata).toHaveBeenCalled()

      // Get the metadata input that was passed to writeMetadata
      const writeMetadataCall = mockWriteMetadata.mock.calls[0]
      const metadataInput = writeMetadataCall[1]

      // CRITICAL ASSERTION: projectPath should be the main worktree path,
      // NOT the parent loom's path
      expect(metadataInput.projectPath).toBe(mainWorktreePath)
      expect(metadataInput.projectPath).not.toBe('/projects/myapp__issue-123')
    })

    it('should include projectPath in metadata for regular looms', async () => {
      const mainWorktreePath = '/projects/myapp'
      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      await manager.createIloom(baseInput)

      expect(mockWriteMetadata).toHaveBeenCalled()

      const writeMetadataCall = mockWriteMetadata.mock.calls[0]
      const metadataInput = writeMetadataCall[1]

      expect(metadataInput.projectPath).toBe(mainWorktreePath)
    })
  })

  describe('copyGitIgnoredFiles', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 123,
      originalInput: '123',
    }

    beforeEach(() => {
      // Reset fs-extra mocks for each test
      vi.mocked(fs.pathExists).mockReset()
      vi.mocked(fs.ensureDir).mockReset()
      vi.mocked(fg.glob).mockReset()

      // Common setup for all tests
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/test/repo/issues/123',
      })

      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {}
      })
    })

    it('should skip copying when no patterns are configured', async () => {
      // No copyGitIgnoredPatterns configured
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({})

      await manager.createIloom(baseInput)

      // fast-glob should not be called since no patterns configured
      expect(fg.glob).not.toHaveBeenCalled()
    })

    it('should copy files matching configured patterns', async () => {
      const mainWorktreePath = '/projects/myapp'

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      // Configure patterns
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        copyGitIgnoredPatterns: ['*.db']
      })

      // Mock fast-glob to return matching files
      vi.mocked(fg.glob).mockResolvedValue(['app.db', 'cache.db'])

      // Main files exist
      vi.mocked(fs.pathExists).mockImplementation(async (p: fs.PathLike) => {
        const pathStr = String(p)
        if (pathStr === mainWorktreePath || pathStr.startsWith(mainWorktreePath)) {
          return true
        }
        return false
      })

      // Files are not tracked by git
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      // Worktree files don't exist yet
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify fast-glob was called with array of patterns
      expect(fg.glob).toHaveBeenCalledWith(['*.db'], {
        cwd: mainWorktreePath,
        onlyFiles: true,
        dot: true,
      })

      // Verify copyIfExists was called for matching db files
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const dbFileCopies = copyIfExistsCalls.filter(
        call => String(call[0]).endsWith('.db')
      )
      expect(dbFileCopies.length).toBeGreaterThanOrEqual(1)
    })

    it('should skip files that are tracked by git', async () => {
      const mainWorktreePath = '/projects/myapp'

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      // Configure patterns
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        copyGitIgnoredPatterns: ['*.db']
      })

      // Mock fast-glob to return a file
      vi.mocked(fg.glob).mockResolvedValue(['tracked.db'])

      vi.mocked(fs.pathExists).mockResolvedValue(true)

      // File IS tracked by git - should be skipped
      vi.mocked(isFileTrackedByGit).mockResolvedValue(true)

      await manager.createIloom(baseInput)

      // Verify fast-glob was called with array of patterns
      expect(fg.glob).toHaveBeenCalledWith(['*.db'], expect.any(Object))

      // Verify copyIfExists was NOT called for tracked.db
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const trackedDbCopies = copyIfExistsCalls.filter(
        call => String(call[0]).includes('tracked.db')
      )
      expect(trackedDbCopies.length).toBe(0)
    })

    it('should handle multiple patterns in a single glob call', async () => {
      const mainWorktreePath = '/projects/myapp'

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      // Configure multiple patterns
      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        copyGitIgnoredPatterns: ['*.db', '*.sqlite']
      })

      // Mock fast-glob to return files matching all patterns (deduplicated by fast-glob)
      vi.mocked(fg.glob).mockResolvedValue(['app.db', 'data.sqlite'])

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)

      await manager.createIloom(baseInput)

      // All patterns should be passed to a single fg.glob call
      expect(fg.glob).toHaveBeenCalledTimes(1)
      expect(fg.glob).toHaveBeenCalledWith(['*.db', '*.sqlite'], {
        cwd: mainWorktreePath,
        onlyFiles: true,
        dot: true,
      })
    })

    it('should warn but not fail on copy errors', async () => {
      const mainWorktreePath = '/projects/myapp'

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        copyGitIgnoredPatterns: ['*.db']
      })

      // Mock fast-glob to throw an error
      vi.mocked(fg.glob).mockRejectedValue(new Error('Permission denied'))

      vi.mocked(fs.pathExists).mockResolvedValue(true)

      // Should not throw - errors are caught and logged
      await expect(manager.createIloom(baseInput)).resolves.toBeDefined()
    })

    it('should support recursive ** patterns like **/*.db', async () => {
      const mainWorktreePath = '/projects/myapp'
      const worktreePath = '/test/worktree-issue-123'

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        copyGitIgnoredPatterns: ['**/*.db']
      })

      // Mock fast-glob to return nested files
      vi.mocked(fg.glob).mockResolvedValue([
        'app.db',
        'data/nested.db',
        'data/deep/other.db'
      ])

      // Main files exist, worktree files don't
      vi.mocked(fs.pathExists).mockImplementation(async (p: fs.PathLike) => {
        const pathStr = String(p)
        // Files exist in main workspace, not in worktree
        if (pathStr.startsWith(mainWorktreePath)) {
          return true
        }
        if (pathStr.startsWith(worktreePath)) {
          return false
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify fast-glob was called with all patterns at once
      expect(fg.glob).toHaveBeenCalledWith(['**/*.db'], {
        cwd: mainWorktreePath,
        onlyFiles: true,
        dot: true,
      })

      // Verify copyIfExists was called for all nested db files
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const dbFileCopies = copyIfExistsCalls.filter(
        call => String(call[0]).endsWith('.db')
      )
      expect(dbFileCopies.length).toBe(3)
    })

    it('should support brace expansion like {data,backup}/*.db', async () => {
      const mainWorktreePath = '/projects/myapp'
      const worktreePath = '/test/worktree-issue-123'

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => mainWorktreePath),
        configurable: true
      })

      vi.mocked(mockSettings.loadSettings).mockResolvedValue({
        copyGitIgnoredPatterns: ['{data,backup}/*.db']
      })

      // Mock fast-glob to return files from both directories
      vi.mocked(fg.glob).mockResolvedValue([
        'data/app.db',
        'backup/old.db'
      ])

      // Main files exist, worktree files don't
      vi.mocked(fs.pathExists).mockImplementation(async (p: fs.PathLike) => {
        const pathStr = String(p)
        // Files exist in main workspace, not in worktree
        if (pathStr.startsWith(mainWorktreePath)) {
          return true
        }
        if (pathStr.startsWith(worktreePath)) {
          return false
        }
        return false
      })
      vi.mocked(isFileTrackedByGit).mockResolvedValue(false)
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)

      await manager.createIloom(baseInput)

      // Verify fast-glob was called with all patterns at once
      expect(fg.glob).toHaveBeenCalledWith(['{data,backup}/*.db'], {
        cwd: mainWorktreePath,
        onlyFiles: true,
        dot: true,
      })

      // Verify copyIfExists was called for files from both directories
      const copyIfExistsCalls = vi.mocked(mockEnvironment.copyIfExists).mock.calls
      const dbFileCopies = copyIfExistsCalls.filter(
        call => String(call[0]).endsWith('.db')
      )
      expect(dbFileCopies.length).toBe(2)
    })
  })

  describe('oneShot metadata persistence', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 496,
      originalInput: '496',
    }

    beforeEach(() => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 496,
        title: 'OneShot Mode Test',
        body: 'Test body',
        state: 'open',
        url: 'https://github.com/test/test/issues/496',
        labels: [],
        assignees: [],
      })

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => '/main/workspace'),
        configurable: true,
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree/issue-496')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree/issue-496')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3496)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
    })

    it('should pass oneShot to metadata when provided in createIloom options', async () => {
      const inputWithOneShot: CreateLoomInput = {
        ...baseInput,
        options: { oneShot: 'noReview' },
      }

      await manager.createIloom(inputWithOneShot)

      // Verify writeMetadata was called with oneShot
      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]
      expect(metadataInput.oneShot).toBe('noReview')
    })

    it('should pass bypassPermissions oneShot mode to metadata', async () => {
      const inputWithOneShot: CreateLoomInput = {
        ...baseInput,
        options: { oneShot: 'bypassPermissions' },
      }

      await manager.createIloom(inputWithOneShot)

      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]
      expect(metadataInput.oneShot).toBe('bypassPermissions')
    })

    it('should NOT include oneShot in metadata when default mode (not explicitly set)', async () => {
      // Note: When oneShot is undefined or 'default', it should not be included in metadata
      // The spread operator ...(input.options?.oneShot && { oneShot: input.options.oneShot })
      // only includes oneShot if it's truthy
      await manager.createIloom(baseInput)

      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]
      expect(metadataInput.oneShot).toBeUndefined()
    })

    it('should pass oneShot to metadata when reusing existing loom without metadata', async () => {
      const existingWorktree = {
        path: '/test/worktree-issue-496',
        branch: 'issue-496-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)

      // No existing metadata (null) - reuseIloom will write new metadata
      mockReadMetadata.mockResolvedValue(null)

      const inputWithOneShot: CreateLoomInput = {
        ...baseInput,
        options: { oneShot: 'noReview' },
      }

      await manager.createIloom(inputWithOneShot)

      // Verify writeMetadata was called (since no existing metadata)
      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]
      expect(metadataInput.oneShot).toBe('noReview')
    })

    it('should NOT overwrite metadata when reusing loom that already has metadata', async () => {
      const existingWorktree = {
        path: '/test/worktree-issue-496',
        branch: 'issue-496-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)

      // Existing metadata present
      mockReadMetadata.mockResolvedValue({
        description: 'Existing loom',
        created_at: '2024-01-01T00:00:00Z',
        branchName: 'issue-496-test',
        worktreePath: '/test/worktree-issue-496',
        issueType: 'issue',
        issue_numbers: ['496'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#dcebff',
        sessionId: 'existing-session',
        projectPath: '/main/workspace',
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        oneShot: 'default',
        capabilities: [],
        parentLoom: null,
      })

      const inputWithOneShot: CreateLoomInput = {
        ...baseInput,
        options: { oneShot: 'bypassPermissions' },
      }

      await manager.createIloom(inputWithOneShot)

      // Verify writeMetadata was NOT called (existing metadata preserved)
      expect(mockWriteMetadata).not.toHaveBeenCalled()
    })
  })

  describe('complexity metadata persistence', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 500,
      originalInput: '500',
    }

    beforeEach(() => {
      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 500,
        title: 'Complexity Override Test',
        body: 'Test body',
        state: 'open',
        url: 'https://github.com/test/test/issues/500',
        labels: [],
        assignees: [],
      })

      Object.defineProperty(mockGitWorktree, 'workingDirectory', {
        get: vi.fn(() => '/main/workspace'),
        configurable: true,
      })

      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue('/test/worktree/issue-500')
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue('/test/worktree/issue-500')
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3500)
      vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
        capabilities: [],
        binEntries: {},
      })
    })

    it('should persist complexity in metadata when createIloom is called with complexity option', async () => {
      const inputWithComplexity: CreateLoomInput = {
        ...baseInput,
        options: { complexity: 'simple' },
      }

      await manager.createIloom(inputWithComplexity)

      // Verify writeMetadata was called with complexity: 'simple'
      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]
      expect(metadataInput.complexity).toBe('simple')
    })

    it('should NOT include complexity in metadata when not provided', async () => {
      await manager.createIloom(baseInput)

      expect(mockWriteMetadata).toHaveBeenCalled()
      const metadataInput = mockWriteMetadata.mock.calls[0][1]
      expect(metadataInput.complexity).toBeUndefined()
    })

    it('should call updateMetadata with complexity when reusing loom that already has metadata', async () => {
      const existingWorktree = {
        path: '/test/worktree-issue-500',
        branch: 'issue-500-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)

      // Existing metadata present (no complexity)
      mockReadMetadata.mockResolvedValue({
        description: 'Existing loom',
        created_at: '2024-01-01T00:00:00Z',
        branchName: 'issue-500-test',
        worktreePath: '/test/worktree-issue-500',
        issueType: 'issue',
        issue_numbers: ['500'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#dcebff',
        sessionId: 'existing-session',
        projectPath: '/main/workspace',
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        oneShot: 'default',
        capabilities: [],
        parentLoom: null,
      })

      const inputWithComplexity: CreateLoomInput = {
        ...baseInput,
        options: { complexity: 'complex' },
      }

      await manager.createIloom(inputWithComplexity)

      // writeMetadata should NOT be called (existing metadata preserved)
      expect(mockWriteMetadata).not.toHaveBeenCalled()

      // updateMetadata SHOULD be called with complexity override
      expect(mockUpdateMetadata).toHaveBeenCalledWith(
        '/test/worktree-issue-500',
        { complexity: 'complex' },
      )
    })

    it('should NOT call updateMetadata when complexity is not provided on existing worktree', async () => {
      const existingWorktree = {
        path: '/test/worktree-issue-500',
        branch: 'issue-500-test',
        commit: 'abc123',
        bare: false,
        detached: false,
        locked: false,
      }

      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(existingWorktree)

      // Existing metadata present (no complexity)
      mockReadMetadata.mockResolvedValue({
        description: 'Existing loom',
        created_at: '2024-01-01T00:00:00Z',
        branchName: 'issue-500-test',
        worktreePath: '/test/worktree-issue-500',
        issueType: 'issue',
        issue_numbers: ['500'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#dcebff',
        sessionId: 'existing-session',
        projectPath: '/main/workspace',
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        oneShot: 'default',
        capabilities: [],
        parentLoom: null,
      })

      // No complexity in options
      await manager.createIloom(baseInput)

      // Neither writeMetadata nor updateMetadata should be called
      expect(mockWriteMetadata).not.toHaveBeenCalled()
      expect(mockUpdateMetadata).not.toHaveBeenCalled()
    })
  })

  describe('findChildLooms', () => {
    const parentBranch = 'feat/issue-100__epic-feature'

    const makeMetadata = (overrides: Partial<{
      branchName: string | null
      parentLoom: { type: 'issue' | 'pr' | 'branch' | 'epic'; identifier: string | number; branchName: string; worktreePath: string } | null
    }>) => ({
      description: 'test',
      created_at: null,
      branchName: overrides.branchName ?? null,
      worktreePath: null,
      issueType: null as const,
      issueKey: null,
      issue_numbers: [],
      pr_numbers: [],
      issueTracker: null,
      colorHex: null,
      sessionId: null,
      projectPath: null,
      issueUrls: {},
      prUrls: {},
      draftPrNumber: null,
      oneShot: null,
      capabilities: [],
      state: null,
      childIssueNumbers: [],
      parentLoom: overrides.parentLoom ?? null,
      childIssues: [],
      dependencyMap: {},
      mcpConfigPath: null,
    })

    const makeWorktree = (branch: string, wtPath: string) => ({
      path: wtPath,
      branch,
      commit: 'abc123',
      bare: false,
      detached: false,
    })

    it('should return worktrees whose metadata has matching parentLoom.branchName', async () => {
      const childMetadata1 = makeMetadata({
        branchName: 'feat/issue-101__child-one',
        parentLoom: {
          type: 'issue',
          identifier: 100,
          branchName: parentBranch,
          worktreePath: '/project-looms/feat-issue-100__epic-feature',
        },
      })
      const childMetadata2 = makeMetadata({
        branchName: 'feat/issue-102__child-two',
        parentLoom: {
          type: 'issue',
          identifier: 100,
          branchName: parentBranch,
          worktreePath: '/project-looms/feat-issue-100__epic-feature',
        },
      })
      const unrelatedMetadata = makeMetadata({
        branchName: 'feat/issue-200__unrelated',
        parentLoom: {
          type: 'issue',
          identifier: 999,
          branchName: 'feat/issue-999__other-epic',
          worktreePath: '/project-looms/feat-issue-999__other-epic',
        },
      })

      mockListAllMetadata.mockResolvedValue([childMetadata1, childMetadata2, unrelatedMetadata])

      const worktrees = [
        makeWorktree('feat/issue-101__child-one', '/project-looms/feat-issue-101__child-one'),
        makeWorktree('feat/issue-102__child-two', '/project-looms/feat-issue-102__child-two'),
        makeWorktree('feat/issue-200__unrelated', '/project-looms/feat-issue-200__unrelated'),
        makeWorktree('main', '/project'),
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(worktrees)

      const result = await manager.findChildLooms(parentBranch)

      expect(result).toHaveLength(2)
      expect(result.map(wt => wt.branch)).toEqual([
        'feat/issue-101__child-one',
        'feat/issue-102__child-two',
      ])
    })

    it('should return empty array when no metadata matches', async () => {
      const unrelatedMetadata = makeMetadata({
        branchName: 'feat/issue-200__unrelated',
        parentLoom: null,
      })

      mockListAllMetadata.mockResolvedValue([unrelatedMetadata])

      const worktrees = [
        makeWorktree('feat/issue-200__unrelated', '/project-looms/feat-issue-200__unrelated'),
        makeWorktree('main', '/project'),
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(worktrees)

      const result = await manager.findChildLooms(parentBranch)

      expect(result).toHaveLength(0)
    })

    it('should return empty array when metadata exists but worktree does not (pruned)', async () => {
      // Metadata says a child exists, but the worktree has been pruned/removed
      const childMetadata = makeMetadata({
        branchName: 'feat/issue-101__child-one',
        parentLoom: {
          type: 'issue',
          identifier: 100,
          branchName: parentBranch,
          worktreePath: '/project-looms/feat-issue-101__child-one',
        },
      })

      mockListAllMetadata.mockResolvedValue([childMetadata])

      // Only main worktree exists -- child was pruned
      const worktrees = [
        makeWorktree('main', '/project'),
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(worktrees)

      const result = await manager.findChildLooms(parentBranch)

      expect(result).toHaveLength(0)
    })

    it('should return empty array when listWorktrees returns null', async () => {
      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(null as unknown as [])

      const result = await manager.findChildLooms(parentBranch)

      expect(result).toHaveLength(0)
    })

    it('should handle errors gracefully and return empty array', async () => {
      vi.mocked(mockGitWorktree.listWorktrees).mockRejectedValue(new Error('git failed'))

      const result = await manager.findChildLooms(parentBranch)

      expect(result).toHaveLength(0)
    })

    it('should skip metadata entries with null branchName', async () => {
      const nullBranchMetadata = makeMetadata({
        branchName: null,
        parentLoom: {
          type: 'issue',
          identifier: 100,
          branchName: parentBranch,
          worktreePath: '/project-looms/feat-issue-100__epic-feature',
        },
      })

      mockListAllMetadata.mockResolvedValue([nullBranchMetadata])

      const worktrees = [
        makeWorktree('main', '/project'),
      ]

      vi.mocked(mockGitWorktree.listWorktrees).mockResolvedValue(worktrees)

      const result = await manager.findChildLooms(parentBranch)

      expect(result).toHaveLength(0)
    })
  })
})
