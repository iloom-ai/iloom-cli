import { getLogger } from '../utils/logger-context.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { ResourceCleanup } from '../lib/ResourceCleanup.js'
import { ProcessManager } from '../lib/process/ProcessManager.js'
import { DatabaseManager } from '../lib/DatabaseManager.js'
import { EnvironmentManager } from '../lib/EnvironmentManager.js'
import { CLIIsolationManager } from '../lib/CLIIsolationManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { promptConfirmation } from '../utils/prompt.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { loadEnvIntoProcess } from '../utils/env.js'
import { createNeonProviderFromSettings } from '../utils/neon-helpers.js'
import { LoomManager } from '../lib/LoomManager.js'
import type { CleanupOptions } from '../types/index.js'
import type { CleanupResult } from '../types/cleanup.js'
import type { ParsedInput } from './start.js'

/**
 * Input structure for CleanupCommand.execute()
 */
export interface CleanupCommandInput {
  identifier?: string
  options: CleanupOptions
}

/**
 * Parsed and validated cleanup command input
 * Mode determines which cleanup operation to perform
 */
export interface ParsedCleanupInput {
  mode: 'list' | 'single' | 'issue' | 'all'
  identifier?: string
  issueNumber?: string | number
  branchName?: string
  originalInput?: string
  options: CleanupOptions
}

/**
 * Manages cleanup command execution with option parsing and validation
 * Follows the command pattern established by StartCommand
 *
 * This implementation handles ONLY parsing, validation, and mode determination.
 * Actual cleanup operations are deferred to subsequent sub-issues.
 */
export class CleanupCommand {
  private readonly gitWorktreeManager: GitWorktreeManager
  private resourceCleanup?: ResourceCleanup
  private loomManager?: import('../lib/LoomManager.js').LoomManager
  private readonly identifierParser: IdentifierParser

  constructor(
    gitWorktreeManager?: GitWorktreeManager,
    resourceCleanup?: ResourceCleanup
  ) {
    // Load environment variables first
    const envResult = loadEnvIntoProcess()
    if (envResult.error) {
      getLogger().debug(`Environment loading warning: ${envResult.error.message}`)
    }
    if (envResult.parsed) {
      getLogger().debug(`Loaded ${Object.keys(envResult.parsed).length} environment variables`)
    }

    this.gitWorktreeManager = gitWorktreeManager ?? new GitWorktreeManager()

    // Initialize ResourceCleanup with DatabaseManager and CLIIsolationManager
    // ResourceCleanup will be initialized lazily with proper configuration
    if (resourceCleanup) {
      this.resourceCleanup = resourceCleanup
    }

    // Initialize IdentifierParser for pattern-based detection
    this.identifierParser = new IdentifierParser(this.gitWorktreeManager)
  }

  /**
   * Lazy initialization of ResourceCleanup and LoomManager with properly configured DatabaseManager
   */
  private async ensureResourceCleanup(): Promise<void> {
    if (this.resourceCleanup && this.loomManager) {
      return
    }

    const settingsManager = new SettingsManager()
    const settings = await settingsManager.loadSettings()
    const databaseUrlEnvVarName = settings.capabilities?.database?.databaseUrlEnvVarName ?? 'DATABASE_URL'

    const environmentManager = new EnvironmentManager()
    const neonProvider = createNeonProviderFromSettings(settings)
    const databaseManager = new DatabaseManager(neonProvider, environmentManager, databaseUrlEnvVarName)
    const cliIsolationManager = new CLIIsolationManager()

    this.resourceCleanup ??= new ResourceCleanup(
      this.gitWorktreeManager,
      new ProcessManager(),
      databaseManager,
      cliIsolationManager
    )

    // Initialize LoomManager if not provided (for child loom detection)
    if (!this.loomManager) {
      const { IssueTrackerFactory } = await import('../lib/IssueTrackerFactory.js')
      const { ClaudeContextManager } = await import('../lib/ClaudeContextManager.js')
      const { ProjectCapabilityDetector } = await import('../lib/ProjectCapabilityDetector.js')
      const { DefaultBranchNamingService } = await import('../lib/BranchNamingService.js')

      this.loomManager = new LoomManager(
        this.gitWorktreeManager,
        IssueTrackerFactory.create(settings),
        new DefaultBranchNamingService({ useClaude: true }),
        environmentManager,
        new ClaudeContextManager(),
        new ProjectCapabilityDetector(),
        cliIsolationManager,
        settingsManager,
        databaseManager
      )
    }
  }

