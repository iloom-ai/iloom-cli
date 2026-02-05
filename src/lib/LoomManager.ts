import path from 'path'
import fs from 'fs-extra'
import fg from 'fast-glob'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import type { IssueTracker } from './IssueTracker.js'
import type { BranchNamingService } from './BranchNamingService.js'
import { EnvironmentManager } from './EnvironmentManager.js'
import { ClaudeContextManager } from './ClaudeContextManager.js'
import { ProjectCapabilityDetector } from './ProjectCapabilityDetector.js'
import { CLIIsolationManager } from './CLIIsolationManager.js'
import { VSCodeIntegration } from './VSCodeIntegration.js'
import { SettingsManager } from './SettingsManager.js'
import { MetadataManager, type WriteMetadataInput } from './MetadataManager.js'
import { branchExists, executeGitCommand, ensureRepositoryHasCommits, extractIssueNumber, isFileTrackedByGit, extractPRNumber, PLACEHOLDER_COMMIT_PREFIX, pushBranchToRemote, GitCommandError, fetchOrigin } from '../utils/git.js'
import { GitHubService } from './GitHubService.js'
import { generateRandomSessionId } from '../utils/claude.js'
import { installDependencies } from '../utils/package-manager.js'
import { generateColorFromBranchName, selectDistinctColor, hexToRgb, type ColorData } from '../utils/color.js'
import { detectDarkMode } from '../utils/terminal.js'
import { DatabaseManager } from './DatabaseManager.js'
import { loadEnvIntoProcess, findEnvFileForDatabaseUrl, isNoEnvFilesFoundError } from '../utils/env.js'
import type { Loom, CreateLoomInput } from '../types/loom.js'
import type { GitWorktree } from '../types/worktree.js'
import type { Issue, PullRequest } from '../types/index.js'
import { getLogger } from '../utils/logger-context.js'
import { PRManager } from './PRManager.js'

/**
 * LoomManager orchestrates the creation and management of looms (isolated workspaces)
 * Bridges the gap between input validation and workspace operations
 */
export class LoomManager {
  private metadataManager: MetadataManager
  private githubService: GitHubService | undefined

  constructor(
    private gitWorktree: GitWorktreeManager,
    private issueTracker: IssueTracker,
    private branchNaming: BranchNamingService,
    private environment: EnvironmentManager,
    _claude: ClaudeContextManager, // Not stored - kept for DI compatibility, LoomLauncher creates its own
    private capabilityDetector: ProjectCapabilityDetector,
    private cliIsolation: CLIIsolationManager,
    private settings: SettingsManager,
    private database?: DatabaseManager,
    githubService?: GitHubService
  ) {
    this.metadataManager = new MetadataManager()
    this.githubService = githubService
  }

