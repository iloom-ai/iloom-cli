import { realpathSync } from 'fs'
import { extractIssueNumber } from './git.js'
import type { GitWorktree } from '../types/worktree.js'
import type { LoomMetadata, SwarmState } from '../lib/MetadataManager.js'
import type { ProjectCapability } from '../types/loom.js'

/**
 * Resolve a path through symlinks, falling back to the original path on error.
 */
function resolvePathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Reference to a parent loom for child looms
 * Matches the structure in LoomMetadata.parentLoom
 */
export interface ParentLoomRef {
  type: 'issue' | 'pr' | 'branch' | 'epic'
  identifier: string | number
  branchName: string
  worktreePath: string
  databaseBranch?: string
}

/**
 * Child issue data for JSON output
 */
export interface ChildIssueJson {
  id: string
  title: string
  url: string
  state: string
  hasActiveLoom: boolean
  loomBranch: string | null
}

/**
 * Child loom data for JSON output
 */
export interface ChildLoomJson {
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
 * Children data object for parent looms (only populated when --children flag is used)
 */
export interface ChildrenJson {
  issues: ChildIssueJson[]
  looms: ChildLoomJson[]
  summary: ChildrenSummary
}

/**
 * Swarm issue data for epic loom JSON output
 * Each child issue enriched with state and worktreePath from its loom metadata
 */
export interface SwarmIssue {
  number: string          // With prefix: "#123" (GitHub), "ENG-123" (Linear)
  title: string
  url: string
  state: SwarmState | null
  worktreePath: string | null
}

/**
 * JSON output schema for il list --json
 */
export interface LoomJsonOutput {
  name: string
  worktreePath: string | null
  branch: string | null
  type: 'branch' | 'issue' | 'pr' | 'epic'
  issue_numbers: string[]
  pr_numbers: string[]
  isMainWorktree: boolean
  description?: string | null
  created_at?: string | null
  issueTracker?: string | null
  colorHex?: string | null
  projectPath?: string | null
  issueUrls?: Record<string, string>
  prUrls?: Record<string, string>
  capabilities?: ProjectCapability[]
  status?: 'active' | 'finished'
  finishedAt?: string | null
  /** Swarm mode lifecycle state (null for non-swarm looms) */
  state?: SwarmState | null
  /** Whether this loom is a child of another loom (has a parentLoom) */
  isChildLoom: boolean
  /** Reference to the parent loom if this is a child loom */
  parentLoom: ParentLoomRef | null
  /** Children data (only populated when --children flag is used) */
  children?: ChildrenJson | null
  /** Swarm issues for epic looms (only present when type === 'epic') */
  swarmIssues?: SwarmIssue[] | null
  /** Dependency map for epic looms (only present when type === 'epic') */
  dependencyMap?: Record<string, string[]> | null
}

/**
 * Determine loom type from branch name and path patterns
 * Priority: PR (from path _pr_N suffix) > issue (from branch) > branch
 */
function determineLoomType(worktree: GitWorktree): 'branch' | 'issue' | 'pr' {
  // Check for PR pattern in path: _pr_N suffix
  // This pattern is added by generateWorktreePath when isPR is true
  const prPathPattern = /_pr_\d+$/
  if (prPathPattern.test(worktree.path)) {
    return 'pr'
  }

  // Check for issue pattern in branch using existing extractIssueNumber
  const issueNumber = extractIssueNumber(worktree.branch)
  if (issueNumber !== null) {
    return 'issue'
  }

  // Default to 'branch' type
  return 'branch'
}

/**
 * Extract PR numbers from worktree path
 * Returns array of string PR numbers extracted from _pr_N suffix
 */
function extractPRNumbers(path: string): string[] {
  if (!path) {
    return []
  }

  const prPathPattern = /_pr_(\d+)$/
  const match = path.match(prPathPattern)
  if (match?.[1]) {
    return [match[1]]
  }

  return []
}

/**
 * Extract issue numbers from branch name
 * Returns array of string identifiers (may include prefixes like PROJ-)
 */
function extractIssueNumbers(branch: string): string[] {
  if (!branch) {
    return []
  }

  const issueNumber = extractIssueNumber(branch)
  if (issueNumber === null) {
    return []
  }

  // Return as array, already deduplicated by being a single extraction
  return [issueNumber]
}

/**
 * Enrich child issues from epic metadata with state and worktreePath
 * by looking up each child's loom metadata from the provided metadata collection.
 * When a child loom is not found in active metadata, falls back to checking
 * finished/archived metadata to preserve state for cleaned-up child looms.
 *
 * @param childIssues - Child issues from epic metadata
 * @param allMetadata - All active loom metadata to search for child looms
 * @param finishedMetadata - Optional finished/archived loom metadata for fallback lookup
 * @param projectPath - Optional project path to scope metadata filtering (prevents cross-project collisions)
 * @returns Array of SwarmIssue with enriched state and worktreePath
 */
export function enrichSwarmIssues(
  childIssues: LoomMetadata['childIssues'],
  allMetadata: LoomMetadata[],
  finishedMetadata?: LoomMetadata[],
  projectPath?: string | null,
): SwarmIssue[] {
  // When projectPath is provided, filter metadata to only entries from the same project.
  // This prevents cross-project collisions where different projects share issue numbers.
  const resolvedProjectPath = projectPath ? resolvePathSafe(projectPath) : null
  const scopedActive = resolvedProjectPath
    ? allMetadata.filter(m => m.projectPath && resolvePathSafe(m.projectPath) === resolvedProjectPath)
    : allMetadata
  const scopedFinished = resolvedProjectPath && finishedMetadata
    ? finishedMetadata.filter(m => m.projectPath && resolvePathSafe(m.projectPath) === resolvedProjectPath)
    : finishedMetadata

  // Build a map of issue number -> metadata for fast lookup
  const issueNumberToMetadata = new Map<string, LoomMetadata>()
  for (const meta of scopedActive) {
    for (const issueNum of meta.issue_numbers) {
      issueNumberToMetadata.set(issueNum, meta)
    }
  }

  // Build a separate map for finished metadata (only used as fallback)
  const finishedIssueNumberToMetadata = new Map<string, LoomMetadata>()
  if (scopedFinished) {
    for (const meta of scopedFinished) {
      for (const issueNum of meta.issue_numbers) {
        finishedIssueNumberToMetadata.set(issueNum, meta)
      }
    }
  }

  return childIssues.map((child) => {
    // Strip the '#' prefix from GitHub issue numbers for lookup
    // e.g., "#123" -> "123", "ENG-123" stays as-is
    const lookupNumber = child.number.startsWith('#')
      ? child.number.slice(1)
      : child.number
    const childMeta = issueNumberToMetadata.get(lookupNumber)
      ?? finishedIssueNumberToMetadata.get(lookupNumber)

    return {
      number: child.number,
      title: child.title,
      url: child.url,
      state: childMeta?.state ?? null,
      worktreePath: childMeta?.worktreePath ?? null,
    }
  })
}

/**
 * Format single worktree to JSON schema
 * - When metadata is available, use metadata values for type, issue_numbers, pr_numbers
 * - When metadata is not available, derive values from worktree path/branch
 *
 * @param worktree - The worktree to format
 * @param mainWorktreePath - Optional path to the main worktree for isMainWorktree detection
 * @param metadata - Optional metadata from MetadataManager (preferred source when available)
 * @param allMetadata - Optional array of all active loom metadata (for enriching epic swarm issues)
 * @param finishedMetadata - Optional finished/archived metadata for fallback swarm issue enrichment
 */
export function formatLoomForJson(
  worktree: GitWorktree,
  mainWorktreePath?: string,
  metadata?: LoomMetadata | null,
  allMetadata?: LoomMetadata[],
  finishedMetadata?: LoomMetadata[],
): LoomJsonOutput {
  // Use metadata values when available, otherwise derive from worktree
  const loomType = metadata?.issueType ?? determineLoomType(worktree)

  // Use metadata arrays when available, otherwise extract from path/branch
  let issueNumbers: string[]
  let prNumbers: string[]

  if (metadata) {
    // Use metadata values directly
    issueNumbers = metadata.issue_numbers
    prNumbers = metadata.pr_numbers
  } else {
    // Derive from worktree path/branch
    issueNumbers = []
    prNumbers = []
    if (loomType === 'pr') {
      prNumbers = extractPRNumbers(worktree.path)
    } else if (loomType === 'issue') {
      issueNumbers = extractIssueNumbers(worktree.branch)
    }
  }

  // Determine if this is the main worktree by comparing paths
  const isMainWorktree = mainWorktreePath ? worktree.path === mainWorktreePath : false

  // Build swarmIssues and dependencyMap for epic looms
  const isEpic = loomType === 'epic'
  const swarmIssues = isEpic && metadata?.childIssues && metadata.childIssues.length > 0
    ? enrichSwarmIssues(metadata.childIssues, allMetadata ?? [], finishedMetadata, metadata?.projectPath)
    : isEpic ? [] : undefined
  const dependencyMap = isEpic
    ? (metadata?.dependencyMap && Object.keys(metadata.dependencyMap).length > 0
        ? metadata.dependencyMap
        : {})
    : undefined

  return {
    name: worktree.branch || worktree.path,
    worktreePath: worktree.bare ? null : worktree.path,
    branch: (metadata?.branchName ?? worktree.branch) || null,
    type: loomType,
    issue_numbers: issueNumbers,
    pr_numbers: prNumbers,
    isMainWorktree,
    description: metadata?.description ?? null,
    created_at: metadata?.created_at ?? null,
    issueTracker: metadata?.issueTracker ?? null,
    colorHex: metadata?.colorHex ?? null,
    projectPath: metadata?.projectPath ?? null,
    issueUrls: metadata?.issueUrls ?? {},
    prUrls: metadata?.prUrls ?? {},
    capabilities: metadata?.capabilities ?? [],
    state: metadata?.state ?? null,
    isChildLoom: metadata?.parentLoom != null,
    parentLoom: metadata?.parentLoom ?? null,
    ...(swarmIssues !== undefined && { swarmIssues }),
    ...(dependencyMap !== undefined && { dependencyMap }),
  }
}

/**
 * Format array of worktrees to JSON schema
 *
 * @param worktrees - Array of worktrees to format
 * @param mainWorktreePath - Optional path to the main worktree for isMainWorktree detection
 * @param metadata - Optional map of worktree paths to metadata
 * @param allMetadata - Optional array of all active loom metadata (for enriching epic swarm issues)
 * @param finishedMetadata - Optional finished/archived metadata for fallback swarm issue enrichment
 */
export function formatLoomsForJson(
  worktrees: GitWorktree[],
  mainWorktreePath?: string,
  metadata?: Map<string, LoomMetadata | null>,
  allMetadata?: LoomMetadata[],
  finishedMetadata?: LoomMetadata[],
): LoomJsonOutput[] {
  // If allMetadata not provided, derive from metadata map values
  const resolvedAllMetadata = allMetadata ?? (metadata
    ? Array.from(metadata.values()).filter((m): m is LoomMetadata => m != null)
    : [])
  return worktrees.map(wt => formatLoomForJson(wt, mainWorktreePath, metadata?.get(wt.path), resolvedAllMetadata, finishedMetadata))
}

/**
 * Format finished loom metadata to JSON schema
 *
 * Finished looms don't have an associated worktree, so we derive values from metadata.
 *
 * @param metadata - The finished loom metadata
 * @param allMetadata - Optional array of all active loom metadata (for enriching epic swarm issues)
 * @param finishedMetadata - Optional finished/archived metadata for fallback swarm issue enrichment
 */
export function formatFinishedLoomForJson(metadata: LoomMetadata, allMetadata?: LoomMetadata[], finishedMetadata?: LoomMetadata[]): LoomJsonOutput {
  // Use metadata values for type, default to 'branch' if not set
  const loomType = metadata.issueType ?? 'branch'

  // Build swarmIssues and dependencyMap for epic looms
  const isEpic = loomType === 'epic'
  const swarmIssues = isEpic && metadata.childIssues && metadata.childIssues.length > 0
    ? enrichSwarmIssues(metadata.childIssues, allMetadata ?? [], finishedMetadata, metadata.projectPath)
    : isEpic ? [] : undefined
  const dependencyMap = isEpic
    ? (metadata.dependencyMap && Object.keys(metadata.dependencyMap).length > 0
        ? metadata.dependencyMap
        : {})
    : undefined

  return {
    name: metadata.branchName ?? metadata.worktreePath ?? 'unknown',
    worktreePath: null, // Finished looms no longer have a worktree
    branch: metadata.branchName,
    type: loomType,
    issue_numbers: metadata.issue_numbers,
    pr_numbers: metadata.pr_numbers,
    isMainWorktree: false, // Finished looms are never the main worktree
    description: metadata.description ?? null,
    created_at: metadata.created_at ?? null,
    issueTracker: metadata.issueTracker ?? null,
    colorHex: metadata.colorHex ?? null,
    projectPath: metadata.projectPath ?? null,
    issueUrls: metadata.issueUrls ?? {},
    prUrls: metadata.prUrls ?? {},
    capabilities: metadata.capabilities ?? [],
    status: metadata.status ?? 'finished',
    finishedAt: metadata.finishedAt ?? null,
    state: metadata.state ?? null,
    isChildLoom: metadata.parentLoom != null,
    parentLoom: metadata.parentLoom ?? null,
    ...(swarmIssues !== undefined && { swarmIssues }),
    ...(dependencyMap !== undefined && { dependencyMap }),
  }
}