  /**
   * Check for child looms and exit gracefully if any exist
   * Always checks the TARGET loom (the one being cleaned up), not the current directory's loom
   *
   * @param parsed - The parsed input identifying the loom being cleaned up
   */
  private async checkForChildLooms(parsed: ParsedCleanupInput): Promise<void> {
    await this.ensureResourceCleanup()
    if (!this.loomManager) {
      throw new Error('Failed to initialize LoomManager')
    }

    // Determine which branch is being cleaned up based on parsed input
    let targetBranch: string | undefined

    if (parsed.branchName) {
      targetBranch = parsed.branchName
    } else if (parsed.mode === 'issue' && parsed.issueNumber !== undefined) {
      // For issues, try to find the worktree by issue number to get the branch name
      const worktree = await this.gitWorktreeManager.findWorktreeForIssue(parsed.issueNumber)
      targetBranch = worktree?.branch
    }

    // If we can't determine the target branch, skip the check
    if (!targetBranch) {
      getLogger().debug(`Cannot determine target branch for child loom check`)
      return
    }

    // Check if the TARGET loom has any child looms
    const hasChildLooms = await this.loomManager.checkAndWarnChildLooms(targetBranch)
    if (hasChildLooms) {
      throw new Error('Cannot cleanup loom while child looms exist. Please \'finish\' or \'cleanup\' child looms first.')
    }
  }

  /**
   * Main entry point for the cleanup command
   * Parses input, validates options, and determines operation mode
   */
  public async execute(input: CleanupCommandInput): Promise<CleanupResult | void> {
    // Step 1: Parse input and determine mode
    const parsed = this.parseInput(input)

    // Step 2: Validate option combinations (fail fast before any delay)
    this.validateInput(parsed)

    // Note: JSON mode auto-skips routine confirmations (programmatic use can't interact)
    // Safety checks still require --force to bypass (ResourceCleanup.validateWorktreeSafety throws errors)

    // Step 3: Check for child looms AFTER parsing input
    // This ensures we only block when cleaning the CURRENT loom (parent), not a child
    await this.checkForChildLooms(parsed)

    // Step 4: Handle deferred execution (after all validation passes)
    if (input.options.defer) {
      getLogger().info(`Waiting ${input.options.defer}ms before cleanup...`)
      await new Promise(resolve => globalThis.setTimeout(resolve, input.options.defer))
    }

    // Step 5: Execute based on mode
    getLogger().info(`Cleanup mode: ${parsed.mode}`)

    if (parsed.mode === 'single') {
      return await this.executeSingleCleanup(parsed)
    } else if (parsed.mode === 'list') {
      getLogger().info('Would list all worktrees')  // TODO: Implement in Sub-issue #2
      getLogger().success('Command parsing and validation successful')
      return {
        identifier: 'list',
        success: true,
        dryRun: parsed.options.dryRun ?? false,
        operations: [],
        errors: [],
        rollbackRequired: false,
      }
    } else if (parsed.mode === 'all') {
      getLogger().info('Would remove all worktrees')  // TODO: Implement in Sub-issue #5
      getLogger().success('Command parsing and validation successful')
      return {
        identifier: 'all',
        success: true,
        dryRun: parsed.options.dryRun ?? false,
        operations: [],
        errors: [],
        rollbackRequired: false,
      }
    } else if (parsed.mode === 'issue') {
      return await this.executeIssueCleanup(parsed)
    }
  }

