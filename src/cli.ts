import { program, Command, Option } from 'commander'
import { logger, createStderrLogger } from './utils/logger.js'
import { withLogger } from './utils/logger-context.js'
import { GitWorktreeManager } from './lib/GitWorktreeManager.js'
import { ShellCompletion } from './lib/ShellCompletion.js'
import { SettingsManager } from './lib/SettingsManager.js'
import { IssueTrackerFactory } from './lib/IssueTrackerFactory.js'
import { IssueEnhancementService } from './lib/IssueEnhancementService.js'
import { AgentManager } from './lib/AgentManager.js'
import { GitHubService } from './lib/GitHubService.js'
import { MetadataManager, type LoomMetadata } from './lib/MetadataManager.js'
import { StartCommand } from './commands/start.js'
import { AddIssueCommand } from './commands/add-issue.js'
import { EnhanceCommand } from './commands/enhance.js'
import { FinishCommand } from './commands/finish.js'
import { UserAbortedCommitError } from './types/index.js'
import type { StartOptions, CleanupOptions, FinishOptions } from './types/index.js'
import { getPackageInfo } from './utils/package-info.js'
import { hasMultipleRemotes } from './utils/remote.js'
import { getIdeConfig, isIdeAvailable, getInstallHint } from './utils/ide.js'
import { fileURLToPath } from 'url'
import { realpathSync } from 'fs'
import { formatLoomsForJson, formatFinishedLoomForJson } from './utils/loom-formatter.js'
import { assembleChildrenData, type ChildrenData } from './utils/list-children.js'
import { findMainWorktreePathWithSettings, GitCommandError, isValidGitRepo } from './utils/git.js'
import fs from 'fs-extra'
import { VersionMigrationManager } from './lib/VersionMigrationManager.js'

// Get package.json for version
const __filename = fileURLToPath(import.meta.url)
const packageJson = getPackageInfo(__filename)

// Helper function to parse issue identifiers (numeric or alphanumeric)
function parseIssueIdentifier(value: string): string | number {
  const parsed = parseInt(value, 10)
  // Return number if purely numeric, otherwise return string
  return !isNaN(parsed) && String(parsed) === value ? parsed : value
}

program
  .name('iloom')
  .description(packageJson.description)
  .version(packageJson.version)
  .option('--debug', 'Enable debug output (default: based on ILOOM_DEBUG env var)')
  .option('--completion', 'Output shell completion script for current shell')
  .option('--set <key=value>', 'Override any setting using dot notation (repeatable, e.g., --set workflows.issue.startIde=false)')
  .allowUnknownOption() // Allow --set to be used multiple times
  .addHelpText('afterAll', '\nBy using iloom, you agree to our Terms of Service: https://iloom.ai/terms')
  .hook('preAction', async (thisCommand, actionCommand) => {
    // Set debug mode based on flag or environment variable
    const options = thisCommand.opts()
    // Default to environment variable value, then false if not set
    const envDebug = process.env.ILOOM_DEBUG === 'true'
    const debugEnabled = options.debug !== undefined ? options.debug : envDebug
    logger.setDebug(debugEnabled)

    // Handle --completion flag
    if (options.completion) {
      const shellCompletion = new ShellCompletion()
      shellCompletion.printCompletionScript()
      process.exit(0)
    }

    // Check for updates before command execution for global installations
    try {
      const { checkAndNotifyUpdate } = await import('./utils/update-notifier.js')
      const { detectInstallationMethod } = await import('./utils/installation-detector.js')

      // Detect installation method
      const installMethod = detectInstallationMethod(__filename)

      // Check and notify (non-blocking, all errors handled internally)
      // Suppress update notification when --json flag is passed to avoid breaking JSON output
      const jsonMode = actionCommand.opts().json === true
      await checkAndNotifyUpdate(packageJson.version, packageJson.name, installMethod, { suppressOutput: jsonMode })
    } catch {
      // Silently fail - update check should never break user experience
    }

    // Migrate legacy .hatchbox settings to .iloom (BEFORE settings validation)
    try {
      const { SettingsMigrationManager } = await import('./lib/SettingsMigrationManager.js')
      const migrationManager = new SettingsMigrationManager()
      await migrationManager.migrateSettingsIfNeeded()
    } catch (error) {
      // Log warning but don't fail - migration is best-effort
      logger.debug(`Settings migration failed: ${error instanceof Error ? error.message : 'Unknown'}`)
    }

    // Run version-based migrations (AFTER settings migration, BEFORE settings validation)
    try {
      const versionMigrationManager = new VersionMigrationManager()
      await versionMigrationManager.runMigrationsIfNeeded(packageJson.version)
    } catch (error) {
      // Log warning but don't fail - migration is best-effort
      logger.warn(`Version migration failed: ${error instanceof Error ? error.message : 'Unknown'}`)
    }

    // Validate settings for all commands
    await validateSettingsForCommand(actionCommand)

    // Validate GitHub CLI availability for commands that need it
    await validateGhCliForCommand(actionCommand)

    // Validate IDE availability for start command
    await validateIdeForStartCommand(actionCommand)
  })
  .hook('postAction', async (_thisCommand, actionCommand) => {
    try {
      const { showVSCodeAnnouncementIfNeeded } = await import('./utils/vscode-announcement.js')
      const jsonMode = actionCommand.opts().json === true
      if (!jsonMode) {
        await showVSCodeAnnouncementIfNeeded(actionCommand.name())
      }
    } catch {
      // Silently fail - announcement should never break CLI
    }
  })

