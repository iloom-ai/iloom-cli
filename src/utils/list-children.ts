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
import type { IssueTracker } from '../lib/IssueTracker.js'
import { logger } from './logger.js'

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
 * Fetch child issues from the appropriate provider via IssueTracker interface
 *
 * Uses Promise.allSettled for fault tolerance - API failures return empty array
 * with a warning logged rather than crashing.
 *
 * @param parentIssueNumber - The issue number/identifier of the parent
 * @param issueTracker - IssueTracker instance to delegate to
 * @param repo - Optional repo in "owner/repo" format for GitHub
 * @returns Array of raw child issues, or empty array on failure
 */
export async function fetchChildIssues(
  parentIssueNumber: string,
  issueTracker: IssueTracker,
  repo?: string,
): Promise<RawChildIssue[]> {
  logger.debug('Fetching child issues', { parentIssueNumber, provider: issueTracker.providerName, repo })

  try {
    return await issueTracker.getChildIssues(parentIssueNumber, repo)
  } catch (error) {
    logger.warn(`Failed to fetch child issues for ${parentIssueNumber}`, { error })
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
 * @param issueTracker - IssueTracker instance for fetching child issues
 * @param repo - Optional repo in "owner/repo" format for GitHub
 * @returns ChildrenData or null if no parent issue to query
 */
export async function assembleChildrenData(
  parentLoom: LoomMetadata,
  metadataManager: MetadataManager,
  issueTracker: IssueTracker,
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
    fetchChildIssues(parentIssueNumber, issueTracker, repo),
    findChildLooms(parentLoom.branchName, metadataManager),
  ])

  // Match and return
  return matchChildrenData(childIssues, childLooms)
}

// ============================================================================
// Child Issue Details (for epic metadata persistence)
// ============================================================================

/**
 * Child issue detail for persistence in epic metadata
 */
export interface ChildIssueDetail {
  number: string   // Prefixed: "#123" for GitHub, "ENG-123" for Linear
  title: string
  body: string
  url: string
}

/**
 * Fetch child issue details with body content and properly-prefixed numbers
 *
 * Unlike fetchChildIssues (which returns minimal data for list display),
 * this function fetches full issue details including body/description
 * and formats the issue number with the appropriate provider prefix.
 *
 * @param parentIssueNumber - The parent issue number/identifier
 * @param issueTracker - IssueTracker instance for fetching full issue details
 * @param repo - Optional repo in "owner/repo" format for GitHub
 * @returns Array of child issue details, or empty array on failure
 */
export async function fetchChildIssueDetails(
  parentIssueNumber: string,
  issueTracker: IssueTracker,
  repo?: string,
): Promise<ChildIssueDetail[]> {
  const providerName = issueTracker.providerName

  logger.debug('Fetching child issue details', { parentIssueNumber, provider: providerName })

  // First fetch the list of child issues (lightweight)
  const childIssues = await fetchChildIssues(parentIssueNumber, issueTracker, repo)

  if (childIssues.length === 0) {
    return []
  }

  // Fetch full details for each child in parallel
  const results = await Promise.allSettled(
    childIssues.map(async (child): Promise<ChildIssueDetail> => {
      try {
        const fullIssue = await issueTracker.fetchIssue(child.id, repo)
        return {
          number: formatIssueNumber(child.id, providerName),
          title: fullIssue.title,
          body: fullIssue.body,
          url: child.url,
        }
      } catch {
        // Fall back to data from child list if full fetch fails
        return {
          number: formatIssueNumber(child.id, providerName),
          title: child.title,
          body: '',
          url: child.url,
        }
      }
    }),
  )

  // Collect fulfilled results
  const details: ChildIssueDetail[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      details.push(result.value)
    } else {
      logger.warn('Failed to fetch details for a child issue', { error: result.reason })
    }
  }

  return details
}

/**
 * Format an issue number with the appropriate provider prefix
 *
 * @param issueId - Raw issue ID (e.g., "123" for GitHub, "ENG-123" for Linear)
 * @param providerName - Provider type
 * @returns Prefixed number: "#123" for GitHub, "ENG-123" for Linear (already prefixed)
 */
function formatIssueNumber(issueId: string, providerName: string): string {
  if (providerName === 'github') {
    return `#${issueId}`
  }
  // Linear and Jira identifiers are already prefixed (e.g., "ENG-123", "PROJ-456")
  return issueId
}