  /**
   * Parse input to determine cleanup mode and extract relevant data
   * Implements auto-detection: numeric input = issue number, non-numeric = branch name
   *
   * @private
   */
  private parseInput(input: CleanupCommandInput): ParsedCleanupInput {
    const { identifier, options } = input

    // Trim identifier if present
    const trimmedIdentifier = identifier?.trim() ?? undefined

    // Mode: List (takes priority - it's informational only)
    if (options.list) {
      const result: ParsedCleanupInput = {
        mode: 'list',
        options
      }
      if (trimmedIdentifier) {
        result.identifier = trimmedIdentifier
      }
      return result
    }

    // Mode: All (remove everything)
    if (options.all) {
      const result: ParsedCleanupInput = {
        mode: 'all',
        options
      }
      if (trimmedIdentifier) {
        result.identifier = trimmedIdentifier
      }
      if (options.issue !== undefined) {
        result.issueNumber = options.issue
      }
      return result
    }

    // Mode: Explicit issue number via --issue flag
    if (options.issue !== undefined) {
      // Need to determine if identifier is branch or numeric to set branchName
      if (trimmedIdentifier) {
        const numericPattern = /^[0-9]+$/
        if (!numericPattern.test(trimmedIdentifier)) {
          // Identifier is a branch name with explicit --issue flag
          return {
            mode: 'issue',
            issueNumber: options.issue,
            branchName: trimmedIdentifier,
            identifier: trimmedIdentifier,
            originalInput: trimmedIdentifier,
            options
          }
        }
      }
      const result: ParsedCleanupInput = {
        mode: 'issue',
        issueNumber: options.issue,
        options
      }
      if (trimmedIdentifier) {
        result.identifier = trimmedIdentifier
      }
      return result
    }

    // Mode: Auto-detect from identifier
    if (!trimmedIdentifier) {
      throw new Error('Missing required argument: identifier. Use --all to remove all worktrees or --list to list them.')
    }

    // Auto-detection: Check if identifier is purely numeric
    // Pattern from bash script line 364: ^[0-9]+$
    const numericPattern = /^[0-9]+$/
    if (numericPattern.test(trimmedIdentifier)) {
      // Numeric input = issue number
      return {
        mode: 'issue',
        issueNumber: parseInt(trimmedIdentifier, 10),
        identifier: trimmedIdentifier,
        originalInput: trimmedIdentifier,
        options
      }
    } else {
      // Non-numeric = branch name
      return {
        mode: 'single',
        branchName: trimmedIdentifier,
        identifier: trimmedIdentifier,
        originalInput: trimmedIdentifier,
        options
      }
    }
  }

  /**
   * Validate parsed input for option conflicts
   * Throws descriptive errors for invalid option combinations
   *
   * @private
   */
  private validateInput(parsed: ParsedCleanupInput): void {
    const { mode, options, branchName } = parsed

    // Conflict: --list is informational only, incompatible with destructive operations
    if (mode === 'list') {
      if (options.all) {
        throw new Error('Cannot use --list with --all (list is informational only)')
      }
      if (options.issue !== undefined) {
        throw new Error('Cannot use --list with --issue (list is informational only)')
      }
      if (parsed.identifier) {
        throw new Error('Cannot use --list with a specific identifier (list shows all worktrees)')
      }
    }

    // Conflict: --all removes everything, can't combine with specific identifier or --issue
    if (mode === 'all') {
      if (parsed.identifier) {
        throw new Error('Cannot use --all with a specific identifier. Use one or the other.')
      }
      if (parsed.issueNumber !== undefined) {
        throw new Error('Cannot use --all with a specific identifier. Use one or the other.')
      }
    }

    // Conflict: explicit --issue flag with branch name identifier
    // (This prevents confusion when user provides both)
    if (options.issue !== undefined && branchName) {
      throw new Error('Cannot use --issue flag with branch name identifier. Use numeric identifier or --issue flag alone.')
    }

    // Note: --force and --dry-run are compatible with all modes (no conflicts)
  }

