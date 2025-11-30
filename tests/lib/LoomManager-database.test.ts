import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LoomManager } from '../../src/lib/LoomManager.js'
import { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import { GitHubService } from '../../src/lib/GitHubService.js'
import { EnvironmentManager } from '../../src/lib/EnvironmentManager.js'
import { ClaudeContextManager } from '../../src/lib/ClaudeContextManager.js'
import { ProjectCapabilityDetector } from '../../src/lib/ProjectCapabilityDetector.js'
import { CLIIsolationManager } from '../../src/lib/CLIIsolationManager.js'
import { SettingsManager } from '../../src/lib/SettingsManager.js'
import { DatabaseManager } from '../../src/lib/DatabaseManager.js'
import type { CreateLoomInput } from '../../src/types/loom.js'
import { createMockDatabaseManager } from '../mocks/MockDatabaseProvider.js'

// Mock all dependencies
vi.mock('../../src/lib/GitWorktreeManager.js')
vi.mock('../../src/lib/GitHubService.js')
vi.mock('../../src/lib/EnvironmentManager.js')
vi.mock('../../src/lib/ClaudeContextManager.js')
vi.mock('../../src/lib/ProjectCapabilityDetector.js')
vi.mock('../../src/lib/CLIIsolationManager.js')
vi.mock('../../src/lib/SettingsManager.js')

// Mock branchExists utility
vi.mock('../../src/utils/git.js', () => ({
  branchExists: vi.fn().mockResolvedValue(false),
  executeGitCommand: vi.fn().mockResolvedValue(''),
  ensureRepositoryHasCommits: vi.fn().mockResolvedValue(undefined),
  isEmptyRepository: vi.fn().mockResolvedValue(false),
}))

// Mock package-manager utilities
vi.mock('../../src/utils/package-manager.js', () => ({
  installDependencies: vi.fn().mockResolvedValue(undefined),
}))

// Mock LoomLauncher (dynamically imported)
vi.mock('../../src/lib/LoomLauncher.js', () => ({
  LoomLauncher: vi.fn(() => ({
    launchLoom: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Mock vscode utils (dynamically imported)
vi.mock('../../src/utils/vscode.js', () => ({
  openVSCodeWindow: vi.fn().mockResolvedValue(undefined),
}))

describe('LoomManager - Database Integration', () => {
  let manager: LoomManager
  let mockGitWorktree: vi.Mocked<GitWorktreeManager>
  let mockGitHub: vi.Mocked<GitHubService>
  let mockEnvironment: vi.Mocked<EnvironmentManager>
  let mockClaude: vi.Mocked<ClaudeContextManager>
  let mockCapabilityDetector: vi.Mocked<ProjectCapabilityDetector>
  let mockCLIIsolation: vi.Mocked<CLIIsolationManager>
  let mockSettings: vi.Mocked<SettingsManager>
  let mockDatabase: DatabaseManager

  beforeEach(() => {
    mockGitWorktree = new GitWorktreeManager() as vi.Mocked<GitWorktreeManager>
    mockGitHub = new GitHubService() as vi.Mocked<GitHubService>
    mockEnvironment = new EnvironmentManager() as vi.Mocked<EnvironmentManager>
    mockClaude = new ClaudeContextManager() as vi.Mocked<ClaudeContextManager>
    mockCapabilityDetector = new ProjectCapabilityDetector() as vi.Mocked<ProjectCapabilityDetector>
    mockCLIIsolation = new CLIIsolationManager() as vi.Mocked<CLIIsolationManager>
    mockSettings = new SettingsManager() as vi.Mocked<SettingsManager>

    // Create mock database manager with default behavior
    mockDatabase = createMockDatabaseManager()

    manager = new LoomManager(
      mockGitWorktree,
      mockGitHub,
      mockEnvironment,
      mockClaude,
      mockCapabilityDetector,
      mockCLIIsolation,
      mockSettings,
      mockDatabase
    )

    // Default mock for capability detector (web-only) - can be overridden in tests
    vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue({
      capabilities: ['web'],
      binEntries: {},
    })

    // Default mock for settings - returns empty settings (uses default basePort 3000)
    vi.mocked(mockSettings.loadSettings).mockResolvedValue({})

    // Default mock for calculatePort and setEnvVar - setupEnvironment now calls these directly
    vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)
    vi.mocked(mockEnvironment.setEnvVar).mockResolvedValue()

    // Set IssueTracker interface properties
    mockGitHub.supportsPullRequests = true
    mockGitHub.providerName = 'github'

    vi.clearAllMocks()
  })

  describe('createIloom with database branching', () => {
    const baseInput: CreateLoomInput = {
      type: 'issue',
      identifier: 123,
      originalInput: '123',
    }

    it('should create database branch and update .env when configured', async () => {
      // GIVEN: Valid NEON configuration and DATABASE_URL in .env
      const connectionString = 'postgresql://neon-branch-connection-string'
      mockDatabase.createBranchIfConfigured = vi.fn().mockResolvedValue(connectionString)
      mockDatabase.getConfiguredVariableName = vi.fn().mockReturnValue('DATABASE_URL')

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
      vi.mocked(mockGitHub.generateBranchName).mockResolvedValue('issue-123-test')

      // Mock worktree creation
      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      // Mock environment setup
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockEnvironment.setEnvVar).mockResolvedValue()

      // Mock Claude launch with context
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      // WHEN: createIloom is called
      const result = await manager.createIloom(baseInput)

      // THEN: DatabaseManager.createBranchIfConfigured is called with correct branch name and env path
      expect(mockDatabase.createBranchIfConfigured).toHaveBeenCalledWith(
        'issue-123-test',
        `${expectedPath}/.env`,
        undefined, // cwd
        undefined  // fromBranch (no parent loom)
      )

      // THEN: Connection string is written to .env via EnvironmentManager.setEnvVar
      expect(mockEnvironment.setEnvVar).toHaveBeenCalledWith(
        `${expectedPath}/.env`,
        'DATABASE_URL',
        connectionString
      )

      // THEN: loom metadata includes databaseBranch property
      expect(result.databaseBranch).toBe('issue-123-test')
    })

    it('should skip database setup when DatabaseManager returns null', async () => {
      // GIVEN: No NEON configuration (DatabaseManager returns null)
      mockDatabase.createBranchIfConfigured = vi.fn().mockResolvedValue(null)

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })
      vi.mocked(mockGitHub.generateBranchName).mockResolvedValue('issue-123-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      // WHEN: createIloom is called
      const result = await manager.createIloom(baseInput)

      // THEN: No error is thrown
      expect(result).toBeDefined()

      // THEN: EnvironmentManager.setEnvVar is not called for DATABASE_URL
      expect(mockEnvironment.setEnvVar).not.toHaveBeenCalledWith(
        expect.anything(),
        'DATABASE_URL',
        expect.anything()
      )

      // THEN: loom metadata does not include databaseBranch property
      expect(result.databaseBranch).toBeUndefined()
    })

    it('should skip database setup when skipDatabase option is true', async () => {
      // GIVEN: Valid NEON configuration but skipDatabase option is true
      const inputWithSkipDatabase: CreateLoomInput = {
        ...baseInput,
        options: { skipDatabase: true },
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
      vi.mocked(mockGitHub.generateBranchName).mockResolvedValue('issue-123-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      // WHEN: createIloom is called with skipDatabase option
      await manager.createIloom(inputWithSkipDatabase)

      // THEN: DatabaseManager.createBranchIfConfigured is not called
      expect(mockDatabase.createBranchIfConfigured).not.toHaveBeenCalled()
    })

    it('should throw error when database branch creation fails', async () => {
      // GIVEN: DatabaseManager.createBranchIfConfigured throws error
      const dbError = new Error('Failed to create Neon database branch')
      mockDatabase.createBranchIfConfigured = vi.fn().mockRejectedValue(dbError)

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })
      vi.mocked(mockGitHub.generateBranchName).mockResolvedValue('issue-123-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

      // WHEN/THEN: createIloom is called and error propagates
      await expect(manager.createIloom(baseInput)).rejects.toThrow(
        'Failed to create Neon database branch'
      )
    })

    it('should handle .env update failures gracefully', async () => {
      // GIVEN: DatabaseManager returns connection string but EnvironmentManager.setEnvVar throws
      const connectionString = 'postgresql://neon-branch-connection-string'
      mockDatabase.createBranchIfConfigured = vi.fn().mockResolvedValue(connectionString)
      mockDatabase.getConfiguredVariableName = vi.fn().mockReturnValue('DATABASE_URL')

      const envError = new Error('Failed to write to .env file')
      vi.mocked(mockEnvironment.setEnvVar).mockRejectedValue(envError)

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })
      vi.mocked(mockGitHub.generateBranchName).mockResolvedValue('issue-123-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)

      // WHEN/THEN: createIloom is called and error propagates with clear message
      await expect(manager.createIloom(baseInput)).rejects.toThrow(
        'Failed to write to .env file'
      )
    })

    it('should work with DatabaseManager when not provided (optional parameter)', async () => {
      // GIVEN: LoomManager created without DatabaseManager
      const managerWithoutDb = new LoomManager(
        mockGitWorktree,
        mockGitHub,
        mockEnvironment,
        mockClaude,
        mockCapabilityDetector,
        mockCLIIsolation,
        mockSettings
        // No database parameter
      )

      vi.mocked(mockGitHub.fetchIssue).mockResolvedValue({
        number: 123,
        title: 'Test',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        url: 'https://github.com/owner/repo/issues/123',
      })
      vi.mocked(mockGitHub.generateBranchName).mockResolvedValue('issue-123-test')
      vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValue(null)

      const expectedPath = '/test/worktree-issue-123'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3123)
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      // WHEN: createIloom is called
      const result = await managerWithoutDb.createIloom(baseInput)

      // THEN: No error is thrown and loom is created without database branch
      expect(result).toBeDefined()
      expect(result.databaseBranch).toBeUndefined()
    })
  })

  describe('reuseIloom with database branching', () => {
    it('should not create new database branch when reusing worktree', async () => {
      // GIVEN: Existing worktree with database already configured
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

      // WHEN: createIloom is called for existing worktree
      await manager.createIloom(input)

      // THEN: DatabaseManager.createBranchIfConfigured is not called
      expect(mockDatabase.createBranchIfConfigured).not.toHaveBeenCalled()
    })
  })

  describe('database branching for different loom types', () => {
    it('should create database branch for PR loom', async () => {
      const prInput: CreateLoomInput = {
        type: 'pr',
        identifier: 456,
        originalInput: 'pr/456',
      }

      const connectionString = 'postgresql://neon-pr-connection-string'
      mockDatabase.createBranchIfConfigured = vi.fn().mockResolvedValue(connectionString)
      mockDatabase.getConfiguredVariableName = vi.fn().mockReturnValue('DATABASE_URL')

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
      vi.mocked(mockGitWorktree.findWorktreeForPR).mockResolvedValue(null)

      const expectedPath = '/test/worktree-feature-branch'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3456)
      vi.mocked(mockEnvironment.setEnvVar).mockResolvedValue()
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      const result = await manager.createIloom(prInput)

      expect(mockDatabase.createBranchIfConfigured).toHaveBeenCalledWith(
        'feature-branch',
        `${expectedPath}/.env`,
        undefined, // cwd
        undefined  // fromBranch (no parent loom)
      )
      expect(mockEnvironment.setEnvVar).toHaveBeenCalledWith(
        `${expectedPath}/.env`,
        'DATABASE_URL',
        connectionString
      )
      expect(result.databaseBranch).toBe('feature-branch')
    })

    it('should create database branch for branch loom', async () => {
      const branchInput: CreateLoomInput = {
        type: 'branch',
        identifier: 'feature-xyz',
        originalInput: 'feature-xyz',
      }

      const connectionString = 'postgresql://neon-branch-connection-string'
      mockDatabase.createBranchIfConfigured = vi.fn().mockResolvedValue(connectionString)
      mockDatabase.getConfiguredVariableName = vi.fn().mockReturnValue('DATABASE_URL')

      const expectedPath = '/test/worktree-feature-xyz'
      vi.mocked(mockGitWorktree.generateWorktreePath).mockReturnValue(expectedPath)
      vi.mocked(mockGitWorktree.createWorktree).mockResolvedValue(expectedPath)
      vi.mocked(mockEnvironment.calculatePort).mockReturnValue(3000)
      vi.mocked(mockEnvironment.setEnvVar).mockResolvedValue()
      vi.mocked(mockClaude.launchWithContext).mockResolvedValue()

      const result = await manager.createIloom(branchInput)

      expect(mockDatabase.createBranchIfConfigured).toHaveBeenCalledWith(
        'feature-xyz',
        `${expectedPath}/.env`,
        undefined, // cwd
        undefined  // fromBranch (no parent loom)
      )
      expect(mockEnvironment.setEnvVar).toHaveBeenCalledWith(
        `${expectedPath}/.env`,
        'DATABASE_URL',
        connectionString
      )
      expect(result.databaseBranch).toBe('feature-xyz')
    })
  })
})
