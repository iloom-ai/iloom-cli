import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import crypto from 'crypto'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { findMainWorktreePathWithSettings } from '../utils/git.js'
import { fetchGitHubIssueList, fetchGitHubPRList } from '../utils/github.js'
import { fetchLinearIssueList } from '../utils/linear.js'
import { getLogger } from '../utils/logger-context.js'

/**
 * Unified output interface for issues from any provider
 */
export interface IssueListItem {
  id: string
  title: string
  updatedAt: string
  url: string
  state: string
  type?: 'issue' | 'pr'
}

/**
 * File-based cache structure (follows UpdateNotifier pattern)
 */
interface IssuesCacheFile {
  timestamp: number    // Date.now() when cached
  projectPath: string  // for verification
  provider: string     // 'github' | 'linear'
  data: IssueListItem[]
}

// Cache configuration
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes
const CACHE_DIR = path.join(os.homedir(), '.config', 'iloom-ai', 'cache')

/**
 * Generate a deterministic cache file path from project path + provider
 */
function getCacheFilePath(projectPath: string, provider: string, limit: number): string {
  const hash = crypto.createHash('md5').update(`${projectPath}:${provider}:${limit}`).digest('hex').slice(0, 12)
  return path.join(CACHE_DIR, `issues-${hash}.json`)
}

/**
 * Read cache file, return null if missing/expired/corrupted
 * Follows UpdateNotifier.getCachedCheck pattern
 */
async function readCacheFile(cacheFilePath: string): Promise<IssueListItem[] | null> {
  try {
    if (!fs.existsSync(cacheFilePath)) return null
    const content = await fs.readFile(cacheFilePath, 'utf8')
    const cache = JSON.parse(content) as IssuesCacheFile
    if (Date.now() - cache.timestamp < CACHE_TTL_MS) return cache.data
    return null // expired
  } catch {
    return null // corrupted or unreadable, treat as cache miss
  }
}

/**
 * Write cache file following UpdateNotifier.saveCacheFile pattern
 */
async function writeCacheFile(
  cacheFilePath: string,
  data: IssueListItem[],
  projectPath: string,
  provider: string,
): Promise<void> {
  try {
    await fs.ensureDir(CACHE_DIR)
    const cache: IssuesCacheFile = { timestamp: Date.now(), projectPath, provider, data }
    await fs.writeFile(cacheFilePath, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    // Cache write failure is non-fatal, just log debug
    getLogger().debug(`Failed to write issues cache to ${cacheFilePath}`)
  }
}

export interface IssuesCommandOptions {
  projectPath?: string | undefined
  limit?: number | undefined
}

/**
 * IssuesCommand: List open issues from the configured issue tracker
 *
 * Returns JSON array of issues. Uses file-based caching with ~2 minute TTL.
 * Follows the ProjectsCommand pattern for structure.
 */
export class IssuesCommand {
  private readonly settingsManager: SettingsManager

  constructor(settingsManager?: SettingsManager) {
    this.settingsManager = settingsManager ?? new SettingsManager()
  }

  /**
   * Execute the issues command
   * @param options - Command options
   * @returns Array of issue list items
   */
  async execute(options?: IssuesCommandOptions): Promise<IssueListItem[]> {
    const logger = getLogger()
    const limit = options?.limit ?? 100

    // 1. Resolve project root
    let resolvedProjectPath: string
    if (options?.projectPath) {
      resolvedProjectPath = options.projectPath
    } else {
      try {
        resolvedProjectPath = await findMainWorktreePathWithSettings()
      } catch {
        logger.debug('Failed to resolve worktree path, falling back to cwd')
        resolvedProjectPath = process.cwd()
      }
    }

    // 2. Load settings from resolved root
    const settings = await this.settingsManager.loadSettings(resolvedProjectPath)

    // 3. Determine provider
    const provider = IssueTrackerFactory.getProviderName(settings)

    // 4. Check file-based cache
    const cacheFilePath = getCacheFilePath(resolvedProjectPath, provider, limit)
    const cached = await readCacheFile(cacheFilePath)
    if (cached !== null) {
      logger.debug(`Returning cached issues (${cached.length} items)`)
      // Backfill type field for cache entries from before PR support was added
      return cached.map(item => ({ type: 'issue' as const, ...item }))
    }

    // 5. Fetch issues based on provider
    let results: IssueListItem[]

    if (provider === 'github') {
      results = await fetchGitHubIssueList({
        limit,
        cwd: resolvedProjectPath,
      })
    } else if (provider === 'linear') {
      const teamId = settings.issueManagement?.linear?.teamId
      if (!teamId) {
        throw new Error(
          'Linear team ID not configured. Set issueManagement.linear.teamId in your settings.json.',
        )
      }
      const apiToken = settings.issueManagement?.linear?.apiToken ?? process.env.LINEAR_API_TOKEN
      results = await fetchLinearIssueList(teamId, {
        limit,
        ...(apiToken ? { apiToken } : {}),
      })
    } else {
      throw new Error(`Unsupported issue tracker provider: ${provider}`)
    }

    // Tag issues with type
    results.forEach(item => { item.type = 'issue' })

    // 6. Fetch PRs from GitHub (PRs are a GitHub concept regardless of issue tracker)
    try {
      const prs = await fetchGitHubPRList({
        limit,
        cwd: resolvedProjectPath,
      })
      const prItems: IssueListItem[] = prs.map(pr => ({ ...pr, type: 'pr' as const }))
      results = [...results, ...prItems]
    } catch (error) {
      // Only catch expected, non-fatal errors from gh CLI
      // Per CLAUDE.md: "DO NOT SWALLOW ERRORS" -- must check specifically
      const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ''
      const isExpectedError = error instanceof Error && (
        error.message.includes('not logged in') ||
        error.message.includes('auth login') ||
        error.message.includes('rate limit') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ECONNREFUSED') ||
        stderr.includes('not logged in') ||
        stderr.includes('rate limit')
      )
      if (isExpectedError) {
        logger.warn(`PR fetch failed (non-fatal), continuing with issues only: ${error.message}`)
      } else {
        throw error // Re-throw unexpected errors -- do not swallow
      }
    }

    // 7. Sort by updatedAt descending and apply limit
    results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    results = results.slice(0, limit)

    // 8. Write results to cache file
    await writeCacheFile(cacheFilePath, results, resolvedProjectPath, provider)

    return results
  }
}
