/**
 * Linear CLI utilities
 * Wrapper functions for the linearis CLI tool
 */

import { execa } from 'execa'
import type { LinearIssue, LinearComment } from '../types/linear.js'
import { LinearServiceError } from '../types/linear.js'
import { logger } from './logger.js'

/**
 * Slugify a title for use in Linear URLs
 * Converts to lowercase, replaces non-alphanumeric with hyphens, truncates to reasonable length
 * @param title - Issue title
 * @param maxLength - Maximum slug length (default: 50)
 * @returns Slugified title
 */
export function slugifyTitle(title: string, maxLength: number = 50): string {
  // Convert to lowercase, replace non-alphanumeric chars with hyphens
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens

  // If already short enough, return as-is
  if (slug.length <= maxLength) {
    return slug
  }

  // Split by hyphens and rebuild until we hit the limit
  const parts = slug.split('-')
  let result = ''
  for (const part of parts) {
    const candidate = result ? `${result}-${part}` : part
    if (candidate.length > maxLength) {
      break
    }
    result = candidate
  }

  return result || slug.slice(0, maxLength) // fallback if first part is too long
}

/**
 * Build a Linear issue URL with optional title slug
 * @param identifier - Issue identifier (e.g., "ENG-123")
 * @param title - Optional issue title for slug
 * @returns Linear URL
 */
export function buildLinearIssueUrl(identifier: string, title?: string): string {
  const base = `https://linear.app/issue/${identifier}`
  if (title) {
    const slug = slugifyTitle(title)
    return slug ? `${base}/${slug}` : base
  }
  return base
}

/**
 * Check if linearis CLI is installed and available
 */
export async function isLinearisCLIInstalled(): Promise<boolean> {
  try {
    await execa('which', ['linearis'])
    return true
  } catch {
    return false
  }
}

/**
 * Execute a linearis CLI command with error handling
 * @param args - Command arguments for linearis
 * @param options - Execution options
 * @returns Parsed JSON output from linearis
 * @throws LinearServiceError on CLI errors
 */
