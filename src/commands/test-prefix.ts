import { logger } from '../utils/logger.js'
import { generateWorktreePath } from '../utils/git.js'
import { SettingsManager } from '../lib/SettingsManager.js'

/**
 * Input structure for TestPrefixCommand.execute()
 */
export interface TestPrefixCommandInput {
  options: Record<string, never>
}

/**
 * Test command to preview worktree paths based on configured prefix
 * Demonstrates how different branch names will be resolved with current settings
 */
export class TestPrefixCommand {
  private readonly settingsManager: SettingsManager

  constructor(settingsManager?: SettingsManager) {
    this.settingsManager = settingsManager ?? new SettingsManager()
  }

  /**
   * Main entry point for the test-prefix command
   * Shows example worktree paths for different scenarios
   */
  public async execute(): Promise<void> {
    try {
      logger.info('Testing Worktree Prefix Configuration\n')

      // Display the current working directory
      const rootDir = process.cwd()
      logger.info(`Repository: ${rootDir}`)

      // Load settings from .iloom/settings.json
      const settings = await this.settingsManager.loadSettings()

      // Display configured prefix
      if (settings.worktreePrefix === undefined) {
        logger.info('Prefix: <default> (will calculate from repo name)')
      } else if (settings.worktreePrefix === '') {
        logger.info('Prefix: "" (no prefix mode)')
      } else {
        logger.info(`Prefix: "${settings.worktreePrefix}"`)
      }

      logger.info('')
      logger.info('Example Worktree Paths:\n')

      // Test examples
      const examples = [
        { branch: 'issue-123', label: 'Issue Branch', options: {} },
        { branch: 'issue-456', label: 'Issue Branch', options: { isPR: true, prNumber: 456 } },
        { branch: 'feature-auth', label: 'Regular Branch', options: {} },
      ]

      for (const example of examples) {
        const options = settings.worktreePrefix !== undefined
          ? { ...example.options, prefix: settings.worktreePrefix }
          : example.options

        const worktreePath = generateWorktreePath(
          example.branch,
          rootDir,
          options
        )

        const suffix = example.options.isPR ? ' (PR)' : ''
        logger.info(`  ${example.label}${suffix}: ${example.branch}`)
        logger.success(`  -> ${worktreePath}`)
        logger.info('')
      }

      logger.info('Tip: Edit .iloom/settings.json to change the worktreePrefix\n')
      logger.success('Test completed!')

    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Test failed: ${error.message}`)
      } else {
        logger.error('Test failed with unknown error')
      }
      throw error
    }
  }
}
