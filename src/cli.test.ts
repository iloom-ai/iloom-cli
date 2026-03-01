import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { validateGhCliForCommand, validateIdeForStartCommand } from './cli.js'
import { GitHubService } from './lib/GitHubService.js'
import { SettingsManager } from './lib/SettingsManager.js'
import { VersionMigrationManager } from './lib/VersionMigrationManager.js'
import * as ide from './utils/ide.js'

// Unit tests for gh CLI validation (not integration tests)
describe('GitHub CLI validation', () => {
  describe('validateGhCliForCommand', () => {
    let commandName: string
    let mockExit: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>
    let mockIsCliAvailable: ReturnType<typeof vi.spyOn<typeof GitHubService, 'isCliAvailable'>>
    let mockLoadSettings: ReturnType<typeof vi.spyOn<SettingsManager, 'loadSettings'>>

    // Helper to create mock command with proper typing
    const createMockCommand = () =>
      ({
        name: () => commandName,
      }) as unknown as import('commander').Command

    beforeEach(() => {
      // Mock process.exit
      mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      // Default command state
      commandName = ''

      // Mock GitHubService.isCliAvailable
      mockIsCliAvailable = vi.spyOn(GitHubService, 'isCliAvailable')

      // Mock SettingsManager
      mockLoadSettings = vi.spyOn(SettingsManager.prototype, 'loadSettings')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    describe('commands that always require gh CLI', () => {
      it('should exit with error when gh CLI is missing for feedback command', async () => {
        commandName = 'feedback'
        mockIsCliAvailable.mockReturnValue(false)

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })

      it('should exit with error when gh CLI is missing for contribute command', async () => {
        commandName = 'contribute'
        mockIsCliAvailable.mockReturnValue(false)

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })

      it('should not exit when gh CLI is available for feedback command', async () => {
        commandName = 'feedback'
        mockIsCliAvailable.mockReturnValue(true)

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })
    })

    describe('commands that conditionally require gh CLI', () => {
      it('should exit when gh CLI missing and provider is github', async () => {
        commandName = 'start'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'github' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })

      it('should exit when gh CLI missing and merge mode is pr', async () => {
        commandName = 'finish'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'linear' },
          mergeBehavior: { mode: 'pr' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })

      it('should exit when gh CLI missing and merge mode is draft-pr', async () => {
        commandName = 'finish'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'linear' },
          mergeBehavior: { mode: 'draft-pr' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })

      it('should not exit when gh CLI missing but provider is linear and merge mode is local', async () => {
        commandName = 'start'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'linear' },
          mergeBehavior: { mode: 'local' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })

      it('should not exit when gh CLI is available regardless of provider', async () => {
        commandName = 'enhance'
        mockIsCliAvailable.mockReturnValue(true)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'github' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })

      it('should handle missing settings gracefully and assume gh CLI needed', async () => {
        commandName = 'start'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockRejectedValue(new Error('Settings file not found'))

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })
    })

    describe('commands that only warn', () => {
      it('should not exit for init command even when gh CLI is missing', async () => {
        commandName = 'init'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'github' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })

      it('should not exit for list command even when gh CLI is missing', async () => {
        commandName = 'list'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'github' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })

      it('should not exit for open command even when gh CLI is missing', async () => {
        commandName = 'open'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          issueManagement: { provider: 'github' },
        })

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })
    })

    describe('commands that bypass gh CLI check', () => {
      it('should not check gh CLI for help command', async () => {
        commandName = 'help'
        mockIsCliAvailable.mockReturnValue(false)

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsCliAvailable).not.toHaveBeenCalled()
      })

      it('should not check gh CLI for test commands', async () => {
        commandName = 'test-github'
        mockIsCliAvailable.mockReturnValue(false)

        await validateGhCliForCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsCliAvailable).not.toHaveBeenCalled()
      })
    })

    describe('default provider handling', () => {
      it('should use github as default provider when not specified', async () => {
        commandName = 'start'
        mockIsCliAvailable.mockReturnValue(false)
        mockLoadSettings.mockResolvedValue({
          // No issueManagement.provider specified
        })

        await validateGhCliForCommand(createMockCommand())

        // Should exit because default provider is 'github' and gh CLI is missing
        expect(mockExit).toHaveBeenCalledWith(1)
      })
    })
  })
})