  /**
   * Get database branch name for a loom by reading its .env file
   * Returns null if database is not configured or branch cannot be determined
   *
   * @param loomPath - Path to the loom worktree
   */
  async getDatabaseBranchForLoom(loomPath: string): Promise<string | null> {
    if (!this.database) {
      return null
    }

    try {
      const envFilePath = path.join(loomPath, '.env')
      const settings = await this.settings.loadSettings()
      const databaseUrlVarName = settings.capabilities?.database?.databaseUrlEnvVarName ?? 'DATABASE_URL'

      // Get database connection string from loom's .env file
      const connectionString = await this.environment.getEnvVariable(envFilePath, databaseUrlVarName)

      if (!connectionString) {
        return null
      }

      return await this.database.getBranchNameFromConnectionString(connectionString, loomPath)
    } catch (error) {
      getLogger().debug(`Could not get database branch for loom at ${loomPath}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return null
    }
  }

  /**
   * Create a new loom (isolated workspace)
   * Orchestrates worktree creation, environment setup, and Claude context generation
   * NEW: Checks for existing worktrees and reuses them if found
   */
  async createIloom(input: CreateLoomInput): Promise<Loom> {
    // 1. Fetch issue/PR data if needed
    getLogger().info('Fetching issue data...')
    const issueData = await this.fetchIssueData(input)

    // NEW: Check for existing worktree BEFORE generating branch name (for efficiency)
    if (input.type === 'issue' || input.type === 'pr' || input.type === 'branch') {
      getLogger().info('Checking for existing worktree...')
      const existing = await this.findExistingIloom(input, issueData)
      if (existing) {
        getLogger().success(`Found existing worktree, reusing: ${existing.path}`)
        return await this.reuseIloom(existing, input, issueData)
      }
      getLogger().info('No existing worktree found, creating new one...')
    }

    // 2. Generate or validate branch name
    getLogger().info('Preparing branch name...')
    const branchName = await this.prepareBranchName(input, issueData)

    // 3. Create git worktree (WITHOUT dependency installation)
    getLogger().info('Creating git worktree...')
    const worktreePath = await this.createWorktreeOnly(input, branchName)

    // 4. Load main .env variables into process.env (like bash script lines 336-339)
    this.loadMainEnvFile()

    // 5. Detect project capabilities
    const { capabilities, binEntries } = await this.capabilityDetector.detectCapabilities(worktreePath)

    // 6. Copy environment files (.env) - ALWAYS done regardless of capabilities
    await this.copyEnvironmentFiles(worktreePath)

    // 7. Copy Loom settings (settings.local.json) - ALWAYS done regardless of capabilities
    await this.copyIloomSettings(worktreePath)

    // 7.1. Copy iloom package local config (package.iloom.local.json)
    await this.copyIloomPackageLocal(worktreePath)

    // 7.5. Copy Claude settings (.claude/settings.local.json) - ALWAYS done regardless of capabilities
    await this.copyClaudeSettings(worktreePath)

    // 7.6. Copy gitignored files matching configured patterns
    await this.copyGitIgnoredFiles(worktreePath)

    // 8. Setup PORT environment variable - ONLY for web projects
    // Load base port from settings
    const settingsData = await this.settings.loadSettings()
    const basePort = settingsData.capabilities?.web?.basePort ?? 3000

    let port = basePort // default
    if (capabilities.includes('web')) {
      port = await this.setupPortForWeb(worktreePath, input, basePort)
    }

    // 9. Install dependencies AFTER environment setup (like bash script line 757-769)
    try {
      await installDependencies(worktreePath, true, true)
    } catch (error) {
      // Log warning but don't fail - matches bash script behavior
      getLogger().warn(`Failed to install dependencies: ${error instanceof Error ? error.message : 'Unknown error'}`, error)
    }

    // 10. Setup database branch if configured
    let databaseBranch: string | undefined = undefined
    if (this.database && !input.options?.skipDatabase) {
      try {
        const connectionString = await this.database.createBranchIfConfigured(
          branchName,
          worktreePath, // workspace path - checks all dotenv-flow files
          undefined, // cwd
          input.parentLoom?.databaseBranch // fromBranch - use parent's database branch for child looms
        )

        if (connectionString) {
          const varName = this.database.getConfiguredVariableName()
          const targetFile = await findEnvFileForDatabaseUrl(
            worktreePath,
            varName,
            isFileTrackedByGit,
            async (p) => fs.pathExists(p),
            async (p, v) => this.environment.getEnvVariable(p, v)
          )
          await this.environment.setEnvVar(
            path.join(worktreePath, targetFile),
            varName,
            connectionString
          )
          getLogger().success('Database branch configured')
          databaseBranch = branchName
        }
      } catch (error) {
        getLogger().error(
          `Failed to setup database branch: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
        throw error  // Database creation failures are fatal
      }
    }

    // 10. Setup CLI isolation if project has CLI capability
    // Skip in branch mode - branch mode workspaces don't have a built dist/cli.js
    let cliSymlinks: string[] | undefined = undefined
    if (capabilities.includes('cli') && input.type !== 'branch') {
      try {
        cliSymlinks = await this.cliIsolation.setupCLIIsolation(
          worktreePath,
          input.identifier,
          binEntries
        )
      } catch (error) {
        // Log warning but don't fail - matches dependency installation behavior
        getLogger().warn(
          `Failed to setup CLI isolation: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error
        )
      }
    }

    // 10.5. Handle github-draft-pr mode - push branch and create draft PR
    let draftPrNumber: number | undefined = undefined
    let draftPrUrl: string | undefined = undefined

    const mergeBehavior = settingsData.mergeBehavior ?? { mode: 'local' }

    if (mergeBehavior.mode === 'github-draft-pr' && (input.type === 'issue' || input.type === 'branch')) {
      const prManager = new PRManager(settingsData)

      // Fetch from origin to get latest remote branch state
      getLogger().info('Fetching from origin...')
      await executeGitCommand(['fetch', 'origin'], { cwd: worktreePath })

      // Check if remote branch already exists
      let remoteBranchExists = false
      try {
        await executeGitCommand(['rev-parse', '--verify', `origin/${branchName}`], { cwd: worktreePath })
        remoteBranchExists = true
        getLogger().info(`Remote branch origin/${branchName} already exists, resetting local to match...`)
      } catch (error: unknown) {
        // Only treat as "branch doesn't exist" if it's a GitCommandError with the expected error patterns
        // Git rev-parse returns exit code 128 for missing refs with messages like:
        // "fatal: Needed a single revision" or "unknown revision"
        if (error instanceof GitCommandError &&
            (error.stderr.includes('unknown revision') ||
             error.stderr.includes('Needed a single revision') ||
             error.stderr.includes('bad revision'))) {
          // Remote branch doesn't exist - this is the normal case for new branches
          getLogger().debug(`Remote branch origin/${branchName} does not exist`)
        } else {
          // Re-throw unexpected errors (e.g., git crash, permissions, lock file issues)
          throw error
        }
      }

      // If remote branch exists, reset local branch to match it (preserves previous work)
      if (remoteBranchExists) {
        await executeGitCommand(['reset', '--hard', `origin/${branchName}`], { cwd: worktreePath })
        await executeGitCommand(['branch', '--set-upstream-to', `origin/${branchName}`], { cwd: worktreePath })
        getLogger().success('Local branch reset to match remote')
      } else {
        // Only create placeholder commit if remote branch didn't exist
        // (if we reset to remote, we already have commits)
        getLogger().info('Creating placeholder commit for draft PR...')
        await executeGitCommand(
          [
            'commit',
            '--allow-empty',
            '--no-verify',
            '-m',
            `${PLACEHOLDER_COMMIT_PREFIX} Temporary commit for draft PR (will be removed on finish)`
          ],
          { cwd: worktreePath }
        )
        getLogger().debug('Placeholder commit created')

        // Push branch to remote (required for draft PR creation)
        getLogger().info('Pushing branch to remote for draft PR...')
        await pushBranchToRemote(branchName, worktreePath, { dryRun: false })
      }

      // Check for existing draft PR before creating a new one
      const existingPR = await prManager.checkForExistingPR(branchName, worktreePath)

      if (existingPR) {
        // Reuse existing PR
        draftPrNumber = existingPR.number
        draftPrUrl = existingPR.url
        getLogger().success(`Found existing PR: ${existingPR.url}`)
      } else {
        // Generate PR title and body
        // For issue mode: use issue title and reference issue number
        // For branch mode: use branch name and generic description
        const prTitle = issueData?.title ?? `Work on ${branchName}`
        const prBody = input.type === 'issue'
          ? `PR for issue #${input.identifier}\n\nThis PR was created automatically by iloom.`
          : `Branch: ${branchName}\n\nThis PR was created automatically by iloom.`

        // Create draft PR
        getLogger().info('Creating draft PR...')
        const prResult = await prManager.createDraftPR(
          branchName,
          prTitle,
          prBody,
          worktreePath
        )

        draftPrNumber = prResult.number
        draftPrUrl = prResult.url
        getLogger().success(`Draft PR created: ${prResult.url}`)
      }
    }

    // 11. Select color with collision avoidance
    // Get hex colors in use from ALL stored looms across all projects (global collision detection)
    // This prevents color reuse across different repositories for the same user
    const allMetadata = await this.metadataManager.listAllMetadata()
    const usedHexColors: string[] = allMetadata
      .filter((metadata) => metadata.colorHex !== null)
      .map((metadata) => metadata.colorHex as string)

    // Detect dark mode and select appropriate color palette
    const themeMode = await detectDarkMode()

    // Select distinct color using hex-based comparison
    const colorData = selectDistinctColor(branchName, usedHexColors, themeMode)
    getLogger().debug(`Selected color ${colorData.hex} for branch ${branchName} (${usedHexColors.length} colors in use globally)`)

    // Apply color synchronization (terminal and VSCode) based on settings
    try {
      await this.applyColorSynchronization(worktreePath, branchName, colorData, settingsData, input.options)
    } catch (error) {
      // Log warning but don't fail - colors are cosmetic
      getLogger().warn(
        `Failed to apply color synchronization: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error
      )
    }

    // NEW: Move issue to In Progress (for new worktrees)
    if (input.type === 'issue') {
      try {
        getLogger().info('Moving issue to In Progress...')
        // Check if provider supports this optional method
        if (this.issueTracker.moveIssueToInProgress) {
          await this.issueTracker.moveIssueToInProgress(input.identifier as number)
        }
      } catch (error) {
        // Warn but don't fail - matches bash script behavior
        getLogger().warn(
          `Failed to move issue to In Progress: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error
        )
      }
    }

    // 11.5. Launch workspace components based on individual flags
    const enableClaude = input.options?.enableClaude !== false
    const enableCode = input.options?.enableCode !== false
    const enableDevServer = input.options?.enableDevServer !== false
    const enableTerminal = input.options?.enableTerminal ?? false
    const oneShot = input.options?.oneShot ?? 'default'
    const setArguments = input.options?.setArguments
    const executablePath = input.options?.executablePath

    // Only launch if at least one component is enabled
    if (enableClaude || enableCode || enableDevServer || enableTerminal) {
      const { LoomLauncher } = await import('./LoomLauncher.js')
      const { ClaudeContextManager } = await import('./ClaudeContextManager.js')

      // Create ClaudeContextManager with shared SettingsManager to ensure CLI overrides work
      const claudeContext = new ClaudeContextManager(undefined, undefined, this.settings)
      const launcher = new LoomLauncher(claudeContext, this.settings)

      await launcher.launchLoom({
        enableClaude,
        enableCode,
        enableDevServer,
        enableTerminal,
        worktreePath,
        branchName,
        port,
        capabilities,
        workflowType: input.type === 'branch' ? 'regular' : input.type,
        identifier: input.identifier,
        ...(issueData?.title && { title: issueData.title }),
        oneShot,
        ...(setArguments && { setArguments }),
        ...(executablePath && { executablePath }),
        sourceEnvOnStart: settingsData.sourceEnvOnStart ?? false,
        colorTerminal: input.options?.colorTerminal ?? settingsData.colors?.terminal ?? true,
        colorHex: colorData.hex,
      })
    }

    // 12. Write loom metadata (spec section 3.1)
    // Derive description from issue/PR title or branch name
    const description = issueData?.title ?? branchName

    // Build issue/pr numbers arrays based on type
    // For PR workflows, extract issue number from branch name if present
    let issue_numbers: string[] = []
    let extractedIssueNum: string | null = null
    if (input.type === 'issue') {
      issue_numbers = [String(input.identifier)]
    } else if (input.type === 'pr') {
      extractedIssueNum = extractIssueNumber(branchName)
      if (extractedIssueNum) {
        issue_numbers = [extractedIssueNum]
      }
    }
    const pr_numbers: string[] = input.type === 'pr' ? [String(input.identifier)] : []

    // If a draft PR was created, add its number to pr_numbers
    // This ensures pr_numbers and prUrls are consistent (fixes #555)
    if (draftPrNumber && !pr_numbers.includes(String(draftPrNumber))) {
      pr_numbers.push(String(draftPrNumber))
    }

    // Generate random session ID for Claude Code resume support
    // Each loom gets a unique session ID, enabling fresh Claude sessions
    const sessionId = generateRandomSessionId()

    // Build issueUrls/prUrls based on workflow type
    // For PR workflows, construct issue URL by replacing /pull/N with /issues/M
    let issueUrls: Record<string, string> = {}
    if (input.type === 'issue' && issueData?.url) {
      issueUrls = { [String(input.identifier)]: issueData.url }
    } else if (input.type === 'pr' && extractedIssueNum && issueData?.url) {
      const issueUrl = issueData.url.replace(`/pull/${input.identifier}`, `/issues/${extractedIssueNum}`)
      issueUrls = { [extractedIssueNum]: issueUrl }
    }
    // Include draft PR URL in prUrls if created
    const prUrls: Record<string, string> = draftPrNumber && draftPrUrl
      ? { [String(draftPrNumber)]: draftPrUrl }
      : input.type === 'pr' && issueData?.url
        ? { [String(input.identifier)]: issueData.url }
        : {}

    const metadataInput: WriteMetadataInput = {
      description,
      branchName,
      worktreePath,
      issueType: input.type,
      issue_numbers,
      pr_numbers,
      issueTracker: this.issueTracker.providerName,
      colorHex: colorData.hex,
      sessionId,
      projectPath: this.gitWorktree.workingDirectory,
      issueUrls,
      prUrls,
      capabilities,
      ...(draftPrNumber && { draftPrNumber }),
      ...(input.options?.oneShot && { oneShot: input.options.oneShot }),
      ...(input.parentLoom && { parentLoom: input.parentLoom }),
    }
    await this.metadataManager.writeMetadata(worktreePath, metadataInput)

    // 13. Create and return loom metadata
    const loom: Loom = {
      id: this.generateLoomId(input),
      path: worktreePath,
      branch: branchName,
      type: input.type,
      identifier: input.identifier,
      port,
      description,
      createdAt: new Date(),
      lastAccessed: new Date(),
      ...(databaseBranch !== undefined && { databaseBranch }),
      ...(capabilities.length > 0 && { capabilities }),
      ...(Object.keys(binEntries).length > 0 && { binEntries }),
      ...(cliSymlinks && cliSymlinks.length > 0 && { cliSymlinks }),
      ...(issueData !== null && {
        issueData: {
          title: issueData.title,
          body: issueData.body,
          url: issueData.url,
          state: issueData.state,
        },
      }),
    }

    getLogger().success(`Created loom: ${loom.id} at ${loom.path}`)
    return loom
  }

