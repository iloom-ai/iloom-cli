import { logger } from '../utils/logger.js'
import { ShellCompletion } from '../lib/ShellCompletion.js'
import chalk from 'chalk'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { detectClaudeCli, launchClaude } from '../utils/claude.js'
import { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import { fileURLToPath } from 'url'

/**
 * Initialize iloom configuration and setup shell autocomplete
 * Implements the `il init` command requested in issue #94
 */
export class InitCommand {
  private readonly shellCompletion: ShellCompletion
  private readonly templateManager: PromptTemplateManager

  constructor(shellCompletion?: ShellCompletion, templateManager?: PromptTemplateManager) {
    this.shellCompletion = shellCompletion ?? new ShellCompletion()
    this.templateManager = templateManager ?? new PromptTemplateManager()
  }

  /**
   * Main entry point for the init command
   * Prompts user for autocomplete setup and displays instructions
   * @param customInitialMessage Optional custom initial message to send to Claude (defaults to "Help me configure iloom settings.")
   */
  public async execute(customInitialMessage?: string): Promise<void> {
    try {
      logger.debug('InitCommand.execute() starting', {
        cwd: process.cwd(),
        nodeVersion: process.version,
        hasCustomInitialMessage: !!customInitialMessage
      })

      logger.info(chalk.bold('Welcome to iloom setup'))

      // Setup project configuration
      logger.info(chalk.bold('Verifying current setup...'))

      await this.setupProjectConfiguration()

      // Launch guided Claude configuration if available
      await this.launchGuidedInit(customInitialMessage)

      logger.info(chalk.green('Setup complete! Enjoy using iloom CLI.'))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      logger.error(`Initialization failed: ${message}`)
      throw error
    }
  }

  /**
   * Setup project configuration files
   * Creates settings.local.json and updates .gitignore
   */
  private async setupProjectConfiguration(): Promise<void> {
    logger.debug('setupProjectConfiguration() starting')

    // Migrate legacy .hatchbox settings to .iloom (BEFORE creating new files)
    try {
      logger.debug('Loading SettingsMigrationManager for legacy migration')
      const { SettingsMigrationManager } = await import('../lib/SettingsMigrationManager.js')
      const migrationManager = new SettingsMigrationManager()
      logger.debug('Running settings migration check')
      await migrationManager.migrateSettingsIfNeeded()
      logger.debug('Settings migration check completed')
    } catch (error) {
      // Log warning but don't fail
      logger.warn(`Settings migration failed: ${error instanceof Error ? error.message : 'Unknown'}`)
      logger.debug('Settings migration error details', { error })
    }

    // Update .gitignore
    logger.debug('Starting .gitignore update')
    await this.updateGitignore()
    logger.debug('setupProjectConfiguration() completed')

    // Ensure .iloom directory exists
    const iloomDir = path.join(process.cwd(), '.iloom')
    logger.debug('Creating .iloom directory', { iloomDir })
    await mkdir(iloomDir, { recursive: true })
    logger.debug('.iloom directory created/verified')

    // // Create settings.local.json if it doesn't exist
    // const settingsLocalPath = path.join(iloomDir, 'settings.local.json')
    // logger.debug('Checking for existing settings.local.json', { settingsLocalPath })

    // if (!existsSync(settingsLocalPath)) {
    //   logger.debug('Creating settings.local.json file')
    //   await writeFile(settingsLocalPath, '{}\n', 'utf-8')
    //   logger.info('Created .iloom/settings.local.json')
    //   logger.debug('settings.local.json file created successfully')
    // } else {
    //   logger.debug('settings.local.json file already exists, skipping')
    // }
  }

  /**
   * Add settings.local.json to .gitignore if not already present
   */
  private async updateGitignore(): Promise<void> {
    const gitignorePath = path.join(process.cwd(), '.gitignore')
    const entryToAdd = '.iloom/settings.local.json'

    logger.debug('updateGitignore() starting', {
      gitignorePath,
      entryToAdd
    })

    // Read existing .gitignore or create empty
    let content = ''
    if (existsSync(gitignorePath)) {
      logger.debug('.gitignore file exists, reading content')
      content = await readFile(gitignorePath, 'utf-8')
      logger.debug('Read .gitignore content', {
        contentLength: content.length,
        lineCount: content.split('\n').length
      })
    } else {
      logger.debug('.gitignore file does not exist, will create new one')
    }

    // Check if entry already exists
    const lines = content.split('\n')
    const entryExists = lines.some(line => line.trim() === entryToAdd)
    logger.debug('Checking if entry already exists', {
      entryExists,
      totalLines: lines.length
    })

    if (entryExists) {
      logger.debug('Entry already exists, skipping .gitignore update')
      return
    }

    // Add entry with comment
    const commentLine = '\n# Added by iloom CLI'
    const separator = content.endsWith('\n') || content === '' ? '' : '\n'
    const newContent = content + separator + commentLine + '\n' + entryToAdd + '\n'

    logger.debug('Writing updated .gitignore', {
      originalLength: content.length,
      newLength: newContent.length,
      addedLines: 3 // comment + entry + newline
    })

    await writeFile(gitignorePath, newContent, 'utf-8')
    logger.info('Added .iloom/settings.local.json to .gitignore')
    logger.debug('.gitignore update completed successfully')
  }

  /**
   * Launch interactive Claude-guided configuration
   * @param customInitialMessage Optional custom initial message to send to Claude
   */
  private async launchGuidedInit(customInitialMessage?: string): Promise<void> {
    logger.debug('launchGuidedInit() starting', { hasCustomInitialMessage: !!customInitialMessage })
    logger.info(chalk.bold('Starting interactive Claude-guided configuration...'))

    // Check if Claude CLI is available
    logger.debug('Checking Claude CLI availability')
    const claudeAvailable = await detectClaudeCli()
    logger.debug('Claude CLI availability check result', { claudeAvailable })

    if (!claudeAvailable) {
      logger.warn('Claude Code not detected. Skipping guided configuration.')
      logger.info('iloom won\'t be able to help you much without Claude Code, so please install it: npm install -g @anthropic-ai/claude-code')
      logger.debug('Exiting launchGuidedInit() due to missing Claude CLI')
      return
    }

    try {
      // Load schema from dist/schema/settings.schema.json
      // Use similar approach to PromptTemplateManager for path resolution
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = path.dirname(__filename)

      // Walk up to find the schema directory (in case of chunked files)
      let schemaPath = path.join(__dirname, 'schema', 'settings.schema.json')

      logger.debug('Loading settings schema', {
        __filename,
        __dirname,
        schemaPath,
        schemaExists: existsSync(schemaPath)
      })

      let schemaContent = ''
      if (existsSync(schemaPath)) {
        logger.debug('Reading schema file')
        schemaContent = await readFile(schemaPath, 'utf-8')
        logger.debug('Schema file loaded', {
          contentLength: schemaContent.length,
          isValidJson: ((): boolean => {
            try {
              JSON.parse(schemaContent)
              return true
            } catch {
              return false
            }
          })()
        })
      } else {
        logger.warn('Schema file not found - Claude will work without schema validation')
        logger.debug('Schema file not found at expected path', { schemaPath })
      }

      // Check for existing settings - read BOTH files if they exist
      const settingsLocalPath = path.join(process.cwd(), '.iloom', 'settings.local.json')
      const settingsCommittedPath = path.join(process.cwd(), '.iloom', 'settings.json')

      let settingsJson = ''
      let settingsLocalJson = ''

      logger.debug('Checking for settings files', {
        settingsLocalPath,
        settingsCommittedPath,
        localExists: existsSync(settingsLocalPath),
        committedExists: existsSync(settingsCommittedPath)
      })

      // Read settings.json if it exists
      if (existsSync(settingsCommittedPath)) {
        logger.debug('Reading settings.json')
        const content = await readFile(settingsCommittedPath, 'utf-8')
        const trimmed = content.trim()
        if (trimmed !== '{}' && trimmed !== '') {
          settingsJson = content
          logger.debug('settings.json loaded', {
            contentLength: content.length,
            isValidJson: ((): boolean => {
              try {
                JSON.parse(content)
                return true
              } catch {
                return false
              }
            })()
          })
        } else {
          logger.debug('settings.json is empty, skipping')
        }
      } else {
        logger.debug('settings.json does not exist')
      }

      // Read settings.local.json if it exists
      if (existsSync(settingsLocalPath)) {
        logger.debug('Reading settings.local.json')
        const content = await readFile(settingsLocalPath, 'utf-8')
        const trimmed = content.trim()
        if (trimmed !== '{}' && trimmed !== '') {
          settingsLocalJson = content
          logger.debug('settings.local.json loaded', {
            contentLength: content.length,
            isValidJson: ((): boolean => {
              try {
                JSON.parse(content)
                return true
              } catch {
                return false
              }
            })()
          })
        } else {
          logger.debug('settings.local.json is empty, skipping')
        }
      } else {
        logger.debug('settings.local.json does not exist')
      }

      // Log summary
      logger.debug('Settings files summary', {
        hasSettingsJson: !!settingsJson,
        hasSettingsLocalJson: !!settingsLocalJson,
        settingsJsonLength: settingsJson.length,
        settingsLocalJsonLength: settingsLocalJson.length
      })

      // Detect shell and read config
      logger.debug('Detecting user shell for autocomplete setup')
      const shell = this.shellCompletion.detectShell()
      logger.debug('Shell detection result', { shell })

      let shellConfigPath = ''
      let shellConfigContent = ''

      if (shell !== 'unknown') {
        logger.debug('Grepping shell config for completion setup')
        const shellConfig = await this.shellCompletion.grepCompletionConfig(shell)
        if (shellConfig) {
          shellConfigPath = shellConfig.path
          shellConfigContent = shellConfig.content
          logger.debug('Shell config completion grep completed', {
            path: shellConfigPath,
            contentLength: shellConfigContent.length,
            configExists: existsSync(shellConfigPath),
            hasMatches: shellConfigContent.trim().length > 0
          })
        } else {
          logger.debug('Could not read shell config')
        }
      } else {
        logger.debug('Unknown shell detected, skipping config read')
      }

      // Detect git remotes for GitHub configuration
      logger.debug('Detecting git remotes for GitHub configuration')
      const { parseGitRemotes } = await import('../utils/remote.js')
      const remotes = await parseGitRemotes()
      logger.debug('Git remotes detected', { count: remotes.length, remotes })

      let remotesInfo = ''
      let multipleRemotes = ''
      let singleRemote = ''
      let singleRemoteName = ''
      let singleRemoteUrl = ''
      let noRemotes = ''

      if (remotes.length === 0) {
        noRemotes = 'true'
        remotesInfo = 'No git remotes detected in this repository.'
      } else if (remotes.length === 1 && remotes[0]) {
        singleRemote = 'true'
        singleRemoteName = remotes[0].name
        singleRemoteUrl = remotes[0].url
        remotesInfo = `Detected Remote:\n- **${remotes[0].name}**: ${remotes[0].url} (${remotes[0].owner}/${remotes[0].repo})`
      } else {
        multipleRemotes = 'true'
        remotesInfo = `Detected Remotes (${remotes.length}):\n` +
          remotes.map(r => `- **${r.name}**: ${r.url} (${r.owner}/${r.repo})`).join('\n')
      }

      // Load README content for comprehensive documentation
      logger.info('Loading iloom documentation...')
      const readmeContent = await this.loadReadmeContent()
      logger.debug('README content loaded', {
        readmeContentLength: readmeContent.length,
      })

      // Build template variables
      const variables = {
        SETTINGS_SCHEMA: schemaContent,
        SETTINGS_JSON: settingsJson,
        SETTINGS_LOCAL_JSON: settingsLocalJson,
        SHELL_TYPE: shell,
        SHELL_CONFIG_PATH: shellConfigPath,
        SHELL_CONFIG_CONTENT: shellConfigContent,
        REMOTES_INFO: remotesInfo,
        MULTIPLE_REMOTES: multipleRemotes,
        SINGLE_REMOTE: singleRemote,
        SINGLE_REMOTE_NAME: singleRemoteName,
        SINGLE_REMOTE_URL: singleRemoteUrl,
        NO_REMOTES: noRemotes,
        README_CONTENT: readmeContent,
      }

      logger.debug('Building template variables', {
        variableKeys: Object.keys(variables),
        schemaContentLength: schemaContent.length,
        settingsJsonLength: settingsJson.length,
        settingsLocalJsonLength: settingsLocalJson.length
      })

      // Get init prompt
      logger.debug('Loading init prompt template')
      const prompt = await this.templateManager.getPrompt('init', variables)

      logger.debug('Init prompt loaded', {
        promptLength: prompt.length,
        containsSchema: prompt.includes('SETTINGS_SCHEMA'),
        containsExistingSettings: prompt.includes('EXISTING_SETTINGS')
      })

      const claudeOptions = {
        headless: false,
        appendSystemPrompt: prompt,
        addDir: process.cwd(),
      }

      logger.debug('Launching Claude with options', {
        optionKeys: Object.keys(claudeOptions),
        headless: claudeOptions.headless,
        hasSystemPrompt: !!claudeOptions.appendSystemPrompt,
        addDir: claudeOptions.addDir,
        promptLength: prompt.length,
        hasCustomInitialMessage: !!customInitialMessage
      })

      // Launch Claude in interactive mode with custom initial message if provided
      const initialMessage = customInitialMessage ?? 'Help me configure iloom settings.'
      await launchClaude(initialMessage, claudeOptions)
      logger.debug('Claude session completed')

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      logger.warn(`Guided configuration failed: ${message}`)
      logger.debug('launchGuidedInit() error details', { error })
      logger.info('You can manually edit .iloom/settings.json to configure iloom.')
    }

    logger.debug('launchGuidedInit() completed')
  }

  /**
   * Load README.md content for init prompt
   * Walks up from dist directory to find README.md in project root
   */
  private async loadReadmeContent(): Promise<string> {
    try {
      // Walk up from current file location to find README.md
      // Use same pattern as PromptTemplateManager for finding files
      let currentDir = path.dirname(fileURLToPath(import.meta.url))

      // Walk up to find README.md
      while (currentDir !== path.dirname(currentDir)) {
        const readmePath = path.join(currentDir, 'README.md')
        try {
          const content = await readFile(readmePath, 'utf-8')
          logger.debug('Loaded README.md for init prompt', { readmePath })
          return content
        } catch {
          currentDir = path.dirname(currentDir)
        }
      }

      logger.debug('README.md not found, returning empty string')
      return ''
    } catch (error) {
      // Graceful degradation - return empty string on error
      logger.debug(`Failed to load README.md: ${error}`)
      return ''
    }
  }

}
