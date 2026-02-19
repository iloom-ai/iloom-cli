import { logger } from '../utils/logger.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import type { IssueManagementProvider } from '../mcp/types.js'

/**
 * Test command for Jira integration
 * Tests various Jira API operations against a real Jira instance
 */
export class TestJiraCommand {
  private readonly settingsManager: SettingsManager

  constructor(settingsManager?: SettingsManager) {
    this.settingsManager = settingsManager ?? new SettingsManager()
  }

  private async createProvider(): Promise<IssueManagementProvider> {
    const settings = await this.settingsManager.loadSettings()
    return IssueManagementProviderFactory.create('jira', settings)
  }

  async createChildIssue(parentKey: string): Promise<void> {
    const provider = await this.createProvider()

    logger.info(`Creating test child issue under ${parentKey}...`)
    const result = await provider.createChildIssue({
      parentId: parentKey,
      title: `[Test] Child issue of ${parentKey}`,
      body: 'This is a test child issue created by iloom test-jira.',
    })

    logger.success(`Child issue created: ${result.id}`)
    logger.info(`  URL: ${result.url}`)
  }

  async createDependency(blockingKey: string, blockedKey: string): Promise<void> {
    const provider = await this.createProvider()

    logger.info(`Creating dependency: ${blockingKey} blocks ${blockedKey}...`)
    await provider.createDependency({
      blockingIssue: blockingKey,
      blockedIssue: blockedKey,
    })

    logger.success(`Dependency created: ${blockingKey} blocks ${blockedKey}`)
  }

  async getDependencies(issueKey: string): Promise<void> {
    const provider = await this.createProvider()

    logger.info(`Fetching dependencies for ${issueKey}...`)
    const result = await provider.getDependencies({
      number: issueKey,
      direction: 'both',
    })

    logger.info(`Blocking (${issueKey} blocks):`)
    if (result.blocking.length === 0) {
      logger.info('  (none)')
    } else {
      for (const dep of result.blocking) {
        logger.info(`  ${dep.id}: ${dep.title} [${dep.state}]`)
      }
    }

    logger.info(`Blocked by (blocks ${issueKey}):`)
    if (result.blockedBy.length === 0) {
      logger.info('  (none)')
    } else {
      for (const dep of result.blockedBy) {
        logger.info(`  ${dep.id}: ${dep.title} [${dep.state}]`)
      }
    }
  }

  async removeDependency(blockingKey: string, blockedKey: string): Promise<void> {
    const provider = await this.createProvider()

    logger.info(`Removing dependency: ${blockingKey} blocks ${blockedKey}...`)
    await provider.removeDependency({
      blockingIssue: blockingKey,
      blockedIssue: blockedKey,
    })

    logger.success(`Dependency removed: ${blockingKey} no longer blocks ${blockedKey}`)
  }

  async getChildIssues(issueKey: string): Promise<void> {
    const provider = await this.createProvider()

    logger.info(`Fetching child issues of ${issueKey}...`)
    const children = await provider.getChildIssues({ number: issueKey })

    if (children.length === 0) {
      logger.info('No child issues found')
    } else {
      logger.info(`Child issues (${children.length}):`)
      for (const child of children) {
        logger.info(`  ${child.id}: ${child.title} [${child.state}] ${child.url}`)
      }
    }
  }
}
