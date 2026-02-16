/**
 * List children utilities for the --children flag in il list command
 *
 * This module handles:
 * - Fetching child issues from GitHub/Linear APIs
 * - Finding child looms by scanning metadata for parentLoom.branchName match
 * - Matching child issues to child looms bidirectionally
 * - Computing summary statistics
 */

import { MetadataManager, type LoomMetadata } from '../lib/MetadataManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import { getSubIssues } from './github.js'
import { getLinearChildIssues } from './linear.js'
import { logger } from './logger.js'
import { JiraApiClient } from '../lib/providers/jira/index.js'
import { escapeJql } from './jira.js'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Information about a child issue from the issue tracker API
 */
export interface ChildIssueInfo {
  id: string
  title: string
  url: string
  state: string
  hasActiveLoom: boolean
  loomBranch: string | null
}

/**
 * Information about a child loom from metadata
 */
export interface ChildLoomInfo {
  branch: string
  issueNumbers: string[]
  hasMatchingIssue: boolean
}

/**
 * Summary statistics for children
 */
export interface ChildrenSummary {
  totalIssues: number
  issuesWithLooms: number
  totalLooms: number
  orphanLooms: number
}

/**
 * Complete children data for a parent loom
 */
export interface ChildrenData {
  issues: ChildIssueInfo[]
  looms: ChildLoomInfo[]
  summary: ChildrenSummary
}

// ============================================================================
// Child Issue Fetching
// ============================================================================

/**
 * Raw child issue data from API (before matching with looms)
 */
interface RawChildIssue {
  id: string
  title: string
  url: string
  state: string
}

/**
 * Fetch child issues from the appropriate provider (GitHub or Linear)
 *
 * Uses Promise.allSettled for fault tolerance - API failures return empty array
 * with a warning logged rather than crashing.
 *
 * @param parentIssueNumber - The issue number/identifier of the parent
 * @param settings - IloomSettings to determine which provider to use
 * @param repo - Optional repo in "owner/repo" format for GitHub
 * @returns Array of raw child issues, or empty array on failure
 */
export async function fetchChildIssues(
  parentIssueNumber: string,
  settings: IloomSettings,
  repo?: string,
): Promise<RawChildIssue[]> {
  const providerName = IssueTrackerFactory.getProviderName(settings)

  logger.debug('Fetching child issues', { parentIssueNumber, provider: providerName, repo })

  // Use Promise.allSettled for fault tolerance
  const results = await Promise.allSettled([
    (async (): Promise<RawChildIssue[]> => {
      if (providerName === 'github') {
        // GitHub uses numeric issue numbers
        const issueNum = parseInt(parentIssueNumber, 10)
        if (isNaN(issueNum)) {
          logger.warn(`Invalid GitHub issue number: ${parentIssueNumber}`)
          return []
        }
        return getSubIssues(issueNum, repo)
      } else if (providerName === 'linear') {
        // Linear uses identifiers like "ENG-123"
        // Pass API token from settings since LinearService may not have been instantiated
        const apiToken = settings.issueManagement?.linear?.apiToken
        return getLinearChildIssues(parentIssueNumber, apiToken ? { apiToken } : undefined)
      } else if (providerName === 'jira') {
        // Jira uses issue keys like "PROJ-123"
        const jiraSettings = settings.issueManagement?.jira
        if (!jiraSettings?.host || !jiraSettings?.username || !jiraSettings?.apiToken) {
          logger.warn('Missing Jira settings (host, username, apiToken) for child issue fetch')
          return []
        }
        const client = new JiraApiClient({
          host: jiraSettings.host,
          username: jiraSettings.username,
          apiToken: jiraSettings.apiToken,
        })
        const issues = await client.searchIssues(`parent = "${escapeJql(parentIssueNumber)}"`)
        return issues.map(issue => ({
          id: issue.key,
          title: issue.fields.summary,
          url: `${jiraSettings.host.replace(/\/$/, '')}/browse/${issue.key}`,
          state: issue.fields.status.name.toLowerCase(),
        }))
      } else {
        logger.warn(`Unsupported issue tracker provider: ${providerName}`)
        return []
      }
    })(),
  ])

  // Extract result from Promise.allSettled
  const result = results[0]
  if (result.status === 'fulfilled') {
    return result.value
  } else {
    logger.warn(`Failed to fetch child issues for ${parentIssueNumber}`, { error: result.reason })
    return []
  }
}

// ============================================================================
// Child Loom Detection
// ============================================================================

/**
 * Find child looms by scanning metadata for parentLoom.branchName match
 *
 * Scans all active loom metadata and filters to those whose parentLoom.branchName
 * matches the given parent branch name.
 *
 * @param parentBranchName - The branch name of the parent loom
 * @param metadataManager - MetadataManager instance for reading loom metadata
 * @returns Array of LoomMetadata for child looms
 */
