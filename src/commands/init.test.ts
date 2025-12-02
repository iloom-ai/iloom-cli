import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InitCommand } from './init.js'
import { ShellCompletion } from '../lib/ShellCompletion.js'
import { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import * as claudeUtils from '../utils/claude.js'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { SettingsMigrationManager } from '../lib/SettingsMigrationManager.js'

// Mock fs/promises and fs
vi.mock('fs/promises')
vi.mock('fs')

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
      vi.mocked(readFile).mockResolvedValue('') // Empty .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      // When Claude CLI is not available, shell detection is not called
      expect(mockShellCompletion.grepCompletionConfig).not.toHaveBeenCalled()

      // Verify project configuration still runs
      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.iloom'), { recursive: true })
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        '\n# Added by iloom CLI\n.iloom/settings.local.json\n',
        'utf-8'
      )
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

    it('should create .gitignore entry if not exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readFile).mockResolvedValue('') // Empty .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.iloom'), { recursive: true })
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        '\n# Added by iloom CLI\n.iloom/settings.local.json\n',
        'utf-8'
      )
    })

    it('should not create settings.local.json file', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('.iloom/settings.local.json\n') // Entry already in .gitignore

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.iloom'), { recursive: true })
      // writeFile should not be called at all since .gitignore already has the entry
      const writeFileCalls = vi.mocked(writeFile).mock.calls
      const settingsLocalCalls = writeFileCalls.filter(call =>
        call[0].toString().includes('settings.local.json')
      )
      expect(settingsLocalCalls).toHaveLength(0)
    })

    it('should add settings.local.json to .gitignore', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('node_modules/\n')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        'node_modules/\n\n# Added by iloom CLI\n.iloom/settings.local.json\n',
        'utf-8'
      )
    })

    it('should create .gitignore if missing', async () => {
      vi.mocked(existsSync).mockReturnValue(false)

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        '\n# Added by iloom CLI\n.iloom/settings.local.json\n',
        'utf-8'
      )
    })

    it('should not duplicate entry in .gitignore', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('.iloom/settings.local.json\n')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      // Should not write to .gitignore since entry already exists
      const writeFileCalls = vi.mocked(writeFile).mock.calls
      const gitignoreCalls = writeFileCalls.filter(call =>
        call[0].toString().includes('.gitignore')
      )
      expect(gitignoreCalls).toHaveLength(0)
    })

    it('should handle .gitignore without trailing newline', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue('node_modules/')

      initCommand = new InitCommand(mockShellCompletion, mockTemplateManager)
      await initCommand.execute()

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        'node_modules/\n\n# Added by iloom CLI\n.iloom/settings.local.json\n',
        'utf-8'
      )
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
      vi.mocked(readFile).mockImplementation(async (filePath: string | Buffer | URL) => {
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
})
