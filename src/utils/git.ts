import path from 'path'
import { execa, type ExecaError } from 'execa'
import { type GitWorktree } from '../types/worktree.js'
import { SettingsManager, type SettingsManager as SettingsManagerType } from '../lib/SettingsManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { logger } from './logger.js'

/**
 * Custom error class for Git command failures
 * Preserves exit code and stderr for precise error handling
 */
export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | undefined,
    public readonly stderr: string
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

/**
 * Execute a Git command and return the stdout result
 * Throws a GitCommandError if the command fails
 */
export async function executeGitCommand(
  args: string[],
  options?: { cwd?: string; timeout?: number; stdio?: 'inherit' | 'pipe'; env?: NodeJS.ProcessEnv }
): Promise<string> {
  try {
    const result = await execa('git', args, {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeout ?? 30000,
      encoding: 'utf8',
      stdio: options?.stdio ?? 'pipe',
      verbose: logger.isDebugEnabled(),
      // Spread env conditionally - only include if defined
      ...(options?.env && { env: options.env }),
    })

    return result.stdout
  } catch (error) {
    const execaError = error as ExecaError
    const stderr = execaError.stderr ?? execaError.message ?? 'Unknown Git error'
    throw new GitCommandError(
      `Git command failed: ${stderr}`,
      execaError.exitCode,
      stderr
    )
  }
}

/**
 * Parse git worktree list output into structured data
 * @param output - The output from git worktree list --porcelain
 * @param defaultBranch - Default branch name to use for bare repositories (defaults to 'main')
 */
export function parseWorktreeList(output: string, defaultBranch?: string): GitWorktree[] {
  const worktrees: GitWorktree[] = []
  const lines = output.trim().split('\n')

  let i = 0
  while (i < lines.length) {
    const pathLine = lines[i]
    if (!pathLine?.startsWith('worktree ')) {
      i++
      continue
    }

    // Parse path line: "worktree /path/to/worktree"
    const pathMatch = pathLine.match(/^worktree (.+)$/)
    if (!pathMatch) {
      i++
      continue
    }

    let branch = ''
    let commit = ''
    let detached = false
    let bare = false
    let locked = false
    let lockReason: string | undefined

    // Process subsequent lines for this worktree
    i++
    while (i < lines.length && !lines[i]?.startsWith('worktree ')) {
      const line = lines[i]?.trim()
      if (!line) {
        i++
        continue
      }

      if (line === 'bare') {
        bare = true
        branch = defaultBranch ?? 'main' // Default assumption for bare repo
      } else if (line === 'detached') {
        detached = true
        branch = 'HEAD'
      } else if (line.startsWith('locked')) {
        locked = true
        const lockMatch = line.match(/^locked (.+)$/)
        lockReason = lockMatch?.[1]
        branch = branch || 'unknown'
      } else if (line.startsWith('HEAD ')) {
        // Parse commit line: "HEAD abc123def456..."
        const commitMatch = line.match(/^HEAD ([a-f0-9]+)/)
        if (commitMatch) {
          commit = commitMatch[1] ?? ''
        }
      } else if (line.startsWith('branch ')) {
        // Parse branch line: "branch refs/heads/feature-branch"
        const branchMatch = line.match(/^branch refs\/heads\/(.+)$/)
        branch = branchMatch?.[1] ?? line.replace('branch ', '')
      }

      i++
    }

    const worktree: GitWorktree = {
      path: pathMatch[1] ?? '',
      branch,
      commit,
      bare,
      detached,
      locked,
    }

    if (lockReason !== undefined) {
      worktree.lockReason = lockReason
    }

    worktrees.push(worktree)
  }

  return worktrees
}

/**
 * Check if a branch name follows PR naming patterns
 */
export function isPRBranch(branchName: string): boolean {
  const prPatterns = [
    /^pr\/\d+/i, // pr/123, pr/123-feature-name
    /^pull\/\d+/i, // pull/123
    /^\d+[-_]/, // 123-feature-name, 123_feature_name
    /^feature\/pr[-_]?\d+/i, // feature/pr123, feature/pr-123
    /^hotfix\/pr[-_]?\d+/i, // hotfix/pr123
  ]

  return prPatterns.some(pattern => pattern.test(branchName))
}

/**
 * Extract PR number from branch name
 */
export function extractPRNumber(branchName: string): number | null {
  const patterns = [
    /^pr\/(\d+)/i, // pr/123
    /^pull\/(\d+)/i, // pull/123
    /^(\d+)[-_]/, // 123-feature-name
    /^feature\/pr[-_]?(\d+)/i, // feature/pr123
    /^hotfix\/pr[-_]?(\d+)/i, // hotfix/pr123
    /pr[-_]?(\d+)/i, // anywhere with pr123 or pr-123
  ]

  for (const pattern of patterns) {
    const match = branchName.match(pattern)
    if (match?.[1]) {
      const num = parseInt(match[1], 10)
      if (!isNaN(num)) return num
    }
  }

  return null
}