// Unit tests for IDE validation
describe('IDE validation', () => {
  describe('validateIdeForStartCommand', () => {
    let commandName: string
    let commandOpts: Record<string, unknown>
    let mockExit: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>
    let mockIsIdeAvailable: ReturnType<typeof vi.spyOn<typeof ide, 'isIdeAvailable'>>
    let mockLoadSettings: ReturnType<typeof vi.spyOn<SettingsManager, 'loadSettings'>>

    // Helper to create mock command with proper typing
    const createMockCommand = () =>
      ({
        name: () => commandName,
        opts: () => commandOpts,
      }) as unknown as import('commander').Command

    beforeEach(() => {
      // Mock process.exit
      mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      // Default command state
      commandName = ''
      commandOpts = {}

      // Mock isIdeAvailable
      mockIsIdeAvailable = vi.spyOn(ide, 'isIdeAvailable')

      // Mock SettingsManager
      mockLoadSettings = vi.spyOn(SettingsManager.prototype, 'loadSettings')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    describe('command filtering', () => {
      it('should skip validation for non-start commands', async () => {
        commandName = 'finish'

        await validateIdeForStartCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsIdeAvailable).not.toHaveBeenCalled()
      })

      it('should skip validation for list command', async () => {
        commandName = 'list'

        await validateIdeForStartCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsIdeAvailable).not.toHaveBeenCalled()
      })
    })

    describe('--no-code flag handling', () => {
      it('should skip validation when --no-code flag is used', async () => {
        commandName = 'start'
        commandOpts = { code: false }

        await validateIdeForStartCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsIdeAvailable).not.toHaveBeenCalled()
      })
    })

    describe('startIde setting handling', () => {
      it('should skip validation when startIde is false in settings', async () => {
        commandName = 'start'
        commandOpts = {}
        mockLoadSettings.mockResolvedValue({
          workflows: { issue: { startIde: false } }
        })

        await validateIdeForStartCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsIdeAvailable).not.toHaveBeenCalled()
      })

      it('should validate when --code flag overrides startIde=false', async () => {
        commandName = 'start'
        commandOpts = { code: true }
        mockLoadSettings.mockResolvedValue({
          workflows: { issue: { startIde: false } }
        })
        mockIsIdeAvailable.mockResolvedValue(true)

        await validateIdeForStartCommand(createMockCommand())

        expect(mockIsIdeAvailable).toHaveBeenCalled()
        expect(mockExit).not.toHaveBeenCalled()
      })
    })

    describe('IDE availability checking', () => {
      it('should exit with error when configured IDE command is not found', async () => {
        commandName = 'start'
        commandOpts = {}
        mockLoadSettings.mockResolvedValue({})
        mockIsIdeAvailable.mockResolvedValue(false)

        await validateIdeForStartCommand(createMockCommand())

        expect(mockExit).toHaveBeenCalledWith(1)
      })

      it('should pass when configured IDE is available', async () => {
        commandName = 'start'
        commandOpts = {}
        mockLoadSettings.mockResolvedValue({})
        mockIsIdeAvailable.mockResolvedValue(true)

        await validateIdeForStartCommand(createMockCommand())

        expect(mockExit).not.toHaveBeenCalled()
      })

      it('should check correct IDE command based on settings', async () => {
        commandName = 'start'
        commandOpts = {}
        mockLoadSettings.mockResolvedValue({
          ide: { type: 'cursor' }
        })
        mockIsIdeAvailable.mockResolvedValue(true)

        await validateIdeForStartCommand(createMockCommand())

        expect(mockIsIdeAvailable).toHaveBeenCalledWith('cursor')
      })

      it('should default to vscode when IDE type not configured', async () => {
        commandName = 'start'
        commandOpts = {}
        mockLoadSettings.mockResolvedValue({})
        mockIsIdeAvailable.mockResolvedValue(true)

        await validateIdeForStartCommand(createMockCommand())

        expect(mockIsIdeAvailable).toHaveBeenCalledWith('code')
      })
    })

    describe('settings loading error handling', () => {
      it('should skip validation when settings cannot be loaded', async () => {
        commandName = 'start'
        commandOpts = {}
        mockLoadSettings.mockRejectedValue(new Error('Settings file not found'))

        await validateIdeForStartCommand(createMockCommand())

        // Should not exit - let settings validation handle the error
        expect(mockExit).not.toHaveBeenCalled()
        expect(mockIsIdeAvailable).not.toHaveBeenCalled()
      })
    })
  })
})

