import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { getLogger } from '../utils/logger-context.js'
import type { ProjectCapability } from '../types/loom.js'
import type { OneShotMode } from '../types/index.js'

export type SwarmState = 'pending' | 'in_progress' | 'code_review' | 'done' | 'failed'

/**
 * Schema for metadata JSON file
 * Stored in ~/.config/iloom-ai/looms/
 */
export interface MetadataFile {
  description: string
  created_at?: string
  version: number
  // Additional metadata fields (v2)
  branchName?: string
  worktreePath?: string
  issueType?: 'branch' | 'issue' | 'pr' | 'epic'
  issueKey?: string // Canonical, properly-cased issue key (e.g., "PROJ-123")
  issue_numbers?: string[]
  pr_numbers?: string[]
  issueTracker?: string
  colorHex?: string // Stored hex color (e.g., "#dcebff") - robust against palette changes
  sessionId?: string // Claude Code session ID for resume support
  projectPath?: string // Main worktree path (project root) - enables project identification
  issueUrls?: Record<string, string> // Map of issue ID to URL in the issue tracker
  prUrls?: Record<string, string> // Map of PR number to URL in the issue tracker
  draftPrNumber?: number // Draft PR number if github-draft-pr mode was used
  oneShot?: OneShotMode // One-shot automation mode stored during loom creation
  capabilities?: ProjectCapability[] // Detected project capabilities
  state?: SwarmState // Swarm mode lifecycle state
  childIssueNumbers?: string[] // Child issue numbers for epic looms
  parentLoom?: {
    type: 'issue' | 'pr' | 'branch' | 'epic'
    identifier: string | number
    branchName: string
    worktreePath: string
    databaseBranch?: string
  }
  // Epic/swarm child issue data (populated during spin setup)
  childIssues?: Array<{
    number: string   // Prefixed: "#123" for GitHub, "ENG-123" for Linear
    title: string
    body: string
    url: string
  }>
  dependencyMap?: Record<string, string[]> // issueNumber -> array of blocking issueNumbers
  mcpConfigPath?: string // Path to per-loom MCP config file (for swarm claude -p commands)
}

/**
 * Input for writing metadata (all fields except version and created_at)
 * Note: issueTracker is required because every loom should have an associated
 * issue tracker provider (defaults to 'github' via IssueTrackerFactory)
 */
export interface WriteMetadataInput {
  description: string
  branchName: string
  worktreePath: string
  issueType: 'branch' | 'issue' | 'pr' | 'epic'
  issueKey?: string // Canonical, properly-cased issue key (e.g., "PROJ-123")
  issue_numbers: string[]
  pr_numbers: string[]
  issueTracker: string
  colorHex: string // Hex color (e.g., "#dcebff") - robust against palette changes
  sessionId: string // Claude Code session ID for resume support (required for new looms)
  projectPath: string // Main worktree path (project root) - required for new looms
  issueUrls: Record<string, string> // Map of issue ID to URL in the issue tracker
  prUrls: Record<string, string> // Map of PR number to URL in the issue tracker
  draftPrNumber?: number // Draft PR number for github-draft-pr mode
  oneShot?: OneShotMode // One-shot automation mode to persist
  capabilities: ProjectCapability[] // Detected project capabilities (required for new looms)
  state?: SwarmState // Swarm mode lifecycle state
  childIssueNumbers?: string[] // Child issue numbers for epic looms
  parentLoom?: {
    type: 'issue' | 'pr' | 'branch' | 'epic'
    identifier: string | number
    branchName: string
    worktreePath: string
    databaseBranch?: string
  }
  // Epic/swarm child issue data (populated during spin setup)
  childIssues?: Array<{
    number: string   // Prefixed: "#123" for GitHub, "ENG-123" for Linear
    title: string
    body: string
    url: string
  }>
  dependencyMap?: Record<string, string[]> // issueNumber -> array of blocking issueNumbers
  mcpConfigPath?: string // Path to per-loom MCP config file (for swarm claude -p commands)
}

/**
 * Result of reading metadata for a worktree
 */