/**
 * Extract issue number from branch name
 * Supports both new format (issue-{issueId}__{slug}) and old format (issue-{number}-{slug})
 * @returns string issue ID (alphanumeric) or null if not found
 */
export function extractIssueNumber(branchName: string): string | null {
  // Priority 1: New format - issue-{issueId}__ (alphanumeric ID with double underscore)
  const newFormatPattern = /issue-([^_]+)__/i
  const newMatch = branchName.match(newFormatPattern)
  if (newMatch?.[1]) return newMatch[1]

  // Priority 2: Old format - issue-{number}- or issue-{number}$ (numeric only, dash or end)
  const oldFormatPattern = /issue-(\d+)(?:-|$)/i
  const oldMatch = branchName.match(oldFormatPattern)
  if (oldMatch?.[1]) return oldMatch[1]

  // Priority 3: Alphanumeric ID at end (either format without description)
  const alphanumericEndPattern = /issue-([^_\s/]+)$/i
  const alphanumericMatch = branchName.match(alphanumericEndPattern)
  if (alphanumericMatch?.[1]) return alphanumericMatch[1]

  // Priority 4: Legacy patterns (issue_N, leading number)
  const legacyPatterns = [
    /issue_(\d+)/i,     // issue_42
    /^(\d+)-/,          // 42-feature-name
  ]
  for (const pattern of legacyPatterns) {
    const match = branchName.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
}

/**
 * Check if a path follows worktree naming patterns
 */
export function isWorktreePath(path: string): boolean {
  const worktreePatterns = [
    /\/worktrees?\//i, // Contains /worktree/ or /worktrees/
    /\/workspace[-_]?\d+/i, // workspace123, workspace-123
    /\/issue[-_]?\d+/i, // issue123, issue-123
    /\/pr[-_]?\d+/i, // pr123, pr-123
    /-worktree$/i, // ends with -worktree
    /\.worktree$/i, // ends with .worktree
  ]

  return worktreePatterns.some(pattern => pattern.test(path))
}

/**
 * Generate a worktree path based on branch name and root directory
 * For PRs, adds _pr_<PR_NUM> suffix to distinguish from issue branches
 */
export function generateWorktreePath(
  branchName: string,
  rootDir: string = process.cwd(),
  options?: { isPR?: boolean; prNumber?: number; prefix?: string }
): string {
  // Replace slashes with dashes (matches bash line 593)
  let sanitized = branchName.replace(/\//g, '-')

  // Add PR suffix if this is a PR (matches bash lines 595-597)
  if (options?.isPR && options?.prNumber) {
    sanitized = `${sanitized}_pr_${options.prNumber}`
  }

  const parentDir = path.dirname(rootDir)

  // Handle prefix logic
  let prefix: string

  if (options?.prefix === undefined) {
    // No prefix in options - calculate default: <basename>-looms
    const mainFolderName = path.basename(rootDir)
    prefix = mainFolderName ? `${mainFolderName}-looms/` : 'looms/'
  } else if (options.prefix === '') {
    // Empty string = no prefix mode
    prefix = ''
  } else {
    // Custom prefix provided
    prefix = options.prefix

    // Check if prefix contains forward slashes (nested directory structure)
    const hasNestedPath = prefix.includes('/')

    if (hasNestedPath) {
      // Check if it ends with a separator character (dash, underscore, or slash)
      const endsWithSeparator = /[-_/]$/.test(prefix)

      if (!endsWithSeparator) {
        // Has nested path but no trailing separator: auto-append hyphen
        // Example: "temp/looms" becomes "temp/looms-"
        prefix = `${prefix}-`
      }
      // If it already ends with -, _, or /, keep as-is
    } else {
      // Single-level prefix: auto-append separator if it doesn't end with one
      const endsWithSeparator = /[-_]$/.test(prefix)
      if (!endsWithSeparator) {
        prefix = `${prefix}-`
      }
    }
  }

  // Apply prefix (or not, if empty)
  if (prefix === '') {
    return path.join(parentDir, sanitized)
  } else if (prefix.endsWith('/')) {
    // Forward slash = nested directory, use path.join for proper handling
    return path.join(parentDir, prefix, sanitized)
  } else if (prefix.includes('/')) {
    // Contains slash but doesn't end with slash = nested with separator (e.g., "looms/myprefix-")
    // Split and handle: last part is prefix with separator, rest is directory path
    const lastSlashIndex = prefix.lastIndexOf('/')
    const dirPath = prefix.substring(0, lastSlashIndex)
    const prefixWithSeparator = prefix.substring(lastSlashIndex + 1)
    return path.join(parentDir, dirPath, `${prefixWithSeparator}${sanitized}`)
  } else {
    // Dash/underscore separator = single directory name
    return path.join(parentDir, `${prefix}${sanitized}`)
  }
}

/**
 * Validate that a directory is a valid Git repository
 */
export async function isValidGitRepo(path: string): Promise<boolean> {
  try {
    await executeGitCommand(['rev-parse', '--git-dir'], { cwd: path })
    return true
  } catch {
    return false
  }
}

/**
 * Get the current branch name for a repository
 */
export async function getCurrentBranch(path: string = process.cwd()): Promise<string | null> {
  try {
    const result = await executeGitCommand(['branch', '--show-current'], { cwd: path })
    return result.trim()
  } catch {
    return null
  }
}

/**
 * Check if a branch exists (local or remote)
 */
export async function branchExists(
  branchName: string,
  path: string = process.cwd(),
  includeRemote = true
): Promise<boolean> {
  try {
    // Check local branches
    const localResult = await executeGitCommand(['branch', '--list', branchName], { cwd: path })
    if (localResult.trim()) {
      return true
    }

    // Check remote branches if requested
    if (includeRemote) {
      const remoteResult = await executeGitCommand(['branch', '-r', '--list', `*/${branchName}`], {
        cwd: path,
      })
      if (remoteResult.trim()) {
        return true
      }
    }

    return false
  } catch {
    return false
  }
}

/**
 * Get the root directory of the current worktree
 * Returns the worktree root when in a linked worktree, or main repo root when in main worktree
 */
export async function getWorktreeRoot(path: string = process.cwd()): Promise<string | null> {
  try {
    const result = await executeGitCommand(['rev-parse', '--show-toplevel'], { cwd: path })
    return result.trim()
  } catch {
    return null
  }
}

/**
 * Get the main repository root directory
 * Returns the main repo root even when called from a linked worktree
 */
export async function getRepoRoot(path: string = process.cwd()): Promise<string | null> {
  try {
    // Get the common git directory (shared by all worktrees)
    const gitCommonDir = await executeGitCommand(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: path }
    )
    const trimmedPath = gitCommonDir.trim()

    // Handle linked worktree: /path/to/repo/.git/worktrees/worktree-name -> /path/to/repo
    // Handle main worktree: /path/to/repo/.git -> /path/to/repo
    const repoRoot = trimmedPath
      .replace(/\/\.git\/worktrees\/[^/]+$/, '')  // Remove /.git/worktrees/name suffix
      .replace(/\/\.git$/, '')                     // Remove /.git suffix

    return repoRoot
  } catch(error) {
    // "not a git repository" is expected when running outside a git repo - use debug level
    // Check for GitCommandError with exit code 128 or the specific stderr message
    if (error instanceof GitCommandError &&
        (error.exitCode === 128 || /fatal: not a git repository/i.test(error.stderr))) {
      logger.info(`Note: No git repository detected: ${path}`)
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.warn(`Failed to determine repo root from git-common-dir: ${path}`, errorMessage)
    }
    return null
  }
}

/**
 * Find the worktree path where main branch is checked out
 * Copies bash script approach: parse git worktree list to find main
 */
export async function findMainWorktreePath(
  path: string = process.cwd(),
  options?: { mainBranch?: string }
): Promise<string> {
  try {
    const output = await executeGitCommand(['worktree', 'list', '--porcelain'], { cwd: path })
    const worktrees = parseWorktreeList(output, options?.mainBranch)

    // Guard: empty worktree list
    if (worktrees.length === 0) {
      throw new Error('No worktrees found in repository')
    }

    // Tier 1: Check for specified mainBranch in options
    if (options?.mainBranch) {
      const specified = worktrees.find(wt => wt.branch === options.mainBranch)
      if (!specified?.path) {
        throw new Error(
          `No worktree found with branch '${options.mainBranch}' (specified in settings). Available worktrees: ${worktrees.map(wt => `${wt.path} (${wt.branch})`).join(', ')}`
        )
      }
      return specified.path
    }

    // Tier 2: Look for "main" branch
    const mainBranch = worktrees.find(wt => wt.branch === 'main')
    if (mainBranch?.path) {
      return mainBranch.path
    }

    // Tier 3: Use first worktree (primary worktree)
    const firstWorktree = worktrees[0]
    if (!firstWorktree?.path) {
      throw new Error('Failed to determine primary worktree path')
    }
    return firstWorktree.path
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('No worktree found with branch') ||
        error.message.includes('No worktrees found') ||
        error.message.includes('Failed to determine primary worktree'))
    ) {
      // Re-throw our specific errors
      throw error
    }
    throw new Error(`Failed to find main worktree: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Find main worktree path with automatic settings loading
 *
 * This is a convenience wrapper that:
 * 1. Loads project settings from .iloom/settings.json
 * 2. Extracts mainBranch configuration if present
 * 3. Calls findMainWorktreePath with appropriate options
 *
 * @param path - Path to search from (defaults to process.cwd())
 * @param settingsManager - Optional SettingsManager instance (for DI/testing)
 * @returns Path to main worktree
 * @throws Error if main worktree cannot be found
 */
export async function findMainWorktreePathWithSettings(
  path?: string,
  settingsManager?: SettingsManagerType
): Promise<string> {
  // Lazy load SettingsManager to avoid circular dependencies
  settingsManager ??= new SettingsManager()

  const settings = await settingsManager.loadSettings(path)
  const findOptions = settings.mainBranch ? { mainBranch: settings.mainBranch } : undefined
  return findMainWorktreePath(path, findOptions)
}

/**
 * Find the worktree path where a specific branch is checked out
 *
 * Used by MergeManager to find the correct worktree for child loom merges.
 * When finishing a child loom, we need to find where the PARENT branch is
 * checked out (the merge target), not where settings.mainBranch is checked out.
 *
 * @param branchName - The branch name to find
 * @param path - Path to search from (defaults to process.cwd())
 * @returns Path to worktree where the branch is checked out
 * @throws Error if no worktree has the specified branch checked out
 */
export async function findWorktreeForBranch(
  branchName: string,
  path: string = process.cwd()
): Promise<string> {
  try {
    const output = await executeGitCommand(['worktree', 'list', '--porcelain'], { cwd: path })
    const worktrees = parseWorktreeList(output, branchName)

    // Guard: empty worktree list
    if (worktrees.length === 0) {
      throw new Error('No worktrees found in repository')
    }

    // Find the worktree with the specified branch
    const targetWorktree = worktrees.find(wt => wt.branch === branchName)
    if (!targetWorktree?.path) {
      throw new Error(
        `No worktree found with branch '${branchName}' checked out. ` +
        `Available worktrees: ${worktrees.map(wt => `${wt.path} (${wt.branch})`).join(', ')}`
      )
    }
    return targetWorktree.path
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('No worktree found with branch') ||
        error.message.includes('No worktrees found'))
    ) {
      // Re-throw our specific errors
      throw error
    }
    throw new Error(`Failed to find worktree for branch '${branchName}': ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Check if there are uncommitted changes in a repository
 */
export async function hasUncommittedChanges(path: string = process.cwd()): Promise<boolean> {
  try {
    const result = await executeGitCommand(['status', '--porcelain'], { cwd: path })
    return result.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Get the default branch name for a repository
 */
export async function getDefaultBranch(path: string = process.cwd()): Promise<string> {
  try {
    // Try to get from remote
    const remoteResult = await executeGitCommand(['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: path,
    })
    const match = remoteResult.match(/refs\/remotes\/origin\/(.+)/)
    if (match) return match[1] ?? 'main'

    // Fallback to common default branch names
    const commonDefaults = ['main', 'master', 'develop']
    for (const branch of commonDefaults) {
      if (await branchExists(branch, path)) {
        return branch
      }
    }

    return 'main' // Final fallback
  } catch {
    return 'main'
  }
}

/**
 * Find all branches related to a GitHub issue or PR number
 * Matches patterns like:
 * - Issue patterns: issue-25, issue/25, 25-feature, feat-25, feat/issue-25
 * - PR patterns: pr/25, pull/25, pr-25, feature/pr-25
 *
 * Based on bash cleanup-worktree.sh find_issue_branches() (lines 133-154)
 *
 * @param issueNumber - The issue or PR number to search for
 * @param path - Working directory to search from (defaults to process.cwd())
 * @param settingsManager - Optional SettingsManager instance (for DI/testing)
 */
export async function findAllBranchesForIssue(
  issueNumber: string | number,
  path: string = process.cwd(),
  settingsManager?: SettingsManagerType
): Promise<string[]> {
  // Lazy load SettingsManager to avoid circular dependencies
  if (!settingsManager) {
    const { SettingsManager: SM } = await import('../lib/SettingsManager.js')
    settingsManager = new SM()
  }

  // Get protected branches list from centralized method
  const protectedBranches = await settingsManager.getProtectedBranches(path)

  // Get all branches (local and remote)
  const output = await executeGitCommand(['branch', '-a'], { cwd: path })

  const branches: string[] = []
  const lines = output.split('\n').filter(Boolean)

  for (const line of lines) {
    // Skip remotes/origin/HEAD pointer
    if (line.includes('remotes/origin/HEAD')) {
      continue
    }

    // Clean the branch name:
    // 1. Remove git status markers (* + spaces at start)
    let cleanBranch = line.replace(/^[*+ ]+/, '')

    // 2. Remove 'origin/' prefix if present
    cleanBranch = cleanBranch.replace(/^origin\//, '')

    // 3. Remove 'remotes/origin/' prefix if present
    cleanBranch = cleanBranch.replace(/^remotes\/origin\//, '')

    // 4. Trim any remaining whitespace
    cleanBranch = cleanBranch.trim()

    // Skip protected branches
    if (protectedBranches.includes(cleanBranch)) {
      continue
    }

    // Check if branch contains issue number with strict word boundary pattern
    // The issue number must NOT be:
    // - Part of a larger number (preceded or followed by a digit)
    // - After an unknown word (like "tissue-25")
    // The issue number CAN be:
    // - At start: "25-feature"
    // - After known prefix + separator: "issue-25", "feat-25", "fix-25", "pr-25"
    // - After just a separator with no prefix: test_25 (separator at start)

    // First check: not part of a larger number
    const notPartOfNumber = new RegExp(`(?<!\\d)${issueNumber}(?!\\d)`)
    if (!notPartOfNumber.test(cleanBranch)) {
      continue
    }

    // Second check: if preceded by letters, validate they're known issue-related prefixes
    // This prevents "tissue-25" but allows "issue-25", "feat-25", etc.
    const beforeNumber = cleanBranch.substring(0, cleanBranch.indexOf(String(issueNumber)))

    if (beforeNumber) {
      // Extract the last word (letters) before the number
      const lastWord = beforeNumber.match(/([a-zA-Z]+)[-_/\s]*$/)
      if (lastWord?.[1]) {
        const word = lastWord[1].toLowerCase()
        // Known prefixes for issue-related branches
        const knownPrefixes = [
          'issue', 'issues',
          'feat', 'feature', 'features',
          'fix', 'fixes', 'bugfix', 'hotfix',
          'pr', 'pull',
          'test', 'tests',
          'chore',
          'docs',
          'refactor',
          'perf',
          'style',
          'ci',
          'build',
          'revert'
        ]

        // If we found a word and it's NOT in the known list, skip this branch
        if (!knownPrefixes.includes(word)) {
          continue
        }
      }
    }

    // Passed all checks - add to results
    if (!branches.includes(cleanBranch)) {
      branches.push(cleanBranch)
    }
  }

  return branches
}

/**
 * Check if a repository is empty (has no commits yet)
 * @param path - Repository path to check (defaults to process.cwd())
 * @returns true if repository has no commits, false otherwise
 */
export async function isEmptyRepository(path: string = process.cwd()): Promise<boolean> {
  try {
    await executeGitCommand(['rev-parse', '--verify', 'HEAD'], { cwd: path })
    return false // HEAD exists, repo has commits
  } catch {
    return true // HEAD doesn't exist, repo is empty
  }
}

/**
 * Ensure repository has at least one commit
 * Creates an initial empty commit if repository is empty
 * @param path - Repository path (defaults to process.cwd())
 */
export async function ensureRepositoryHasCommits(path: string = process.cwd()): Promise<void> {
  const isEmpty = await isEmptyRepository(path)
  if (isEmpty) {
    await executeGitCommand(['commit', '--no-verify', '--allow-empty', '-m', 'Initial commit'], { cwd: path })
  }
}

/**
 * Push a branch to remote repository
 * Used for PR workflow to push changes to remote without merging locally
 *
 * @param branchName - The branch name to push
 * @param worktreePath - The worktree path where the branch is checked out
 * @param options - Push options
 * @throws Error if push fails
 */
export async function pushBranchToRemote(
  branchName: string,
  worktreePath: string,
  options?: { dryRun?: boolean }
): Promise<void> {
  if (options?.dryRun) {
    // In dry-run mode, just log what would be done
    return
  }

  try {
    // Execute: git push origin <branch-name>
    // This matches the bash script behavior (merge-and-clean.sh line 359)
    await executeGitCommand(['push', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 120000, // 120 second timeout for push operations
    })
  } catch (error) {
    // Provide helpful error message based on common push failures
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Check for common error patterns and provide context, but ALWAYS include original error
    if (errorMessage.includes('failed to push') || errorMessage.includes('rejected')) {
      throw new Error(
        `Failed to push changes to origin/${branchName}\n\n` +
        `   Git error: ${errorMessage}\n\n` +
        `   Possible causes:\n` +
        `   • Remote branch was deleted\n` +
        `   • Push was rejected (non-fast-forward)\n` +
        `   • Network connectivity issues\n\n` +
        `   To retry: il finish --pr <number>\n` +
        `   To force push: git push origin ${branchName} --force`
      )
    }

    if (errorMessage.includes('Could not resolve host') || errorMessage.includes('network')) {
      throw new Error(
        `Failed to push changes to origin/${branchName}: Network connectivity issues\n\n` +
        `   Git error: ${errorMessage}\n\n` +
        `   Check your internet connection and try again.`
      )
    }

    if (errorMessage.includes('No such remote')) {
      throw new Error(
        `Failed to push changes: Remote 'origin' not found\n\n` +
        `   Git error: ${errorMessage}\n\n` +
        `   Configure remote: git remote add origin <url>`
      )
    }

    // For other errors, re-throw with original message
    throw new Error(`Failed to push to remote: ${errorMessage}`)
  }
}

/**
 * Fetch from origin to ensure we have latest refs
 * Used before branching and rebasing operations to stay current with remote
 *
 * @param cwd - Working directory to run git command in
 * @throws Error if fetch fails (network issues, access denied, etc.)
 */
export async function fetchOrigin(cwd: string): Promise<void> {
  try {
    await executeGitCommand(['fetch', 'origin'], {
      cwd,
      timeout: 60000, // 60 second timeout for fetch operations
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to fetch from origin: ${errorMessage}\n\n` +
      `Check your network connection and repository access.`
    )
  }
}

/**
 * Check if a file is tracked by git
 * Uses git ls-files to check if file is in the index
 * @param filePath - Absolute or relative path to the file
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file is tracked, false otherwise
 */
export async function isFileTrackedByGit(
  filePath: string,
  cwd: string = process.cwd()
): Promise<boolean> {
  try {
    const result = await executeGitCommand(
      ['ls-files', '--error-unmatch', filePath],
      { cwd }
    )
    return result.trim().length > 0
  } catch (error) {
    // Only return false if it's the specific "pathspec did not match" error
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('pathspec') && errorMessage.includes('did not match')) {
      return false
    }
    // Re-throw other errors
    throw error
  }
}

/**
 * Check if a file is gitignored
 * Uses `git check-ignore` which handles nested gitignore files and global patterns
 *
 * @param filePath - Path to file to check (relative to repo root)
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file IS ignored, false if NOT ignored or on error
 */
export async function isFileGitignored(
  filePath: string,
  cwd: string = process.cwd()
): Promise<boolean> {
  try {
    await executeGitCommand(['check-ignore', '-q', filePath], { cwd })
    return true // Exit 0 = file IS ignored
  } catch {
    return false // Exit 1 = NOT ignored (or error)
  }
}

/**
 * Check if a branch is merged into the main branch
 *
 * Uses `git merge-base --is-ancestor` which is more reliable than `git branch -d`'s check.
 * The `-d` flag checks against current HEAD, which can give false positives when:
 * - Running from a worktree where main isn't checked out
 * - Squash or rebase merges were used
 *
 * This function explicitly checks if the branch tip is an ancestor of the main branch,
 * providing consistent results regardless of which worktree the command runs from.
 *
 * @param branchName - The branch to check
 * @param mainBranch - The main branch to check against (defaults to 'main')
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if branch is merged into main, false otherwise
 */
export async function isBranchMergedIntoMain(
  branchName: string,
  mainBranch: string = 'main',
  cwd: string = process.cwd()
): Promise<boolean> {
  try {
    // git merge-base --is-ancestor exits 0 if branchName is ancestor of mainBranch, 1 if not
    await executeGitCommand(['merge-base', '--is-ancestor', branchName, mainBranch], { cwd })
    return true
  } catch {
    return false
  }
}

/**
 * Check if a branch exists on the remote (origin) and is up-to-date with local
 * Useful for GitHub-PR workflows to ensure branch has been pushed and is current
 *
 * @param branchName - Name of the branch to check
 * @param cwd - Working directory to run git command in
 * @returns Promise<boolean> - true if remote branch exists and matches local HEAD, false otherwise
 */
export async function isRemoteBranchUpToDate(
  branchName: string,
  cwd: string
): Promise<boolean> {
  try {
    // First, check if remote branch exists and get its commit hash
    const remoteResult = await executeGitCommand(['ls-remote', '--heads', 'origin', branchName], { cwd })

    if (remoteResult.trim().length === 0) {
      // Remote branch doesn't exist
      return false
    }

    // Extract the commit hash from ls-remote output (format: "hash\trefs/heads/branchname")
    const remoteCommit = remoteResult.trim().split('\t')[0]

    // Get the local branch's HEAD commit
    const localCommit = await executeGitCommand(['rev-parse', branchName], { cwd })

    // Both must exist and match
    return localCommit.trim() === remoteCommit
  } catch {
    return false
  }
}

/**
 * Result of checking remote branch status for safety validation
 */
export interface RemoteBranchStatus {
  /** Whether the remote branch exists */
  exists: boolean
  /** Whether the remote is ahead of local (has commits not present locally) */
  remoteAhead: boolean
  /** Whether local is ahead of remote (has unpushed commits) */
  localAhead: boolean
  /** Whether a network error occurred during the check */
  networkError: boolean
  /** Error message if network error occurred */
  errorMessage?: string
}

/**
 * Check the status of a remote branch for safety validation during cleanup
 * This function provides detailed status needed for the 5-point safety check:
 *
 * The key insight: we care about DATA LOSS, not about remote state
 * - Remote ahead of local is SAFE (commits exist on remote, no data loss)
 * - Local ahead of remote is DANGEROUS (unpushed commits would be lost)
 *
 * 5-point safety logic:
 * 1. Network error -> BLOCK (can't verify safety)
 * 2. Remote ahead of local -> OK (no data loss - commits exist on remote)
 * 3. Local ahead of remote (unpushed commits) -> BLOCK (data loss risk)
 * 4. No remote, merged to main -> OK (work is in main)
 * 5. No remote, NOT merged to main -> BLOCK (unmerged work would be lost)
 *
 * @param branchName - Name of the branch to check
 * @param cwd - Working directory to run git command in
 * @returns Promise<RemoteBranchStatus> - Detailed status of the remote branch
 */
export async function checkRemoteBranchStatus(
  branchName: string,
  cwd: string
): Promise<RemoteBranchStatus> {
  try {
    // First, fetch to ensure we have the latest remote refs
    // This is important to accurately detect if remote is ahead
    try {
      await executeGitCommand(['fetch', 'origin', branchName], { cwd, timeout: 30000 })
    } catch (fetchError) {
      // Fetch failing for a specific branch is OK - branch might not exist on remote
      // We'll detect this in the ls-remote call
      const fetchErrorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError)

      // Check if this is a network error vs branch not found
      if (fetchErrorMessage.includes('Could not resolve host') ||
          fetchErrorMessage.includes('unable to access') ||
          fetchErrorMessage.includes('network') ||
          fetchErrorMessage.includes('Connection refused') ||
          fetchErrorMessage.includes('Connection timed out')) {
        return {
          exists: false,
          remoteAhead: false,
          localAhead: false,
          networkError: true,
          errorMessage: fetchErrorMessage
        }
      }
      // Otherwise continue - branch might just not exist on remote
    }

    // Check if remote branch exists using ls-remote
    const remoteResult = await executeGitCommand(['ls-remote', '--heads', 'origin', branchName], { cwd })

    if (remoteResult.trim().length === 0) {
      // Remote branch doesn't exist
      return {
        exists: false,
        remoteAhead: false,
        localAhead: false,
        networkError: false
      }
    }

    // Remote branch exists - check if it's ahead of local
    // Extract the remote commit hash
    const remoteCommit = remoteResult.trim().split('\t')[0]

    // Guard against undefined (shouldn't happen but TypeScript wants it)
    if (!remoteCommit) {
      return {
        exists: false,
        remoteAhead: false,
        localAhead: false,
        networkError: false
      }
    }

    // Get the local branch's HEAD commit
    const localCommit = await executeGitCommand(['rev-parse', branchName], { cwd })
    const localCommitTrimmed = localCommit.trim()

    if (remoteCommit === localCommitTrimmed) {
      // Remote and local are at the same commit - safe (no unpushed commits)
      return {
        exists: true,
        remoteAhead: false,
        localAhead: false,
        networkError: false
      }
    }

    // Commits differ - check if remote is ahead of local
    // Use merge-base to find common ancestor, then compare
    try {
      // Check if localCommit is an ancestor of remoteCommit (meaning remote is ahead)
      await executeGitCommand(['merge-base', '--is-ancestor', localCommitTrimmed, remoteCommit], { cwd })
      // If we get here, local IS an ancestor of remote, meaning remote is ahead
      // This is SAFE - no data loss because commits exist on remote
      return {
        exists: true,
        remoteAhead: true,
        localAhead: false,
        networkError: false
      }
    } catch {
      // Local is NOT an ancestor of remote
      // This means local is ahead or branches have diverged
      // Either way, local has unpushed commits - this is DANGEROUS (data loss risk)
      return {
        exists: true,
        remoteAhead: false,
        localAhead: true,
        networkError: false
      }
    }
  } catch (error) {
    // Check if this is a network error
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (errorMessage.includes('Could not resolve host') ||
        errorMessage.includes('unable to access') ||
        errorMessage.includes('network') ||
        errorMessage.includes('Connection refused') ||
        errorMessage.includes('Connection timed out')) {
      return {
        exists: false,
        remoteAhead: false,
        localAhead: false,
        networkError: true,
        errorMessage
      }
    }

    // For other errors, assume remote doesn't exist
    return {
      exists: false,
      remoteAhead: false,
      localAhead: false,
      networkError: false
    }
  }
}

/**
 * Get the merge target branch for a loom
 * Priority: parent loom metadata (parentLoom.branchName) > configured main branch > 'main'
 *
 * This is the shared utility for determining where a branch should merge to.
 * Child looms merge to their parent branch, standalone looms merge to main.
 *
 * @param worktreePath - Path to load metadata/settings from (defaults to process.cwd())
 * @param options - Optional dependency injection for testing
 * @returns The branch name to merge into
 */
export async function getMergeTargetBranch(
  worktreePath: string = process.cwd(),
  options?: {
    settingsManager?: SettingsManagerType
    metadataManager?: MetadataManager
  }
): Promise<string> {
  const settingsManager = options?.settingsManager ?? new SettingsManager()
  const metadataManager = options?.metadataManager ?? new MetadataManager()

  // Check for parent loom metadata first (child looms merge to parent)
  logger.debug(`Checking for parent loom metadata at: ${worktreePath}`)
  const metadata = await metadataManager.readMetadata(worktreePath)
  if (metadata?.parentLoom?.branchName) {
    logger.debug(`Using parent branch as merge target: ${metadata.parentLoom.branchName}`)
    return metadata.parentLoom.branchName
  }
  logger.debug('No parent loom metadata found, falling back to settings')

  // Fall back to configured main branch
  const settings = await settingsManager.loadSettings(worktreePath)
  const mainBranch = settings.mainBranch ?? 'main'
  logger.debug(`Using configured main branch as merge target: ${mainBranch}`)
  return mainBranch
}

/**
 * Placeholder commit prefix used by github-draft-pr mode.
 * Created during il start to enable draft PR creation (GitHub requires at least one commit ahead of base).
 * Removed during il finish before the final push to maintain clean commit history.
 */
export const PLACEHOLDER_COMMIT_PREFIX = '[iloom]'

/**
 * Check if HEAD commit is a placeholder commit
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if HEAD is a placeholder commit
 */
export async function isPlaceholderCommit(cwd: string = process.cwd()): Promise<boolean> {
  try {
    const subject = await executeGitCommand(['log', '-1', '--format=%s', 'HEAD'], { cwd })
    return subject.trim().startsWith(PLACEHOLDER_COMMIT_PREFIX)
  } catch {
    // No HEAD (empty repo) or other error - not a placeholder
    return false
  }
}

/**
 * Find placeholder commit SHA in history using git log --grep
 * @param worktreePath - Working directory
 * @returns SHA of placeholder commit if found, null otherwise
 */
export async function findPlaceholderCommitSha(worktreePath: string): Promise<string | null> {
  try {
    // Search commit history for placeholder prefix
    // Use --fixed-strings to treat the pattern literally (brackets are regex special chars)
    const log = await executeGitCommand(
      ['log', '--format=%H', '--fixed-strings', '--grep', PLACEHOLDER_COMMIT_PREFIX, '-n', '1'],
      { cwd: worktreePath }
    )
    const sha = log.trim()
    if (sha.length === 0) {
      return null
    }

    // Verify the found commit actually has the placeholder prefix in its subject
    // This guards against git grep matching in commit body instead of subject
    const subject = await executeGitCommand(
      ['log', '-1', '--format=%s', sha],
      { cwd: worktreePath }
    )
    if (!subject.trim().startsWith(PLACEHOLDER_COMMIT_PREFIX)) {
      return null
    }

    return sha
  } catch {
    return null
  }
}

/**
 * Remove placeholder commit when it's HEAD
 * Uses soft reset to preserve any staged changes
 * @param worktreePath - Working directory
 * @returns true if placeholder was removed
 */
export async function removePlaceholderCommitFromHead(worktreePath: string): Promise<boolean> {
  if (!await isPlaceholderCommit(worktreePath)) {
    return false
  }
  await executeGitCommand(['reset', '--soft', 'HEAD~1'], { cwd: worktreePath })
  return true
}

/**
 * Remove placeholder commit from history using rebase
 * Used when user has made commits on top of placeholder
 * @param worktreePath - Working directory
 * @param placeholderSha - SHA of the placeholder commit to remove
 * @throws Error if rebase fails
 */
export async function removePlaceholderCommitFromHistory(
  worktreePath: string,
  placeholderSha: string
): Promise<void> {
  // Get parent of placeholder commit
  const parentSha = await executeGitCommand(
    ['rev-parse', `${placeholderSha}^`],
    { cwd: worktreePath }
  )

  // Rebase to drop the placeholder: rebase --onto parent^ placeholder
  await executeGitCommand(
    ['rebase', '--onto', parentSha.trim(), placeholderSha],
    { cwd: worktreePath }
  )
}
