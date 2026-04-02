import { logger } from '../utils/logger.js'
import { resolveBareModeConfig } from '../utils/claude.js'
import { CommitManager } from '../lib/CommitManager.js'

/**
 * Test command to demonstrate bare mode commit message generation.
 * Uses the real CommitManager code path to generate a commit message.
 */
export class TestCommitMsgCommand {
  public async execute(): Promise<void> {
    logger.info('Testing Commit Message Generation (Bare Mode)\n')

    // Show bare mode resolution
    logger.info('Resolving bare mode configuration...')
    const config = await resolveBareModeConfig()

    if (config.bare && config.oauthToken) {
      logger.success('Using bare mode with OAuth token')
    } else if (config.bare) {
      logger.success('Using bare mode with API key')
    } else {
      logger.warn('Using standard mode (no bare)')
    }

    logger.info('')
    logger.info('Generating commit message via CommitManager...\n')

    const commitManager = new CommitManager()
    const worktreePath = process.cwd()

    const startTime = Date.now()
    const result = await commitManager.generateClaudeCommitMessage(
      worktreePath,
      undefined,
      '#'
    )
    const duration = Date.now() - startTime

    if (result) {
      logger.info('Generated commit message:')
      logger.info('---')
      logger.info(result)
      logger.info('---')
    } else {
      logger.warn('No commit message generated (Claude unavailable or failed)')
    }
    logger.success(`\nDuration: ${duration}ms`)
  }
}
