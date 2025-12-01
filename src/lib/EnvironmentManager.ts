import fs from 'fs-extra'
import { createLogger } from '../utils/logger.js'
import type {
  PortAssignmentOptions,
} from '../types/environment.js'
import {
  parseEnvFile,
  formatEnvLine,
  validateEnvVariable,
} from '../utils/env.js'
import { calculatePortForBranch } from '../utils/port.js'

const logger = createLogger({ prefix: '📝' })

export class EnvironmentManager {
  private readonly backupSuffix: string = '.backup'

  /**
   * Set or update an environment variable in a .env file
   * Ports functionality from bash/utils/env-utils.sh:setEnvVar()
   * @returns The backup path if a backup was created
   */
  async setEnvVar(
    filePath: string,
    key: string,
    value: string,
    backup: boolean = false
  ): Promise<string | void> {
    // Validate variable name
    const validation = validateEnvVariable(key, value)
    if (!validation.valid) {
      throw new Error(validation.error ?? 'Invalid variable name')
    }

    const fileExists = await fs.pathExists(filePath)

    if (!fileExists) {
      // File doesn't exist, create it
      logger.info(`Creating ${filePath} with ${key}...`)
      const content = formatEnvLine(key, value)
      await fs.writeFile(filePath, content, 'utf8')
      logger.success(`${filePath} created with ${key}`)
      return
    }

    // File exists, read and parse it
    const existingContent = await fs.readFile(filePath, 'utf8')
    const envMap = parseEnvFile(existingContent)

    // Create backup if requested
    let backupPath: string | undefined
    if (backup) {
      backupPath = await this.createBackup(filePath)
    }

    // Update or add the variable
    envMap.set(key, value)

    // Rebuild the file content, preserving comments and empty lines
    const lines = existingContent.split('\n')
    const newLines: string[] = []
    let variableUpdated = false

    for (const line of lines) {
      const trimmedLine = line.trim()

      // Preserve comments and empty lines
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        newLines.push(line)
        continue
      }

      // Remove 'export ' prefix if present
      const cleanLine = trimmedLine.startsWith('export ')
        ? trimmedLine.substring(7)
        : trimmedLine

      // Check if this line contains our variable
      const equalsIndex = cleanLine.indexOf('=')
      if (equalsIndex !== -1) {
        const lineKey = cleanLine.substring(0, equalsIndex).trim()
        if (lineKey === key) {
          // Replace this line with the new value
          newLines.push(formatEnvLine(key, value))
          variableUpdated = true
          continue
        }
      }

      // Keep other lines as-is
      newLines.push(line)
    }

    // If variable wasn't in the file, add it at the end
    if (!variableUpdated) {
      logger.info(`Adding ${key} to ${filePath}...`)
      newLines.push(formatEnvLine(key, value))
      logger.success(`${key} added successfully`)
    } else {
      logger.info(`Updating ${key} in ${filePath}...`)
      logger.success(`${key} updated successfully`)
    }

    // Write the updated content
    const newContent = newLines.join('\n')
    await fs.writeFile(filePath, newContent, 'utf8')

    return backupPath
  }

  /**
   * Read and parse a .env file
   */
  async readEnvFile(filePath: string): Promise<Map<string, string>> {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      return parseEnvFile(content)
    } catch (error) {
      // If file doesn't exist or can't be read, return empty map
      logger.debug(
        `Could not read env file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return new Map()
    }
  }

  /**
   * Get a specific environment variable from a .env file
   * Returns null if file doesn't exist or variable is not found
   */
  async getEnvVariable(filePath: string, variableName: string): Promise<string | null> {
    const envVars = await this.readEnvFile(filePath)
    return envVars.get(variableName) ?? null
  }

  /**
   * Generic file copy helper that only copies if source exists
   * Does not throw if source file doesn't exist - just logs and returns
   * @private
   */
   async copyIfExists(
    source: string,
    destination: string
  ): Promise<void> {
    const sourceExists = await fs.pathExists(source)
    if (!sourceExists) {
      logger.debug(`Source file ${source} does not exist, skipping copy`)
      return
    }

    await fs.copy(source, destination, { overwrite: false })
    logger.success(`Copied ${source} to ${destination}`)
  }

  /**
   * Calculate unique port for workspace
   * Implements:
   * - Issue/PR: 3000 + issue/PR number
   * - Branch: 3000 + deterministic hash offset (1-999)
   */
  calculatePort(options: PortAssignmentOptions): number {
    const basePort = options.basePort ?? 3000

    // Priority: issueNumber > prNumber > branchName > basePort only
    if (options.issueNumber !== undefined) {
      // Try to parse as number for backward compatibility
      const numericIssue = typeof options.issueNumber === 'number'
        ? options.issueNumber
        : parseInt(String(options.issueNumber), 10)

      if (!isNaN(numericIssue) && String(numericIssue) === String(options.issueNumber)) {
        // Purely numeric issue ID - use arithmetic port calculation
        const port = basePort + numericIssue
        // Validate port range
        if (port > 65535) {
          throw new Error(
            `Calculated port ${port} exceeds maximum (65535). Use a lower base port or issue number.`
          )
        }
        return port
      }
      // Alphanumeric ID - use hash-based calculation
      return calculatePortForBranch(String(options.issueNumber), basePort)
    }

    if (options.prNumber !== undefined) {
      const port = basePort + options.prNumber
      // Validate port range
      if (port > 65535) {
        throw new Error(
          `Calculated port ${port} exceeds maximum (65535). Use a lower base port or PR number.`
        )
      }
      return port
    }

    if (options.branchName !== undefined) {
      // Use deterministic hash for branch-based workspaces
      return calculatePortForBranch(options.branchName, basePort)
    }

    // Fallback: basePort only (no offset)
    return basePort
  }

  /**
   * Set port environment variable for workspace
   */
  async setPortForWorkspace(
    envFilePath: string,
    issueNumber?: string | number,
    prNumber?: number,
    branchName?: string
  ): Promise<number> {
    const options: PortAssignmentOptions = {}
    if (issueNumber !== undefined) {
      options.issueNumber = issueNumber
    }
    if (prNumber !== undefined) {
      options.prNumber = prNumber
    }
    if (branchName !== undefined) {
      options.branchName = branchName
    }
    const port = this.calculatePort(options)
    await this.setEnvVar(envFilePath, 'PORT', String(port))
    return port
  }

  /**
   * Validate environment configuration
   */
  async validateEnvFile(
    filePath: string
  ): Promise<{ valid: boolean; errors: string[] }> {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const envMap = parseEnvFile(content)
      const errors: string[] = []

      // Validate each variable name
      for (const [key, value] of envMap.entries()) {
        const validation = validateEnvVariable(key, value)
        if (!validation.valid) {
          errors.push(`${key}: ${validation.error}`)
        }
      }

      return {
        valid: errors.length === 0,
        errors,
      }
    } catch (error) {
      return {
        valid: false,
        errors: [
          `Failed to read or parse file: ${error instanceof Error ? error.message : String(error)}`,
        ],
      }
    }
  }

  /**
   * Create backup of existing file
   */
  private async createBackup(filePath: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${filePath}${this.backupSuffix}-${timestamp}`
    await fs.copy(filePath, backupPath)
    logger.debug(`Created backup at ${backupPath}`)
    return backupPath
  }
}
