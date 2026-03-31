import type { DatabaseProvider } from '../types/index.js'
import { EnvironmentManager } from './EnvironmentManager.js'
import { getLogger } from '../utils/logger-context.js'
import { hasVariableInAnyEnvFile } from '../utils/env.js'
import fs from 'fs-extra'

/**
 * Database Manager - orchestrates database operations with conditional execution
 * Ports functionality from bash scripts with guard conditions:
 *   1. Database provider must be properly configured (provider.isConfigured())
 *   2. The worktree's .env file must contain the configured database URL variable (default: DATABASE_URL)
 *
 * This ensures database branching only occurs for projects that actually use databases
 */
export class DatabaseManager {
  constructor(
    private provider: DatabaseProvider,
    private environment: EnvironmentManager,
    private databaseUrlEnvVarName: string = 'DATABASE_URL'
  ) {
    // Debug: Show which database URL variable name is configured
    if (databaseUrlEnvVarName !== 'DATABASE_URL') {
      getLogger().debug(`DatabaseManager configured with custom variable: ${databaseUrlEnvVarName}`)
    } else {
      getLogger().debug('DatabaseManager using default variable: DATABASE_URL')
    }
  }

  /**
   * Get the configured database URL environment variable name
   */
  getConfiguredVariableName(): string {
    return this.databaseUrlEnvVarName
  }

  /**
   * Check if database branching should be used
   * Requires BOTH conditions:
   *   1. Database provider is properly configured (checked via provider.isConfigured())
   *   2. Any dotenv-flow file contains the configured database URL variable
   */
  async shouldUseDatabaseBranching(workspacePath: string): Promise<boolean> {
    // Check for provider configuration
    if (!this.provider.isConfigured()) {
      getLogger().debug('Skipping database branching: Database provider not configured')
      return false
    }

    // Check if any dotenv-flow file has the configured database URL variable
    const hasDatabaseUrl = await this.hasDatabaseUrlInEnv(workspacePath)
    if (!hasDatabaseUrl) {
      getLogger().debug(
        'Skipping database branching: configured database URL variable not found in any env file'
      )
      return false
    }

    return true
  }