export interface LoomMetadata {
  status?: 'active' | 'finished'
  finishedAt?: string | null
  description: string
  created_at: string | null
  branchName: string | null
  worktreePath: string | null
  issueType: 'branch' | 'issue' | 'pr' | 'epic' | null
  issueKey: string | null // Canonical, properly-cased issue key (e.g., "PROJ-123")
  issue_numbers: string[]
  pr_numbers: string[]
  issueTracker: string | null
  colorHex: string | null // Hex color (e.g., "#dcebff") - robust against palette changes
  sessionId: string | null // Claude Code session ID (null for legacy looms)
  projectPath: string | null // Main worktree path (null for legacy looms)
  issueUrls: Record<string, string> // Map of issue ID to URL ({} for legacy looms)
  prUrls: Record<string, string> // Map of PR number to URL ({} for legacy looms)
  draftPrNumber: number | null // Draft PR number (null if not draft mode)
  oneShot: OneShotMode | null // One-shot mode (null for legacy looms)
  capabilities: ProjectCapability[] // Detected project capabilities (empty for legacy looms)
  state: SwarmState | null // Swarm mode lifecycle state (null for non-swarm looms)
  childIssueNumbers: string[] // Child issue numbers for epic looms (empty for non-epic looms)
  parentLoom: {
    type: 'issue' | 'pr' | 'branch' | 'epic'
    identifier: string | number
    branchName: string
    worktreePath: string
    databaseBranch?: string
  } | null
  // Epic/swarm child issue data (empty arrays/objects for non-epic looms)
  childIssues: Array<{
    number: string
    title: string
    body: string
    url: string
  }>
  dependencyMap: Record<string, string[]>
  mcpConfigPath: string | null // Path to per-loom MCP config file (null for non-swarm looms)
}

/**
 * MetadataManager: Manage loom metadata persistence
 *
 * Stores loom metadata in ~/.config/iloom-ai/looms/ directory.
 * Each worktree gets a JSON file named by slugifying its absolute path.
 *
 * Per spec section 2.2:
 * - Filename derived from worktree absolute path
 * - Path separators replaced with double underscores
 * - Non-alphanumeric chars (except _ and -) replaced with hyphens
 */
export class MetadataManager {
  private readonly loomsDir: string
  private readonly finishedDir: string

  constructor() {
    this.loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms')
    this.finishedDir = path.join(this.loomsDir, 'finished')
  }

  /**
   * Convert MetadataFile to LoomMetadata with default values for optional fields
   */
  private toMetadata(data: MetadataFile): LoomMetadata {
    return {
      description: data.description,
      created_at: data.created_at ?? null,
      branchName: data.branchName ?? null,
      worktreePath: data.worktreePath ?? null,
      issueType: data.issueType ?? null,
      issueKey: data.issueKey ?? null,
      issue_numbers: data.issue_numbers ?? [],
      pr_numbers: data.pr_numbers ?? [],
      issueTracker: data.issueTracker ?? null,
      colorHex: data.colorHex ?? null,
      sessionId: data.sessionId ?? null,
      projectPath: data.projectPath ?? null,
      issueUrls: data.issueUrls ?? {},
      prUrls: data.prUrls ?? {},
      draftPrNumber: data.draftPrNumber ?? null,
      oneShot: data.oneShot ?? null,
      capabilities: data.capabilities ?? [],
      state: data.state ?? null,
      childIssueNumbers: data.childIssueNumbers ?? [],
      parentLoom: data.parentLoom ?? null,
      childIssues: data.childIssues ?? [],
      dependencyMap: data.dependencyMap ?? {},
      mcpConfigPath: data.mcpConfigPath ?? null,
    }
  }

  /**
   * Convert worktree path to filename slug per spec section 2.2
   *
   * Algorithm:
   * 1. Trim trailing slashes
   * 2. Replace all path separators (/ or \) with __ (double underscore)
   * 3. Replace any other non-alphanumeric characters (except _ and -) with -
   * 4. Append .json
   *
   * Example:
   * - Worktree: /Users/jane/dev/repo
   * - Filename: _Users__jane__dev__repo.json
   */
  slugifyPath(worktreePath: string): string {
    // 1. Trim trailing slashes
    let slug = worktreePath.replace(/[/\\]+$/, '')

    // 2. Replace path separators with triple underscores
    slug = slug.replace(/[/\\]/g, '___')

    // 3. Replace non-alphanumeric chars (except _ and -) with hyphens
    slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')

    // 4. Append .json
    return `${slug}.json`
  }

  /**
   * Get the full path to the metadata file for a worktree
   */
  private getFilePath(worktreePath: string): string {
    const filename = this.slugifyPath(worktreePath)
    return path.join(this.loomsDir, filename)
  }

  /**
   * Get the full path to the metadata file for a worktree (public API)
   * Used by other services that need to reference the metadata file location
   * (e.g., MCP servers that need to read loom context)
   */
  getMetadataFilePath(worktreePath: string): string {
    return this.getFilePath(worktreePath)
  }