  /**
   * Finish a loom (merge work and cleanup)
   * Not yet implemented - see Issue #7
   */
  async finishIloom(_identifier: string): Promise<void> {
    throw new Error('Not implemented - see Issue #7')
  }


  /**
   * List all active looms
   */
  async listLooms(): Promise<Loom[]> {
    const worktrees = await this.gitWorktree.listWorktrees()
    if (!worktrees) {
      return []
    }
    return await this.mapWorktreesToLooms(worktrees)
  }

  /**
   * Find a specific loom by identifier
   * Case-insensitive matching for Linear IDs (MARK-1 vs mark-1)
   */
  async findIloom(identifier: string): Promise<Loom | null> {
    const looms = await this.listLooms()
    const lowerIdentifier = identifier.toLowerCase()
    return (
      looms.find(
        h =>
          h.id.toLowerCase() === lowerIdentifier ||
          h.identifier.toString().toLowerCase() === lowerIdentifier ||
          h.branch.toLowerCase() === lowerIdentifier
      ) ?? null
    )
  }

  /**
   * Find child looms for a given parent loom
   * Child looms are worktrees created with the parent loom as their base
   *
   * @param parentBranchName - The parent loom's branch name
   * @returns Array of child loom worktrees
   */
  async findChildLooms(parentBranchName: string): Promise<GitWorktree[]> {
    try {
      const worktrees = await this.gitWorktree.listWorktrees()
      if (!worktrees) {
        return []
      }

      // Sanitize parent branch name the same way as in createWorktreeOnly (lines 361-363)
      const sanitizedBranchName = parentBranchName
        .replace(/\//g, '-')
        .replace(/[^a-zA-Z0-9-_]/g, '-')

      // Child looms are in directory: {sanitizedBranchName}-looms/
      const pattern = `${sanitizedBranchName}-looms/`

      return worktrees.filter(wt => wt.path.includes(pattern))
    } catch (error) {
      getLogger().debug(`Failed to find child looms: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return []
    }
  }

  /**
   * Check for child looms and warn user if any exist
   * This is useful before finishing or cleaning up a parent loom
   *
   * @param branchName - Optional branch name to check. If not provided, uses current branch.
   * @returns true if child looms were found, false otherwise
   */
  async checkAndWarnChildLooms(branchName?: string): Promise<boolean> {
    // Use provided branch name or get current branch
    let targetBranch: string | null | undefined = branchName
    if (!targetBranch) {
      const { getCurrentBranch } = await import('../utils/git.js')
      targetBranch = await getCurrentBranch()
    }

    // Skip if not on a branch
    if (!targetBranch) {
      return false
    }

    const childLooms = await this.findChildLooms(targetBranch)
    if (childLooms.length > 0) {
      getLogger().warn(`Found ${childLooms.length} child loom(s) that should be finished first:`)
      for (const child of childLooms) {
        getLogger().warn(`  - ${child.path}`)
      }
      getLogger().warn('')
      getLogger().warn('To finish child looms:')
      for (const child of childLooms) {
        // Extract identifier from child branch for finish command
        // Check PR first since PR branches often contain issue numbers too
        const prMatch = child.branch.match(/_pr_(\d+)/)
        const issueId = extractIssueNumber(child.branch)

        const childIdentifier = prMatch
          ? prMatch[1]  // PR: use number
          : issueId ?? child.branch  // Issue: use extracted ID (alphanumeric or numeric), or branch name

        getLogger().warn(`  il finish ${childIdentifier}`)
      }
      getLogger().warn('')
      return true
    }

    return false
  }

  /**
   * Fetch issue/PR data based on input type
   */
  private async fetchIssueData(
    input: CreateLoomInput
  ): Promise<Issue | PullRequest | null> {
    if (input.type === 'issue') {
      return await this.issueTracker.fetchIssue(input.identifier as number)
    } else if (input.type === 'pr') {
      // Use issue tracker if it supports PRs
      if (this.issueTracker.supportsPullRequests && this.issueTracker.fetchPR) {
        return await this.issueTracker.fetchPR(input.identifier as number)
      }
      // Use injected GitHubService if available
      if (this.githubService) {
        return await this.githubService.fetchPR(input.identifier as number)
      }
      // Create GitHubService on demand for PR fetching
      const github = new GitHubService()
      return await github.fetchPR(input.identifier as number)
    }
    return null
  }

  /**
   * Prepare branch name based on input type and issue/PR data
   */
  private async prepareBranchName(
    input: CreateLoomInput,
    issueData: Issue | PullRequest | null
  ): Promise<string> {
    if (input.type === 'branch') {
      return input.identifier as string
    }

    if (input.type === 'pr' && issueData && 'branch' in issueData) {
      return issueData.branch
    }

    if (input.type === 'issue' && issueData) {
      // Use BranchNamingService for AI-powered branch name generation
      const branchName = await this.branchNaming.generateBranchName({
        issueNumber: input.identifier as number,
        title: issueData.title,
      })
      return branchName
    }

    // Fallback for edge cases
    if (input.type === 'pr') {
      return `pr-${input.identifier}`
    }

    throw new Error(`Unable to determine branch name for input type: ${input.type}`)
  }

  /**
   * Create worktree for the loom (without dependency installation)
   */
  private async createWorktreeOnly(
    input: CreateLoomInput,
    branchName: string
  ): Promise<string> {
    // Ensure repository has at least one commit (needed for worktree creation)
    // This handles the case where the repo is completely empty (post git init, pre-first commit)
    getLogger().info('Ensuring repository has initial commit...')
    await ensureRepositoryHasCommits(this.gitWorktree.workingDirectory)

    // Load worktree prefix from settings
    const settingsData = await this.settings.loadSettings()
    let worktreePrefix = settingsData.worktreePrefix

    // If this is a child loom, compute dynamic prefix based on parent
    if (input.parentLoom) {
      // Sanitize branch name for directory use
      const sanitizedBranchName = input.parentLoom.branchName
        .replace(/\//g, '-')
        .replace(/[^a-zA-Z0-9-_]/g, '-')
      worktreePrefix = `${sanitizedBranchName}-looms/`
      getLogger().info(`Creating child loom with prefix: ${worktreePrefix}`)
    }

    // Build options object, only including prefix if it's defined
    const pathOptions: { isPR?: boolean; prNumber?: number; prefix?: string } =
      input.type === 'pr'
        ? { isPR: true, prNumber: input.identifier as number }
        : {}

    if (worktreePrefix !== undefined) {
      pathOptions.prefix = worktreePrefix
    }

    const worktreePath = this.gitWorktree.generateWorktreePath(
      branchName,
      undefined,
      pathOptions
    )

    // Fetch all remote branches to ensure we have latest refs (especially for PRs)
    // Ports: bash script lines 667-674
    if (input.type === 'pr') {
      getLogger().info('Fetching all remote branches...')
      try {
        await executeGitCommand(['fetch', 'origin'], { cwd: this.gitWorktree.workingDirectory })
        getLogger().success('Successfully fetched from remote')
      } catch (error) {
        throw new Error(
          `Failed to fetch from remote: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
          `Make sure you have access to the repository.`
        )
      }
    }

    // Check if branch exists locally only (used for different purposes depending on type)
    // Pass false for includeRemote to only check local branches - remote branch existence
    // is handled separately in github-draft-pr mode
    const branchExistedLocally = await branchExists(branchName, process.cwd(), false)

    // For non-PRs, throw error if branch exists
    // For PRs, we'll use this to determine if we need to reset later
    if (input.type !== 'pr' && branchExistedLocally) {
      throw new Error(
        `Cannot create worktree: branch '${branchName}' already exists. ` +
        `Use 'git branch -D ${branchName}' to delete it first if needed.`
      )
    }

    // Determine base branch based on loom type and merge mode:
    // - Child looms: use parent's local branch (parent may not be pushed yet)
    // - PR modes (github-pr, github-draft-pr) for non-child, non-PR type: fetch and use origin/{mainBranch}
    // - Local mode or PR type: use explicit baseBranch or default (main)
    const mergeBehavior = settingsData.mergeBehavior ?? { mode: 'local' }
    const isPRMode = mergeBehavior.mode === 'github-pr' || mergeBehavior.mode === 'github-draft-pr'
    const isChildLoom = !!input.parentLoom

    let baseBranch: string | undefined

    if (isChildLoom) {
      // Child looms: use parent's local branch (no fetch - parent may not be pushed)
      baseBranch = input.parentLoom?.branchName ?? input.baseBranch
    } else if (isPRMode && input.type !== 'pr') {
      // PR modes (non-child, non-PR type): fetch origin and branch from origin/{mainBranch}
      getLogger().info('Fetching from origin to ensure latest main branch...')
      await fetchOrigin(this.gitWorktree.workingDirectory)

      const mainBranch = settingsData.mainBranch ?? 'main'
      baseBranch = `origin/${mainBranch}`
      getLogger().info(`Branching from ${baseBranch}`)
    } else {
      // Local mode or PR type: use explicit baseBranch or default (main)
      baseBranch = input.baseBranch
    }

    await this.gitWorktree.createWorktree({
      path: worktreePath,
      branch: branchName,
      createBranch: input.type !== 'pr', // PRs use existing branches
      ...(baseBranch && { baseBranch }),
    })

    // Reset PR branch to match remote exactly (if we created a new local branch)
    // Ports: bash script lines 689-713
    if (input.type === 'pr' && !branchExistedLocally) {
      getLogger().info('Resetting new PR branch to match remote exactly...')
      try {
        await executeGitCommand(['reset', '--hard', `origin/${branchName}`], { cwd: worktreePath })
        await executeGitCommand(['branch', '--set-upstream-to', `origin/${branchName}`], { cwd: worktreePath })
        getLogger().success('Successfully reset to match remote')
      } catch (error) {
        getLogger().warn(`Failed to reset to match remote: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    return worktreePath
  }

  /**
   * Copy user application environment files (.env) from main repo to worktree
   * Copies all dotenv-flow patterns: .env, .env.local, .env.{NODE_ENV}, .env.{NODE_ENV}.local
   * Only copies files that exist and are NOT tracked by git (tracked files exist via worktree)
   * Always called regardless of project capabilities
   */
  private async copyEnvironmentFiles(worktreePath: string): Promise<void> {
    const mainWorkspacePath = this.gitWorktree.workingDirectory
    const nodeEnv = process.env.DOTENV_FLOW_NODE_ENV ?? 'development'

    // Define all dotenv-flow patterns to copy
    const envFilePatterns = [
      '.env',
      '.env.local',
      `.env.${nodeEnv}`,
      `.env.${nodeEnv}.local`
    ]

    for (const pattern of envFilePatterns) {
      try {
        const mainEnvPath = path.join(mainWorkspacePath, pattern)
        const worktreeEnvPath = path.join(worktreePath, pattern)

        // Skip if file doesn't exist in main workspace
        if (!(await fs.pathExists(mainEnvPath))) {
          continue
        }

        // Skip if file is tracked by git (it will exist in worktree via git)
        if (await isFileTrackedByGit(pattern, mainWorkspacePath)) {
          getLogger().debug(`Skipping ${pattern} (tracked by git, already in worktree)`)
          continue
        }

        // Skip if file already exists in worktree
        if (await fs.pathExists(worktreeEnvPath)) {
          getLogger().warn(`${pattern} already exists in worktree, skipping copy`)
          continue
        }

        // Copy the untracked env file
        await this.environment.copyIfExists(mainEnvPath, worktreeEnvPath)
        getLogger().debug(`Copied ${pattern} to worktree`)
      } catch (error) {
        // Handle gracefully if individual file fails to copy
        getLogger().warn(`Warning: Failed to copy ${pattern}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }
  }

  /**
   * Copy iloom configuration (settings.local.json) from main repo to worktree
   * Always called regardless of project capabilities
   * @param worktreePath Path to the worktree
   */
  private async copyIloomSettings(worktreePath: string): Promise<void> {
    const mainSettingsLocalPath = path.join(process.cwd(), '.iloom', 'settings.local.json')

    try {
      const worktreeIloomDir = path.join(worktreePath, '.iloom')

      // Ensure .iloom directory exists in worktree
      await fs.ensureDir(worktreeIloomDir)

      const worktreeSettingsLocalPath = path.join(worktreeIloomDir, 'settings.local.json')

      // Check if settings.local.json already exists in worktree
      if (await fs.pathExists(worktreeSettingsLocalPath)) {
        getLogger().warn('settings.local.json already exists in worktree, skipping copy')
      } else {
        await this.environment.copyIfExists(mainSettingsLocalPath, worktreeSettingsLocalPath)
      }
    } catch (error) {
      getLogger().warn(`Warning: Failed to copy settings.local.json: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Copy iloom package local config (package.iloom.local.json) from main repo to worktree
   * Always called regardless of project capabilities
   * Follows the same pattern as copyIloomSettings()
   * @param worktreePath Path to the worktree
   */
  private async copyIloomPackageLocal(worktreePath: string): Promise<void> {
    const mainPackageLocalPath = path.join(process.cwd(), '.iloom', 'package.iloom.local.json')

    try {
      const worktreeIloomDir = path.join(worktreePath, '.iloom')

      // Ensure .iloom directory exists in worktree
      await fs.ensureDir(worktreeIloomDir)

      const worktreePackageLocalPath = path.join(worktreeIloomDir, 'package.iloom.local.json')

      // Check if package.iloom.local.json already exists in worktree
      if (await fs.pathExists(worktreePackageLocalPath)) {
        getLogger().debug('package.iloom.local.json already exists in worktree, skipping copy')
      } else {
        await this.environment.copyIfExists(mainPackageLocalPath, worktreePackageLocalPath)
      }
    } catch (error) {
      getLogger().warn(`Warning: Failed to copy package.iloom.local.json: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Copy Claude settings (settings.local.json) from main repo to worktree
   * Always called regardless of project capabilities
   * Follows the same pattern as copyIloomSettings()
   * @param worktreePath Path to the worktree
   */
  private async copyClaudeSettings(worktreePath: string): Promise<void> {
    const mainClaudeSettingsPath = path.join(process.cwd(), '.claude', 'settings.local.json')

    try {
      const worktreeClaudeDir = path.join(worktreePath, '.claude')

      // Ensure .claude directory exists in worktree
      await fs.ensureDir(worktreeClaudeDir)

      const worktreeClaudeSettingsPath = path.join(worktreeClaudeDir, 'settings.local.json')

      // Check if settings.local.json already exists in worktree
      if (await fs.pathExists(worktreeClaudeSettingsPath)) {
        getLogger().debug('.claude/settings.local.json already exists in worktree, skipping copy')
      } else {
        await this.environment.copyIfExists(mainClaudeSettingsPath, worktreeClaudeSettingsPath)
      }
    } catch (error) {
      getLogger().warn(`Warning: Failed to copy .claude/settings.local.json: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Copy gitignored files matching configured patterns from main repo to worktree
   * Uses copyGitIgnoredPatterns from settings to determine which files to copy
   * Only copies files that exist and are NOT tracked by git
   *
   * @param worktreePath Path to the worktree
   */
  private async copyGitIgnoredFiles(worktreePath: string): Promise<void> {
    // Load settings to get patterns
    const settingsData = await this.settings.loadSettings()
    const patterns = settingsData.copyGitIgnoredPatterns

    // Exit early if no patterns configured
    if (!patterns || patterns.length === 0) {
      getLogger().debug('No copyGitIgnoredPatterns configured, skipping gitignored file copy')
      return
    }

    const mainWorkspacePath = this.gitWorktree.workingDirectory

    try {
      // Pass all patterns at once - fast-glob deduplicates automatically
      const allMatches = await fg.glob(patterns, {
        cwd: mainWorkspacePath,
        onlyFiles: true,
        dot: true,
      })

      if (allMatches.length === 0) {
        getLogger().debug(`No files matched copyGitIgnoredPatterns: ${patterns.join(', ')}`)
        return
      }

      getLogger().info(`Copying ${allMatches.length} gitignored file(s) matching: ${patterns.join(', ')}`)

      // Copy each unique file once
      let copiedCount = 0
      for (const relativePath of allMatches) {
        const mainFilePath = path.join(mainWorkspacePath, relativePath)
        const worktreeFilePath = path.join(worktreePath, relativePath)

        // Skip if file doesn't exist in main workspace
        if (!(await fs.pathExists(mainFilePath))) {
          continue
        }

        // Skip if file is tracked by git (it will exist in worktree via git)
        if (await isFileTrackedByGit(relativePath, mainWorkspacePath)) {
          getLogger().debug(`Skipping ${relativePath} (tracked by git, already in worktree)`)
          continue
        }

        // Skip if file already exists in worktree
        if (await fs.pathExists(worktreeFilePath)) {
          getLogger().debug(`Skipping ${relativePath} (already exists in worktree)`)
          continue
        }

        // Ensure parent directory exists
        await fs.ensureDir(path.dirname(worktreeFilePath))

        // Copy the untracked file
        await this.environment.copyIfExists(mainFilePath, worktreeFilePath)
        getLogger().debug(`Copied gitignored file: ${relativePath}`)
        copiedCount++
      }

      if (copiedCount > 0) {
        getLogger().debug(`Copied ${copiedCount} gitignored file(s) to loom`)
      }
    } catch (error) {
      // Warn but don't fail - glob/file failures shouldn't block workflow
      getLogger().warn(`Warning: Failed to copy gitignored files: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Setup PORT environment variable for web projects
   * Only called when project has web capabilities
   */
  private async setupPortForWeb(
    worktreePath: string,
    input: CreateLoomInput,
    basePort: number
  ): Promise<number> {
    const envFilePath = path.join(worktreePath, '.env.local')

    // Calculate port based on input type
    const options: { basePort: number; issueNumber?: number; prNumber?: number; branchName?: string } = { basePort }

    if (input.type === 'issue') {
      options.issueNumber = input.identifier as number
    } else if (input.type === 'pr') {
      options.prNumber = input.identifier as number
    } else if (input.type === 'branch') {
      options.branchName = input.identifier as string
    }

    const port = this.environment.calculatePort(options)

    await this.environment.setEnvVar(envFilePath, 'PORT', String(port))
    return port
  }

  /**
   * Load environment variables from main .env file into process.env
   * Uses dotenv-flow to handle various .env file patterns
   */
  private loadMainEnvFile(): void {
    const result = loadEnvIntoProcess({ path: process.cwd() })

    if (result.error) {
      // Only log warning for actual errors, not for "no .env files found" which is harmless
      if (isNoEnvFilesFoundError(result.error)) {
        getLogger().debug('No .env files found (this is normal for projects without environment files)')
      } else {
        getLogger().warn(`Warning: Could not load .env files: ${result.error.message}`)
      }
    } else {
      getLogger().info('Loaded environment variables using dotenv-flow')
      if (result.parsed && Object.keys(result.parsed).length > 0) {
        getLogger().debug(`Loaded ${Object.keys(result.parsed).length} environment variables`)
      }
    }
  }

  /**
   * Generate a unique loom ID
   */
  private generateLoomId(input: CreateLoomInput): string {
    const prefix = input.type
    return `${prefix}-${input.identifier}`
  }

  /**
   * Calculate port for the loom
   * Base port: configurable via settings.capabilities.web.basePort (default 3000) + issue/PR number (or deterministic hash for branches)
   */
  private async calculatePort(input: CreateLoomInput): Promise<number> {
    // Load base port from settings
    const settingsData = await this.settings.loadSettings()
    const basePort = settingsData.capabilities?.web?.basePort ?? 3000

    if (input.type === 'issue') {
      if (typeof input.identifier === 'number') {
        return this.environment.calculatePort({ basePort, issueNumber: input.identifier })
      } else if (typeof input.identifier === 'string') {
        // Alphanumeric issue ID (e.g., Linear: ENG-123) - delegate to EnvironmentManager
        return this.environment.calculatePort({ basePort, issueNumber: input.identifier })
      }
    }

    if (input.type === 'pr' && typeof input.identifier === 'number') {
      return this.environment.calculatePort({ basePort, prNumber: input.identifier })
    }

    if (input.type === 'branch' && typeof input.identifier === 'string') {
      // Use deterministic hash for branch-based ports
      return this.environment.calculatePort({ basePort, branchName: input.identifier })
    }

    // Fallback: basePort only (shouldn't reach here with valid input)
    throw new Error(`Unknown input type: ${input.type} with identifier type: ${typeof input.identifier}`)
  }


  /**
   * Apply color synchronization to both VSCode and terminal
   * Colors are cosmetic - errors are logged but don't block workflow
   * Respects colors settings for independent control
   *
   * DEFAULTS:
   * - terminal: true (always safe, only affects macOS Terminal.app)
   * - vscode: false (safe default, prevents unexpected file modifications)
   *
   * @param colorData - Pre-computed color data (from collision avoidance)
   */
  private async applyColorSynchronization(
    worktreePath: string,
    branchName: string,
    colorData: ColorData,
    settings: import('./SettingsManager.js').IloomSettings,
    options?: CreateLoomInput['options']
  ): Promise<void> {
    // Determine color settings: options override settings, settings override defaults
    // Note: vscode defaults to FALSE for safety
    const colorVscode = options?.colorVscode ?? settings.colors?.vscode ?? false
    const colorTerminal = options?.colorTerminal ?? settings.colors?.terminal ?? true

    if (!colorVscode && !colorTerminal) {
      getLogger().debug('Color synchronization disabled for both VSCode and terminal')
      return
    }

    // Apply VSCode title bar color if enabled (default: disabled for safety)
    if (colorVscode) {
      const vscode = new VSCodeIntegration()
      await vscode.setTitleBarColor(worktreePath, colorData.hex)
      getLogger().info(`Applied VSCode title bar color: ${colorData.hex} for branch: ${branchName}`)
    } else {
      getLogger().debug('VSCode color sync disabled (default: false for safety)')
    }

    // Note: Terminal color is applied during window creation in LoomLauncher
    // The colorTerminal setting is passed through to launch options
  }

  /**
   * Map worktrees to loom objects
   * Reads loom metadata from MetadataManager with branch name parsing as fallback
   */
  private async mapWorktreesToLooms(worktrees: GitWorktree[]): Promise<Loom[]> {
    return await Promise.all(worktrees.map(async (wt) => {
      // Read metadata from persistent storage first
      const loomMetadata = await this.metadataManager.readMetadata(wt.path)

      // Priority 1: Use metadata as source of truth if available
      let type: 'issue' | 'pr' | 'branch' = 'branch'
      let identifier: string | number = wt.branch

      if (loomMetadata?.issueType) {
        type = loomMetadata.issueType

        // Extract identifier from metadata based on type
        if (type === 'issue' && loomMetadata.issue_numbers?.[0]) {
          const issueId = loomMetadata.issue_numbers[0]
          // Try to parse as number, otherwise keep as string (for alphanumeric IDs)
          const numericId = parseInt(issueId, 10)
          identifier = isNaN(numericId) ? issueId : numericId
        } else if (type === 'pr' && loomMetadata.pr_numbers?.[0]) {
          const prId = loomMetadata.pr_numbers[0]
          // PRs are always numeric
          identifier = parseInt(prId, 10)
        } else if (type === 'branch') {
          identifier = wt.branch
        }
      } else {
        // Priority 2: Fall back to branch name parsing if metadata not available

        // Check for PR pattern first (higher priority)
        const prNumber = extractPRNumber(wt.branch)
        if (prNumber !== null) {
          type = 'pr'
          identifier = prNumber
        } else {
          // Check for issue pattern
          const issueNumber = extractIssueNumber(wt.branch)
          if (issueNumber !== null) {
            type = 'issue'
            // Try to parse as number, otherwise keep as string (for alphanumeric IDs)
            const numericId = parseInt(issueNumber, 10)
            identifier = isNaN(numericId) ? issueNumber : numericId
          } else {
            // Default to branch type
            type = 'branch'
            identifier = wt.branch
          }
        }
      }

      return {
        id: `${type}-${identifier}`,
        path: wt.path,
        branch: wt.branch,
        type,
        identifier,
        port: await this.calculatePort({ type, identifier, originalInput: '' }),
        ...(loomMetadata?.description && { description: loomMetadata.description }),
        createdAt: new Date(),
        lastAccessed: new Date(),
      }
    }))
  }

  /**
   * NEW: Find existing loom for the given input
   * Checks for worktrees matching the issue/PR identifier
   */
  private async findExistingIloom(
    input: CreateLoomInput,
    issueData: Issue | PullRequest | null
  ): Promise<GitWorktree | null> {
    if (input.type === 'issue') {
      return await this.gitWorktree.findWorktreeForIssue(input.identifier as number)
    } else if (input.type === 'pr' && issueData && 'branch' in issueData) {
      return await this.gitWorktree.findWorktreeForPR(
        input.identifier as number,
        issueData.branch
      )
    } else if (input.type === 'branch') {
      return await this.gitWorktree.findWorktreeForBranch(input.identifier as string)
    }
    return null
  }

  /**
   * NEW: Reuse an existing loom
   * Includes environment setup and database branching for existing worktrees
   * Ports: handle_existing_worktree() from bash script lines 168-215
   */
  private async reuseIloom(
    worktree: GitWorktree,
    input: CreateLoomInput,
    issueData: Issue | PullRequest | null
  ): Promise<Loom> {
    const worktreePath = worktree.path
    const branchName = worktree.branch

    // 1. Load main .env variables into process.env
    this.loadMainEnvFile()

    // 2. Detect capabilities (quick, no installation)
    const { capabilities, binEntries } = await this.capabilityDetector.detectCapabilities(worktreePath)

    // 3. Defensively copy .env and settings.local.json if missing
    await this.copyEnvironmentFiles(worktreePath)
    await this.copyIloomSettings(worktreePath)
    await this.copyIloomPackageLocal(worktreePath)
    await this.copyClaudeSettings(worktreePath)

    // 3.5. Copy gitignored files matching configured patterns
    await this.copyGitIgnoredFiles(worktreePath)

    // 4. Setup PORT for web projects (ensure it's set even if .env existed)
    // Load base port from settings
    const settingsData = await this.settings.loadSettings()
    const basePort = settingsData.capabilities?.web?.basePort ?? 3000

    let port = basePort
    if (capabilities.includes('web')) {
      port = await this.setupPortForWeb(worktreePath, input, basePort)
    }

    // 5. Skip database branch creation for existing worktrees
    // The database branch should have been created when the worktree was first created
    // Matches bash script behavior: handle_existing_worktree() skips all setup
    getLogger().info('Database branch assumed to be already configured for existing worktree')
    const databaseBranch: string | undefined = undefined

    // 5.5. Read existing metadata to get colorHex (for reusing stored color)
    const existingMetadata = await this.metadataManager.readMetadata(worktreePath)

    // Determine colorHex for launch
    let colorHex: string
    if (existingMetadata?.colorHex) {
      // Use stored hex color (already migrated from colorIndex if needed in readMetadata)
      colorHex = existingMetadata.colorHex
      getLogger().debug(`Reusing stored color ${colorHex} for branch ${branchName}`)
    } else {
      // No metadata - fall back to hash-based with dark mode detection
      const themeMode = await detectDarkMode()
      const colorData = generateColorFromBranchName(branchName, themeMode)
      colorHex = colorData.hex
      getLogger().debug(`No stored color, using hash-based color ${colorHex} for branch ${branchName} (${themeMode} mode)`)
    }

    // Apply color synchronization (VSCode colors for reused looms)
    // Mirrors createIloom() behavior at lines 205-214
    try {
      const colorData: ColorData = { hex: colorHex, rgb: hexToRgb(colorHex), index: 0 }
      await this.applyColorSynchronization(worktreePath, branchName, colorData, settingsData, input.options)
    } catch (error) {
      // Log warning but don't fail - colors are cosmetic
      getLogger().warn(
        `Failed to apply color synchronization: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error
      )
    }

    // 6. Move issue to In Progress (for reused worktrees too)
    if (input.type === 'issue') {
      try {
        getLogger().info('Moving issue to In Progress...')
        // Check if provider supports this optional method
        if (this.issueTracker.moveIssueToInProgress) {
          await this.issueTracker.moveIssueToInProgress(input.identifier as number)
        }
      } catch (error) {
        getLogger().warn(
          `Failed to move issue to In Progress: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error
        )
      }
    }

    // 7. Launch components (same as new worktree)
    const enableClaude = input.options?.enableClaude !== false
    const enableCode = input.options?.enableCode !== false
    const enableDevServer = input.options?.enableDevServer !== false
    const enableTerminal = input.options?.enableTerminal ?? false
    const oneShot = input.options?.oneShot ?? 'default'
    const setArguments = input.options?.setArguments
    const executablePath = input.options?.executablePath

    if (enableClaude || enableCode || enableDevServer || enableTerminal) {
      getLogger().info('Launching workspace components...')
      const { LoomLauncher } = await import('./LoomLauncher.js')
      const { ClaudeContextManager } = await import('./ClaudeContextManager.js')

      // Create ClaudeContextManager with shared SettingsManager to ensure CLI overrides work
      const claudeContext = new ClaudeContextManager(undefined, undefined, this.settings)
      const launcher = new LoomLauncher(claudeContext, this.settings)

      await launcher.launchLoom({
        enableClaude,
        enableCode,
        enableDevServer,
        enableTerminal,
        worktreePath,
        branchName,
        port,
        capabilities,
        workflowType: input.type === 'branch' ? 'regular' : input.type,
        identifier: input.identifier,
        ...(issueData?.title && { title: issueData.title }),
        oneShot,
        ...(setArguments && { setArguments }),
        ...(executablePath && { executablePath }),
        sourceEnvOnStart: settingsData.sourceEnvOnStart ?? false,
        colorTerminal: input.options?.colorTerminal ?? settingsData.colors?.terminal ?? true,
        colorHex,
      })
    }

    // 8. Write loom metadata if missing (spec section 3.1)
    // For reused looms, only write if metadata file doesn't exist
    const description = existingMetadata?.description ?? issueData?.title ?? branchName
    if (!existingMetadata) {
      // Build issue/pr numbers arrays based on type
      // For PR workflows, extract issue number from branch name if present
      let issue_numbers: string[] = []
      let extractedIssueNum: string | null = null
      if (input.type === 'issue') {
        issue_numbers = [String(input.identifier)]
      } else if (input.type === 'pr') {
        extractedIssueNum = extractIssueNumber(branchName)
        if (extractedIssueNum) {
          issue_numbers = [extractedIssueNum]
        }
      }
      const pr_numbers: string[] = input.type === 'pr' ? [String(input.identifier)] : []

      // Generate random session ID for Claude Code resume support
      // Each loom gets a unique session ID, enabling fresh Claude sessions
      const sessionId = generateRandomSessionId()

      // Build issueUrls/prUrls based on workflow type
      // For PR workflows, construct issue URL by replacing /pull/N with /issues/M
      let issueUrls: Record<string, string> = {}
      if (input.type === 'issue' && issueData?.url) {
        issueUrls = { [String(input.identifier)]: issueData.url }
      } else if (input.type === 'pr' && extractedIssueNum && issueData?.url) {
        const issueUrl = issueData.url.replace(`/pull/${input.identifier}`, `/issues/${extractedIssueNum}`)
        issueUrls = { [extractedIssueNum]: issueUrl }
      }
      const prUrls: Record<string, string> = input.type === 'pr' && issueData?.url
        ? { [String(input.identifier)]: issueData.url }
        : {}

      const metadataInput: WriteMetadataInput = {
        description,
        branchName,
        worktreePath,
        issueType: input.type,
        issue_numbers,
        pr_numbers,
        issueTracker: this.issueTracker.providerName,
        colorHex,
        sessionId,
        projectPath: this.gitWorktree.workingDirectory,
        issueUrls,
        prUrls,
        capabilities,
        ...(input.options?.oneShot && { oneShot: input.options.oneShot }),
        ...(input.parentLoom && { parentLoom: input.parentLoom }),
      }
      await this.metadataManager.writeMetadata(worktreePath, metadataInput)
    }

    // 9. Return loom metadata
    const loom: Loom = {
      id: this.generateLoomId(input),
      path: worktreePath,
      branch: branchName,
      type: input.type,
      identifier: input.identifier,
      port,
      description,
      createdAt: new Date(), // We don't have actual creation date, use now
      lastAccessed: new Date(),
      ...(databaseBranch !== undefined && { databaseBranch }),
      ...(capabilities.length > 0 && { capabilities }),
      ...(Object.keys(binEntries).length > 0 && { binEntries }),
      ...(issueData !== null && {
        issueData: {
          title: issueData.title,
          body: issueData.body,
          url: issueData.url,
          state: issueData.state,
        },
      }),
    }

    getLogger().success(`Reused existing loom: ${loom.id} at ${loom.path}`)
    return loom
  }
}
