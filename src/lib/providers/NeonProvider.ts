import { execa, type ExecaError } from 'execa'
import type { DatabaseProvider } from '../../types/index.js'
import { createLogger } from '../../utils/logger.js'
import { promptConfirmation } from '../../utils/prompt.js'

const logger = createLogger({ prefix: '🗂️' })

interface NeonBranch {
  name: string
  id: string
  [key: string]: unknown
}

export interface NeonConfig {
  projectId: string
  parentBranch: string
}

/**
 * Validate Neon configuration
 * Checks that required configuration values are present
 */
export function validateNeonConfig(config: {
  projectId?: string
  parentBranch?: string
}): { valid: boolean; error?: string } {
  if (!config.projectId) {
    return {
      valid: false,
      error: 'Neon projectId is required. Configure in .iloom/settings.json under databaseProviders.neon',
    }
  }

  if (!config.parentBranch) {
    return {
      valid: false,
      error: 'Neon parentBranch is required. Configure in .iloom/settings.json under databaseProviders.neon',
    }
  }

  // Basic validation for project ID format (should start with appropriate prefix)
  if (!/^[a-zA-Z0-9-]+$/.test(config.projectId)) {
    return {
      valid: false,
      error: 'Neon projectId contains invalid characters',
    }
  }

  return { valid: true }
}

/**
 * Neon database provider implementation
 * Ports functionality from bash/utils/neon-utils.sh
 */
export class NeonProvider implements DatabaseProvider {
  private _isConfigured: boolean = false

  constructor(private config: NeonConfig) {
    logger.debug('NeonProvider initialized with config:', {
      projectId: config.projectId,
      parentBranch: config.parentBranch,
      hasProjectId: !!config.projectId,
      hasParentBranch: !!config.parentBranch,
    })

    // Validate config but don't throw - just mark as not configured
    // This allows the provider to be instantiated even when Neon is not being used
    const validation = validateNeonConfig(config)
    if (!validation.valid) {
      logger.debug(`NeonProvider not configured: ${validation.error}`)
      logger.debug('Neon database branching will not be used')
      this._isConfigured = false
    } else {
      this._isConfigured = true
    }
  }

  /**
   * Check if provider is properly configured
   * Returns true if projectId and parentBranch are valid in settings
   */
  isConfigured(): boolean {
    return this._isConfigured
  }

  /**
   * Execute a Neon CLI command and return stdout
   * Throws an error if the command fails
   *
   * @param args - Command arguments to pass to neon CLI
   * @param cwd - Optional working directory to run the command from (defaults to current directory)
   */
  private async executeNeonCommand(args: string[], cwd?: string): Promise<string> {
    // Check if provider is properly configured
    if (!this._isConfigured) {
      throw new Error('NeonProvider is not configured. Check databaseProviders.neon configuration in .iloom/settings.json')
    }

    // Log the exact command being executed for debugging
    const command = `neon ${args.join(' ')}`
    logger.debug(`Executing Neon CLI command: ${command}`)
    logger.debug(`Project ID being used: ${this.config.projectId}`)
    if (cwd) {
      logger.debug(`Working directory: ${cwd}`)
    }

    const result = await execa('neon', args, {
      timeout: 30000,
      encoding: 'utf8',
      stdio: 'pipe',
      ...(cwd && { cwd }),
    })
    return result.stdout
  }

