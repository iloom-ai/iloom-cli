import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseManager } from '../../src/lib/DatabaseManager.js'
import type { DatabaseProvider } from '../../src/types/index.js'
import { EnvironmentManager } from '../../src/lib/EnvironmentManager.js'

// Mock the logger
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  })),
}))

describe('DatabaseManager', () => {
  let databaseManager: DatabaseManager
  let mockProvider: DatabaseProvider
  let mockEnvironment: EnvironmentManager

  beforeEach(() => {
    // Create mock provider
    mockProvider = {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      isConfigured: vi.fn().mockReturnValue(true),
      createBranch: vi.fn().mockResolvedValue('postgresql://test-connection-string'),
      deleteBranch: vi.fn().mockResolvedValue({
        success: true,
        deleted: true,
        notFound: false,
        branchName: 'test-branch'
      }),
      sanitizeBranchName: vi.fn((name: string) => name.replace(/\//g, '_')),
      branchExists: vi.fn().mockResolvedValue(false),
      listBranches: vi.fn().mockResolvedValue([]),
      getConnectionString: vi.fn().mockResolvedValue('postgresql://test-connection'),
      findPreviewBranch: vi.fn().mockResolvedValue(null),
      getBranchNameFromEndpoint: vi.fn().mockResolvedValue(null),
    }

    // Create mock environment
    mockEnvironment = {
      readEnvFile: vi.fn().mockResolvedValue(new Map([['DATABASE_URL', 'postgresql://localhost/test']])),
      writeEnvFile: vi.fn().mockResolvedValue(undefined),
      updateEnvValue: vi.fn().mockResolvedValue(undefined),
      removeEnvValue: vi.fn().mockResolvedValue(undefined),
    } as unknown as EnvironmentManager

    // Create DatabaseManager instance
    databaseManager = new DatabaseManager(mockProvider, mockEnvironment)

    vi.clearAllMocks()
  })

  describe('shouldUseDatabaseBranching', () => {
    it('should return true when provider is configured and DATABASE_URL is present', async () => {
      // Mock provider as configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)

      // Mock .env file with DATABASE_URL
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )

      const result = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(true)
      expect(mockEnvironment.readEnvFile).toHaveBeenCalledWith('/path/to/.env')
    })

    it('should return true when provider is configured and custom database variable is present', async () => {
      // Mock provider as configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)

      // Create DatabaseManager with custom variable name
      const customDbManager = new DatabaseManager(mockProvider, mockEnvironment, 'POSTGRES_URL')

      // Mock .env file with custom variable
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['POSTGRES_URL', 'postgresql://localhost/test']])
      )

      const result = await customDbManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(true)
    })

    it('should return false when provider is not configured', async () => {
      // Mock provider as not configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

      // Mock .env file with DATABASE_URL (shouldn't be checked)
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )

      const result = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(false)
      // Should not check .env file if provider not configured
      expect(mockEnvironment.readEnvFile).not.toHaveBeenCalled()
    })

    it('should return false when configured database URL variable is missing from .env', async () => {
      // Mock provider as configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)

      // Mock .env file without DATABASE_URL
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['OTHER_VAR', 'some-value']])
      )

      const result = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(false)
      expect(mockEnvironment.readEnvFile).toHaveBeenCalledWith('/path/to/.env')
    })

    it('should return false when .env file cannot be read', async () => {
      // Mock provider as configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)

      // Mock .env file read failure
      vi.mocked(mockEnvironment.readEnvFile).mockRejectedValue(new Error('File not found'))

      const result = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(false)
    })
  })

  describe('getConfiguredVariableName', () => {
    it('should return default DATABASE_URL when no custom name provided', () => {
      const databaseManager = new DatabaseManager(mockProvider, mockEnvironment)

      expect(databaseManager.getConfiguredVariableName()).toBe('DATABASE_URL')
    })

    it('should return custom variable name when provided', () => {
      const databaseManager = new DatabaseManager(mockProvider, mockEnvironment, 'POSTGRES_URL')

      expect(databaseManager.getConfiguredVariableName()).toBe('POSTGRES_URL')
    })

    it('should return custom variable name for DATABASE_URI', () => {
      const databaseManager = new DatabaseManager(mockProvider, mockEnvironment, 'DATABASE_URI')

      expect(databaseManager.getConfiguredVariableName()).toBe('DATABASE_URI')
    })
  })

  describe('createBranchIfConfigured', () => {
    beforeEach(() => {
      // Set up valid configuration by default
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )
    })

    it('should return null when database branching not configured', async () => {
      // Mock provider as not configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

      const result = await databaseManager.createBranchIfConfigured('feature-branch', '/path/to/.env')

      expect(result).toBe(null)
      expect(mockProvider.createBranch).not.toHaveBeenCalled()
    })

    it('should return null when CLI not available', async () => {
      vi.mocked(mockProvider.isCliAvailable).mockResolvedValue(false)

      const result = await databaseManager.createBranchIfConfigured('feature-branch', '/path/to/.env')

      expect(result).toBe(null)
      expect(mockProvider.createBranch).not.toHaveBeenCalled()
    })

    it('should return null when not authenticated', async () => {
      vi.mocked(mockProvider.isAuthenticated).mockResolvedValue(false)

      const result = await databaseManager.createBranchIfConfigured('feature-branch', '/path/to/.env')

      expect(result).toBe(null)
      expect(mockProvider.createBranch).not.toHaveBeenCalled()
    })

    it('should create branch and return connection string when fully configured', async () => {
      const connectionString = 'postgresql://test-connection-string'
      vi.mocked(mockProvider.createBranch).mockResolvedValue(connectionString)

      const result = await databaseManager.createBranchIfConfigured('feature-branch', '/path/to/.env')

      expect(result).toBe(connectionString)
      expect(mockProvider.isCliAvailable).toHaveBeenCalled()
      expect(mockProvider.isAuthenticated).toHaveBeenCalled()
      expect(mockProvider.createBranch).toHaveBeenCalledWith('feature-branch', undefined, undefined)
      expect(mockProvider.sanitizeBranchName).toHaveBeenCalledWith('feature-branch')
    })

    it('should throw error when branch creation fails', async () => {
      const error = new Error('Failed to create branch')
      vi.mocked(mockProvider.createBranch).mockRejectedValue(error)

      await expect(
        databaseManager.createBranchIfConfigured('feature-branch', '/path/to/.env')
      ).rejects.toThrow('Failed to create branch')
    })

    it('should handle non-Error exceptions', async () => {
      vi.mocked(mockProvider.createBranch).mockRejectedValue('String error')

      await expect(
        databaseManager.createBranchIfConfigured('feature-branch', '/path/to/.env')
      ).rejects.toBe('String error')
    })
  })

  describe('deleteBranchIfConfigured', () => {
    beforeEach(() => {
      // Set up valid configuration by default
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )
    })

    it('should return early when database branching not configured', async () => {
      // Mock provider as not configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

      // Pre-fetched config says shouldCleanup = true, but provider not configured
      await databaseManager.deleteBranchIfConfigured('feature-branch', true)

      expect(mockProvider.deleteBranch).not.toHaveBeenCalled()
    })

    it('should return early when CLI not available', async () => {
      vi.mocked(mockProvider.isCliAvailable).mockResolvedValue(false)

      await databaseManager.deleteBranchIfConfigured('feature-branch', true)

      expect(mockProvider.deleteBranch).not.toHaveBeenCalled()
    })

    it('should return early when not authenticated', async () => {
      vi.mocked(mockProvider.isAuthenticated).mockResolvedValue(false)

      await databaseManager.deleteBranchIfConfigured('feature-branch', true)

      expect(mockProvider.deleteBranch).not.toHaveBeenCalled()
    })

    it('should delete branch when fully configured', async () => {
      await databaseManager.deleteBranchIfConfigured('feature-branch', true)

      expect(mockProvider.isCliAvailable).toHaveBeenCalled()
      expect(mockProvider.isAuthenticated).toHaveBeenCalled()
      expect(mockProvider.deleteBranch).toHaveBeenCalledWith('feature-branch', false, undefined)
    })

    it('should pass isPreview flag to provider', async () => {
      await databaseManager.deleteBranchIfConfigured('feature-branch', true, true)

      expect(mockProvider.deleteBranch).toHaveBeenCalledWith('feature-branch', true, undefined)
    })

    it('should return error result when deletion fails', async () => {
      const error = new Error('Failed to delete branch')
      vi.mocked(mockProvider.deleteBranch).mockRejectedValue(error)

      // Should return error result object, not throw
      const result = await databaseManager.deleteBranchIfConfigured('feature-branch', true)

      expect(result).toEqual({
        success: false,
        deleted: false,
        notFound: false,
        error: 'Failed to delete branch',
        branchName: 'feature-branch'
      })
      expect(mockProvider.deleteBranch).toHaveBeenCalled()
    })

    it('should handle non-Error exceptions during deletion', async () => {
      vi.mocked(mockProvider.deleteBranch).mockRejectedValue('String error')

      // Should return error result object, not throw
      const result = await databaseManager.deleteBranchIfConfigured('feature-branch', true)

      expect(result).toEqual({
        success: false,
        deleted: false,
        notFound: false,
        error: 'String error',
        branchName: 'feature-branch'
      })
    })

    describe('with pre-fetched shouldCleanup parameter', () => {
      it('should delete branch when shouldCleanup = true without reading env file', async () => {
        // GIVEN: shouldCleanup = true passed directly
        // WHEN: deleteBranchIfConfigured called with shouldCleanup = true
        await databaseManager.deleteBranchIfConfigured('feature-branch', true)

        // THEN: Provider deletion called without env file read
        expect(mockEnvironment.readEnvFile).not.toHaveBeenCalled()
        expect(mockProvider.isCliAvailable).toHaveBeenCalled()
        expect(mockProvider.isAuthenticated).toHaveBeenCalled()
        expect(mockProvider.deleteBranch).toHaveBeenCalledWith('feature-branch', false, undefined)
      })

      it('should skip deletion when shouldCleanup = false', async () => {
        // GIVEN: shouldCleanup = false passed directly
        // WHEN: deleteBranchIfConfigured called
        const result = await databaseManager.deleteBranchIfConfigured('feature-branch', false)

        // THEN: Returns early with notFound result
        expect(result).toEqual({
          success: true,
          deleted: false,
          notFound: true,
          branchName: 'feature-branch'
        })

        // THEN: No provider methods called
        expect(mockEnvironment.readEnvFile).not.toHaveBeenCalled()
        expect(mockProvider.isCliAvailable).not.toHaveBeenCalled()
        expect(mockProvider.deleteBranch).not.toHaveBeenCalled()
      })

      it('should check provider configuration when shouldCleanup = true but provider not configured', async () => {
        // GIVEN: shouldCleanup = true
        // GIVEN: Provider.isConfigured() = false
        vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

        // WHEN: deleteBranchIfConfigured called
        const result = await databaseManager.deleteBranchIfConfigured('feature-branch', true)

        // THEN: Returns early with notFound result
        expect(result).toEqual({
          success: true,
          deleted: false,
          notFound: true,
          branchName: 'feature-branch'
        })

        // THEN: No deletion attempted
        expect(mockProvider.deleteBranch).not.toHaveBeenCalled()
      })

      it('should handle CLI not available when shouldCleanup = true', async () => {
        // GIVEN: shouldCleanup = true
        // GIVEN: CLI not available
        vi.mocked(mockProvider.isCliAvailable).mockResolvedValue(false)

        // WHEN: deleteBranchIfConfigured called
        const result = await databaseManager.deleteBranchIfConfigured('feature-branch', true)

        // THEN: Returns error result
        expect(result).toEqual({
          success: false,
          deleted: false,
          notFound: true,
          error: 'CLI tool not available',
          branchName: 'feature-branch'
        })
      })

      it('should handle not authenticated when shouldCleanup = true', async () => {
        // GIVEN: shouldCleanup = true
        // GIVEN: Not authenticated
        vi.mocked(mockProvider.isAuthenticated).mockResolvedValue(false)

        // WHEN: deleteBranchIfConfigured called
        const result = await databaseManager.deleteBranchIfConfigured('feature-branch', true)

        // THEN: Returns error result
        expect(result).toEqual({
          success: false,
          deleted: false,
          notFound: false,
          error: 'Not authenticated with DB Provider',
          branchName: 'feature-branch'
        })
      })

      it('should pass isPreview flag with shouldCleanup = true', async () => {
        // GIVEN: shouldCleanup = true and isPreview = true
        // WHEN: deleteBranchIfConfigured called
        await databaseManager.deleteBranchIfConfigured('feature-branch', true, true)

        // THEN: Provider called with isPreview flag
        expect(mockProvider.deleteBranch).toHaveBeenCalledWith('feature-branch', true, undefined)
      })
    })
  })

  describe('private methods behavior verification', () => {
    it('should verify configuration behavior through public methods', async () => {
      // Test when provider is configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )

      const result1 = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')
      expect(result1).toBe(true)

      // Test when provider is not configured
      vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

      const result2 = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')
      expect(result2).toBe(false)
    })

    it('should verify hasDatabaseUrlInEnv behavior through public methods', async () => {
      // Mock provider as configured for all tests
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)

      // Test with DATABASE_URL
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )
      expect(await databaseManager.shouldUseDatabaseBranching('/path/to/.env')).toBe(true)

      // Test with custom variable name
      const customDbManager = new DatabaseManager(mockProvider, mockEnvironment, 'POSTGRES_URL')
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['POSTGRES_URL', 'postgresql://localhost/test']])
      )
      expect(await customDbManager.shouldUseDatabaseBranching('/path/to/.env')).toBe(true)

      // Test with neither
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['OTHER_VAR', 'some-value']])
      )
      expect(await databaseManager.shouldUseDatabaseBranching('/path/to/.env')).toBe(false)

      // Test with read error
      vi.mocked(mockEnvironment.readEnvFile).mockRejectedValue(new Error('File not found'))
      expect(await databaseManager.shouldUseDatabaseBranching('/path/to/.env')).toBe(false)
    })
  })

  describe('edge cases and integration scenarios', () => {
    it('should handle provider not configured due to invalid config', async () => {
      // Mock provider as not configured (e.g., empty projectId)
      vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

      const result = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(false)
    })

    it('should handle provider not configured due to missing config', async () => {
      // Mock provider as not configured (e.g., missing parentBranch)
      vi.mocked(mockProvider.isConfigured).mockReturnValue(false)

      const result = await databaseManager.shouldUseDatabaseBranching('/path/to/.env')

      expect(result).toBe(false)
    })

    it('should work with different .env file paths', async () => {
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )

      await databaseManager.createBranchIfConfigured('feature-branch', '/different/path/.env')

      expect(mockEnvironment.readEnvFile).toHaveBeenCalledWith('/different/path/.env')
    })

    it('should handle branch names with special characters', async () => {
      vi.mocked(mockProvider.isConfigured).mockReturnValue(true)
      vi.mocked(mockEnvironment.readEnvFile).mockResolvedValue(
        new Map([['DATABASE_URL', 'postgresql://localhost/test']])
      )

      const branchName = 'feature/issue-123/fix'
      await databaseManager.createBranchIfConfigured(branchName, '/path/to/.env')

      expect(mockProvider.createBranch).toHaveBeenCalledWith(branchName, undefined, undefined)
      expect(mockProvider.sanitizeBranchName).toHaveBeenCalledWith(branchName)
    })
  })
})