  /**
   * Execute cleanup for single worktree
   * Implements two-stage confirmation: worktree removal, then branch deletion
   * Uses IdentifierParser for pattern-based detection without GitHub API calls
   */
  private async executeSingleCleanup(parsed: ParsedCleanupInput): Promise<CleanupResult> {
    const identifier = parsed.branchName ?? parsed.identifier ?? ''
    if (!identifier) {
      throw new Error('No identifier found for cleanup')
    }
    const { force, dryRun } = parsed.options

    // Step 1: Parse identifier using pattern-based detection
    let parsedInput: ParsedInput = await this.identifierParser.parseForPatternDetection(identifier)

    // If type is 'branch', try to extract issue number for CLI symlink cleanup
    if (parsedInput.type === 'branch' && parsedInput.branchName) {
      const { extractIssueNumber } = await import('../utils/git.js')
      const extractedNumber = extractIssueNumber(parsedInput.branchName)
      if (extractedNumber !== null) {
        parsedInput = {
          ...parsedInput,
          number: extractedNumber  // Add number for CLI symlink cleanup
        }
      }
    }

    // Step 2: Display worktree details
    getLogger().info(`Preparing to cleanup worktree: ${identifier}`)

    // Step 3: Routine confirmation - worktree removal
    // Skip if --force (user explicitly bypasses) or --json (programmatic use can't interact)
    // Note: Safety checks (uncommitted changes, unmerged work) still require --force to bypass
    if (!force && !parsed.options.json) {
      const confirmWorktree = await promptConfirmation('Remove this worktree?', true)
      if (!confirmWorktree) {
        getLogger().info('Cleanup cancelled')
        return {
          identifier,
          success: false,
          dryRun: dryRun ?? false,
          operations: [],
          errors: [],
          rollbackRequired: false,
        }
      }
    }

    // Step 4: Execute worktree cleanup (includes safety validation)
    // Issue #275 fix: Run 5-point safety check BEFORE any deletion
    // This prevents the scenario where worktree is deleted but branch deletion fails
    await this.ensureResourceCleanup()
    if (!this.resourceCleanup) {
      throw new Error('Failed to initialize ResourceCleanup')
    }
    const cleanupResult = await this.resourceCleanup.cleanupWorktree(parsedInput, {
      dryRun: dryRun ?? false,
      force: force ?? false,
      deleteBranch: true,  // Always include branch deletion (safety checks run first)
      keepDatabase: false,
      checkMergeSafety: true  // Run 5-point safety check BEFORE any deletion
    })

    // Add dryRun flag to result
    cleanupResult.dryRun = dryRun ?? false

    // Step 5: Report cleanup results
    this.reportCleanupResults(cleanupResult)

    // Final success message
    if (cleanupResult.success) {
      getLogger().success('Cleanup completed successfully')
    } else {
      getLogger().warn('Cleanup completed with errors - see details above')
    }

    return cleanupResult
  }

  /**
   * Report cleanup operation results to user
   */
  private reportCleanupResults(result: CleanupResult): void {
    getLogger().info('Cleanup operations:')

    result.operations.forEach(op => {
      const status = op.success ? '✓' : '✗'
      const message = op.error ? `${op.message}: ${op.error}` : op.message

      if (op.success) {
        getLogger().info(`  ${status} ${message}`)
      } else {
        getLogger().error(`  ${status} ${message}`)
      }
    })

    if (result.errors.length > 0) {
      getLogger().warn(`${result.errors.length} error(s) occurred during cleanup`)
    }
  }

