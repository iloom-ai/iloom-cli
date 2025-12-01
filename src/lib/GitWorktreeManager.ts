import path from 'path'
import fs from 'fs-extra'
import {
  type GitWorktree,
  type WorktreeCreateOptions,
  type WorktreeListOptions,
  type WorktreeValidation,
  type WorktreeStatus,
  type WorktreeCleanupOptions,
} from '../types/worktree.js'
import {
  executeGitCommand,
  parseWorktreeList,
  isPRBranch,
  extractPRNumber,
  generateWorktreePath,
  isValidGitRepo,
  getCurrentBranch,
  getRepoRoot,
  hasUncommittedChanges,
  getDefaultBranch,
  findMainWorktreePathWithSettings,
} from '../utils/git.js'
import type { SettingsManager } from './SettingsManager.js'

/**
 * Manages Git worktrees for the iloom CLI
 * Ports functionality from bash scripts into TypeScript
 */
export class GitWorktreeManager {
  private readonly _workingDirectory: string

  constructor(workingDirectory: string = process.cwd()) {
    this._workingDirectory = workingDirectory
  }

  /**
   * Get the working directory for git operations (main worktree path)
   */
  get workingDirectory(): string {
    return this._workingDirectory
  }

  /**
   * List all worktrees in the repository
   * Defaults to porcelain format for reliable machine parsing
   * Equivalent to: git worktree list --porcelain
   */
  async listWorktrees(options: WorktreeListOptions = {}): Promise<GitWorktree[]> {
    const args = ['worktree', 'list']
    // Default to porcelain format for consistent parsing (can be disabled with porcelain: false)
    if (options.porcelain !== false) args.push('--porcelain')
    if (options.verbose) args.push('-v')

    const output = await executeGitCommand(args, { cwd: this._workingDirectory })
    return parseWorktreeList(output)
  }

  /**
   * Find worktree for a specific branch
   * Ports: find_worktree_for_branch() from find-worktree-for-branch.sh
   */
  async findWorktreeForBranch(branchName: string): Promise<GitWorktree | null> {
    const worktrees = await this.listWorktrees()
    return worktrees.find(wt => wt.branch === branchName) ?? null
  }

  /**
   * Check if a worktree is the main repository worktree
   * Uses findMainWorktreePathWithSettings to determine the main worktree based on settings.
   *
   * @param worktree - The worktree to check
   * @param settingsManager - SettingsManager instance for loading settings
   * @returns true if the worktree is the main worktree
   */
  async isMainWorktree(worktree: GitWorktree, settingsManager: SettingsManager): Promise<boolean> {
    const mainWorktreePath = await findMainWorktreePathWithSettings(worktree.path, settingsManager)
    return worktree.path === mainWorktreePath
  }

  /**
   * Check if a worktree is a PR worktree based on naming patterns
   * Ports: is_pr_worktree() from worktree-utils.sh
   */
  isPRWorktree(worktree: GitWorktree): boolean {
    return isPRBranch(worktree.branch)
  }

  /**
   * Get PR number from worktree branch name
   * Ports: get_pr_number_from_worktree() from worktree-utils.sh
   */
  getPRNumberFromWorktree(worktree: GitWorktree): number | null {
    return extractPRNumber(worktree.branch)
  }

  /**
   * Create a new worktree
   * Ports worktree creation logic from new-branch-workflow.sh
   * @returns The absolute path to the created worktree
   */
  async createWorktree(options: WorktreeCreateOptions): Promise<string> {
    // Validate inputs
    if (!options.branch) {
      throw new Error('Branch name is required')
    }

    // Ensure path is absolute
    const absolutePath = path.resolve(options.path)

    // Check if path already exists and handle force flag
    if (await fs.pathExists(absolutePath)) {
      if (!options.force) {
        throw new Error(`Path already exists: ${absolutePath}`)
      }
      // Remove existing directory if force is true
      await fs.remove(absolutePath)
    }

    // Build git worktree add command
    const args = ['worktree', 'add']

    if (options.createBranch) {
      args.push('-b', options.branch)
    }

    if (options.force) {
      args.push('--force')
    }

    args.push(absolutePath)

    // Add branch name if not creating new branch
    if (!options.createBranch) {
      args.push(options.branch)
    } else if (options.baseBranch) {
      args.push(options.baseBranch)
    }

    await executeGitCommand(args, { cwd: this._workingDirectory })
    return absolutePath
  }