  /**
   * Check if neon CLI is available
   * Ports: check_neon_cli() from bash/utils/neon-utils.sh:18-23
   */
  async isCliAvailable(): Promise<boolean> {
    try {
      await execa('command', ['-v', 'neon'], {
        timeout: 5000,
        shell: true,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Check if user is authenticated with Neon CLI
   * Ports: check_neon_auth() from bash/utils/neon-utils.sh:25-36
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
      await execa('neon', ['me'], {
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
        stderr.toLowerCase().includes('login required')

      if (isAuthError) {
        return false
      }

      // For any other error, let it bubble up
      throw error
    }
  }

  /**
   * Sanitize branch name for Neon (replace slashes with underscores)
   * Ports: sanitize_neon_branch_name() from bash/utils/neon-utils.sh:11-15
   */
  sanitizeBranchName(branchName: string): string {
    return branchName.replace(/\//g, '_')
  }

  /**
   * Extract endpoint ID from Neon connection string
   * Pattern matches: ep-abc-123 or ep-abc-123-pooler
   * Returns: ep-abc-123 (without -pooler suffix)
   * Used by: get_neon_branch_name() from bash/utils/neon-utils.sh:294
   */
  private extractEndpointId(connectionString: string): string | null {
    // First, extract the full host part between @ and first dot
    // Examples:
    //   @ep-abc123.us-east-1.neon.tech -> ep-abc123
    //   @ep-abc123-pooler.us-east-1.neon.tech -> ep-abc123-pooler
    const hostMatch = connectionString.match(/@(ep-[a-z0-9-]+)\./)
    if (!hostMatch?.[1]) {
      return null
    }

    const fullEndpoint = hostMatch[1]
    // Remove -pooler suffix if present
    return fullEndpoint.replace(/-pooler$/, '')
  }

  /**
   * List all branches in the Neon project
   * Ports: list_neon_branches() from bash/utils/neon-utils.sh:63-74
   *
   * @param cwd - Optional working directory to run commands from
   */
  async listBranches(cwd?: string): Promise<string[]> {
    const output = await this.executeNeonCommand([
      'branches',
      'list',
      '--project-id',
      this.config.projectId,
      '--output',
      'json',
    ], cwd)

    const branches: NeonBranch[] = JSON.parse(output)
    return branches.map(branch => branch.name)
  }

  /**
   * Check if a branch exists
   * Ports: check_neon_branch_exists() from bash/utils/neon-utils.sh:38-61
   *
   * @param name - Branch name to check
   * @param cwd - Optional working directory to run commands from
   */
  async branchExists(name: string, cwd?: string): Promise<boolean> {
    const branches = await this.listBranches(cwd)
    return branches.includes(name)
  }

  /**
   * Get connection string for a specific branch
   * Ports: get_neon_connection_string() from bash/utils/neon-utils.sh:76-90
   *
   * @param branch - Branch name to get connection string for
   * @param cwd - Optional working directory to run commands from
   */
  async getConnectionString(branch: string, cwd?: string): Promise<string> {
    const connectionString = await this.executeNeonCommand([
      'connection-string',
      '--branch',
      branch,
      '--project-id',
      this.config.projectId,
    ], cwd)
    return connectionString.trim()
  }

  /**
   * Find Vercel preview database branch
   * Checks for both patterns: preview/<branch> and preview_<sanitized-branch>
   * Ports: find_preview_database_branch() from bash/utils/neon-utils.sh:92-124
   *
   * @param branchName - Branch name to find preview for
   * @param cwd - Optional working directory to run commands from
   */
  async findPreviewBranch(branchName: string, cwd?: string): Promise<string | null> {
    // Check for exact preview branch match with slash pattern
    const slashPattern = `preview/${branchName}`
    if (await this.branchExists(slashPattern, cwd)) {
      logger.info(`Found Vercel preview database: ${slashPattern}`)
      return slashPattern
    }

    // Check for underscore pattern variation
    const sanitized = this.sanitizeBranchName(branchName)
    const underscorePattern = `preview_${sanitized}`
    if (await this.branchExists(underscorePattern, cwd)) {
      logger.info(`Found Vercel preview database: ${underscorePattern}`)
      return underscorePattern
    }

    return null
  }

  /**
   * Create a new database branch
   * ALWAYS checks for Vercel preview database first
   * Returns connection string for the branch
   * Ports: create_neon_database_branch() from bash/utils/neon-utils.sh:126-187
   *
   * @param name - Name for the new branch
   * @param fromBranch - Parent branch to create from (defaults to config.parentBranch)
   * @param cwd - Optional working directory to run commands from
   */
  async createBranch(name: string, fromBranch?: string, cwd?: string): Promise<string> {
    // Always check for existing Vercel preview database first (lines 149-158)
    const previewBranch = await this.findPreviewBranch(name, cwd)
    if (previewBranch) {
      const connectionString = await this.getConnectionString(previewBranch, cwd)
      logger.success(`Using existing Vercel preview database: ${previewBranch}`)
      return connectionString
    }

    // Sanitize branch name for Neon (replace slashes with underscores)
    const sanitizedName = this.sanitizeBranchName(name)
    const parentBranch = fromBranch ?? this.config.parentBranch

    logger.info('Creating Neon database branch...')
    logger.info(`  Source branch: ${parentBranch}`)
    logger.info(`  New branch: ${sanitizedName}`)

    // Create the database branch
    await this.executeNeonCommand([
      'branches',
      'create',
      '--name',
      sanitizedName,
      '--parent',
      parentBranch,
      '--project-id',
      this.config.projectId,
    ], cwd)

    logger.success('Database branch created successfully')

    // Get the connection string for the new branch
    logger.info('Getting connection string for new database branch...')
    const connectionString = await this.getConnectionString(sanitizedName, cwd)

    return connectionString
  }

  /**
   * Delete a database branch
   * Includes preview database protection with user confirmation
   * Ports: delete_neon_database_branch() from bash/utils/neon-utils.sh:204-259
   *
   * @param name - Name of the branch to delete
   * @param isPreview - Whether this is a preview database branch
   * @param cwd - Optional working directory to run commands from (prevents issues with deleted directories)
   */
  async deleteBranch(name: string, isPreview: boolean = false, cwd?: string): Promise<import('../../types/index.js').DatabaseDeletionResult> {
    // Sanitize branch name for Neon
    const sanitizedName = this.sanitizeBranchName(name)

    // For preview contexts, check for preview databases first
    if (isPreview) {
      const previewBranch = await this.findPreviewBranch(name, cwd)
      if (previewBranch) {
        logger.warn(`Found Vercel preview database: ${previewBranch}`)
        logger.warn('Preview databases are managed by Vercel and will be cleaned up automatically')
        logger.warn('Manual deletion may interfere with Vercel\'s preview deployments')

        const confirmed = await promptConfirmation(
          'Delete preview database anyway?',
          false
        )

        if (confirmed) {
          // User confirmed - delete preview branch
          try {
            logger.info(`Deleting Vercel preview database: ${previewBranch}`)
            await this.executeNeonCommand([
              'branches',
              'delete',
              previewBranch,
              '--project-id',
              this.config.projectId,
            ], cwd)
            logger.success('Preview database deleted successfully')
            return {
              success: true,
              deleted: true,
              notFound: false,
              branchName: previewBranch
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            logger.error(`Failed to delete preview database: ${errorMessage}`)
            return {
              success: false,
              deleted: false,
              notFound: false,
              error: errorMessage,
              branchName: previewBranch
            }
          }
        } else {
          // User declined deletion
          logger.info('Skipping preview database deletion')
          return {
            success: true,
            deleted: false,
            notFound: false,
            userDeclined: true,
            branchName: previewBranch
          }
        }
      }
      // If no preview database found, fall through to check regular branch
    }

    // Check for regular branch
    logger.info(`Checking for Neon database branch: ${sanitizedName}`)

    try {
      const exists = await this.branchExists(sanitizedName, cwd)

      if (!exists) {
        logger.info(`No database branch found for '${name}'`)
        return {
          success: true,
          deleted: false,
          notFound: true,
          branchName: sanitizedName
        }
      }

      // Branch exists - delete it
      logger.info(`Deleting Neon database branch: ${sanitizedName}`)
      await this.executeNeonCommand([
        'branches',
        'delete',
        sanitizedName,
        '--project-id',
        this.config.projectId,
      ], cwd)
      logger.success('Database branch deleted successfully')

      return {
        success: true,
        deleted: true,
        notFound: false,
        branchName: sanitizedName
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`Failed to delete database branch: ${errorMessage}`)
      return {
        success: false,
        deleted: false,
        notFound: false,
        error: errorMessage,
        branchName: sanitizedName
      }
    }
  }

  /**
   * Get branch name from endpoint ID (reverse lookup)
   * Searches all branches to find one with matching endpoint
   * Ports: get_neon_branch_name() from bash/utils/neon-utils.sh:262-308
   *
   * @param endpointId - Endpoint ID to search for
   * @param cwd - Optional working directory to run commands from
   */
  async getBranchNameFromEndpoint(endpointId: string, cwd?: string): Promise<string | null> {
    const branches = await this.listBranches(cwd)

    for (const branch of branches) {
      try {
        const connectionString = await this.getConnectionString(branch, cwd)
        const branchEndpointId = this.extractEndpointId(connectionString)

        if (branchEndpointId === endpointId) {
          return branch
        }
      } catch {
        // Skip branches that fail to get connection string
        continue
      }
    }

    return null
  }
}