export async function executeLinearisCommand<T>(
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<T> {
  try {
    // Check if CLI is installed first
    logger.debug(`executeLinearisCommand: Checking if linearis CLI is installed`)
    const isInstalled = await isLinearisCLIInstalled()
    if (!isInstalled) {
      logger.debug(`executeLinearisCommand: linearis CLI NOT installed`)
      throw new LinearServiceError(
        'CLI_NOT_FOUND',
        'linearis CLI is not installed. Install with: npm install -g linearis',
      )
    }

    logger.debug(`executeLinearisCommand: Running: linearis ${args.join(' ')}`)
    const { stdout } = await execa('linearis', args, {
      ...(options?.cwd && { cwd: options.cwd }),
      timeout: options?.timeout ?? 30000,
    })

    logger.debug(`executeLinearisCommand: Success, parsing JSON response`)
    // linearis returns JSON by default
    return JSON.parse(stdout) as T
  } catch (error) {
    // Re-throw LinearServiceError as-is
    if (error instanceof LinearServiceError) {
      logger.debug(`executeLinearisCommand: LinearServiceError: ${error.code} - ${error.message}`)
      throw error
    }

    // Handle execa errors
    if (error && typeof error === 'object' && 'stderr' in error) {
      const execaError = error as { stderr?: string; message?: string }
      const stderr = execaError.stderr ?? execaError.message ?? 'Unknown error'
      logger.debug(`executeLinearisCommand: CLI error stderr: ${stderr}`)

      // Map common Linear API errors
      if (stderr.includes('not found') || stderr.includes('Not found')) {
        logger.debug(`executeLinearisCommand: Mapped to NOT_FOUND error`)
        throw new LinearServiceError('NOT_FOUND', 'Linear issue or resource not found', {
          stderr,
        })
      }

      if (stderr.includes('unauthorized') || stderr.includes('Unauthorized')) {
        logger.debug(`executeLinearisCommand: Mapped to UNAUTHORIZED error`)
        throw new LinearServiceError(
          'UNAUTHORIZED',
          'Linear authentication failed. Check LINEAR_API_KEY environment variable.',
          { stderr },
        )
      }

      if (stderr.includes('rate limit')) {
        logger.debug(`executeLinearisCommand: Mapped to RATE_LIMITED error`)
        throw new LinearServiceError('RATE_LIMITED', 'Linear API rate limit exceeded', {
          stderr,
        })
      }

      // Generic CLI error
      logger.debug(`executeLinearisCommand: Generic CLI_ERROR`)
      throw new LinearServiceError('CLI_ERROR', `Linear CLI error: ${stderr}`, { stderr })
    }

    // Unknown error type
    logger.debug(`executeLinearisCommand: Unknown error type: ${error}`)
    throw new LinearServiceError('CLI_ERROR', 'Unknown error executing linearis CLI', {
      error,
    })
  }
}

/**
 * Fetch a Linear issue by identifier
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @returns Linear issue details
 * @throws LinearServiceError if issue not found or CLI error
 */
export async function fetchLinearIssue(identifier: string): Promise<LinearIssue> {
  logger.debug(`Fetching Linear issue: ${identifier}`)
  return executeLinearisCommand<LinearIssue>(['issues', 'read', identifier])
}

/**
 * Create a new Linear issue
 * @param title - Issue title
 * @param body - Issue description (markdown)
 * @param teamKey - Team key (e.g., "ENG", "PLAT")
 * @param labels - Optional label names to apply
 * @returns Created issue identifier and URL
 * @throws LinearServiceError on creation failure
 */
export async function createLinearIssue(
  title: string,
  body: string,
  teamKey: string,
  labels?: string[],
): Promise<{ identifier: string; url: string }> {
  logger.debug(`Creating Linear issue in team ${teamKey}: ${title}`)

  const args = ['issues', 'create', title, '--team', teamKey]

  if (body) {
    args.push('--description', body)
  }

  if (labels && labels.length > 0) {
    args.push('--labels', labels.join(','))
  }

  const issue = await executeLinearisCommand<LinearIssue>(args)

  // Construct URL if not provided by linearis CLI
  const url = issue.url ?? buildLinearIssueUrl(issue.identifier, title)

  return {
    identifier: issue.identifier,
    url,
  }
}

/**
 * Create a comment on a Linear issue
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @param body - Comment body (markdown)
 * @returns Created comment details
 * @throws LinearServiceError on creation failure
 */
export async function createLinearComment(
  identifier: string,
  body: string,
): Promise<LinearComment> {
  logger.debug(`Creating comment on Linear issue ${identifier}`)
  return executeLinearisCommand<LinearComment>(['comments', 'create', identifier, '--body', body])
}

/**
 * Update a Linear issue's workflow state
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @param stateName - Target state name (e.g., "In Progress", "Done")
 * @throws LinearServiceError on update failure
 */
export async function updateLinearIssueState(
  identifier: string,
  stateName: string,
): Promise<void> {
  logger.debug(`Updating Linear issue ${identifier} state to: ${stateName}`)
  await executeLinearisCommand(['issues', 'update', identifier, '--state', stateName])
}

/**
 * Get a specific comment by ID
 * @param commentId - Linear comment UUID
 * @returns Comment details
 * @throws LinearServiceError if comment not found
 */
export async function getLinearComment(commentId: string): Promise<LinearComment> {
  logger.debug(`Fetching Linear comment: ${commentId}`)
  return executeLinearisCommand<LinearComment>(['comments', 'read', commentId])
}

/**
 * Update an existing comment
 * @param commentId - Linear comment UUID
 * @param body - New comment body (markdown)
 * @returns Updated comment details
 * @throws LinearServiceError on update failure
 */
export async function updateLinearComment(
  commentId: string,
  body: string,
): Promise<LinearComment> {
  logger.debug(`Updating Linear comment: ${commentId}`)
  return executeLinearisCommand<LinearComment>(['comments', 'update', commentId, '--body', body])
}