export async function findChildLooms(
  parentBranchName: string,
  metadataManager: MetadataManager,
): Promise<LoomMetadata[]> {
  logger.debug('Finding child looms', { parentBranchName })

  // Get all active loom metadata
  const allMetadata = await metadataManager.listAllMetadata()

  // Filter to looms where parentLoom.branchName matches
  const childLooms = allMetadata.filter((metadata) => {
    // Skip if no parentLoom field
    if (!metadata.parentLoom) {
      return false
    }

    // Match by parentLoom.branchName
    return metadata.parentLoom.branchName === parentBranchName
  })

  logger.debug(`Found ${childLooms.length} child looms for parent: ${parentBranchName}`)

  return childLooms
}

// ============================================================================
// Matching Logic
// ============================================================================

/**
 * Match child issues to child looms and compute summary statistics
 *
 * Performs bidirectional matching:
 * - For each child issue: check if any child loom has that issue number
 * - For each child loom: check if any child issue matches its issue_numbers
 *
 * @param childIssues - Raw child issues from API
 * @param childLooms - Child loom metadata
 * @returns ChildrenData with matched issues, looms, and summary
 */
export function matchChildrenData(
  childIssues: RawChildIssue[],
  childLooms: LoomMetadata[],
): ChildrenData {
  // Build a map of issue ID -> child loom for fast lookup
  const issueToLoomMap = new Map<string, LoomMetadata>()
  for (const loom of childLooms) {
    for (const issueNum of loom.issue_numbers) {
      issueToLoomMap.set(issueNum, loom)
    }
  }

  // Build a set of all issue IDs from child issues for fast lookup
  const childIssueIds = new Set(childIssues.map((issue) => issue.id))

  // Match child issues to looms
  const matchedIssues: ChildIssueInfo[] = childIssues.map((issue) => {
    const matchingLoom = issueToLoomMap.get(issue.id)
    return {
      id: issue.id,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      hasActiveLoom: matchingLoom != null,
      loomBranch: matchingLoom?.branchName ?? null,
    }
  })

  // Match child looms to issues
  const matchedLooms: ChildLoomInfo[] = childLooms.map((loom) => {
    // Check if any of the loom's issue_numbers match a child issue
    const hasMatchingIssue = loom.issue_numbers.some((issueNum) => childIssueIds.has(issueNum))
    return {
      branch: loom.branchName ?? '',
      issueNumbers: loom.issue_numbers,
      hasMatchingIssue,
    }
  })

  // Compute summary statistics
  const summary: ChildrenSummary = {
    totalIssues: matchedIssues.length,
    issuesWithLooms: matchedIssues.filter((issue) => issue.hasActiveLoom).length,
    totalLooms: matchedLooms.length,
    orphanLooms: matchedLooms.filter((loom) => !loom.hasMatchingIssue).length,
  }

  return {
    issues: matchedIssues,
    looms: matchedLooms,
    summary,
  }
}

// ============================================================================
// Orchestrator Function
// ============================================================================

/**
 * Assemble complete children data for a parent loom
 *
 * This is the main entry point that orchestrates:
 * 1. Fetching child issues from the API
 * 2. Finding child looms from metadata
 * 3. Matching and computing summary
 *
 * Returns null if the loom has no issue_numbers (nothing to fetch children for).
 * Uses Promise.allSettled internally for fault tolerance.
 *
 * @param parentLoom - The parent loom metadata
 * @param metadataManager - MetadataManager instance
 * @param settings - IloomSettings for determining provider
 * @param repo - Optional repo in "owner/repo" format for GitHub
 * @returns ChildrenData or null if no parent issue to query
 */
export async function assembleChildrenData(
  parentLoom: LoomMetadata,
  metadataManager: MetadataManager,
  settings: IloomSettings,
  repo?: string,
): Promise<ChildrenData | null> {
  // Can't fetch children if there's no parent issue
  if (!parentLoom.issue_numbers || parentLoom.issue_numbers.length === 0) {
    logger.debug('No issue_numbers on loom, skipping children fetch', {
      branch: parentLoom.branchName,
    })
    return null
  }

  // Can't fetch children if no branch name (can't match child looms)
  if (!parentLoom.branchName) {
    logger.debug('No branchName on loom, skipping children fetch')
    return null
  }

  // Use the first issue number as the parent for child issue fetching
  // Safe to access [0] since we already checked length > 0 above
  const parentIssueNumber = parentLoom.issue_numbers[0]
  if (parentIssueNumber === undefined) {
    // This should never happen given the length check above, but satisfies TypeScript
    return null
  }

  // Fetch child issues and find child looms in parallel for performance
  const [childIssues, childLooms] = await Promise.all([
    fetchChildIssues(parentIssueNumber, settings, repo),
    findChildLooms(parentLoom.branchName, metadataManager),
  ])

  // Match and return
  return matchChildrenData(childIssues, childLooms)
}
