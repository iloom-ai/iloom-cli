import { describe, it, expect, beforeEach, vi } from 'vitest'
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
import { branchExists, ensureRepositoryHasCommits } from '../utils/git.js'

// Mock all dependencies
vi.mock('./GitWorktreeManager.js')
vi.mock('./GitHubService.js')
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

// Mock branchExists utility
vi.mock('../utils/git.js', () => ({
  branchExists: vi.fn().mockResolvedValue(false),
  executeGitCommand: vi.fn().mockResolvedValue(''),
  ensureRepositoryHasCommits: vi.fn().mockResolvedValue(undefined),
  isEmptyRepository: vi.fn().mockResolvedValue(false),
}))

// Mock package-manager utilities
vi.mock('../utils/package-manager.js', () => ({
  installDependencies: vi.fn().mockResolvedValue(undefined),
}))

// Mock LoomLauncher (dynamically imported)
vi.mock('./LoomLauncher.js', () => ({
  LoomLauncher: vi.fn(() => ({
    launchLoom: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Mock vscode utils (dynamically imported)
vi.mock('../utils/vscode.js', () => ({
  openVSCodeWindow: vi.fn().mockResolvedValue(undefined),
}))

describe('LoomManager', () => {
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
    vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-123-test-branch')

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

      // Verify installDependencies was called with the correct path
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true)
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

      // Verify installDependencies was called with the correct path
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true)
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

      // Verify installDependencies was called with the correct path
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true)
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
      expect(installDependencies).toHaveBeenCalledWith(expectedPath, true)

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
      expect(branchExists).toHaveBeenCalledWith('pr-branch')
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
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-165-empty-repo')
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
      vi.mocked(mockBranchNaming.generateBranchName).mockResolvedValue('feat/issue-166-with-commits')
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
})