  /**
   * Write metadata for a worktree (spec section 3.1)
   *
   * @param worktreePath - Absolute path to the worktree (used for file naming)
   * @param input - Metadata to write (description plus additional fields)
   */
  async writeMetadata(worktreePath: string, input: WriteMetadataInput): Promise<void> {
    try {
      // 1. Ensure looms directory exists
      await fs.ensureDir(this.loomsDir, { mode: 0o755 })

      // 2. Create JSON content
      const content: MetadataFile = {
        description: input.description,
        created_at: new Date().toISOString(),
        version: 1,
        branchName: input.branchName,
        worktreePath: input.worktreePath,
        issueType: input.issueType,
        ...(input.issueKey && { issueKey: input.issueKey }),
        issue_numbers: input.issue_numbers,
        pr_numbers: input.pr_numbers,
        issueTracker: input.issueTracker,
        colorHex: input.colorHex,
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        issueUrls: input.issueUrls,
        prUrls: input.prUrls,
        capabilities: input.capabilities,
        ...(input.draftPrNumber && { draftPrNumber: input.draftPrNumber }),
        ...(input.oneShot && { oneShot: input.oneShot }),
        ...(input.state && { state: input.state }),
        ...(input.childIssueNumbers && input.childIssueNumbers.length > 0 && { childIssueNumbers: input.childIssueNumbers }),
        ...(input.parentLoom && { parentLoom: input.parentLoom }),
        ...(input.childIssues && input.childIssues.length > 0 && { childIssues: input.childIssues }),
        ...(input.dependencyMap && Object.keys(input.dependencyMap).length > 0 && { dependencyMap: input.dependencyMap }),
        ...(input.mcpConfigPath && { mcpConfigPath: input.mcpConfigPath }),
      }

      // 3. Write to slugified filename
      const filePath = this.getFilePath(worktreePath)
      await fs.writeFile(filePath, JSON.stringify(content, null, 2), { mode: 0o644 })

      getLogger().debug(`Metadata written for worktree: ${worktreePath}`)
    } catch (error) {
      // Log warning but don't throw - metadata is supplementary
      getLogger().warn(
        `Failed to write metadata for worktree: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Read metadata for a worktree (spec section 3.2)
   *
   * @param worktreePath - Absolute path to the worktree
   * @returns The metadata object with all fields, or null if not found/invalid
   */
  async readMetadata(worktreePath: string): Promise<LoomMetadata | null> {
    try {
      const filePath = this.getFilePath(worktreePath)

      // Check if file exists
      if (!(await fs.pathExists(filePath))) {
        return null
      }

      // Read and parse JSON
      const content = await fs.readFile(filePath, 'utf8')
      const data: MetadataFile = JSON.parse(content)

      if (!data.description) {
        return null
      }

      return this.toMetadata(data)
    } catch (error) {
      // Return null on any error (graceful degradation per spec)
      getLogger().debug(
        `Could not read metadata for worktree ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * List all stored loom metadata files
   *
   * Returns an array of LoomMetadata objects for all valid metadata files
   * in the looms directory. Invalid or unreadable files are skipped.
   *
   * @returns Array of LoomMetadata objects from all stored files
   */
  async listAllMetadata(): Promise<LoomMetadata[]> {
    const results: LoomMetadata[] = []

    try {
      // Check if looms directory exists
      if (!(await fs.pathExists(this.loomsDir))) {
        return results
      }

      // Read all files in looms directory
      const files = await fs.readdir(this.loomsDir)

      // Filter to only .json files and read each
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue
        }

        try {
          const filePath = path.join(this.loomsDir, file)
          const content = await fs.readFile(filePath, 'utf8')
          const data: MetadataFile = JSON.parse(content)

          // Skip files without required description field
          if (!data.description) {
            continue
          }

          results.push(this.toMetadata(data))
        } catch (error) {
          // Skip individual files that fail to parse (graceful degradation)
          getLogger().debug(
            `Skipping metadata file ${file}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch (error) {
      // Log error but return empty array (graceful degradation)
      getLogger().debug(
        `Could not list metadata files: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return results
  }

  /**
   * Update existing metadata for a worktree by merging new fields
   *
   * Reads the existing metadata file, merges the provided updates,
   * and writes back. Only provided fields are overwritten.
   *
   * @param worktreePath - Absolute path to the worktree
   * @param updates - Partial metadata fields to merge
   */
  async updateMetadata(worktreePath: string, updates: Partial<MetadataFile>): Promise<void> {
    try {
      const filePath = this.getFilePath(worktreePath)

      // Check if file exists
      if (!(await fs.pathExists(filePath))) {
        getLogger().warn(`No metadata file to update for worktree: ${worktreePath}`)
        return
      }

      // Read existing data
      const content = await fs.readFile(filePath, 'utf8')
      const data: MetadataFile = JSON.parse(content)

      // Merge updates
      const merged = { ...data, ...updates }

      // Write back
      await fs.writeFile(filePath, JSON.stringify(merged, null, 2), { mode: 0o644 })

      getLogger().debug(`Metadata updated for worktree: ${worktreePath}`)
    } catch (error) {
      getLogger().warn(
        `Failed to update metadata for worktree: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  }

  /**
   * Delete metadata for a worktree (spec section 3.3)
   *
   * Idempotent: silently succeeds if file doesn't exist
   * Non-fatal: logs warning on permission errors but doesn't throw
   *
   * @param worktreePath - Absolute path to the worktree
   */
  async deleteMetadata(worktreePath: string): Promise<void> {
    try {
      const filePath = this.getFilePath(worktreePath)

      // Check if file exists - silently return if not
      if (!(await fs.pathExists(filePath))) {
        getLogger().debug(`No metadata file to delete for worktree: ${worktreePath}`)
        return
      }

      // Delete the file
      await fs.unlink(filePath)
      getLogger().debug(`Metadata deleted for worktree: ${worktreePath}`)
    } catch (error) {
      // Log warning on permission error but don't throw (per spec section 3.3)
      getLogger().warn(
        `Failed to delete metadata for worktree: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Archive metadata for a finished worktree
   *
   * Moves the metadata file to the finished/ subdirectory and adds
   * status: 'finished' and finishedAt timestamp fields.
   *
   * Idempotent: silently succeeds if source file doesn't exist
   * Non-fatal: logs warning on errors but doesn't throw
   *
   * @param worktreePath - Absolute path to the worktree
   */
  async archiveMetadata(worktreePath: string): Promise<void> {
    try {
      const filename = this.slugifyPath(worktreePath)
      const sourcePath = path.join(this.loomsDir, filename)

      // Check if source file exists - silently return if not (idempotent)
      if (!(await fs.pathExists(sourcePath))) {
        getLogger().debug(`No metadata file to archive for worktree: ${worktreePath}`)
        return
      }

      // Read existing metadata
      const content = await fs.readFile(sourcePath, 'utf8')
      const data: MetadataFile = JSON.parse(content)

      // Add finished status and timestamp
      const finishedData = {
        ...data,
        status: 'finished' as const,
        finishedAt: new Date().toISOString(),
      }

      // Ensure finished directory exists
      await fs.ensureDir(this.finishedDir, { mode: 0o755 })

      // Write to finished subdirectory
      const destPath = path.join(this.finishedDir, filename)
      await fs.writeFile(destPath, JSON.stringify(finishedData, null, 2), { mode: 0o644 })

      // Delete original file
      await fs.unlink(sourcePath)

      getLogger().debug(`Metadata archived for worktree: ${worktreePath}`)
    } catch (error) {
      // Log warning but don't throw - archiving is supplementary
      getLogger().warn(
        `Failed to archive metadata for worktree: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * List all finished loom metadata files
   *
   * Returns an array of LoomMetadata objects for all finished looms
   * in the finished/ subdirectory, sorted by finishedAt in descending order
   * (most recently finished first).
   *
   * @returns Array of LoomMetadata objects from finished files, sorted by finishedAt desc
   */
  async listFinishedMetadata(): Promise<LoomMetadata[]> {
    const results: LoomMetadata[] = []

    try {
      // Check if finished directory exists
      if (!(await fs.pathExists(this.finishedDir))) {
        return results
      }

      // Read all files in finished directory
      const files = await fs.readdir(this.finishedDir)

      // Filter to only .json files and read each
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue
        }

        try {
          const filePath = path.join(this.finishedDir, file)
          const content = await fs.readFile(filePath, 'utf8')
          const data = JSON.parse(content) as MetadataFile & { status?: string; finishedAt?: string }

          // Skip files without required description field
          if (!data.description) {
            continue
          }

          const metadata = this.toMetadata(data)
          // Add finished-specific fields
          metadata.status = (data.status as 'active' | 'finished') ?? 'finished'
          metadata.finishedAt = data.finishedAt ?? null

          results.push(metadata)
        } catch (error) {
          // Skip individual files that fail to parse (graceful degradation)
          getLogger().warn(
            `Skipping finished metadata file ${file}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      // Sort by finishedAt descending (most recently finished first)
      results.sort((a, b) => {
        const aTime = a.finishedAt ? new Date(a.finishedAt).getTime() : 0
        const bTime = b.finishedAt ? new Date(b.finishedAt).getTime() : 0
        return bTime - aTime
      })
    } catch (error) {
      // Log error but return empty array (graceful degradation)
      getLogger().warn(
        `Could not list finished metadata files: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return results
  }
}
