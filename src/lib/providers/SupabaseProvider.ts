import { execa, type ExecaError } from 'execa'
import type { DatabaseProvider, DatabaseDeletionResult } from '../../types/index.js'
import { getLogger } from '../../utils/logger-context.js'

export interface SupabaseConfig {
  projectRef: string
  parentBranch?: string
  withData?: boolean // default: true
}

/**
 * Validate Supabase configuration
 * Checks that required configuration values are present
 */
export function validateSupabaseConfig(config: {
  projectRef?: string
  parentBranch?: string
}): { valid: boolean; error?: string } {
  if (!config.projectRef) {
    return {
      valid: false,
      error:
        'Supabase projectRef is required. Configure in .iloom/settings.json under databaseProviders.supabase',
    }
  }

  // parentBranch is optional — Supabase currently always branches from the default branch

  // Basic validation for project ref format (alphanumeric and hyphens)
  if (!/^[a-zA-Z0-9-]+$/.test(config.projectRef)) {
    return {
      valid: false,
      error: 'Supabase projectRef contains invalid characters',
    }
  }

  return { valid: true }
}

/**
 * Supabase database provider implementation
 * Provides database branching via the Supabase CLI
 */
export class SupabaseProvider implements DatabaseProvider {
  private _isConfigured: boolean = false

  readonly displayName = 'Supabase CLI'
  readonly installHint = 'Install with: npm install -g supabase'

  constructor(private config: SupabaseConfig) {
    getLogger().debug('SupabaseProvider initialized with config:', {
      projectRef: config.projectRef,
      parentBranch: config.parentBranch,
      withData: config.withData,
      hasProjectRef: !!config.projectRef,
      hasParentBranch: !!config.parentBranch,
    })

    // Validate config but don't throw - just mark as not configured
    // This allows the provider to be instantiated even when Supabase is not being used
    const validation = validateSupabaseConfig(config)
    if (!validation.valid) {
      getLogger().debug(`SupabaseProvider not configured: ${validation.error}`)
      getLogger().debug('Supabase database branching will not be used')
      this._isConfigured = false
    } else {
      this._isConfigured = true
    }

    if (config.parentBranch) {
      getLogger().debug(
        `parentBranch '${config.parentBranch}' is stored but Supabase currently always branches from the default branch`
      )
    }
  }

  /**
   * Check if provider is properly configured
   * Returns true if projectRef and parentBranch are valid in settings
   */
  isConfigured(): boolean {
    return this._isConfigured
  }

  /**
   * Execute a Supabase CLI command and return stdout
   * Throws an error if the command fails
   *
   * @param args - Command arguments to pass to supabase CLI
   * @param cwd - Optional working directory to run the command from (defaults to current directory)
   */
  private async executeSupabaseCommand(args: string[], cwd?: string, timeout: number = 30000): Promise<string> {
    // Check if provider is properly configured
    if (!this._isConfigured) {
      throw new Error(
        'SupabaseProvider is not configured. Check databaseProviders.supabase configuration in .iloom/settings.json'
      )
    }

    // Log the exact command being executed for debugging
    const command = `supabase ${args.join(' ')}`
    getLogger().debug(`Executing Supabase CLI command: ${command}`)
    getLogger().debug(`Project ref being used: ${this.config.projectRef}`)
    if (cwd) {
      getLogger().debug(`Working directory: ${cwd}`)
    }

    const result = await execa('supabase', args, {
      timeout,
      encoding: 'utf8',
      stdio: 'pipe',
      ...(cwd && { cwd }),
    })
    return result.stdout
  }

  /**
   * Check if supabase CLI is available
   */
  async isCliAvailable(): Promise<boolean> {
    try {
      await execa('supabase', ['--version'], {
        timeout: 5000,
        stdio: 'pipe',
      })
      return true
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code
      // ENOENT means the binary was not found on the system
      // EACCES means the binary exists but has no execute permission
      if (errorCode === 'ENOENT' || errorCode === 'EACCES') {
        return false
      }
      // Any other error (e.g., non-zero exit) still means CLI is present
      return true
    }
  }