// Helper function to validate settings at startup
async function validateSettingsForCommand(command: Command): Promise<void> {
  const commandName = command.name()

  // Tier 1: Commands that bypass ALL validation
  const bypassCommands = ['help', 'init', 'update', 'contribute']

  if (bypassCommands.includes(commandName)) {
    return
  }

  // Tier 2: Commands that warn on settings errors but continue
  const warnOnlyCommands = ['list', 'projects', 'issues']

  // Tier 3: All other commands require FULL validation (settings + multi-remote)
  // Commands: start, add-issue, enhance, finish, cleanup, open, run, etc.
  try {
    const settingsManager = new SettingsManager()

    // Attempt to load settings - this will throw on validation errors
    // Missing file is OK (returns {})
    const settings = await settingsManager.loadSettings()

    // Check for multi-remote configuration requirement
    const multipleRemotes = await hasMultipleRemotes()

    if (multipleRemotes && !settings.issueManagement?.github?.remote) {
      // Auto-launch init command to configure remotes
      // After init completes, function returns and Commander.js continues with original command
      await autoLaunchInitForMultipleRemotes()
      return // Settings now configured, let preAction complete
    }
  } catch (error) {
    if (warnOnlyCommands.includes(commandName)) {
      // For warn-only commands, log warning and continue
      logger.warn(`Configuration warning: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return
    }
    logger.error(`Configuration error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.info('Please fix your .iloom/settings.json file and try again.')
    process.exit(1)
  }
}

// Helper function to validate GitHub CLI availability
// Exported for testing
export async function validateGhCliForCommand(command: Command): Promise<void> {
  const commandName = command.name()

  // Commands that ALWAYS require gh CLI regardless of configuration
  const alwaysRequireGh = ['feedback', 'contribute']

  // Commands that require gh CLI when GitHub provider or github-pr merge mode
  const conditionallyRequireGh = ['start', 'finish', 'enhance', 'add-issue', 'ignite', 'spin']

  // Commands that only warn if gh CLI is missing (secondary/utility commands)
  const warnOnly = ['init', 'list', 'rebase', 'cleanup', 'run', 'update', 'open', 'issues']

  // Test commands and help bypass this check entirely
  if (commandName.startsWith('test-') || commandName === 'help') {
    return
  }

  // Check if gh CLI is available
  const ghAvailable = GitHubService.isCliAvailable()

  // Determine if gh CLI is needed based on configuration
  let needsGhCli = alwaysRequireGh.includes(commandName)

  // For conditional commands, check provider and merge mode
  if (!needsGhCli && conditionallyRequireGh.includes(commandName)) {
    try {
      const settingsManager = new SettingsManager()
      const settings = await settingsManager.loadSettings()

      const provider = IssueTrackerFactory.getProviderName(settings)
      const mergeBehaviorMode = settings.mergeBehavior?.mode

      needsGhCli = provider === 'github' || mergeBehaviorMode === 'github-pr' || mergeBehaviorMode === 'github-draft-pr'
    } catch {
      // If we can't load settings, assume we might need gh CLI
      needsGhCli = true
    }
  }

  // Handle missing gh CLI
  if (!ghAvailable) {
    if (needsGhCli) {
      // ERROR: gh CLI is required for this command
      const errorMessage = alwaysRequireGh.includes(commandName)
        ? `The "${commandName}" command requires GitHub CLI (gh) to be installed.`
        : `GitHub CLI (gh) is required when using GitHub as the issue tracker or "github-pr"/"github-draft-pr" merge mode.`

      logger.error(errorMessage)
      logger.info('')
      logger.info('To install GitHub CLI:')
      logger.info('  • macOS: brew install gh')
      logger.info('  • Windows: winget install GitHub.cli')
      logger.info('  • Linux: https://github.com/cli/cli#installation')
      logger.info('')
      logger.info('After installation, authenticate with: gh auth login')

      process.exit(1)
    } else if (warnOnly.includes(commandName)) {
      // WARN: gh CLI might be needed for certain configurations
      try {
        const settingsManager = new SettingsManager()
        const settings = await settingsManager.loadSettings()

        const provider = IssueTrackerFactory.getProviderName(settings)
        const mergeBehaviorMode = settings.mergeBehavior?.mode

        if (provider === 'github' || mergeBehaviorMode === 'github-pr' || mergeBehaviorMode === 'github-draft-pr') {
          logger.warn('GitHub CLI (gh) is not installed.')
          logger.warn(
            'Some features may not work correctly with your current configuration (GitHub provider or "github-pr"/"github-draft-pr" merge mode).'
          )
          logger.info('To install: brew install gh (macOS) or see https://github.com/cli/cli#installation')
          logger.info('')
        }
      } catch {
        // Silently skip warning if we can't load settings
      }
    }
  }
}

// Helper function to validate IDE availability for start command
// Exported for testing
export async function validateIdeForStartCommand(command: Command): Promise<void> {
  const commandName = command.name()

  // Only validate for start command (and its aliases are resolved to 'start')
  if (commandName !== 'start') {
    return
  }

  // Check if --no-code flag was passed (Commander stores negated option as 'code' = false)
  const codeOption = command.opts()['code']
  if (codeOption === false) {
    return // User explicitly disabled IDE launch
  }

  // Load settings to check IDE configuration and startIde default
  const settingsManager = new SettingsManager()
  let settings
  try {
    settings = await settingsManager.loadSettings()
  } catch {
    // If settings can't be loaded, skip IDE validation (settings validation handles errors)
    return
  }

  // If startIde is explicitly false in workflow config and --code flag wasn't used, skip validation
  const workflowConfig = settings.workflows?.issue
  if (workflowConfig?.startIde === false && codeOption !== true) {
    return
  }

  // Get configured IDE (defaults to vscode)
  const ideConfig = getIdeConfig(settings.ide)
  const available = await isIdeAvailable(ideConfig.command)

  if (!available) {
    const hint = getInstallHint(settings.ide?.type ?? 'vscode')
    logger.error(
      `${ideConfig.name} is configured as your IDE but "${ideConfig.command}" command was not found.`
    )
    logger.info('')
    logger.info(hint)
    logger.info('')
    logger.info('Alternatively, use --no-code to skip IDE launch or configure a different IDE in settings.')
    process.exit(1)
  }
}

/**
 * Auto-launch init command when multiple remotes are detected but not configured
 * Shows message, waits for keypress, launches interactive Claude configuration,
 * then returns to let Commander.js continue with the original command
 */
async function autoLaunchInitForMultipleRemotes(): Promise<void> {
  logger.info('Multiple git remotes detected, but no GitHub remote is configured.')
  logger.info('')
  logger.info('iloom will now launch an interactive configuration session with Claude')
  logger.info('to help you select which remote to use for GitHub operations.')
  logger.info('')

  // Wait for keypress to continue
  const { waitForKeypress } = await import('./utils/prompt.js')
  await waitForKeypress('Press any key to start configuration...')

  logger.info('')

  try {
    // Launch init command with focused initial message
    const { InitCommand } = await import('./commands/init.js')
    const initCommand = new InitCommand()

    // Custom initial message that focuses on multi-remote configuration
    const customInitialMessage = 'Help me configure which git remote iloom should use for GitHub operations. I have multiple remotes and need to select the correct one.'

    await initCommand.execute(customInitialMessage)

    logger.info('')
    logger.info('Configuration complete! Continuing with your original command...')
    logger.info('')

    // Re-validate settings after init to ensure multi-remote is now configured
    const { SettingsManager } = await import('./lib/SettingsManager.js')
    const settingsManager = new SettingsManager()
    const settings = await settingsManager.loadSettings()

    const { hasMultipleRemotes } = await import('./utils/remote.js')
    const multipleRemotes = await hasMultipleRemotes()

    // Verify the issue is resolved
    if (multipleRemotes && !settings.issueManagement?.github?.remote) {
      logger.error('Configuration incomplete: GitHub remote is still not configured.')
      logger.info('Please run "iloom init" again and configure the GitHub remote setting.')
      process.exit(1)
    }

    // Configuration verified - simply return to let Commander.js continue
    // with the original command (preAction hook will complete normally)
    return

  } catch (error) {
    logger.error(`Failed to configure remotes: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.info('You can manually run "iloom init" to configure settings.')
    process.exit(1)
  }
}

// Initialize shell completion (must be after program setup, before parseAsync)
const shellCompletion = new ShellCompletion()
shellCompletion.init()

program
  .command('start')
  .alias('new')
  .alias('create')
  .alias('up')
  .description('Create isolated workspace for an issue/PR')
  .argument('[identifier]', 'Issue number, PR number, or branch name (optional - will prompt if not provided)')
  .option('--claude', 'Enable Claude integration (default: true)')
  .option('--no-claude', 'Disable Claude integration')
  .option('--code', 'Enable VSCode (default: true)')
  .option('--no-code', 'Disable VSCode')
  .option('--dev-server', 'Enable dev server in terminal (default: true)')
  .option('--no-dev-server', 'Disable dev server')
  .option('--terminal', 'Enable terminal without dev server (default: false)')
  .option('--no-terminal', 'Disable terminal')
  .option('--child-loom', 'Force create as child loom (skip prompt)')
  .option('--no-child-loom', 'Force create as independent loom (skip prompt)')
  .option('--body <text>', 'Body text for issue (skips AI enhancement)')
  .option('--json', 'Output result as JSON')
  .addOption(
    new Option('--one-shot <mode>', 'One-shot automation mode')
      .choices(['default', 'noReview', 'bypassPermissions'])
      .default('default')
  )
  .option('--yolo', 'Enable autonomous mode (shorthand for --one-shot=bypassPermissions)')
  .action(async (identifier: string | undefined, options: StartOptions & { yolo?: boolean }) => {
    // Handle --yolo flag: set oneShot to bypassPermissions
    if (options.yolo) {
      options.oneShot = 'bypassPermissions'
    }
    const executeAction = async (): Promise<void> => {
      try {
        let finalIdentifier = identifier

        // Interactive prompting when no identifier provided
        if (!finalIdentifier) {
          if (options.json) {
            logger.error('JSON mode requires identifier argument')
            process.exit(1)
          }
          const { promptInput } = await import('./utils/prompt.js')
          finalIdentifier = await promptInput('Enter issue number, PR number (pr/123), or branch name')

          // Validate non-empty after prompting
          if (!finalIdentifier?.trim()) {
            logger.error('Identifier is required')
            process.exit(1)
          }
        }

        const settingsManager = new SettingsManager()
        const settings = await settingsManager.loadSettings()
        const issueTracker = IssueTrackerFactory.create(settings)
        const command = new StartCommand(issueTracker, undefined, undefined, settingsManager)
        const result = await command.execute({ identifier: finalIdentifier, options })

        if (options.json && result) {
          // JSON mode: output structured result and exit
          console.log(JSON.stringify(result, null, 2))
        }
        process.exit(0)
      } catch (error) {
        logger.error(`Failed to start workspace: ${error instanceof Error ? error.message : 'Unknown error'}`)
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

program
  .command('add-issue')
  .alias('a')
  .description('Create and enhance GitHub issue without starting workspace')
  .argument('<description>', 'Issue title (>30 chars, >2 spaces; or any non-empty text when --body provided)')
  .option('--body <text>', 'Body text for issue (skips AI enhancement)')
  .option('--json', 'Output result as JSON')
  .action(async (description: string, options: { body?: string; json?: boolean }) => {
    const executeAction = async (): Promise<void> => {
      try {
        const settingsManager = new SettingsManager()
        const settings = await settingsManager.loadSettings()
        const issueTracker = IssueTrackerFactory.create(settings)
        const enhancementService = new IssueEnhancementService(issueTracker, new AgentManager(), settingsManager)
        const command = new AddIssueCommand(enhancementService, settingsManager)
        const result = await command.execute({
          description,
          options: {
            ...(options.body && { body: options.body }),
            ...(options.json && { json: options.json })
          }
        })

        if (options.json && result) {
          // JSON mode: output structured result and exit
          console.log(JSON.stringify(result, null, 2))
        } else if (result) {
          // Non-JSON mode: display human-readable success message
          const issueNumber = typeof result === 'object' ? result.id : result
          logger.success(`Issue #${issueNumber} created successfully`)
        }
        process.exit(0)
      } catch (error) {
        logger.error(`Failed to create issue: ${error instanceof Error ? error.message : 'Unknown error'}`)
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

program
  .command('feedback')
  .alias('f')
  .description('Submit feedback/bug report to iloom-cli repository')
  .argument('<description>', 'Feedback title (>30 chars, >2 spaces; or any non-empty text when --body provided)')
  .option('--body <text>', 'Body text for feedback (added after diagnostics)')
  .action(async (description: string, options: { body?: string }) => {
    try {
      const { FeedbackCommand } = await import('./commands/feedback.js')
      const command = new FeedbackCommand()
      const feedbackOptions: import('./types/index.js').FeedbackOptions = {}
      if (options.body !== undefined) {
        feedbackOptions.body = options.body
      }
      const issueNumber = await command.execute({
        description,
        options: feedbackOptions
      })
      logger.success(`Feedback submitted as issue #${issueNumber} in iloom-cli repository`)
      process.exit(0)
    } catch (error) {
      logger.error(`Failed to submit feedback: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('enhance')
  .description('Apply enhancement agent to existing GitHub issue')
  .argument('<issue-number>', 'GitHub issue identifier to enhance', parseIssueIdentifier)
  .option('--no-browser', 'Skip browser opening prompt')
  .option('--author <username>', 'GitHub username to tag in questions (for CI usage)')
  .option('--json', 'Output result as JSON')
  .action(async (issueNumber: string | number, options: { browser?: boolean; author?: string; json?: boolean }) => {
    const executeAction = async (): Promise<void> => {
      try {
        const settingsManager = new SettingsManager()
        const settings = await settingsManager.loadSettings()
        const issueTracker = IssueTrackerFactory.create(settings)
        const enhancementService = new IssueEnhancementService(issueTracker, new AgentManager(), settingsManager)
        const command = new EnhanceCommand(issueTracker, enhancementService, settingsManager)
        const result = await command.execute({
          issueNumber,
          options: {
            noBrowser: options.browser === false,
            ...(options.author && { author: options.author }),
            ...(options.json && { json: options.json })
          }
        })

        if (options.json && result) {
          // JSON mode: output structured result and exit
          console.log(JSON.stringify(result, null, 2))
        } else {
          // Non-JSON mode: display human-readable success message
          logger.success(`Enhancement process completed for issue #${issueNumber}`)
        }
        process.exit(0)
      } catch (error) {
        logger.error(`Failed to enhance issue: ${error instanceof Error ? error.message : 'Unknown error'}`)
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

program
  .command('finish')
  .alias('dn')
  .description('Merge work and cleanup workspace')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .option('-f, --force', 'Skip confirmation prompts')
  .option('-n, --dry-run', 'Preview actions without executing')
  .option('--pr <number>', 'Treat input as PR number', parseFloat)
  .option('--skip-build', 'Skip post-merge build verification')
  .option('--no-browser', 'Skip opening PR in browser (github-pr mode only)')
  .option('--cleanup', 'Clean up worktree after finishing (default in local mode)')
  .option('--no-cleanup', 'Keep worktree after finishing')
  .option('--json', 'Output result as JSON')
  .action(async (identifier: string | undefined, options: FinishOptions) => {
    const executeAction = async (): Promise<void> => {
      try {
        const settingsManager = new SettingsManager()
        const settings = await settingsManager.loadSettings()
        const issueTracker = IssueTrackerFactory.create(settings)
        const command = new FinishCommand(issueTracker)
        const result = await command.execute({ identifier, options })
        if (options.json && result) {
          console.log(JSON.stringify(result, null, 2))
        }
        process.exit(0)
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
        } else {
          logger.error(`Failed to finish workspace: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }

        // Exit 130 for user cancellation (Unix convention: 128 + SIGINT)
        if (error instanceof UserAbortedCommitError) {
          process.exit(130)
        }
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

program
  .command('commit')
  .alias('c')
  .description('Commit all uncommitted files with issue reference')
  .option('-m, --message <text>', 'Custom commit message (skip Claude generation)')
  .option('--fixes', 'Use "Fixes #N" trailer instead of "Refs #N" (closes issue)')
  .option('--no-review', 'Skip commit message review prompt')
  .option('--json', 'Output result as JSON (implies --no-review)')
  .option('--wip-commit', 'Quick WIP commit: skip validations and pre-commit hooks')
  .action(async (options: { message?: string; fixes?: boolean; review?: boolean; json?: boolean; wipCommit?: boolean }) => {
    const executeAction = async (): Promise<void> => {
      try {
        const { CommitCommand } = await import('./commands/commit.js')
        const command = new CommitCommand()
        // --json implies --no-review
        const noReview = options.review === false || options.json === true
        const result = await command.execute({
          message: options.message,
          fixes: options.fixes ?? false,
          noReview,
          json: options.json ?? false,
          wipCommit: options.wipCommit ?? false,
        })
        if (options.json && result) {
          console.log(JSON.stringify(result, null, 2))
        }
        process.exit(0)
      } catch (error) {
        // Handle UserAbortedCommitError with exit code 130
        if (error instanceof UserAbortedCommitError) {
          process.exit(130)
        }
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
        } else {
          logger.error(`Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
        process.exit(1)
      }
    }
    // Wrap in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

program
  .command('rebase')
  .description('Rebase current branch on main with Claude-assisted conflict resolution')
  .option('-f, --force', 'Skip confirmation prompts')
  .option('-n, --dry-run', 'Preview actions without executing')
  .action(async (options: { force?: boolean; dryRun?: boolean }) => {
    try {
      const { RebaseCommand } = await import('./commands/rebase.js')
      const command = new RebaseCommand()
      await command.execute(options)
    } catch (error) {
      logger.error(`Failed to rebase: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('spin')
  .alias('ignite')
  .description('Launch Claude with auto-detected workspace context')
  .addOption(
    new Option('--one-shot <mode>', 'One-shot automation mode')
      .choices(['default', 'noReview', 'bypassPermissions'])
  )
  .option('--yolo', 'Enable autonomous mode (shorthand for --one-shot=bypassPermissions)')
  .option('-p, --print', 'Enable print/headless mode for CI/CD (uses bypassPermissions)')
  .addOption(
    new Option('--output-format <format>', 'Output format for Claude CLI (requires --print)')
      .choices(['json', 'stream-json', 'text'])
  )
  .option('--verbose', 'Enable verbose output (requires --print)')
  .option('--json', 'Output final result as JSON object (requires --print)')
  .option('--json-stream', 'Stream JSONL output to stdout in real-time (requires --print)')
  .action(async (options: {
    oneShot?: import('./types/index.js').OneShotMode
    yolo?: boolean
    print?: boolean
    outputFormat?: 'json' | 'stream-json' | 'text'
    verbose?: boolean
    json?: boolean
    jsonStream?: boolean
  }) => {
    // Handle --yolo flag: set oneShot to bypassPermissions
    if (options.yolo) {
      options.oneShot = 'bypassPermissions'
    }
    try {
      const { IgniteCommand } = await import('./commands/ignite.js')
      const command = new IgniteCommand()

      // Validate mutually exclusive flags
      if (options.json && options.jsonStream) {
        logger.error('--json and --json-stream are mutually exclusive')
        process.exit(1)
      }

      // If output-format or verbose specified without --print, warn and ignore
      if (!options.print && (options.outputFormat !== undefined || options.verbose !== undefined)) {
        logger.warn('--output-format and --verbose flags are ignored without --print')
      }

      // If --json or --json-stream specified without --print, warn and ignore
      if (!options.print && (options.json || options.jsonStream)) {
        logger.warn('--json and --json-stream flags are ignored without --print')
      }

      const printOptions = options.print
        ? {
            print: true,
            ...(options.outputFormat !== undefined && { outputFormat: options.outputFormat }),
            ...(options.verbose !== undefined && { verbose: options.verbose }),
            ...(options.json && { json: true }),
            ...(options.jsonStream && { jsonStream: true }),
          }
        : undefined
      await command.execute(options.oneShot, printOptions)
    } catch (error) {
      logger.error(`Failed to spin up loom: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('open')
  .description('Open workspace in browser or run CLI tool')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .allowUnknownOption()
  .action(async (identifier?: string, _options?: Record<string, unknown>, command?: Command) => {
    try {
      // Extract additional arguments - everything after identifier
      const args = command?.args ? command.args.slice(identifier ? 1 : 0) : []

      const { OpenCommand } = await import('./commands/open.js')
      const cmd = new OpenCommand()
      const input = identifier ? { identifier, args } : { args }
      await cmd.execute(input)
    } catch (error) {
      logger.error(`Failed to open: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('run')
  .description('Run CLI tool or open workspace in browser')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .allowUnknownOption()
  .action(async (identifier?: string, _options?: Record<string, unknown>, command?: Command) => {
    try {
      // Extract additional arguments - everything after identifier
      const args = command?.args ? command.args.slice(identifier ? 1 : 0) : []

      const { RunCommand } = await import('./commands/run.js')
      const cmd = new RunCommand()
      const input = identifier ? { identifier, args } : { args }
      await cmd.execute(input)
    } catch (error) {
      logger.error(`Failed to run: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('vscode')
  .description('Install iloom VS Code extension and open workspace in VS Code')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .option('--no-wait', 'Skip keypress prompt and open immediately')
  .action(async (identifier?: string, options?: { wait?: boolean }) => {
    try {
      const { VSCodeCommand } = await import('./commands/vscode.js')
      const cmd = new VSCodeCommand()
      await cmd.execute({ identifier, wait: options?.wait })
    } catch (error) {
      throw new Error(`Failed to open VS Code: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  })

program
  .command('dev-server')
  .alias('dev')
  .description('Start dev server for workspace (foreground)')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .option('--json', 'Output as JSON')
  .action(async (identifier?: string, options?: { json?: boolean }) => {
    try {
      const { DevServerCommand } = await import('./commands/dev-server.js')
      const cmd = new DevServerCommand()
      await cmd.execute({ identifier, json: options?.json })
    } catch (error) {
      logger.error(`Failed to start dev server: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('shell')
  .alias('terminal')
  .description('Open interactive shell with workspace environment')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .action(async (identifier?: string) => {
    try {
      const { ShellCommand } = await import('./commands/shell.js')
      const cmd = new ShellCommand()
      await cmd.execute({ identifier })
    } catch (error) {
      logger.error(`Failed to open shell: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('build')
  .description('Run the build script')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .action(async (identifier?: string) => {
    try {
      const { BuildCommand } = await import('./commands/build.js')
      const cmd = new BuildCommand()
      await cmd.execute(identifier ? { identifier } : {})
    } catch (error) {
      logger.error(`Build failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('lint')
  .description('Run the lint script')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .action(async (identifier?: string) => {
    try {
      const { LintCommand } = await import('./commands/lint.js')
      const cmd = new LintCommand()
      await cmd.execute(identifier ? { identifier } : {})
    } catch (error) {
      logger.error(`Lint failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('test')
  .description('Run the test script')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .action(async (identifier?: string) => {
    try {
      const { TestCommand } = await import('./commands/test.js')
      const cmd = new TestCommand()
      await cmd.execute(identifier ? { identifier } : {})
    } catch (error) {
      logger.error(`Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('compile')
  .alias('typecheck')
  .description('Run the compile or typecheck script (prefers compile if both exist)')
  .argument('[identifier]', 'Issue number, PR number, or branch name (auto-detected if omitted)')
  .action(async (identifier?: string) => {
    try {
      const { CompileCommand } = await import('./commands/compile.js')
      const cmd = new CompileCommand()
      await cmd.execute(identifier ? { identifier } : {})
    } catch (error) {
      logger.error(`Compile failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('cleanup')
  .alias('remove')
  .alias('clean')
  .description('Remove workspaces')
  .argument('[identifier]', 'Branch name or issue number to cleanup (auto-detected)')
  .option('-l, --list', 'List all worktrees')
  .option('-a, --all', 'Remove all worktrees (interactive confirmation)')
  .option('-i, --issue <number>', 'Cleanup by issue number', parseInt)
  .option('-f, --force', 'Skip confirmations and force removal')
  .option('--dry-run', 'Show what would be done without doing it')
  .option('--json', 'Output result as JSON')
  .option('--defer <ms>', 'Wait specified milliseconds before cleanup', parseInt)
  .action(async (identifier?: string, options?: CleanupOptions) => {
    const executeAction = async (): Promise<void> => {
      try {
        const { CleanupCommand } = await import('./commands/cleanup.js')
        const command = new CleanupCommand()
        const input: { identifier?: string; options: CleanupOptions } = {
          options: options ?? {}
        }
        if (identifier) {
          input.identifier = identifier
        }
        const result = await command.execute(input)
        if (options?.json && result) {
          console.log(JSON.stringify(result, null, 2))
        }
        process.exit(0)
      } catch (error) {
        if (options?.json) {
          console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
        } else {
          // Error message is already well-formatted (e.g., "Cannot cleanup:\n\n...")
          logger.error(error instanceof Error ? error.message : 'Unknown error')
        }
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options?.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

program
  .command('list')
  .description('Show active workspaces')
  .option('--json', 'Output as JSON')
  .option('--finished', 'Show only finished looms (sorted by finish time, latest first)')
  .option('--all', 'Show both active and finished looms')
  .option('--global', 'Show looms from all projects (default: current project only)')
  .option('--children', 'Fetch and display child issues and child looms for each parent loom')
  .action(async (options: { json?: boolean; finished?: boolean; all?: boolean; global?: boolean; children?: boolean }) => {
    try {
      const manager = new GitWorktreeManager()
      const metadataManager = new MetadataManager()

      // Get current project path for filtering (unless --global is set)
      let currentProjectPath: string | null = null
      if (!options.global) {
        try {
          currentProjectPath = await findMainWorktreePathWithSettings()
        } catch (error) {
          // Only catch expected errors (not in a git repo or settings validation failed)
          // For these cases, we show all looms since we can't determine the current project
          if (error instanceof GitCommandError &&
              (error.exitCode === 128 || /fatal: not a git repository/i.test(error.stderr))) {
            currentProjectPath = null
          } else if (error instanceof Error && error.message.includes('Invalid settings')) {
            // Settings validation failure - show all looms
            currentProjectPath = null
          } else {
            throw error
          }
        }
      }

      // Determine what to list based on flags
      const showActive = !options.finished // Show active unless --finished is set
      const showFinished = Boolean(options.finished) || Boolean(options.all)

      // Get active worktrees if needed
      let worktrees: ReturnType<typeof manager.listWorktrees> extends Promise<infer T> ? T : never = []
      const metadata = new Map<string, LoomMetadata | null>()
      // Global active looms (from metadata, not git worktrees) - used when --global is set
      let globalActiveLooms: LoomMetadata[] = []

      if (showActive) {
        if (options.global) {
          // When --global is set, use MetadataManager.listAllMetadata() to get looms from ALL projects
          // This is necessary because GitWorktreeManager.listWorktrees() only returns worktrees
          // from the current git repository, not from other projects
          const allMetadata = await metadataManager.listAllMetadata()

          // Filter to only include looms where worktree path exists and is a valid git repo
          for (const loom of allMetadata) {
            if (!loom.worktreePath) {
              continue // Skip looms without worktree path (legacy)
            }

            // Check if worktree path exists on disk
            const pathExists = await fs.pathExists(loom.worktreePath)
            if (!pathExists) {
              continue // Skip stale metadata (worktree was deleted)
            }

            // Verify it's still a valid git repository
            const isValid = await isValidGitRepo(loom.worktreePath)
            if (!isValid) {
              continue // Skip corrupted worktrees
            }

            globalActiveLooms.push(loom)
            metadata.set(loom.worktreePath, loom)
          }
        } else {
          // Non-global mode: use git worktree list (current repo only)
          try {
            worktrees = await manager.listWorktrees({ porcelain: true })
            // Read metadata for all worktrees
            for (const worktree of worktrees) {
              const loomMetadata = await metadataManager.readMetadata(worktree.path)
              metadata.set(worktree.path, loomMetadata)
            }
          } catch (error) {
            // Handle "not a git repository" - just use empty array
            // Check for GitCommandError with exit code 128 (git's "not a repository" exit code)
            // or fallback to checking stderr for the specific "not a git repository" message
            if (error instanceof GitCommandError &&
                (error.exitCode === 128 || /fatal: not a git repository/i.test(error.stderr))) {
              worktrees = []
            } else {
              throw error
            }
          }
        }
      }

      // Get finished looms if needed
      let finishedLooms: LoomMetadata[] = []
      if (showFinished) {
        finishedLooms = await metadataManager.listFinishedMetadata()
      }

      // Filter by current project for text output (include looms with null projectPath for legacy support)
      // When --global is set, globalActiveLooms is used instead of worktrees, and no project filtering is applied
      let filteredWorktrees = worktrees
      let filteredGlobalActiveLooms = globalActiveLooms
      let filteredFinishedLooms = finishedLooms
      if (currentProjectPath) {
        filteredWorktrees = worktrees.filter(wt => {
          const loomMetadata = metadata.get(wt.path)
          return loomMetadata?.projectPath == null || loomMetadata?.projectPath === currentProjectPath
        })
        filteredFinishedLooms = finishedLooms.filter(loom =>
          loom.projectPath == null || loom.projectPath === currentProjectPath
        )
      }

      if (options.json) {
        let mainWorktreePath: string | undefined
        try {
          mainWorktreePath = await findMainWorktreePathWithSettings()
        } catch {
          // Settings validation failed - continue without main worktree path
        }

        // Format active looms
        let activeJson: ReturnType<typeof formatLoomsForJson> extends (infer T)[] ? (T & { status: 'active'; finishedAt: null })[] : never = []
        if (showActive) {
          if (options.global) {
            // Format global active looms from metadata (similar to finished looms format)
            activeJson = globalActiveLooms.map(loom => ({
              name: loom.branchName ?? loom.worktreePath ?? 'unknown',
              worktreePath: loom.worktreePath,
              branch: loom.branchName,
              type: loom.issueType ?? 'branch',
              issue_numbers: loom.issue_numbers,
              pr_numbers: loom.pr_numbers,
              isMainWorktree: false, // Global looms from other projects are never the main worktree
              description: loom.description ?? null,
              created_at: loom.created_at ?? null,
              issueTracker: loom.issueTracker ?? null,
              colorHex: loom.colorHex ?? null,
              projectPath: loom.projectPath ?? null,
              issueUrls: loom.issueUrls ?? {},
              prUrls: loom.prUrls ?? {},
              status: 'active' as const,
              finishedAt: null,
              isChildLoom: loom.parentLoom != null,
              parentLoom: loom.parentLoom ?? null,
            }))
          } else {
            // Format worktrees from current repo
            activeJson = formatLoomsForJson(worktrees, mainWorktreePath, metadata).map(loom => ({
              ...loom,
              status: 'active' as const,
              finishedAt: null,
            }))
          }
        }

        // Filter active looms by project (include looms with null/undefined projectPath for legacy support)
        // Skip filtering when --global is set (the whole point is to see all projects)
        if (currentProjectPath && !options.global) {
          activeJson = activeJson.filter(loom =>
            loom.projectPath == null || loom.projectPath === currentProjectPath
          )
        }

        // Format finished looms
        let finishedJson = finishedLooms.map(formatFinishedLoomForJson)

        // Filter finished looms by project (include looms with null/undefined projectPath for legacy support)
        if (currentProjectPath) {
          finishedJson = finishedJson.filter(loom =>
            loom.projectPath == null || loom.projectPath === currentProjectPath
          )
        }

        // Fetch children data if --children flag is set
        if (options.children) {
          // Load settings for determining issue tracker provider
          const settingsManager = new SettingsManager()
          const settings = await settingsManager.loadSettings()

          // Fetch children for all active looms in parallel using Promise.allSettled
          const activeChildrenResults = await Promise.allSettled(
            activeJson.map(async (loom): Promise<{ index: number; children: ChildrenData | null }> => {
              const index = activeJson.indexOf(loom)
              // Find the corresponding metadata for this loom
              const loomMetadata = options.global
                ? globalActiveLooms.find(m => m.branchName === loom.branch)
                : metadata.get(loom.worktreePath ?? '')
              if (!loomMetadata) {
                return { index, children: null }
              }
              const children = await assembleChildrenData(loomMetadata, metadataManager, settings)
              return { index, children }
            })
          )

          // Attach children data to active looms
          for (const result of activeChildrenResults) {
            if (result.status === 'fulfilled' && result.value.children) {
              const loom = activeJson[result.value.index]
              if (loom) {
                loom.children = result.value.children
              }
            }
          }

          // Fetch children for all finished looms in parallel using Promise.allSettled
          const finishedChildrenResults = await Promise.allSettled(
            finishedJson.map(async (loom, index): Promise<{ index: number; children: ChildrenData | null }> => {
              // Find the corresponding metadata for this loom
              const loomMetadata = finishedLooms.find(m => m.branchName === loom.branch)
              if (!loomMetadata) {
                return { index, children: null }
              }
              const children = await assembleChildrenData(loomMetadata, metadataManager, settings)
              return { index, children }
            })
          )

          // Attach children data to finished looms
          for (const result of finishedChildrenResults) {
            if (result.status === 'fulfilled' && result.value.children) {
              const loom = finishedJson[result.value.index]
              if (loom) {
                loom.children = result.value.children
              }
            }
          }
        }

        // Combine and output
        const allLooms = [...activeJson, ...finishedJson]
        console.log(JSON.stringify(allLooms, null, 2))
        return
      }

      // Text output - use filtered arrays
      // For active looms, use globalActiveLooms when --global is set, otherwise use worktrees
      const hasActive = options.global ? filteredGlobalActiveLooms.length > 0 : filteredWorktrees.length > 0
      const hasFinished = filteredFinishedLooms.length > 0

      if (!hasActive && !hasFinished) {
        if (options.finished) {
          logger.info('No finished looms found')
        } else if (options.all) {
          logger.info('No looms found')
        } else {
          logger.info('No worktrees found')
        }
        return
      }

      // Load settings for children fetching if --children flag is set
      let textSettings: import('./lib/SettingsManager.js').IloomSettings | null = null
      if (options.children) {
        const settingsManager = new SettingsManager()
        textSettings = await settingsManager.loadSettings()
      }

      // Show active workspaces
      if (showActive && hasActive) {
        logger.info('Active workspaces:')
        if (options.global) {
          // Global mode: display from metadata
          for (const loom of filteredGlobalActiveLooms) {
            // Show child loom indicator if this loom has a parent
            if (loom.parentLoom) {
              logger.info(`  ${loom.branchName ?? 'unknown'} (Child of: ${loom.parentLoom.branchName})`)
            } else {
              logger.info(`  ${loom.branchName ?? 'unknown'}`)
            }
            if (loom.description) {
              logger.info(`    Description: ${loom.description}`)
            }
            if (loom.worktreePath) {
              logger.info(`    Path: ${loom.worktreePath}`)
            }
            if (loom.projectPath) {
              logger.info(`    Project: ${loom.projectPath}`)
            }
            // Show children summary if --children flag is set
            if (options.children && textSettings) {
              const childrenData = await assembleChildrenData(loom, metadataManager, textSettings)
              if (childrenData && (childrenData.summary.totalIssues > 0 || childrenData.summary.totalLooms > 0)) {
                logger.info(`    Child Issues: ${childrenData.summary.totalIssues} (${childrenData.summary.issuesWithLooms} with active looms)`)
                // Show child issues without looms
                for (const issue of childrenData.issues) {
                  if (!issue.hasActiveLoom) {
                    logger.info(`      [No loom] #${issue.id} - ${issue.title} (${issue.state})`)
                  }
                }
              }
            }
          }
        } else {
          // Non-global mode: display from git worktrees
          for (const worktree of filteredWorktrees) {
            const formatted = manager.formatWorktree(worktree)
            const loomMetadata = metadata.get(worktree.path)
            // Show child loom indicator if this loom has a parent
            if (loomMetadata?.parentLoom) {
              logger.info(`  ${formatted.title} (Child of: ${loomMetadata.parentLoom.branchName})`)
            } else {
              logger.info(`  ${formatted.title}`)
            }
            if (loomMetadata?.description) {
              logger.info(`    Description: ${loomMetadata.description}`)
            }
            logger.info(`    Path: ${formatted.path}`)
            logger.info(`    Commit: ${formatted.commit}`)
            // Show children summary if --children flag is set
            if (options.children && textSettings && loomMetadata) {
              const childrenData = await assembleChildrenData(loomMetadata, metadataManager, textSettings)
              if (childrenData && (childrenData.summary.totalIssues > 0 || childrenData.summary.totalLooms > 0)) {
                logger.info(`    Child Issues: ${childrenData.summary.totalIssues} (${childrenData.summary.issuesWithLooms} with active looms)`)
                // Show child issues without looms
                for (const issue of childrenData.issues) {
                  if (!issue.hasActiveLoom) {
                    logger.info(`      [No loom] #${issue.id} - ${issue.title} (${issue.state})`)
                  }
                }
              }
            }
          }
        }
      }

      // Show finished looms
      if (showFinished && hasFinished) {
        if (showActive && hasActive) {
          logger.info('') // Add blank line between sections
        }
        logger.info('Finished looms:')
        for (const loom of filteredFinishedLooms) {
          // Show child loom indicator if this loom has a parent
          if (loom.parentLoom) {
            logger.info(`  ${loom.branchName ?? 'unknown'} (Child of: ${loom.parentLoom.branchName})`)
          } else {
            logger.info(`  ${loom.branchName ?? 'unknown'}`)
          }
          if (loom.description) {
            logger.info(`    Description: ${loom.description}`)
          }
          if (loom.finishedAt) {
            logger.info(`    Finished: ${new Date(loom.finishedAt).toLocaleString()}`)
          }
          // Show children summary if --children flag is set
          if (options.children && textSettings) {
            const childrenData = await assembleChildrenData(loom, metadataManager, textSettings)
            if (childrenData && (childrenData.summary.totalIssues > 0 || childrenData.summary.totalLooms > 0)) {
              logger.info(`    Child Issues: ${childrenData.summary.totalIssues} (${childrenData.summary.issuesWithLooms} with active looms)`)
              // Show child issues without looms
              for (const issue of childrenData.issues) {
                if (!issue.hasActiveLoom) {
                  logger.info(`      [No loom] #${issue.id} - ${issue.title} (${issue.state})`)
                }
              }
            }
          }
        }
      }
    } catch (error) {
      // Handle "not a git repository" gracefully
      // Check for GitCommandError with exit code 128 (git's "not a repository" exit code)
      // or fallback to checking stderr for the specific "not a git repository" message
      if (error instanceof GitCommandError &&
          (error.exitCode === 128 || /fatal: not a git repository/i.test(error.stderr))) {
        if (options.json) {
          console.log('[]')
        } else {
          logger.info('No worktrees found')
        }
        return
      }
      logger.error(`Failed to list worktrees: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('projects')
  .description('List configured iloom projects')
  .option('--json', 'Output as JSON (default behavior)')
  .action(async (options: { json?: boolean }) => {
    try {
      const { ProjectsCommand } = await import('./commands/projects.js')
      const command = new ProjectsCommand()
      const result = await command.execute(options)
      console.log(JSON.stringify(result, null, 2))
    } catch (error) {
      logger.error(`Failed to list projects: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('issues')
  .description('List project issues from configured issue tracker')
  .argument('[project-path]', 'Path to project root (auto-detected if omitted)')
  .option('--json', 'Output as JSON (default behavior)')
  .option('--limit <n>', 'Max issues to return', '100')
  .action(async (projectPath?: string, options?: { json?: boolean; limit?: string }) => {
    try {
      const { IssuesCommand } = await import('./commands/issues.js')
      const command = new IssuesCommand()
      const parsedLimit = parseInt(options?.limit ?? '100', 10)
      const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 100 : parsedLimit
      const result = await command.execute({
        ...(projectPath ? { projectPath } : {}),
        limit,
      })
      console.log(JSON.stringify(result, null, 2))
    } catch (error) {
      logger.error(`Failed to list issues: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('init')
  .alias('config')
  .description('Initialize iloom configuration')
  .argument('[prompt]', 'Custom initial message to send to Claude (defaults to "Help me configure iloom settings.")')
  .action(async (prompt?: string) => {
    try {
      const { InitCommand } = await import('./commands/init.js')
      const command = new InitCommand()
      // Pass custom prompt if provided and non-empty
      const trimmedPrompt = prompt?.trim()
      const customPrompt = trimmedPrompt && trimmedPrompt.length > 0 ? trimmedPrompt : undefined
      await command.execute(customPrompt)
    } catch (error) {
      logger.error(`Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('plan')
  .description('Launch interactive planning session with Architect persona')
  .argument('[prompt]', 'Initial planning prompt or topic')
  .option('--model <model>', 'Model to use (default: opus)')
  .option('--yolo', 'Enable autonomous mode - Claude proceeds without user interaction')
  .option('--planner <provider>', 'AI provider for planning: claude, gemini, codex (default: claude)')
  .option('--reviewer <provider>', 'AI provider for review: claude, gemini, codex, none (default: none)')
  .option('-p, --print', 'Enable print/headless mode for CI/CD (uses bypassPermissions)')
  .addOption(
    new Option('--output-format <format>', 'Output format for Claude CLI (requires --print)')
      .choices(['json', 'stream-json', 'text'])
  )
  .option('--verbose', 'Enable verbose output (requires --print)')
  .option('--json', 'Output final result as JSON object (requires --print)')
  .option('--json-stream', 'Stream JSONL output to stdout in real-time (requires --print)')
  .action(async (prompt?: string, options?: {
    model?: string
    yolo?: boolean
    planner?: string
    reviewer?: string
    print?: boolean
    outputFormat?: 'json' | 'stream-json' | 'text'
    verbose?: boolean
    json?: boolean
    jsonStream?: boolean
  }) => {
    try {
      const { PlanCommand } = await import('./commands/plan.js')
      const command = new PlanCommand()

      // Validate mutually exclusive flags
      if (options?.json && options?.jsonStream) {
        logger.error('--json and --json-stream are mutually exclusive')
        process.exit(1)
      }

      // If output-format or verbose specified without --print, warn and ignore
      if (!options?.print && (options?.outputFormat !== undefined || options?.verbose !== undefined)) {
        logger.warn('--output-format and --verbose flags are ignored without --print')
      }

      // If --json or --json-stream specified without --print, warn and ignore
      if (!options?.print && (options?.json || options?.jsonStream)) {
        logger.warn('--json and --json-stream flags are ignored without --print')
      }

      const printOptions = options?.print
        ? {
            print: true,
            ...(options?.outputFormat !== undefined && { outputFormat: options.outputFormat }),
            ...(options?.verbose !== undefined && { verbose: options.verbose }),
            ...(options?.json && { json: true }),
            ...(options?.jsonStream && { jsonStream: true }),
          }
        : undefined
      await command.execute(prompt, options?.model, options?.yolo, options?.planner, options?.reviewer, printOptions)
    } catch (error) {
      logger.error(`Planning session failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('contribute')
  .description('Set up local development environment for contributing to a GitHub project')
  .argument('[repository]', 'GitHub repository (owner/repo, github.com/owner/repo, or full URL). Defaults to iloom-ai/iloom-cli')
  .action(async (repository?: string) => {
    try {
      const { ContributeCommand } = await import('./commands/contribute.js')
      const command = new ContributeCommand()
      await command.execute(repository)
    } catch (error) {
      logger.error(`Failed to set up contributor environment: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('update')
  .description('Update iloom-cli to the latest version')
  .option('--dry-run', 'Show what would be done without actually updating')
  .action(async (options: { dryRun?: boolean }) => {
    try {
      const { UpdateCommand } = await import('./commands/update.js')
      const command = new UpdateCommand()
      await command.execute(options)
    } catch (error) {
      logger.error(`Failed to update: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

// Test command for GitHub integration
program
  .command('test-github')
  .description('Test GitHub integration (Issue #3)')
  .argument('<identifier>', 'Issue number or PR number')
  .option('--no-claude', 'Skip Claude for branch name generation')
  .action(async (identifier: string, options: { claude?: boolean }) => {
    try {
      const { GitHubService } = await import('./lib/GitHubService.js')
      const { DefaultBranchNamingService } = await import('./lib/BranchNamingService.js')

      logger.info('Testing GitHub Integration\n')

      const service = new GitHubService()
      const branchNaming = new DefaultBranchNamingService({ useClaude: options.claude !== false })

      // Test 1: Input detection
      logger.info('Detecting input type...')
      const detection = await service.detectInputType(identifier)
      logger.info(`   Type: ${detection.type}`)
      logger.info(`   Identifier: ${detection.identifier}`)

      if (detection.type === 'unknown') {
        logger.error('Could not detect if input is an issue or PR')
        process.exit(1)
      }

      // Test 2: Fetch the issue/PR
      logger.info('Fetching from GitHub...')
      if (detection.type === 'issue') {
        if (!detection.identifier) {
          throw new Error('Issue number not detected')
        }
        const issueNumber = parseInt(detection.identifier, 10)
        const issue = await service.fetchIssue(issueNumber)
        logger.success(`   Issue #${issue.number}: ${issue.title}`)
        logger.info(`   State: ${issue.state}`)
        logger.info(`   Labels: ${issue.labels.join(', ') || 'none'}`)
        logger.info(`   URL: ${issue.url}`)

        // Test 3: Generate branch name

        logger.info('Generating branch name...')
        const branchName = await branchNaming.generateBranchName({
          issueNumber: issue.number,
          title: issue.title
        })
        logger.success(`   Branch: ${branchName}`)

        // Test 4: Extract context
        
        logger.info('Extracting context for Claude...')
        const context = service.extractContext(issue)
        logger.info(`   ${context.split('\n').join('\n   ')}`)

      } else {
        if (!detection.identifier) {
          throw new Error('PR number not detected')
        }
        const prNumber = parseInt(detection.identifier, 10)
        const pr = await service.fetchPR(prNumber)
        logger.success(`   PR #${pr.number}: ${pr.title}`)
        logger.info(`   State: ${pr.state}`)
        logger.info(`   Branch: ${pr.branch}`)
        logger.info(`   Base: ${pr.baseBranch}`)
        logger.info(`   URL: ${pr.url}`)

        // Test 3: Extract context
        
        logger.info('Extracting context for Claude...')
        const context = service.extractContext(pr)
        logger.info(`   ${context.split('\n').join('\n   ')}`)
      }

      
      logger.success('All GitHub integration tests passed!')

    } catch (error) {
      logger.error(`Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Test command for Claude integration
program
  .command('test-claude')
  .description('Test Claude integration (Issue #10)')
  .option('--detect', 'Test Claude CLI detection')
  .option('--version', 'Get Claude CLI version')
  .option('--branch <title>', 'Test branch name generation with given title')
  .option('--issue <number>', 'Issue number for branch generation', '123')
  .option('--launch <prompt>', 'Launch Claude with a prompt (headless)')
  .option('--interactive', 'Launch Claude interactively (requires --launch)')
  .option('--template <name>', 'Test template loading')
  .action(async (options: {
    detect?: boolean
    version?: boolean
    branch?: string
    issue?: string
    launch?: string
    interactive?: boolean
    template?: 'issue' | 'pr' | 'regular'
  }) => {
    try {
      const { detectClaudeCli, getClaudeVersion, generateBranchName, launchClaude } = await import('./utils/claude.js')
      const { PromptTemplateManager } = await import('./lib/PromptTemplateManager.js')
      const { ClaudeService } = await import('./lib/ClaudeService.js')
      const { ClaudeContextManager } = await import('./lib/ClaudeContextManager.js')

      logger.info('Testing Claude Integration\n')

      // Test 1: Detection
      if (options.detect) {
        logger.info('Detecting Claude CLI...')
        const isAvailable = await detectClaudeCli()
        if (isAvailable) {
          logger.success('   Claude CLI is available')
        } else {
          logger.error('   Claude CLI not found')
        }
      }

      // Test 2: Version
      if (options.version) {
        logger.info('Getting Claude version...')
        const version = await getClaudeVersion()
        if (version) {
          logger.success(`   Version: ${version}`)
        } else {
          logger.error('   Could not get version')
        }
      }

      // Test 3: Branch name generation
      if (options.branch) {
        logger.info('Generating branch name...')
        const issueNumber = parseInt(options.issue ?? '123')
        logger.info(`   Issue #${issueNumber}: ${options.branch}`)
        const branchName = await generateBranchName(options.branch, issueNumber)
        logger.success(`   Generated: ${branchName}`)
      }

      // Test 4: Launch Claude
      if (options.launch) {
        logger.info('Launching Claude...')
        logger.info(`   Prompt: "${options.launch}"`)
        logger.info(`   Mode: ${options.interactive ? 'Interactive' : 'Headless'}`)

        if (options.interactive) {
          logger.info('   Launching Claude in new terminal...')
          await launchClaude(options.launch, { headless: false })
          logger.info('   (Claude should open in a separate process)')
        } else {
          logger.info('   Waiting for response...')
          const result = await launchClaude(options.launch, { headless: true })
          if (result) {
            logger.success('   Response:')
            logger.info(`   ${result.split('\n').join('\n   ')}`)
          }
        }
      }

      // Test 5: Template loading
      if (options.template) {
        logger.info('Loading template...')
        logger.info(`   Template: ${options.template}`)
        const manager = new PromptTemplateManager()
        try {
          const content = await manager.loadTemplate(options.template)
          logger.success('   Template loaded successfully')
          logger.info('   First 200 chars:')
          logger.info(`   ${content.substring(0, 200).split('\n').join('\n   ')}...`)
        } catch (error) {
          logger.error(`   Failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      }

      // Run all tests in sequence when no specific options provided
      if (!options.detect && !options.version && !options.branch && !options.launch && !options.template) {
        logger.info('Running full Claude integration test suite...\n')

        // Test 1: Detection
        logger.info('1. Testing Claude CLI detection...')
        const isAvailable = await detectClaudeCli()
        if (isAvailable) {
          logger.success('   Claude CLI is available')
        } else {
          logger.error('   Claude CLI not found')
          logger.info('\nSkipping remaining tests since Claude CLI is not available')
          return
        }

        // Test 2: Version
        logger.info('\n2. Getting Claude version...')
        const version = await getClaudeVersion()
        if (version) {
          logger.success(`   Version: ${version}`)
        } else {
          logger.error('   Could not get version')
        }

        // Test 3: Branch name generation
        logger.info('\n3. Testing branch name generation...')
        const testIssueNumber = 123
        const testTitle = 'Add user authentication feature'
        logger.info(`   Issue #${testIssueNumber}: ${testTitle}`)
        const branchName = await generateBranchName(testTitle, testIssueNumber)
        logger.success(`   Generated: ${branchName}`)

        // Test 4: Service initialization
        logger.info('\n4. Testing ClaudeService initialization...')
        new ClaudeService() // Just verify it can be instantiated
        logger.success('   Service initialized')

        // Test 5: Context manager
        logger.info('\n5. Testing ClaudeContextManager...')
        const contextManager = new ClaudeContextManager()
        await contextManager.prepareContext({
          type: 'issue',
          identifier: 123,
          title: 'Test issue',
          workspacePath: process.cwd(),
          port: 3123
        })
        logger.success('   Context prepared')

        // Test 6: Template loading
        logger.info('\n6. Testing template loading...')
        const templateManager = new PromptTemplateManager()
        const templates: Array<'issue' | 'pr' | 'regular'> = ['issue', 'pr', 'regular']
        let templateCount = 0
        for (const template of templates) {
          try {
            await templateManager.loadTemplate(template)
            logger.success(`   ${template} template loaded`)
            templateCount++
          } catch {
            logger.warn(`   ${template} template not found`)
          }
        }
        logger.info(`   Loaded ${templateCount}/${templates.length} templates`)

        // Test 7: Launch Claude headless (quick test)
        logger.info('\n7. Testing Claude launch (headless)...')
        logger.info('   Sending test prompt: "Say hello"')
        try {
          const result = await launchClaude('Say hello', { headless: true })
          if (result) {
            logger.success('   Claude responded successfully')
            logger.info(`   Response preview: ${result.substring(0, 100)}...`)
          } else {
            logger.warn('   No response received')
          }
        } catch (error) {
          logger.error(`   Launch failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }

        logger.info('\n' + '='.repeat(50))
        logger.success('All Claude integration tests complete!')
        logger.info('Summary: All core Claude features are working correctly')
      }

    } catch (error) {
      logger.error(`Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Test command for webserver detection
program
  .command('test-webserver')
  .description('Test if a web server is running on a workspace port')
  .argument('<issue-number>', 'Issue number (port will be calculated as 3000 + issue number)', parseInt)
  .option('--kill', 'Kill the web server if detected')
  .action(async (issueNumber: number, options: { kill?: boolean }) => {
    try {
      const { TestWebserverCommand } = await import('./commands/test-webserver.js')
      const command = new TestWebserverCommand()
      await command.execute({ issueNumber, options })
    } catch (error) {
      logger.error(`Test webserver failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Test command for Git integration
program
  .command('test-git')
  .description('Test Git integration - findMainWorktreePath() function (reads .iloom/settings.json)')
  .action(async () => {
    try {
      const { TestGitCommand } = await import('./commands/test-git.js')
      const command = new TestGitCommand()
      await command.execute()
    } catch (error) {
      logger.error(`Test git failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Test command for iTerm2 dual tab functionality
program
  .command('test-tabs')
  .description('Test iTerm2 dual tab functionality - opens two tabs with test commands')
  .action(async () => {
    try {
      const { TestTabsCommand } = await import('./commands/test-tabs.js')
      const command = new TestTabsCommand()
      await command.execute()
    } catch (error) {
      logger.error(`Test tabs failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Test command for worktree prefix configuration
program
  .command('test-prefix')
  .description('Test worktree prefix configuration - preview worktree paths (reads .iloom/settings.json)')
  .action(async () => {
    try {
      const { TestPrefixCommand } = await import('./commands/test-prefix.js')
      const command = new TestPrefixCommand()
      await command.execute()
    } catch (error) {
      logger.error(`Test prefix failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Command for session summary generation
program
  .command('summary')
  .description('Generate Claude session summary for a loom')
  .argument('[identifier]', 'Issue number, PR number (pr/123), or branch name (auto-detected if omitted)')
  .option('--with-comment', 'Post summary as a comment to the issue/PR')
  .option('--json', 'Output result as JSON')
  .action(async (identifier: string | undefined, options: { withComment?: boolean; json?: boolean }) => {
    const executeAction = async (): Promise<void> => {
      try {
        const { SummaryCommand } = await import('./commands/summary.js')
        const command = new SummaryCommand()
        const result = await command.execute({ identifier, options })

        if (options.json && result) {
          // JSON mode: output structured result and exit
          console.log(JSON.stringify(result, null, 2))
        }
        process.exit(0)
      } catch (error) {
        if (options.json) {
          // JSON mode: output error as JSON
          console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
        } else {
          logger.error(`Summary failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
          if (error instanceof Error && error.stack) {
            logger.debug(error.stack)
          }
        }
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

// Command for loom recap (session context)
program
  .command('recap')
  .description('Get recap for a loom (defaults to current directory)')
  .argument('[identifier]', 'Issue number, PR number (pr/123), or branch name (auto-detected if omitted)')
  .option('--json', 'Output as JSON with filePath for file watching')
  .action(async (identifier: string | undefined, options: { json?: boolean }) => {
    const executeAction = async (): Promise<void> => {
      try {
        const { RecapCommand } = await import('./commands/recap.js')
        const command = new RecapCommand()
        const result = await command.execute({ identifier, json: options.json })

        if (options.json && result) {
          // JSON mode: output structured result and exit
          console.log(JSON.stringify(result, null, 2))
        }
        process.exit(0)
      } catch (error) {
        if (options.json) {
          // JSON mode: output error as JSON
          console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
        } else {
          logger.error(`Recap failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
          if (error instanceof Error && error.stack) {
            logger.debug(error.stack)
          }
        }
        process.exit(1)
      }
    }

    // Wrap execution in logger context for JSON mode
    if (options.json) {
      const jsonLogger = createStderrLogger()
      await withLogger(jsonLogger, executeAction)
    } else {
      await executeAction()
    }
  })

// Test command for Neon integration
program
  .command('test-neon')
  .description('Test Neon integration and debug configuration')
  .action(async () => {
    try {
      const { SettingsManager } = await import('./lib/SettingsManager.js')
      const { createNeonProviderFromSettings } = await import('./utils/neon-helpers.js')

      logger.info('Testing Neon Integration\n')

      // Test 1: Settings Configuration
      logger.info('1. Settings Configuration:')
      const settingsManager = new SettingsManager()
      const settings = await settingsManager.loadSettings()
      const neonConfig = settings.databaseProviders?.neon
      logger.info(`   projectId: ${neonConfig?.projectId ?? '(not configured)'}`)
      logger.info(`   parentBranch: ${neonConfig?.parentBranch ?? '(not configured)'}`)

      // Test 2: Create provider and test initialization
      logger.info('\n2. Creating NeonProvider...')
      try {
        const neonProvider = createNeonProviderFromSettings(settings)
        logger.success('   NeonProvider created successfully')

        // Test 3: CLI availability
        logger.info('\n3. Testing Neon CLI availability...')
        const isAvailable = await neonProvider.isCliAvailable()
        if (isAvailable) {
          logger.success('   Neon CLI is available')
        } else {
          logger.error('   Neon CLI not found')
          logger.info('   Install with: npm install -g @neon/cli')
          return
        }

        // Test 4: Authentication
        logger.info('\n4. Testing Neon CLI authentication...')
        const isAuthenticated = await neonProvider.isAuthenticated()
        if (isAuthenticated) {
          logger.success('   Neon CLI is authenticated')
        } else {
          logger.error('   Neon CLI not authenticated')
          logger.info('   Run: neon auth')
          return
        }

        // Test 5: List branches (if config is valid)
        if (neonConfig?.projectId) {
          logger.info('\n5. Testing branch listing...')
          try {
            const branches = await neonProvider.listBranches()
            logger.success(`   Found ${branches.length} branches:`)
            for (const branch of branches.slice(0, 5)) { // Show first 5
              logger.info(`     - ${branch}`)
            }
            if (branches.length > 5) {
              logger.info(`     ... and ${branches.length - 5} more`)
            }
          } catch (error) {
            logger.error(`   Failed to list branches: ${error instanceof Error ? error.message : 'Unknown error'}`)
          }
        } else {
          logger.warn('\n5. Skipping branch listing (Neon not configured in settings)')
        }

      } catch (error) {
        logger.error(`   Failed to create NeonProvider: ${error instanceof Error ? error.message : 'Unknown error'}`)
        if (error instanceof Error && error.message.includes('not configured')) {
          logger.info('\n   This is expected if Neon is not configured.')
          logger.info('   Configure databaseProviders.neon in .iloom/settings.json to test fully.')
        }
      }

      logger.info('\n' + '='.repeat(50))
      logger.success('Neon integration test complete!')

    } catch (error) {
      logger.error(`Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      if (error instanceof Error && error.stack) {
        logger.debug(error.stack)
      }
      process.exit(1)
    }
  })

// Add custom help command in order to get preAction to run (update check handled by preAction hook)
program
  .command('help')
  .description('Display help information')
  .argument('[command]', 'Show help for specific command')
  .action(async (command?: string) => {
    // Show help (update check already ran in preAction)
    if (command) {
      // Show help for specific command
      const subCommand = program.commands.find(cmd => cmd.name() === command)
      if (subCommand) {
        subCommand.outputHelp()
      } else {
        logger.error(`Unknown command: ${command}`)
        program.outputHelp()
      }
    } else {
      program.outputHelp()
    }

    process.exit(0)
  })

// Parse CLI arguments (only when run directly, not when imported for testing)
// Resolve symlinks to handle npm link and global installs
const isRunDirectly = process.argv[1] && ((): boolean => {
  try {
    const scriptPath = realpathSync(process.argv[1])
    const modulePath = fileURLToPath(import.meta.url)
    return scriptPath === modulePath
  } catch {
    // If we can't resolve the path, assume we should run
    return true
  }
})()

if (isRunDirectly) {
  try {
    await program.parseAsync()
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error: ${error.message}`)
      process.exit(1)
    }
  }
}