  /**
   * Remove a worktree and optionally clean up associated files
   * Ports worktree removal logic from cleanup-worktree.sh
   * @returns A message describing what was done (for dry-run mode)
   */
  async removeWorktree(
    worktreePath: string,
    options: WorktreeCleanupOptions = {}
  ): Promise<string | void> {
    // Validate worktree exists - use porcelain format for consistent parsing
    const worktrees = await this.listWorktrees({ porcelain: true })
    const worktree = worktrees.find(wt => wt.path === worktreePath)

    if (!worktree) {
      // Add debug logging to help diagnose the issue
      const { logger } = await import('../utils/logger.js')
      logger.debug(`Looking for worktree path: ${worktreePath}`)
      logger.debug(`Found ${worktrees.length} worktrees:`)
      worktrees.forEach((wt, i) => {
        logger.debug(`  ${i}: path="${wt.path}", branch="${wt.branch}"`)
      })
      throw new Error(`Worktree not found: ${worktreePath}`)
    }

    // Check for uncommitted changes unless force is specified
    if (!options.force && !options.dryRun) {
      const hasChanges = await hasUncommittedChanges(worktreePath)
      if (hasChanges) {
        throw new Error(`Worktree has uncommitted changes: ${worktreePath}. Use --force to override.`)
      }
    }

    if (options.dryRun) {
      const actions = ['Remove worktree registration']
      if (options.removeDirectory) actions.push('Remove directory from disk')
      if (options.removeBranch) actions.push(`Remove branch: ${worktree.branch}`)

      return `Would perform: ${actions.join(', ')}`
    }

    // Remove worktree registration
    const args = ['worktree', 'remove']
    if (options.force) args.push('--force')
    args.push(worktreePath)

    await executeGitCommand(args, { cwd: this._workingDirectory })

    // Remove directory if requested
    if (options.removeDirectory && (await fs.pathExists(worktreePath))) {
      await fs.remove(worktreePath)
    }

    // Remove branch if requested and safe to do so
    if (options.removeBranch && !worktree.bare) {
      try {
        await executeGitCommand(['branch', '-D', worktree.branch], {
          cwd: this._workingDirectory,
        })
      } catch (error) {
        // Don't fail the whole operation if branch deletion fails
        // Just log a warning (caller can handle this)
        throw new Error(
          `Worktree removed but failed to delete branch ${worktree.branch}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }
  }

  /**
   * Validate worktree state and integrity
   */
  async validateWorktree(worktreePath: string): Promise<WorktreeValidation> {
    const issues: string[] = []
    let existsOnDisk = false
    let isValidRepo = false
    let hasValidBranch = false

    try {
      // Check if path exists on disk
      existsOnDisk = await fs.pathExists(worktreePath)
      if (!existsOnDisk) {
        issues.push('Worktree directory does not exist on disk')
      }

      // Check if it's a valid Git repository
      if (existsOnDisk) {
        isValidRepo = await isValidGitRepo(worktreePath)
        if (!isValidRepo) {
          issues.push('Directory is not a valid Git repository')
        }
      }

      // Check if branch reference is valid
      if (isValidRepo) {
        const currentBranch = await getCurrentBranch(worktreePath)
        hasValidBranch = currentBranch !== null
        if (!hasValidBranch) {
          issues.push('Could not determine current branch')
        }
      }

      // Check if worktree is registered with Git
      const worktrees = await this.listWorktrees()
      const isRegistered = worktrees.some(wt => wt.path === worktreePath)
      if (!isRegistered) {
        issues.push('Worktree is not registered with Git')
      }
    } catch (error) {
      issues.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    return {
      isValid: issues.length === 0,
      issues,
      existsOnDisk,
      isValidRepo,
      hasValidBranch,
    }
  }

  /**
   * Get detailed status information for a worktree
   */
  async getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    const statusOutput = await executeGitCommand(['status', '--porcelain=v1'], {
      cwd: worktreePath,
    })

    let modified = 0
    let staged = 0
    let deleted = 0
    let untracked = 0

    const lines = statusOutput.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const status = line.substring(0, 2)
      if (status[0] === 'M' || status[1] === 'M') modified++
      if (status[0] === 'A' || status[0] === 'D' || status[0] === 'R') staged++
      if (status[0] === 'D' || status[1] === 'D') deleted++
      if (status === '??') untracked++
    }

    const currentBranch = (await getCurrentBranch(worktreePath)) ?? 'unknown'
    const detached = currentBranch === 'unknown'

    // Get ahead/behind information
    let ahead = 0
    let behind = 0
    try {
      const aheadBehindOutput = await executeGitCommand(
        ['rev-list', '--left-right', '--count', `origin/${currentBranch}...HEAD`],
        { cwd: worktreePath }
      )
      const parts = aheadBehindOutput.trim().split('\t')
      const behindStr = parts[0]
      const aheadStr = parts[1]
      behind = behindStr ? parseInt(behindStr, 10) || 0 : 0
      ahead = aheadStr ? parseInt(aheadStr, 10) || 0 : 0
    } catch {
      // Ignore errors for ahead/behind calculation
    }

    return {
      modified,
      staged,
      deleted,
      untracked,
      hasChanges: modified + staged + deleted + untracked > 0,
      branch: currentBranch,
      detached,
      ahead,
      behind,
    }
  }

  /**
   * Generate a suggested worktree path for a branch
   */
  generateWorktreePath(
    branchName: string,
    customRoot?: string,
    options?: { isPR?: boolean; prNumber?: number; prefix?: string }
  ): string {
    const root = customRoot ?? this._workingDirectory
    return generateWorktreePath(branchName, root, options)
  }

  /**
   * Sanitize a branch name for use as a directory name
   * Replaces slashes with dashes and removes invalid filesystem characters
   * Ports logic from bash script line 593: ${BRANCH_NAME//\\//-}
   */
  sanitizeBranchName(branchName: string): string {
    return branchName
      .replace(/\//g, '-')  // Replace slashes with dashes
      .replace(/[^a-zA-Z0-9-]/g, '-')  // Replace invalid chars (including underscores) with dashes
      .replace(/-+/g, '-')  // Collapse multiple dashes
      .replace(/^-|-$/g, '')  // Remove leading/trailing dashes
      .toLowerCase()
  }

  /**
   * Check if repository is in a valid state for worktree operations
   */
  async isRepoReady(): Promise<boolean> {
    try {
      const repoRoot = await getRepoRoot(this._workingDirectory)
      return repoRoot !== null
    } catch {
      return false
    }
  }

  /**
   * Get repository information
   */
  async getRepoInfo(): Promise<{
    root: string | null
    defaultBranch: string
    currentBranch: string | null
  }> {
    const root = await getRepoRoot(this._workingDirectory)
    const defaultBranch = await getDefaultBranch(this._workingDirectory)
    const currentBranch = await getCurrentBranch(this._workingDirectory)

    return {
      root,
      defaultBranch,
      currentBranch,
    }
  }

  /**
   * Prune stale worktree entries (worktrees that no longer exist on disk)
   */
  async pruneWorktrees(): Promise<void> {
    await executeGitCommand(['worktree', 'prune', '-v'], { cwd: this._workingDirectory })
  }

  /**
   * Lock a worktree to prevent it from being pruned or moved
   */
  async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
    const args = ['worktree', 'lock', worktreePath]
    if (reason) args.push('--reason', reason)

    await executeGitCommand(args, { cwd: this._workingDirectory })
  }

  /**
   * Unlock a previously locked worktree
   */
  async unlockWorktree(worktreePath: string): Promise<void> {
    await executeGitCommand(['worktree', 'unlock', worktreePath], { cwd: this._workingDirectory })
  }

  /**
   * Find worktrees matching an identifier (branch name, path, or PR number)
   */
  async findWorktreesByIdentifier(identifier: string): Promise<GitWorktree[]> {
    const worktrees = await this.listWorktrees({ porcelain: true })
    return worktrees.filter(
      wt =>
        wt.branch.includes(identifier) ||
        wt.path.includes(identifier) ||
        this.getPRNumberFromWorktree(wt)?.toString() === identifier
    )
  }

  /**
   * Find worktree for a specific issue number using exact pattern matching
   * Matches: issue-{N} at start OR after /, -, _ (but NOT issue-{N}X where X is a digit)
   * Supports patterns like: issue-44, feat/issue-44-feature, feat-issue-44, bugfix_issue-44, etc.
   * Avoids false matches like: tissue-44, myissue-44
   * Ports: find_existing_worktree() from bash script lines 131-165
   */
  async findWorktreeForIssue(issueNumber: string | number): Promise<GitWorktree | null> {
    const worktrees = await this.listWorktrees({ porcelain: true })

    // Pattern: starts with 'issue-{N}' OR has '/issue-{N}', '-issue-{N}', '_issue-{N}' but not 'issue-{N}{digit}'
    const pattern = new RegExp(`(?:^|[/_-])issue-${issueNumber}(?:-|$)`)

    return worktrees.find(wt => pattern.test(wt.branch)) ?? null
  }

  /**
   * Find worktree for a specific PR by branch name
   * Ports: find_existing_worktree() for PR type from bash script lines 149-160
   */
  async findWorktreeForPR(prNumber: number, branchName: string): Promise<GitWorktree | null> {
    const worktrees = await this.listWorktrees({ porcelain: true })

    // Find by exact branch name match (prioritized)
    const byBranch = worktrees.find(wt => wt.branch === branchName)
    if (byBranch) return byBranch

    // Also check directory name pattern: *_pr_{N}
    const pathPattern = new RegExp(`_pr_${prNumber}$`)
    return worktrees.find(wt => pathPattern.test(wt.path)) ?? null
  }

  /**
   * Remove multiple worktrees
   * Returns a summary of successes and failures
   * Automatically filters out the main worktree
   *
   * @param worktrees - Array of worktrees to remove
   * @param settingsManager - SettingsManager instance for determining main worktree
   * @param options - Cleanup options
   */
  async removeWorktrees(
    worktrees: GitWorktree[],
    settingsManager: SettingsManager,
    options: WorktreeCleanupOptions = {}
  ): Promise<{
    successes: Array<{ worktree: GitWorktree }>
    failures: Array<{ worktree: GitWorktree; error: string }>
    skipped: Array<{ worktree: GitWorktree; reason: string }>
  }> {
    const successes: Array<{ worktree: GitWorktree }> = []
    const failures: Array<{ worktree: GitWorktree; error: string }> = []
    const skipped: Array<{ worktree: GitWorktree; reason: string }> = []

    for (const worktree of worktrees) {
      // Skip main worktree
      if (await this.isMainWorktree(worktree, settingsManager)) {
        skipped.push({ worktree, reason: 'Cannot remove main worktree' })
        continue
      }

      try {
        await this.removeWorktree(worktree.path, {
          ...options,
          removeDirectory: true,
        })
        successes.push({ worktree })
      } catch (error) {
        failures.push({
          worktree,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    return { successes, failures, skipped }
  }

  /**
   * Format worktree information for display
   */
  formatWorktree(worktree: GitWorktree): {
    title: string
    path: string
    commit: string
  } {
    const prNumber = this.getPRNumberFromWorktree(worktree)
    const prLabel = prNumber ? ` (PR #${prNumber})` : ''
    const bareLabel = worktree.bare ? ' [main]' : ''

    return {
      title: `${worktree.branch}${prLabel}${bareLabel}`,
      path: worktree.path,
      commit: worktree.commit.substring(0, 7),
    }
  }
}