  /**
   * Create database branch only if configured
   * Returns connection string if branch was created, null if skipped
   *
   * @param branchName - Name of the branch to create
   * @param workspacePath - Path to workspace for configuration checks (checks all dotenv-flow files)
   * @param cwd - Optional working directory to run commands from
   * @param fromBranch - Optional parent branch to create from (for child looms)
   */
  async createBranchIfConfigured(
    branchName: string,
    workspacePath: string,
    cwd?: string,
    fromBranch?: string
  ): Promise<string | null> {
    // Guard condition: check if database branching should be used
    if (!(await this.shouldUseDatabaseBranching(workspacePath))) {
      return null
    }

    // Check CLI availability and authentication
    if (!(await this.provider.isCliAvailable())) {
      getLogger().warn(`Skipping database branch creation: ${this.provider.displayName} CLI not available`)
      getLogger().warn(`Install with: ${this.provider.installHint}`)
      return null
    }

    try {
      const isAuth = await this.provider.isAuthenticated(cwd)
      if (!isAuth) {
        getLogger().warn(`Skipping database branch creation: Not authenticated with ${this.provider.displayName} CLI`)
        return null
      }
    } catch (error) {
      // Authentication check failed with an unexpected error - surface it
      const errorMessage = error instanceof Error ? error.message : String(error)
      getLogger().error(`Database authentication check failed: ${errorMessage}`)
      throw error
    }

    try {
      // Create the branch (which checks for preview first)
      // Pass fromBranch if provided (for child looms), otherwise undefined (uses configured parent)
      const connectionString = await this.provider.createBranch(branchName, fromBranch, cwd)
      getLogger().success(`Database branch ready: ${this.provider.sanitizeBranchName(branchName)}`)
      return connectionString
    } catch (error) {
      getLogger().error(
        `Failed to create database branch: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  }

  /**
   * Delete database branch only if configured
   * Returns result object indicating what happened
   *
   * @param branchName - Name of the branch to delete
   * @param shouldCleanup - Boolean indicating if database cleanup should be performed (pre-fetched config)
   * @param isPreview - Whether this is a preview database branch
   * @param cwd - Optional working directory to run commands from (prevents issues with deleted directories)
   */
  async deleteBranchIfConfigured(
    branchName: string,
    shouldCleanup: boolean,
    isPreview: boolean = false,
    cwd?: string
  ): Promise<import('../types/index.js').DatabaseDeletionResult> {
    // If shouldCleanup is explicitly false, skip immediately
    if (shouldCleanup === false) {
      return {
        success: true,
        deleted: false,
        notFound: true,  // Treat "not configured" as "nothing to delete"
        branchName
      }
    }

    // If shouldCleanup is explicitly true, validate provider configuration
    if (!this.provider.isConfigured()) {
      getLogger().debug('Skipping database branch deletion: Database provider not configured')
      return {
        success: true,
        deleted: false,
        notFound: true,
        branchName
      }
    }

    // Check CLI availability and authentication
    if (!(await this.provider.isCliAvailable())) {
      getLogger().info(`Skipping database branch deletion: ${this.provider.displayName} CLI not available. Install with: ${this.provider.installHint}`)
      return {
        success: false,
        deleted: false,
        notFound: true,
        error: `${this.provider.displayName} CLI not available`,
        branchName
      }
    }

    try {
      const isAuth = await this.provider.isAuthenticated(cwd)
      if (!isAuth) {
        getLogger().warn(`Skipping database branch deletion: Not authenticated with ${this.provider.displayName}`)
        return {
          success: false,
          deleted: false,
          notFound: false,
          error: `Not authenticated with ${this.provider.displayName}`,
          branchName
        }
      }
    } catch (error) {
      // Authentication check failed with an unexpected error - surface it
      const errorMessage = error instanceof Error ? error.message : String(error)
      getLogger().error(`Database authentication check failed: ${errorMessage}`)
      return {
        success: false,
        deleted: false,
        notFound: false,
        error: `Authentication check failed: ${errorMessage}`,
        branchName
      }
    }

    try {
      // Call provider and return its result directly
      const result = await this.provider.deleteBranch(branchName, isPreview, cwd)
      return result
    } catch (error) {
      // Unexpected error (shouldn't happen since provider returns result object)
      getLogger().warn(
        `Unexpected error in database deletion: ${error instanceof Error ? error.message : String(error)}`
      )
      return {
        success: false,
        deleted: false,
        notFound: false,
        error: error instanceof Error ? error.message : String(error),
        branchName
      }
    }
  }

  /**
   * Get database branch name from connection string (reverse lookup)
   * Returns branch name if provider supports reverse lookup, null otherwise
   *
   * @param connectionString - Database connection string
   * @param cwd - Optional working directory to run commands from
   */
  async getBranchNameFromConnectionString(connectionString: string, cwd?: string): Promise<string | null> {
    // Check if provider supports reverse lookup (duck typing)
    if (!this.provider.isConfigured()) {
      getLogger().debug('Provider not configured, skipping reverse lookup')
      return null
    }

    if ('getBranchNameFromConnectionString' in this.provider &&
        typeof this.provider.getBranchNameFromConnectionString === 'function') {
      return this.provider.getBranchNameFromConnectionString(connectionString, cwd)
    }

    getLogger().debug('Provider does not support reverse lookup')
    return null
  }

  /**
   * Check if any dotenv-flow file has the configured database URL variable
   * CRITICAL: If user explicitly configured a custom variable name (not default),
   * throw an error if it's missing from all env files
   */
  private async hasDatabaseUrlInEnv(workspacePath: string): Promise<boolean> {
    try {
      // Debug: Show what we're looking for
      if (this.databaseUrlEnvVarName !== 'DATABASE_URL') {
        getLogger().debug(`Looking for custom database URL variable: ${this.databaseUrlEnvVarName}`)
      } else {
        getLogger().debug('Looking for default database URL variable: DATABASE_URL')
      }

      // Check all dotenv-flow files for the configured variable
      const hasConfiguredVar = await hasVariableInAnyEnvFile(
        workspacePath,
        this.databaseUrlEnvVarName,
        async (p) => fs.pathExists(p),
        async (p, v) => this.environment.getEnvVariable(p, v)
      )

      if (hasConfiguredVar) {
        if (this.databaseUrlEnvVarName !== 'DATABASE_URL') {
          getLogger().debug(`✅ Found custom database URL variable: ${this.databaseUrlEnvVarName}`)
        } else {
          getLogger().debug(`✅ Found default database URL variable: DATABASE_URL`)
        }
        return true
      }

      // If user explicitly configured a custom variable name (not the default)
      // and it's missing, throw an error
      if (this.databaseUrlEnvVarName !== 'DATABASE_URL') {
        getLogger().debug(`❌ Custom database URL variable '${this.databaseUrlEnvVarName}' not found in any env file`)
        throw new Error(
          `Configured database URL environment variable '${this.databaseUrlEnvVarName}' not found in any dotenv-flow file. ` +
          `Please add it to an .env file or update your iloom configuration.`
        )
      }

      // Fall back to DATABASE_URL when using default configuration
      const hasDefaultVar = await hasVariableInAnyEnvFile(
        workspacePath,
        'DATABASE_URL',
        async (p) => fs.pathExists(p),
        async (p, v) => this.environment.getEnvVariable(p, v)
      )

      if (hasDefaultVar) {
        getLogger().debug('✅ Found fallback DATABASE_URL variable')
      } else {
        getLogger().debug('❌ No DATABASE_URL variable found in any env file')
      }
      return hasDefaultVar
    } catch (error) {
      // Re-throw configuration errors
      if (error instanceof Error && error.message.includes('not found in')) {
        throw error
      }
      // Return false for other errors
      return false
    }
  }
}
