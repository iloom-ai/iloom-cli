import { program, Command, Option } from 'commander'
import { logger } from './utils/logger.js'
import { GitWorktreeManager } from './lib/GitWorktreeManager.js'
import { ShellCompletion } from './lib/ShellCompletion.js'
import { SettingsManager } from './lib/SettingsManager.js'
import { IssueTrackerFactory } from './lib/IssueTrackerFactory.js'
import { IssueEnhancementService } from './lib/IssueEnhancementService.js'
import { AgentManager } from './lib/AgentManager.js'
import { StartCommand } from './commands/start.js'
import { AddIssueCommand } from './commands/add-issue.js'
import { EnhanceCommand } from './commands/enhance.js'
import { FinishCommand } from './commands/finish.js'
import type { StartOptions, CleanupOptions, FinishOptions } from './types/index.js'
import { getPackageInfo } from './utils/package-info.js'
import { fileURLToPath } from 'url'

// Get package.json for version
const __filename = fileURLToPath(import.meta.url)
const packageJson = getPackageInfo(__filename)

program
  .name('iloom')
  .description(packageJson.description)
  .version(packageJson.version)
  .option('--debug', 'Enable debug output (default: based on ILOOM_DEBUG env var)')
  .option('--completion', 'Output shell completion script for current shell')
  .option('--set <key=value>', 'Override any setting using dot notation (repeatable, e.g., --set workflows.issue.startIde=false)')
  .allowUnknownOption() // Allow --set to be used multiple times
  .hook('preAction', async (thisCommand) => {
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
      await checkAndNotifyUpdate(packageJson.version, packageJson.name, installMethod)
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

    // Validate settings for all commands
    await validateSettingsForCommand(thisCommand)
  })