  /**
   * Check if user is authenticated with Supabase CLI
   *
   * @param cwd - Optional working directory to run the command from (prevents issues with deleted directories)
   * @throws Error if authentication check fails for reasons other than not being authenticated
   */
  async isAuthenticated(cwd?: string): Promise<boolean> {
    const cliAvailable = await this.isCliAvailable()
    if (!cliAvailable) {
      return false
    }

    try {
      await execa('supabase', ['projects', 'list'], {
        timeout: 10000,
        stdio: 'pipe',
        ...(cwd && { cwd }),
      })
      return true
    } catch (error) {
      const execaError = error as ExecaError
      const stderr = execaError.stderr?.trim() ?? ''

      // Check for authentication failure patterns (should return false, not throw)
      const isAuthError =
        stderr.toLowerCase().includes('not authenticated') ||
        stderr.toLowerCase().includes('not logged in') ||
        stderr.toLowerCase().includes('authentication required') ||
        stderr.toLowerCase().includes('login required') ||
        stderr.toLowerCase().includes('access token not provided') ||
        stderr.toLowerCase().includes('you need to be logged in')

      if (isAuthError) {
        return false
      }

      // For any other error, let it bubble up
      throw error
    }
  }

  /**
   * Sanitize branch name for Supabase (replace slashes with hyphens)
   * Supabase uses hyphens as separator (not underscores like Neon)
   */
  sanitizeBranchName(branchName: string): string {
    let sanitized = branchName
      .replace(/\//g, '-') // replace slashes with hyphens
      .replace(/[^a-zA-Z0-9_-]/g, '') // remove chars that aren't alphanumeric, hyphens, or underscores
      .replace(/^-+/, '') // strip leading hyphens (prevents CLI flag injection)
    return sanitized || 'unnamed-branch'
  }

  /**
   * List all branches in the Supabase project
   *
   * @param cwd - Optional working directory to run commands from
   */
  async listBranches(cwd?: string): Promise<string[]> {
    const output = await this.executeSupabaseCommand(
      ['branches', 'list', '--project-ref', this.config.projectRef, '-o', 'json'],
      cwd
    )

    interface SupabaseBranch {
      name: string
      [key: string]: unknown
    }

    let jsonString = output
    // CLI tools can prepend warnings to stdout; strip non-JSON prefixes
    const firstBracket = output.indexOf('[')
    if (firstBracket > 0) {
      jsonString = output.slice(firstBracket)
    }

    let branches: SupabaseBranch[]
    try {
      branches = JSON.parse(jsonString)
    } catch (parseError) {
      throw new Error(
        `Failed to parse Supabase branch list as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      )
    }
    return branches.map((branch) => branch.name)
  }

  /**
   * Check if a branch exists
   * Uses `supabase branches get` for a direct lookup (more efficient than listing all)
   *
   * @param name - Branch name to check
   * @param cwd - Optional working directory to run commands from
   */
  async branchExists(name: string, cwd?: string): Promise<boolean> {
    const sanitizedName = this.sanitizeBranchName(name)
    try {
      await this.executeSupabaseCommand(
        ['branches', 'get', sanitizedName, '--project-ref', this.config.projectRef],
        cwd
      )
      return true
    } catch (error) {
      const execaError = error as ExecaError
      const stderr = execaError.stderr?.toLowerCase() ?? ''
      const stdout = execaError.stdout?.toLowerCase() ?? ''
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

      // Only return false for explicit "not found" error signatures
      // Note: Supabase CLI uses exitCode=1 for "not found" and exitCode=2 for auth errors
      const isNotFound =
        stderr.includes('not found') ||
        stderr.includes('does not exist') ||
        stderr.includes('no branch') ||
        stdout.includes('not found') ||
        message.includes('not found') ||
        message.includes('does not exist')

      if (isNotFound) {
        return false
      }

      // For any other error (auth, network, CLI unavailable), rethrow
      throw error
    }
  }

  /**
   * Get connection string for a specific branch
   * Parses POSTGRES_URL_NON_POOLING from `supabase branches get <name> -o env` output
   * Connection strings are never logged at info level or above (security)
   *
   * @param branch - Branch name to get connection string for
   * @param cwd - Optional working directory to run commands from
   */
  async getConnectionString(branch: string, cwd?: string): Promise<string> {
    const sanitizedBranch = this.sanitizeBranchName(branch)
    const output = await this.executeSupabaseCommand(
      ['branches', 'get', sanitizedBranch, '--project-ref', this.config.projectRef, '-o', 'env'],
      cwd
    )

    // Parse POSTGRES_URL_NON_POOLING from env output
    const match = output.match(/^POSTGRES_URL_NON_POOLING=(.+)$/m)
    if (!match?.[1]) {
      throw new Error(
        `Could not find POSTGRES_URL_NON_POOLING in branch '${branch}' environment output`
      )
    }

    const connectionString = match[1].trim()
    // Log only at debug level - never at info level or above (security)
    getLogger().debug(`Connection string retrieved for branch '${branch}'`)
    return connectionString
  }

  /**
   * Create a new database branch
   * Returns connection string for the branch
   *
   * Note: Supabase preview branches always branch from the production database.
   * The fromBranch parameter is accepted for interface compatibility but ignored.
   *
   * @param name - Name for the new branch
   * @param fromBranch - Accepted for interface compatibility but ignored (Supabase always branches from production)
   * @param cwd - Optional working directory to run commands from
   */
  async createBranch(name: string, fromBranch?: string, cwd?: string): Promise<string> {
    void fromBranch // accepted for interface compatibility but ignored - Supabase always branches from production

    const sanitizedName = this.sanitizeBranchName(name)

    getLogger().info('Creating Supabase database branch...')
    getLogger().info(`  New branch: ${sanitizedName}`)

    const args = [
      'branches',
      'create',
      sanitizedName,
      '--project-ref',
      this.config.projectRef,
    ]

    // Add --with-data flag when withData is true (default: true per acceptance criteria)
    if (this.config.withData !== false) {
      args.push('--with-data')
    }

    await this.executeSupabaseCommand(args, cwd, 300000)

    getLogger().success('Database branch created successfully')

    // Get the connection string for the new branch
    getLogger().info('Getting connection string for new database branch...')
    const connectionString = await this.getConnectionString(sanitizedName, cwd)

    return connectionString
  }

  /**
   * Delete a database branch
   *
   * @param name - Name of the branch to delete
   * @param isPreview - Accepted but ignored (Neon-specific concept for Vercel preview databases)
   * @param cwd - Optional working directory to run commands from (prevents issues with deleted directories)
   */
  async deleteBranch(
    name: string,
    isPreview: boolean = false,
    cwd?: string
  ): Promise<DatabaseDeletionResult> {
    void isPreview // accepted but ignored - Neon-specific concept

    const sanitizedName = this.sanitizeBranchName(name)

    getLogger().info(`Checking for Supabase database branch: ${sanitizedName}`)

    try {
      const exists = await this.branchExists(sanitizedName, cwd)

      if (!exists) {
        getLogger().info(`No database branch found for '${name}'`)
        return {
          success: true,
          deleted: false,
          notFound: true,
          branchName: sanitizedName,
        }
      }

      // Branch exists - delete it
      getLogger().info(`Deleting Supabase database branch: ${sanitizedName}`)
      await this.executeSupabaseCommand(
        ['branches', 'delete', sanitizedName, '--project-ref', this.config.projectRef],
        cwd
      )
      getLogger().success('Database branch deleted successfully')

      return {
        success: true,
        deleted: true,
        notFound: false,
        branchName: sanitizedName,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      getLogger().error(`Failed to delete database branch: ${errorMessage}`)
      return {
        success: false,
        deleted: false,
        notFound: false,
        error: errorMessage,
        branchName: sanitizedName,
      }
    }
  }

}
