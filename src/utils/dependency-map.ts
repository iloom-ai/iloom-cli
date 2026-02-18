/**
 * Dependency map builder for epic/swarm child issues
 *
 * Fetches dependency relationships between child issues from the
 * configured issue tracker provider and builds a DAG-compatible
 * dependency map.
 */

import { getIssueDependencies } from './github.js'
import { getLinearIssueDependencies } from './linear.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import { getLogger } from './logger-context.js'

/**
 * Build a dependency map for a set of child issues
 *
 * For each child issue, fetches its "blocked_by" dependencies from the
 * issue tracker API. Only sibling dependencies (within the child issue set)
 * are included — external blockers are filtered out.
 *
 * @param childIssueIds - Array of child issue IDs (e.g., ["101", "102", "103"])
 * @param settings - IloomSettings to determine which provider to use
 * @param repo - Optional repo in "owner/repo" format for GitHub
 * @returns Dependency map: Record<string, string[]> where key is issue ID
 *          and value is array of issue IDs that block it
 */
export async function buildDependencyMap(
  childIssueIds: string[],
  settings: IloomSettings,
  repo?: string,
): Promise<Record<string, string[]>> {
  const providerName = IssueTrackerFactory.getProviderName(settings)
  const childIdSet = new Set(childIssueIds)
  const dependencyMap: Record<string, string[]> = {}

  getLogger().debug('Building dependency map', { childIssueIds, provider: providerName })

  // Initialize all children with empty dependency arrays
  for (const id of childIssueIds) {
    dependencyMap[id] = []
  }

  // Fetch dependencies for each child in parallel
  const results = await Promise.allSettled(
    childIssueIds.map(async (childId) => {
      const blockers = await fetchBlockedBy(childId, providerName, repo)
      // Filter to only sibling dependencies
      const siblingBlockers = blockers.filter((blockerId) => childIdSet.has(blockerId))
      return { childId, siblingBlockers }
    }),
  )

  // Process results
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { childId, siblingBlockers } = result.value
      if (siblingBlockers.length > 0) {
        dependencyMap[childId] = siblingBlockers
      }
    } else {
      getLogger().warn(`Failed to fetch dependencies for a child issue`, { error: result.reason })
    }
  }

  return dependencyMap
}

/**
 * Fetch "blocked_by" dependencies for a single issue from the appropriate provider
 */
async function fetchBlockedBy(
  issueId: string,
  providerName: string,
  repo?: string,
): Promise<string[]> {
  switch (providerName) {
    case 'github': {
      const issueNumber = parseInt(issueId, 10)
      if (isNaN(issueNumber)) {
        getLogger().warn(`Invalid GitHub issue number: ${issueId}`)
        return []
      }
      const deps = await getIssueDependencies(issueNumber, 'blocked_by', repo)
      return deps.map((dep) => dep.id)
    }
    case 'linear': {
      const result = await getLinearIssueDependencies(issueId, 'blocked_by')
      return result.blockedBy.map((dep) => dep.id)
    }
    case 'jira':
      // Jira dependency fetching not yet implemented
      getLogger().debug(`Jira dependency fetching not yet supported for issue ${issueId}`)
      return []
    default:
      getLogger().warn(`Unsupported provider for dependency fetching: ${providerName}`)
      return []
  }
}