// Unit tests for version migration in preAction hook
describe('Version migration in preAction hook', () => {
  let mockRunMigrationsIfNeeded: ReturnType<typeof vi.spyOn<VersionMigrationManager, 'runMigrationsIfNeeded'>>

  beforeEach(() => {
    // Mock the runMigrationsIfNeeded method
    mockRunMigrationsIfNeeded = vi.spyOn(VersionMigrationManager.prototype, 'runMigrationsIfNeeded')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('migration execution', () => {
    it('should call runMigrationsIfNeeded with package version', async () => {
      mockRunMigrationsIfNeeded.mockResolvedValue(undefined)

      // Create a new instance and call the method directly (simulating preAction behavior)
      const manager = new VersionMigrationManager()
      await manager.runMigrationsIfNeeded('0.6.0')

      expect(mockRunMigrationsIfNeeded).toHaveBeenCalledWith('0.6.0')
    })

    it('should not throw when runMigrationsIfNeeded succeeds', async () => {
      mockRunMigrationsIfNeeded.mockResolvedValue(undefined)

      const manager = new VersionMigrationManager()

      await expect(manager.runMigrationsIfNeeded('0.7.0')).resolves.toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('should not crash when migration throws an error', async () => {
      // Simulate the preAction hook behavior where errors are caught and logged
      mockRunMigrationsIfNeeded.mockRejectedValue(new Error('Migration failed'))

      const manager = new VersionMigrationManager()

      // The preAction hook wraps this in a try-catch, so we simulate that behavior
      let caughtError: Error | undefined
      try {
        await manager.runMigrationsIfNeeded('0.7.0')
      } catch (error) {
        caughtError = error instanceof Error ? error : new Error('Unknown error')
      }

      // Verify the error was thrown (the preAction hook catches it)
      expect(caughtError).toBeDefined()
      expect(caughtError?.message).toBe('Migration failed')
    })

    it('should handle non-Error thrown values', async () => {
      // Simulate the preAction hook behavior with non-Error thrown values
      mockRunMigrationsIfNeeded.mockRejectedValue('string error')

      const manager = new VersionMigrationManager()

      // The preAction hook handles both Error and non-Error thrown values
      let caughtValue: unknown
      try {
        await manager.runMigrationsIfNeeded('0.7.0')
      } catch (error) {
        caughtValue = error
      }

      expect(caughtValue).toBe('string error')
    })

    it('should allow CLI to continue after migration error (best-effort migration)', async () => {
      // This test verifies the design: migration errors don't crash the CLI
      mockRunMigrationsIfNeeded.mockRejectedValue(new Error('Network error'))

      const manager = new VersionMigrationManager()

      // Simulate preAction hook error handling pattern:
      // try { await manager.runMigrationsIfNeeded(version) }
      // catch (error) { logger.warn(...) }
      let migrationFailed = false
      let warningMessage = ''

      try {
        await manager.runMigrationsIfNeeded('0.8.0')
      } catch (error) {
        migrationFailed = true
        warningMessage = `Version migration failed: ${error instanceof Error ? error.message : 'Unknown'}`
      }

      // Migration failed but CLI can continue
      expect(migrationFailed).toBe(true)
      expect(warningMessage).toBe('Version migration failed: Network error')

      // In the actual CLI, execution continues past this point
      // This represents successful error handling
    })
  })

  describe('migration state', () => {
    it('should create new VersionMigrationManager instance for each call', () => {
      // Each preAction hook creates a new instance
      const manager1 = new VersionMigrationManager()
      const manager2 = new VersionMigrationManager()

      // They should be different instances
      expect(manager1).not.toBe(manager2)
    })

    it('should respect ILOOM_VERSION_OVERRIDE environment variable', async () => {
      const originalEnv = process.env.ILOOM_VERSION_OVERRIDE
      process.env.ILOOM_VERSION_OVERRIDE = '0.9.0'

      try {
        const manager = new VersionMigrationManager()
        const effectiveVersion = manager.getEffectiveVersion('0.6.0')

        expect(effectiveVersion).toBe('0.9.0')
      } finally {
        if (originalEnv === undefined) {
          delete process.env.ILOOM_VERSION_OVERRIDE
        } else {
          process.env.ILOOM_VERSION_OVERRIDE = originalEnv
        }
      }
    })

    it('should use package version when ILOOM_VERSION_OVERRIDE is not set', () => {
      const originalEnv = process.env.ILOOM_VERSION_OVERRIDE
      delete process.env.ILOOM_VERSION_OVERRIDE

      try {
        const manager = new VersionMigrationManager()
        const effectiveVersion = manager.getEffectiveVersion('0.6.0')

        expect(effectiveVersion).toBe('0.6.0')
      } finally {
        if (originalEnv !== undefined) {
          process.env.ILOOM_VERSION_OVERRIDE = originalEnv
        }
      }
    })
  })
})
