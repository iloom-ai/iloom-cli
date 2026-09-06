import { logger } from '../utils/logger.js'
import { CommitManager } from '../lib/CommitManager.js'

/**
 * Test command to demonstrate commit message generation.
 * Uses the real CommitManager code path (default, non-bare launch).
 */
export class TestCommitMsgCommand {
  public async execute(): Promise<void> {
    logger.info('Testing Commit Message Generation\n')
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