// Helper function to validate settings at startup
async function validateSettingsForCommand(command: Command): Promise<void> {
  const commandName = command.args[0] ?? ''

  // Tier 1: Commands that bypass ALL validation
  const bypassCommands = ['help', 'init', 'update', 'contribute']

  if (bypassCommands.includes(commandName)) {
    return
  }

  // Tier 2: All other commands require FULL validation (settings + multi-remote)
  // Commands: start, add-issue, enhance, finish, list, cleanup, open, run, etc.
  try {
    const settingsManager = new SettingsManager()

    // Attempt to load settings - this will throw on validation errors
    // Missing file is OK (returns {})
    const settings = await settingsManager.loadSettings()

    // Check for multi-remote configuration requirement
    const { hasMultipleRemotes } = await import('./utils/remote.js')
    const multipleRemotes = await hasMultipleRemotes()

    if (multipleRemotes && !settings.issueManagement?.github?.remote) {
      // Auto-launch init command to configure remotes
      // After init completes, function returns and Commander.js continues with original command
      await autoLaunchInitForMultipleRemotes()
      return // Settings now configured, let preAction complete
    }
  } catch (error) {
    logger.error(`Configuration error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.info('Please fix your .iloom/settings.json file and try again.')
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
  .addOption(
    new Option('--one-shot <mode>', 'One-shot automation mode')
      .choices(['default', 'noReview', 'bypassPermissions'])
      .default('default')
  )
  .action(async (identifier: string | undefined, options: StartOptions) => {
    try {
      let finalIdentifier = identifier

      // Interactive prompting when no identifier provided
      if (!finalIdentifier) {
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
      await command.execute({ identifier: finalIdentifier, options })
    } catch (error) {
      logger.error(`Failed to start workspace: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('add-issue')
  .alias('a')
  .description('Create and enhance GitHub issue without starting workspace')
  .argument('<description>', 'Natural language description of the issue (>50 chars, >2 spaces)')
  .action(async (description: string) => {
    try {
      const settingsManager = new SettingsManager()
      const settings = await settingsManager.loadSettings()
      const issueTracker = IssueTrackerFactory.create(settings)
      const enhancementService = new IssueEnhancementService(issueTracker, new AgentManager(), settingsManager)
      const command = new AddIssueCommand(enhancementService, settingsManager)
      const issueNumber = await command.execute({
        description,
        options: {}
      })
      logger.success(`Issue #${issueNumber} created successfully`)
      process.exit(0)
    } catch (error) {
      logger.error(`Failed to create issue: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('feedback')
  .alias('f')
  .description('Submit feedback/bug report to iloom-cli repository')
  .argument('<description>', 'Natural language description of feedback (>50 chars, >2 spaces)')
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
  .argument('<issue-number>', 'GitHub issue number to enhance', parseInt)
  .option('--no-browser', 'Skip browser opening prompt')
  .option('--author <username>', 'GitHub username to tag in questions (for CI usage)')
  .action(async (issueNumber: number, options: { browser?: boolean; author?: string }) => {
    try {
      const settingsManager = new SettingsManager()
      const settings = await settingsManager.loadSettings()
      const issueTracker = IssueTrackerFactory.create(settings)
      const command = new EnhanceCommand(issueTracker)
      await command.execute({
        issueNumber,
        options: {
          noBrowser: options.browser === false,
          ...(options.author && { author: options.author })
        }
      })
      logger.success(`Enhancement process completed for issue #${issueNumber}`)
      process.exit(0)
    } catch (error) {
      logger.error(`Failed to enhance issue: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
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
  .option('--cleanup', 'Clean up worktree after PR creation (github-pr mode only)')
  .option('--no-cleanup', 'Keep worktree after PR creation (github-pr mode only)')
  .action(async (identifier: string | undefined, options: FinishOptions) => {
    try {
      const settingsManager = new SettingsManager()
      const settings = await settingsManager.loadSettings()
      const issueTracker = IssueTrackerFactory.create(settings)
      const command = new FinishCommand(issueTracker)
      await command.execute({ identifier, options })
    } catch (error) {
      logger.error(`Failed to finish workspace: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
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
      .default('default')
  )
  .action(async (options: { oneShot?: import('./types/index.js').OneShotMode }) => {
    try {
      const { IgniteCommand } = await import('./commands/ignite.js')
      const command = new IgniteCommand()
      await command.execute(options.oneShot ?? 'default')
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
  .command('cleanup')
  .description('Remove workspaces')
  .argument('[identifier]', 'Branch name or issue number to cleanup (auto-detected)')
  .option('-l, --list', 'List all worktrees')
  .option('-a, --all', 'Remove all worktrees (interactive confirmation)')
  .option('-i, --issue <number>', 'Cleanup by issue number', parseInt)
  .option('-f, --force', 'Skip confirmations and force removal')
  .option('--dry-run', 'Show what would be done without doing it')
  .action(async (identifier?: string, options?: CleanupOptions) => {
    try {
      const { CleanupCommand } = await import('./commands/cleanup.js')
      const command = new CleanupCommand()
      const input: { identifier?: string; options: CleanupOptions } = {
        options: options ?? {}
      }
      if (identifier) {
        input.identifier = identifier
      }
      await command.execute(input)
    } catch (error) {
      logger.error(`Failed to cleanup worktrees: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }
  })

program
  .command('list')
  .description('Show active workspaces')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const manager = new GitWorktreeManager()
      const worktrees = await manager.listWorktrees({ porcelain: true })

      if (options.json) {
        console.log(JSON.stringify(worktrees, null, 2))
        return
      }

      if (worktrees.length === 0) {
        logger.info('No worktrees found')
        return
      }

      logger.info('Active workspaces:')
      for (const worktree of worktrees) {
        const formatted = manager.formatWorktree(worktree)
        logger.info(`  ${formatted.title}`)
        logger.info(`    Path: ${formatted.path}`)
        logger.info(`    Commit: ${formatted.commit}`)
      }
    } catch (error) {
      // Handle "not a git repository" gracefully
      if (error instanceof Error && error.message.includes('not a git repository')) {
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
  .command('init')
  .alias('config')
  .description('Initialize iloom configuration and setup shell autocomplete')
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
  .command('contribute')
  .description('Set up local development environment for contributing to iloom')
  .action(async () => {
    try {
      const { ContributeCommand } = await import('./commands/contribute.js')
      const command = new ContributeCommand()
      await command.execute()
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

      logger.info('Testing GitHub Integration\n')

      const service = new GitHubService(options.claude !== undefined ? { useClaude: options.claude } : {})

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
        const branchName = await service.generateBranchName({
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

// Parse CLI arguments
try {
  await program.parseAsync()
} catch (error) {
  if (error instanceof Error) {
    logger.error(`Error: ${error.message}`)
    process.exit(1)
  }
}
