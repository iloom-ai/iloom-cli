import { logger } from '../utils/logger.js'
import { ShellCompletion } from '../lib/ShellCompletion.js'
import chalk from 'chalk'
import { mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { detectClaudeCli, launchClaude } from '../utils/claude.js'
import { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import { AgentManager } from '../lib/AgentManager.js'
import { fileURLToPath } from 'url'
import { GitRemote, parseGitRemotes } from '../utils/remote.js'
import { SettingsMigrationManager } from '../lib/SettingsMigrationManager.js'
import { getRepoRoot, isFileGitignored } from '../utils/git.js'
import { FirstRunManager } from '../utils/FirstRunManager.js'
import { TelemetryService } from '../lib/TelemetryService.js'

/**
 * Initialize iloom configuration
 * Implements the `il init` command requested in issue #94
 */
export class InitCommand {
  private readonly shellCompletion: ShellCompletion
  private readonly templateManager: PromptTemplateManager
  private readonly agentManager: AgentManager

  constructor(
    shellCompletion?: ShellCompletion,
    templateManager?: PromptTemplateManager,
    agentManager?: AgentManager
  ) {
    this.shellCompletion = shellCompletion ?? new ShellCompletion()
    this.templateManager = templateManager ?? new PromptTemplateManager()
    this.agentManager = agentManager ?? new AgentManager()
  }

  /**
   * Main entry point for the init command
   * @param customInitialMessage Optional custom initial message to send to Claude (defaults to "Help me configure iloom settings.")
   * @param acceptDefaults If true, skip interactive prompts and mark project as configured with defaults
   */
  public async execute(customInitialMessage?: string, acceptDefaults?: boolean): Promise<void> {
    try {
      logger.debug('InitCommand.execute() starting', {
        cwd: process.cwd(),
        nodeVersion: process.version,
        hasCustomInitialMessage: !!customInitialMessage,
        acceptDefaults: !!acceptDefaults
      })

      logger.info(chalk.bold('Welcome to iloom setup'))

      // Setup project configuration
      logger.info(chalk.bold('Verifying current setup...'))

      await this.setupProjectConfiguration()

      // Determine mode for telemetry
      const mode = acceptDefaults ? 'accept-defaults' as const : customInitialMessage ? 'guided-custom-prompt' as const : 'guided' as const

      try {
        TelemetryService.getInstance().track('init.started', { mode })
      } catch (e) {
        logger.debug('Telemetry tracking failed', { error: e })
      }

      // If accept-defaults mode, mark project as configured and return early
      if (acceptDefaults) {
        await this.markProjectConfigured()
        try {
          TelemetryService.getInstance().track('init.completed', { mode })
        } catch (e) {
          logger.debug('Telemetry tracking failed', { error: e })
        }
        logger.info(chalk.green('Setup complete! Enjoy using iloom CLI.'))
        return
      }

      // Launch guided Claude configuration if available
      const guidedInitSucceeded = await this.launchGuidedInit(customInitialMessage)

      // Only mark project as configured if guided init succeeded and not already marked
      // This enables VSCode extension detection and ensures project appears in `il projects` list
      if (guidedInitSucceeded) {
        const alreadyConfigured = await this.isProjectConfigured()
        if (!alreadyConfigured) {
          await this.markProjectConfigured()
        } else {
          logger.debug('Project already marked as configured, skipping')
        }
      } else {
        logger.debug('Skipping project marker - guided init did not complete successfully')
      }

      logger.info(chalk.green('Setup complete! Enjoy using iloom CLI.'))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      logger.error(`Initialization failed: ${message}`)
      throw error
    }
  }

  /**
   * Setup project configuration files
   * Ensures .iloom directory exists and runs legacy migrations
   */
  private async setupProjectConfiguration(): Promise<void> {
    logger.debug('setupProjectConfiguration() starting')

    // Migrate legacy .hatchbox settings to .iloom (BEFORE creating new files)
    try {
      logger.debug('Loading SettingsMigrationManager for legacy migration')
      const migrationManager = new SettingsMigrationManager()
      logger.debug('Running settings migration check')
      await migrationManager.migrateSettingsIfNeeded()
      logger.debug('Settings migration check completed')
    } catch (error) {
      // Log warning but don't fail
      logger.warn(`Settings migration failed: ${error instanceof Error ? error.message : 'Unknown'}`)
      logger.debug('Settings migration error details', { error })
    }

    // Ensure .iloom directory exists
    const iloomDir = path.join(process.cwd(), '.iloom')
    logger.debug('Creating .iloom directory', { iloomDir })
    await mkdir(iloomDir, { recursive: true })
    logger.debug('.iloom directory created/verified')
    logger.debug('setupProjectConfiguration() completed')
  }

  /**
   * Launch interactive Claude-guided configuration
   * @param customInitialMessage Optional custom initial message to send to Claude
   * @returns true if Claude session completed successfully, false otherwise
   */
  private async launchGuidedInit(customInitialMessage?: string): Promise<boolean> {
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
      return false
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

      // Check for existing settings - read ALL three files if they exist (global, project, local)
      const settingsGlobalPath = path.join(os.homedir(), '.config', 'iloom-ai', 'settings.json')
      const settingsLocalPath = path.join(process.cwd(), '.iloom', 'settings.local.json')
      const settingsCommittedPath = path.join(process.cwd(), '.iloom', 'settings.json')

      let settingsGlobalJson = ''
      let settingsJson = ''
      let settingsLocalJson = ''

      logger.debug('Checking for settings files', {
        settingsGlobalPath,
        settingsLocalPath,
        settingsCommittedPath,
        globalExists: existsSync(settingsGlobalPath),
        localExists: existsSync(settingsLocalPath),
        committedExists: existsSync(settingsCommittedPath)
      })

      // Read global settings.json if it exists
      if (existsSync(settingsGlobalPath)) {
        logger.debug('Reading global settings.json')
        const content = await readFile(settingsGlobalPath, 'utf-8')
        const trimmed = content.trim()
        if (trimmed !== '{}' && trimmed !== '') {
          settingsGlobalJson = content
          logger.debug('global settings.json loaded', {
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
          logger.debug('global settings.json is empty, skipping')
        }
      } else {
        logger.debug('global settings.json does not exist')
      }

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
        hasSettingsGlobalJson: !!settingsGlobalJson,
        hasSettingsJson: !!settingsJson,
        hasSettingsLocalJson: !!settingsLocalJson,
        settingsGlobalJsonLength: settingsGlobalJson.length,
        settingsJsonLength: settingsJson.length,
        settingsLocalJsonLength: settingsLocalJson.length
      })

      // Detect shell and read config
      logger.debug('Detecting user shell')
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

      let remotes: GitRemote[] = []
      try {
        // Detect git remotes for GitHub configuration
        logger.debug('Detecting git remotes for GitHub configuration')
        remotes = await parseGitRemotes()
        logger.debug('Git remotes detected', { count: remotes.length, remotes })
      } catch (error) {
        const message = error instanceof Error ? error.stack : 'Unknown error'
        logger.debug("Error occured while getting remote info: ", message)
      }

      // Detect if .vscode/settings.json is gitignored
      let vscodeSettingsGitignored = false
      try {
        vscodeSettingsGitignored = await isFileGitignored('.vscode/settings.json')
        logger.debug('VSCode settings gitignore status', { vscodeSettingsGitignored })
      } catch (error) {
        logger.debug('Could not detect gitignore status for .vscode/settings.json', { error })
      }

      let remotesInfo = ''
      let multipleRemotes = false
      let singleRemote = false
      let singleRemoteName = ''
      let singleRemoteUrl = ''
      let noRemotes = false

      if (remotes.length === 0) {
        noRemotes = true
        remotesInfo = 'No git remotes detected in this repository.'
      } else if (remotes.length === 1 && remotes[0]) {
        singleRemote = true
        singleRemoteName = remotes[0].name
        singleRemoteUrl = remotes[0].url
        remotesInfo = `Detected Remote:\n- **${remotes[0].name}**: ${remotes[0].url} (${remotes[0].owner}/${remotes[0].repo})`
      } else {
        multipleRemotes = true
        remotesInfo = `Detected Remotes (${remotes.length}):\n` +
          remotes.map(r => `- **${r.name}**: ${r.url} (${r.owner}/${r.repo})`).join('\n')
      }

      // Load README content for comprehensive documentation
      logger.debug('README content loading...')
      const readmeContent = await this.loadReadmeContent()
      logger.debug('README content loaded', {
        readmeContentLength: readmeContent.length,
      })

      // Detect if project has package.json for multi-language support
      const packageJsonPath = path.join(process.cwd(), 'package.json')
      const hasPackageJson = existsSync(packageJsonPath)
      logger.debug('Package.json detection', { packageJsonPath, hasPackageJson })

      // Build template variables
      const variables = {
        SETTINGS_SCHEMA: schemaContent,
        SETTINGS_GLOBAL_JSON: settingsGlobalJson,
        SETTINGS_JSON: settingsJson,
        SETTINGS_LOCAL_JSON: settingsLocalJson,
        SHELL_TYPE: shell,
        SHELL_CONFIG_PATH: shellConfigPath,
        SHELL_CONFIG_CONTENT: shellConfigContent,
        REMOTES_INFO: remotesInfo,
        MULTIPLE_REMOTES: multipleRemotes.toString(),
        SINGLE_REMOTE: singleRemote.toString(),
        SINGLE_REMOTE_NAME: singleRemoteName,
        SINGLE_REMOTE_URL: singleRemoteUrl,
        NO_REMOTES: noRemotes.toString(),
        README_CONTENT: readmeContent,
        VSCODE_SETTINGS_GITIGNORED: vscodeSettingsGitignored.toString(),
        // Multi-language support - mutually exclusive booleans
        HAS_PACKAGE_JSON: hasPackageJson,
        NO_PACKAGE_JSON: !hasPackageJson,
      }

      logger.debug('Building template variables', {
        variableKeys: Object.keys(variables),
        schemaContentLength: schemaContent.length,
        settingsGlobalJsonLength: settingsGlobalJson.length,
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

      // Load framework-detector agent for non-Node.js project setup
      let agents: Record<string, unknown> | undefined
      try {
        const loadedAgents = await this.agentManager.loadAgents(
          undefined, // No settings overrides for init
          variables,
          ['iloom-framework-detector.md']
        )
        agents = this.agentManager.formatForCli(loadedAgents)
        logger.debug('Loaded framework-detector agent for init', {
          agentCount: Object.keys(agents).length,
          agentNames: Object.keys(agents),
        })
      } catch (error) {
        // Log warning but continue without agents
        logger.warn(`Failed to load agents: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }

      // Pre-approved tools for init workflow to reduce permission prompts
      const initAllowedTools = [
        'Bash(git rev-parse:*)',
        'Bash(git init:*)',
        'Bash(git status:*)',
        'Bash(git add:*)',
        'Bash(git commit:*)',
        'Read',
        'Write',
        'Edit',
      ]

      const claudeOptions = {
        model: 'opus',
        headless: false,
        appendSystemPrompt: prompt,
        addDir: process.cwd(),
        allowedTools: initAllowedTools,
        ...(agents && { agents }),
      }

      logger.debug('Launching Claude with options', {
        optionKeys: Object.keys(claudeOptions),
        headless: claudeOptions.headless,
        hasSystemPrompt: !!claudeOptions.appendSystemPrompt,
        addDir: claudeOptions.addDir,
        promptLength: prompt.length,
        hasCustomInitialMessage: !!customInitialMessage,
        hasAgents: !!agents,
      })

      // Launch Claude in interactive mode with custom initial message if provided
      const initialMessage = customInitialMessage ?? 'Help me configure iloom settings.'
      await launchClaude(initialMessage, claudeOptions)
      logger.debug('Claude session completed successfully')
      return true

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      logger.warn(`Guided configuration failed: ${message}`)
      logger.debug('launchGuidedInit() error details', error instanceof Error ? error.stack : {error})
      logger.info('You can manually edit .iloom/settings.json to configure iloom.')
      return false
    }
  }

  /**
   * Check if the project is already marked as configured.
   */
  private async isProjectConfigured(): Promise<boolean> {
    const projectRoot = await getRepoRoot() ?? process.cwd()
    const firstRunManager = new FirstRunManager()
    return firstRunManager.isProjectConfigured(projectRoot)
  }

  /**
   * Mark the project as configured.
   * Used by both accept-defaults mode and after guided init succeeds.
   */
  private async markProjectConfigured(): Promise<void> {
    const projectRoot = await getRepoRoot() ?? process.cwd()
    const firstRunManager = new FirstRunManager()
    await firstRunManager.markProjectAsConfigured(projectRoot)
    logger.debug('Project marked as configured', { projectRoot })
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
