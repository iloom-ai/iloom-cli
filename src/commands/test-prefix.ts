import { logger } from '../utils/logger.js'
import { generateWorktreePath } from '../utils/git.js'

/**
 * Input structure for TestPrefixCommand.execute()
 */
export interface TestPrefixCommandInput {
  options: Record<string, never>
}

/**
 * Test command to preview worktree paths
 * Demonstrates how different branch names will be resolved under .iloom/worktrees/
 */
export class TestPrefixCommand {
  /**
   * Main entry point for the test-prefix command
   * Shows example worktree paths for different scenarios
   */
  public async execute(): Promise<void> {
    try {
      logger.info('Testing Worktree Path Configuration\n')

      // Display the current working directory
      const rootDir = process.cwd()
      logger.info(`Repository: ${rootDir}`)
      logger.info('Worktree location: .iloom/worktrees/ (under project root)')
      logger.info('')
      logger.info('Example Worktree Paths:\n')

      // Test examples
      const examples = [
        { branch: 'issue-123', label: 'Issue Branch', options: {} },
        { branch: 'issue-456', label: 'Issue Branch', options: { isPR: true, prNumber: 456 } },
        { branch: 'feature-auth', label: 'Regular Branch', options: {} },
      ]

      for (const example of examples) {
        const worktreePath = generateWorktreePath(
          example.branch,
          rootDir,
          example.options
        )

        const suffix = example.options.isPR ? ' (PR)' : ''
        logger.info(`  ${example.label}${suffix}: ${example.branch}`)
        logger.success(`  -> ${worktreePath}`)
        logger.info('')
      }

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