  /**
   * Execute cleanup for all worktrees associated with an issue or PR number
   * Searches for worktrees by their path patterns (e.g., issue-25, pr-25, 25-feature, _pr_25)
   * Implements bash cleanup-worktree.sh remove_worktrees_by_issue() (lines 157-242)
   */
  private async executeIssueCleanup(parsed: ParsedCleanupInput): Promise<CleanupResult> {
    const issueNumber = parsed.issueNumber
    if (issueNumber === undefined) {
      throw new Error('No issue/PR number provided for cleanup')
    }

    const { force, dryRun } = parsed.options

    getLogger().info(`Finding worktrees related to issue/PR #${issueNumber}...`)

    // Step 1: Get all worktrees and filter by path pattern
    const worktrees = await this.gitWorktreeManager.listWorktrees()
    const matchingWorktrees = worktrees.filter(wt => {
      const path = wt.path.toLowerCase()
      // Lowercase for case-insensitive matching (Linear IDs are uppercase like MARK-1)
      const idStr = String(issueNumber).toLowerCase()

      // Check if path contains the identifier with proper word boundaries
      // Matches: issue-25, pr-25, 25-feature, _pr_25, issue-mark-1, etc.
      // Uses word boundary or common separators (-, _, /) for alphanumeric IDs
      const pattern = new RegExp(`(?:^|[/_-])${idStr}(?:[/_-]|$)`)
      return pattern.test(path)
    })

    if (matchingWorktrees.length === 0) {
      getLogger().warn(`No worktrees found for issue/PR #${issueNumber}`)
      getLogger().info(`Searched for worktree paths containing: ${issueNumber}, _pr_${issueNumber}, issue-${issueNumber}, etc.`)
      return {
        identifier: String(issueNumber),
        success: true,
        dryRun: dryRun ?? false,
        operations: [],
        errors: [],
        rollbackRequired: false,
      }
    }

    // Step 2: Build targets list from matching worktrees
    const targets: Array<{ branchName: string; hasWorktree: boolean; worktreePath?: string }> =
      matchingWorktrees.map(wt => ({
        branchName: wt.branch,
        hasWorktree: true,
        worktreePath: wt.path
      }))

    // Step 3: Display preview
    getLogger().info(`Found ${targets.length} worktree(s) related to issue/PR #${issueNumber}:`)
    for (const target of targets) {
      getLogger().info(`  Branch: ${target.branchName} (${target.worktreePath})`)
    }

    // Step 4: Routine batch confirmation
    // Skip if --force (user explicitly bypasses) or --json (programmatic use can't interact)
    // Note: Safety checks per-worktree (uncommitted changes, unmerged work) still require --force to bypass
    if (!force && !parsed.options.json) {
      const confirmCleanup = await promptConfirmation(
        `Remove ${targets.length} worktree(s)?`,
        true
      )
      if (!confirmCleanup) {
        getLogger().info('Cleanup cancelled')
        return {
          identifier: String(issueNumber),
          success: false,
          dryRun: dryRun ?? false,
          operations: [],
          errors: [],
          rollbackRequired: false,
        }
      }
    }

    // Step 5: Process each target sequentially
    let worktreesRemoved = 0
    let branchesDeleted = 0
    const databaseBranchesDeletedList: string[] = []
    let failed = 0

    for (const target of targets) {
      getLogger().info(`Processing worktree: ${target.branchName}`)

      // Cleanup worktree using ResourceCleanup with ParsedInput
      // Now includes branch deletion with 5-point safety check BEFORE any deletion
      try {
        // Use the known issue number directly instead of parsing from branch name
        // This ensures CLI symlinks (created with issue number) are properly cleaned up
        const parsedInput: ParsedInput = {
          type: 'issue',
          number: issueNumber,  // Use the known issue number, not parsed from branch
          branchName: target.branchName,
          originalInput: String(issueNumber)
        }

        await this.ensureResourceCleanup()
        if (!this.resourceCleanup) {
          throw new Error('Failed to initialize ResourceCleanup')
        }
        // Issue #275 fix: Run safety checks BEFORE deleting worktree
        // This prevents the scenario where worktree is deleted but branch deletion fails
        const result = await this.resourceCleanup.cleanupWorktree(parsedInput, {
          dryRun: dryRun ?? false,
          force: force ?? false,
          deleteBranch: true,  // Include branch deletion (with safety checks)
          keepDatabase: false,
          checkMergeSafety: true  // Run 5-point safety check BEFORE any deletion
        })

        if (result.success) {
          worktreesRemoved++
          getLogger().success(`  Worktree removed: ${target.branchName}`)

          // Check if branch was deleted
          const branchOperation = result.operations.find(op => op.type === 'branch')
          if (branchOperation?.success) {
            branchesDeleted++
            getLogger().success(`  Branch deleted: ${target.branchName}`)
          }

          // Check if database branch was actually deleted (use explicit deleted field)
          const dbOperation = result.operations.find(op => op.type === 'database')
          if (dbOperation?.deleted) {
            // Get branch name from result or use the target branch name
            const deletedBranchName = target.branchName
            databaseBranchesDeletedList.push(deletedBranchName)
          }
        } else {
          failed++
          getLogger().error(`  Failed to remove worktree: ${target.branchName}`)
        }
      } catch (error) {
        failed++
        const errMsg = error instanceof Error ? error.message : 'Unknown error'
        getLogger().error(`  Failed to cleanup: ${errMsg}`)
        continue // Continue with next worktree even if this one failed
      }
    }

    // Step 7: Report statistics
    getLogger().success(`Completed cleanup for issue/PR #${issueNumber}:`)
    getLogger().info(`   Worktrees removed: ${worktreesRemoved}`)
    getLogger().info(`   Branches deleted: ${branchesDeleted}`)
    if (databaseBranchesDeletedList.length > 0) {
      // Display branch names in the format requested
      getLogger().info(`   Database branches deleted: ${databaseBranchesDeletedList.join(', ')}`)
    }
    if (failed > 0) {
      getLogger().warn(`   Failed operations: ${failed}`)
    }

    // Return aggregated result
    return {
      identifier: String(issueNumber),
      success: failed === 0,
      dryRun: dryRun ?? false,
      operations: [
        { type: 'worktree' as const, success: true, message: `Removed ${worktreesRemoved} worktree(s)` },
        { type: 'branch' as const, success: true, message: `Deleted ${branchesDeleted} branch(es)` },
        ...(databaseBranchesDeletedList.length > 0 ? [{ type: 'database' as const, success: true, message: `Deleted ${databaseBranchesDeletedList.length} database branch(es)`, deleted: true }] : []),
      ],
      errors: [],
      rollbackRequired: false,
    }
  }
}
