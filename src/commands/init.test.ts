import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InitCommand } from './init.js'
import { ShellCompletion } from '../lib/ShellCompletion.js'
import { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import * as claudeUtils from '../utils/claude.js'
import { mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { SettingsMigrationManager } from '../lib/SettingsMigrationManager.js'
import { FirstRunManager } from '../utils/FirstRunManager.js'
import * as gitUtils from '../utils/git.js'
import { TelemetryService } from '../lib/TelemetryService.js'

// Mock fs/promises and fs
vi.mock('fs/promises')
vi.mock('fs')

// Mock TelemetryService
vi.mock('../lib/TelemetryService.js', () => {
  const mockTrack = vi.fn()
  return {
    TelemetryService: {
      getInstance: vi.fn(() => ({
        track: mockTrack,
      })),
    },
  }
})

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
}))

// Mock SettingsMigrationManager
vi.mock('../lib/SettingsMigrationManager.js', () => ({
  SettingsMigrationManager: vi.fn().mockImplementation(() => ({
    migrateSettingsIfNeeded: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Mock FirstRunManager to prevent writing to real filesystem during tests
vi.mock('../utils/FirstRunManager.js')

// Mock claude utils
vi.mock('../utils/claude.js', () => ({
  detectClaudeCli: vi.fn(),
  launchClaude: vi.fn(),
}))

describe('InitCommand', () => {
  let initCommand: InitCommand
  let mockShellCompletion: ShellCompletion
  let mockTemplateManager: PromptTemplateManager

  beforeEach(() => {
    // Create mock shell completion
    mockShellCompletion = {
      detectShell: vi.fn(),
      getSetupInstructions: vi.fn(),
      readShellConfig: vi.fn(),
      grepCompletionConfig: vi.fn(),
      init: vi.fn(),
      getBranchSuggestions: vi.fn(),
      getCompletionScript: vi.fn(),
      printCompletionScript: vi.fn(),
      getShellConfigPath: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    // Create mock template manager
    mockTemplateManager = {
      getPrompt: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    // Setup FirstRunManager mock to prevent writing to real filesystem
    vi.mocked(FirstRunManager).mockImplementation(() => ({
      isProjectConfigured: vi.fn().mockResolvedValue(false),
      markProjectAsConfigured: vi.fn().mockResolvedValue(undefined),
      isFirstRun: vi.fn().mockResolvedValue(false),
      markAsRun: vi.fn().mockResolvedValue(undefined),
    }) as unknown as FirstRunManager)
  })

  describe('execute', () => {
    it('should detect user shell and offer autocomplete setup', async () => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: 'export PATH=$PATH:/usr/local/bin',
      })
      vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue('Test prompt')
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('') // Empty .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(mockShellCompletion.detectShell).toHaveBeenCalled()
      expect(mockShellCompletion.grepCompletionConfig).toHaveBeenCalledWith('bash')
    })

    it('should skip autocomplete setup if user declines but still run project configuration', async () => {
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(false)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      // When Claude CLI is not available, shell detection is not called
      expect(mockShellCompletion.grepCompletionConfig).not.toHaveBeenCalled()

      // Verify project configuration still runs (creates .iloom directory)
      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.iloom'), { recursive: true })
    })

    it('should generate and display setup instructions for bash', async () => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: 'export PATH=$PATH:/usr/local/bin',
      })
      vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue('Test prompt')
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('') // Empty .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(mockShellCompletion.grepCompletionConfig).toHaveBeenCalledWith('bash')
    })

    it('should generate and display setup instructions for zsh', async () => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('zsh')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.zshrc',
        content: 'export PATH=$PATH:/usr/local/bin',
      })
      vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue('Test prompt')
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('') // Empty .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(mockShellCompletion.grepCompletionConfig).toHaveBeenCalledWith('zsh')
    })

    it('should throw error if execution fails', async () => {
      // Mock mkdir to throw error during setupProjectConfiguration
      vi.mocked(mkdir).mockRejectedValue(new Error('Permission denied'))

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)

      await expect(initCommand.execute()).rejects.toThrow('Permission denied')
    })

    it('should pass allowedTools for common git and file operations to launchClaude', async () => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: '',
      })
      vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue('Test prompt')
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          allowedTools: expect.arrayContaining([
            'Bash(git rev-parse:*)',
            'Bash(git init:*)',
            'Bash(git status:*)',
            'Bash(git add:*)',
            'Bash(git commit:*)',
            'Read',
            'Write',
            'Edit',
          ])
        })
      )
    })
  })

  describe('setupProjectConfiguration', () => {
    beforeEach(() => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: '',
      })
      vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue('Test prompt')
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
    })

    it('should run settings migration before creating new settings files', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('') // Empty .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      // Verify migration manager was imported and used
      expect(SettingsMigrationManager).toHaveBeenCalled()
    })

    it('should create .iloom directory', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.iloom'), { recursive: true })
    })
  })

  describe('custom initial message', () => {
    beforeEach(() => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: '',
      })
      vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue('Test prompt')
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('')
    })

    it('should pass custom initial message to Claude when provided', async () => {
      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute('Configure database settings for Neon')

      expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
        'Configure database settings for Neon',
        expect.any(Object)
      )
    })

    it('should use default message when no custom prompt provided', async () => {
      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
        'Help me configure iloom settings.',
        expect.any(Object)
      )
    })

    it('should use default message when custom prompt is undefined', async () => {
      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute(undefined)

      expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
        'Help me configure iloom settings.',
        expect.any(Object)
      )
    })
  })

  describe('package.json detection', () => {
    beforeEach(() => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: '',
      })
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(readFile).mockResolvedValue('')
    })

    it('should set HAS_PACKAGE_JSON=true when package.json exists', async () => {
      // Mock existsSync to return true for package.json
      vi.mocked(existsSync).mockImplementation((filePath: string | Buffer | URL) => {
        const pathStr = filePath.toString()
        return pathStr.endsWith('package.json')
      })

      // Mock getPrompt to capture template variables
      let capturedVariables: Record<string, unknown> = {}
      vi.mocked(mockTemplateManager.getPrompt).mockImplementation(async (_template, variables) => {
        capturedVariables = variables as Record<string, unknown>
        return 'Test prompt'
      })

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(capturedVariables.HAS_PACKAGE_JSON).toBe(true)
      expect(capturedVariables.NO_PACKAGE_JSON).toBe(false)
    })

    it('should set NO_PACKAGE_JSON=true when package.json does not exist', async () => {
      // Mock existsSync to return false for package.json
      vi.mocked(existsSync).mockReturnValue(false)

      // Mock getPrompt to capture template variables
      let capturedVariables: Record<string, unknown> = {}
      vi.mocked(mockTemplateManager.getPrompt).mockImplementation(async (_template, variables) => {
        capturedVariables = variables as Record<string, unknown>
        return 'Test prompt'
      })

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(capturedVariables.HAS_PACKAGE_JSON).toBe(false)
      expect(capturedVariables.NO_PACKAGE_JSON).toBe(true)
    })
  })

  describe('README content injection', () => {
    beforeEach(() => {
      vi.mocked(mockShellCompletion.detectShell).mockReturnValue('bash')
      vi.mocked(mockShellCompletion.grepCompletionConfig).mockResolvedValue({
        path: '/home/user/.bashrc',
        content: '',
      })
      vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
      vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('')
    })

    it('should inject README content into template variables', async () => {
      const mockReadmeContent = '# Test README\n\nThis is a test README.'
      const mockIloomReadmeContent = '# iloom Settings\n\nTest settings documentation.'

      // Mock readFile to return README content when README.md is read
      vi.mocked(readFile).mockImplementation(async (filePath) => {
        const pathStr = filePath.toString()
        if (pathStr.endsWith('README.md') && !pathStr.includes('.iloom')) {
          return mockReadmeContent
        }
        if (pathStr.includes('.iloom') && pathStr.endsWith('README.md')) {
          return mockIloomReadmeContent
        }
        return ''
      })

      // Mock getPrompt to capture template variables
      let capturedVariables: Record<string, unknown> = {}
      vi.mocked(mockTemplateManager.getPrompt).mockImplementation(async (_template, variables) => {
        capturedVariables = variables as Record<string, unknown>
        return 'Test prompt'
      })

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      // Verify README_CONTENT was passed to template
      expect(capturedVariables.README_CONTENT).toBe(mockReadmeContent)
    })

    it('should handle missing README files gracefully', async () => {
      // Mock readFile to throw error (file not found)
      vi.mocked(readFile).mockRejectedValue(new Error('File not found'))

      // Mock getPrompt to capture template variables
      let capturedVariables: Record<string, unknown> = {}
      vi.mocked(mockTemplateManager.getPrompt).mockImplementation(async (_template, variables) => {
        capturedVariables = variables as Record<string, unknown>
        return 'Test prompt'
      })

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      // Should inject empty string when README file is not found
      expect(capturedVariables.README_CONTENT).toBe('')
    })
  })

  describe('accept-defaults mode', () => {
    it('should mark project as configured and skip Claude launch', async () => {
      vi.spyOn(gitUtils, 'getRepoRoot').mockResolvedValue('/mock/repo/root')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute(undefined, true)

      // Verify Claude was NOT launched
      expect(claudeUtils.detectClaudeCli).not.toHaveBeenCalled()
      expect(claudeUtils.launchClaude).not.toHaveBeenCalled()

      // Verify project was marked as configured
      const firstRunManagerInstance = vi.mocked(FirstRunManager).mock.results[0]?.value
      expect(firstRunManagerInstance.markProjectAsConfigured).toHaveBeenCalledWith('/mock/repo/root')
    })

    it('should create .iloom directory via setupProjectConfiguration', async () => {
      vi.spyOn(gitUtils, 'getRepoRoot').mockResolvedValue('/mock/repo/root')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute(undefined, true)

      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.iloom'), { recursive: true })
    })

    it('should still run settings migration in accept-defaults mode', async () => {
      vi.spyOn(gitUtils, 'getRepoRoot').mockResolvedValue('/mock/repo/root')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute(undefined, true)

      expect(SettingsMigrationManager).toHaveBeenCalled()
    })

    it('should use process.cwd() as fallback when getRepoRoot returns null', async () => {
      vi.spyOn(gitUtils, 'getRepoRoot').mockResolvedValue(null)

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute(undefined, true)

      const firstRunManagerInstance = vi.mocked(FirstRunManager).mock.results[0]?.value
      expect(firstRunManagerInstance.markProjectAsConfigured).toHaveBeenCalledWith(process.cwd())
    })

    it('should track telemetry for accept-defaults mode', async () => {
      vi.spyOn(gitUtils, 'getRepoRoot').mockResolvedValue('/mock/repo/root')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute(undefined, true)

      const mockTrack = TelemetryService.getInstance().track
      expect(mockTrack).toHaveBeenCalledWith('init.completed', {
        mode: 'accept-defaults',
      })
    })
  })
})
