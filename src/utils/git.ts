import path from 'path'
import { execa, type ExecaError } from 'execa'
import { type GitWorktree } from '../types/worktree.js'
import type { SettingsManager } from '../lib/SettingsManager.js'
import { logger } from './logger.js'

/**
 * Execute a Git command and return the stdout result
 * Throws an error if the command fails
 */
export async function executeGitCommand(
  args: string[],
  options?: { cwd?: string; timeout?: number; stdio?: 'inherit' | 'pipe' }
): Promise<string> {
  try {
    const result = await execa('git', args, {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeout ?? 30000,
      encoding: 'utf8',
      stdio: options?.stdio ?? 'pipe',
      verbose: logger.isDebugEnabled(),
    })

    return result.stdout
  } catch (error) {
    const execaError = error as ExecaError
    const stderr = execaError.stderr ?? execaError.message ?? 'Unknown Git error'
    throw new Error(`Git command failed: ${stderr}`)
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
 */
export function extractIssueNumber(branchName: string): number | null {
  const patterns = [
    /issue-(\d+)/i,       // issue-42, feat/issue-42-description
    /issue_(\d+)/i,       // issue_42
    /^(\d+)-/,            // 42-feature-name (leading number)
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
 * Get repository root directory
 */
export async function getRepoRoot(path: string = process.cwd()): Promise<string | null> {
  try {
    const result = await executeGitCommand(['rev-parse', '--show-toplevel'], { cwd: path })
    return result.trim()
  } catch {
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
  settingsManager?: SettingsManager
): Promise<string> {
  // Lazy load SettingsManager to avoid circular dependencies
  if (!settingsManager) {
    const { SettingsManager: SM } = await import('../lib/SettingsManager.js')
    settingsManager = new SM()
  }

  const settings = await settingsManager.loadSettings(path)
  const findOptions = settings.mainBranch ? { mainBranch: settings.mainBranch } : undefined
  return findMainWorktreePath(path, findOptions)
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
  settingsManager?: SettingsManager
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

    // Check for common error patterns
    if (errorMessage.includes('failed to push') || errorMessage.includes('rejected')) {
      throw new Error(
        `Failed to push changes to origin/${branchName}\n\n` +
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
        `   Check your internet connection and try again.`
      )
    }

    if (errorMessage.includes('No such remote')) {
      throw new Error(
        `Failed to push changes: Remote 'origin' not found\n\n` +
        `   Configure remote: git remote add origin <url>`
      )
    }

    // For other errors, re-throw with original message
    throw new Error(`Failed to push to remote: ${errorMessage}`)
  }
}
