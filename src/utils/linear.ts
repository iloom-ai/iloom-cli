/**
 * Linear SDK utilities
 * Wrapper functions for the @linear/sdk
 */

import { LinearClient, IssueRelationType } from '@linear/sdk'
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
 * Get Linear API token from environment
 * @returns API token
 * @throws LinearServiceError if token not found
 */
function getLinearApiToken(): string {
  const token = process.env.LINEAR_API_TOKEN
  if (!token) {
    throw new LinearServiceError(
      'UNAUTHORIZED',
      'LINEAR_API_TOKEN not set. Configure in settings.local.json or set environment variable.',
    )
  }
  return token
}

/**
 * Create a Linear SDK client instance
 * @param apiToken - Optional API token (takes precedence over env var)
 * @returns Configured LinearClient
 */
function createLinearClient(apiToken?: string): LinearClient {
  const token = apiToken ?? getLinearApiToken()
  return new LinearClient({ apiKey: token })
}

/**
 * Handle SDK errors and convert to LinearServiceError
 * @param error - Error from SDK
 * @param context - Context string for debugging
 * @throws LinearServiceError
 */
function handleLinearError(error: unknown, context: string): never {
  logger.debug(`${context}: Handling error`, { error })

  // SDK errors typically have a message property
  const errorMessage = error instanceof Error ? error.message : String(error)

  // Map common error patterns
  if (errorMessage.includes('not found') || errorMessage.includes('Not found')) {
    throw new LinearServiceError('NOT_FOUND', 'Linear issue or resource not found', { error })
  }

  if (
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('Unauthorized') ||
    errorMessage.includes('Invalid API key')
  ) {
    throw new LinearServiceError(
      'UNAUTHORIZED',
      'Linear authentication failed. Check LINEAR_API_TOKEN.',
      { error },
    )
  }

  if (errorMessage.includes('rate limit')) {
    throw new LinearServiceError('RATE_LIMITED', 'Linear API rate limit exceeded', { error })
  }

  // Generic SDK error
  throw new LinearServiceError('CLI_ERROR', `Linear SDK error: ${errorMessage}`, { error })
}

/**
 * Fetch a Linear issue by identifier
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @returns Linear issue details
 * @throws LinearServiceError if issue not found or SDK error
 */
export async function fetchLinearIssue(identifier: string): Promise<LinearIssue> {
  try {
    logger.debug(`Fetching Linear issue: ${identifier}`)
    const client = createLinearClient()
    const issue = await client.issue(identifier)

    if (!issue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
    }

    // Convert SDK issue to our LinearIssue type
    const result: LinearIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
    }

    // Add optional fields if present
    if (issue.description) {
      result.description = issue.description
    }

    if (issue.state) {
      const state = await issue.state
      if (state?.name) {
        result.state = state.name
      }
    }

    return result
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'fetchLinearIssue')
  }
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
  _labels?: string[],
): Promise<{ identifier: string; url: string }> {
  try {
    logger.debug(`Creating Linear issue in team ${teamKey}: ${title}`)
    const client = createLinearClient()

    // Get team by key
    const teams = await client.teams()
    const team = teams.nodes.find((t) => t.key === teamKey)

    if (!team) {
      throw new LinearServiceError('NOT_FOUND', `Linear team ${teamKey} not found`)
    }

    // Create issue
    const issueInput: { teamId: string; title: string; description?: string } = {
      teamId: team.id,
      title,
    }

    if (body) {
      issueInput.description = body
    }

    const payload = await client.createIssue(issueInput)

    const issue = await payload.issue

    if (!issue) {
      throw new LinearServiceError('CLI_ERROR', 'Failed to create Linear issue')
    }

    // Construct URL
    const url = issue.url ?? buildLinearIssueUrl(issue.identifier, title)

    return {
      identifier: issue.identifier,
      url,
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'createLinearIssue')
  }
}

/**
 * Create a child issue linked to a parent issue
 * Linear supports atomic creation with parentId field
 * @param title - Issue title
 * @param body - Issue description (markdown)
 * @param teamKey - Team key (e.g., "ENG")
 * @param parentId - Parent issue UUID (from issue.id, not identifier)
 * @param labels - Optional label names to apply
 * @returns Created issue identifier and URL
 * @throws LinearServiceError on creation failure
 */
export async function createLinearChildIssue(
  title: string,
  body: string,
  teamKey: string,
  parentId: string,
  _labels?: string[],
): Promise<{ identifier: string; url: string }> {
  try {
    logger.debug(`Creating Linear child issue in team ${teamKey}: ${title}`)
    const client = createLinearClient()

    // Get team by key
    const teams = await client.teams()
    const team = teams.nodes.find((t) => t.key === teamKey)

    if (!team) {
      throw new LinearServiceError('NOT_FOUND', `Linear team ${teamKey} not found`)
    }

    // Create issue with parentId for atomic parent-child relationship
    const issueInput: { teamId: string; title: string; description?: string; parentId: string } = {
      teamId: team.id,
      title,
      parentId, // UUID of parent issue
    }

    if (body) {
      issueInput.description = body
    }

    const payload = await client.createIssue(issueInput)

    const issue = await payload.issue

    if (!issue) {
      throw new LinearServiceError('CLI_ERROR', 'Failed to create Linear child issue')
    }

    // Construct URL
    const url = issue.url ?? buildLinearIssueUrl(issue.identifier, title)

    return {
      identifier: issue.identifier,
      url,
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'createLinearChildIssue')
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
  try {
    logger.debug(`Creating comment on Linear issue ${identifier}`)
    const client = createLinearClient()

    // Get issue by identifier to get its ID
    const issue = await client.issue(identifier)
    if (!issue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
    }

    // Create comment using issue ID
    const payload = await client.createComment({
      issueId: issue.id,
      body,
    })

    const comment = await payload.comment

    if (!comment) {
      throw new LinearServiceError('CLI_ERROR', 'Failed to create Linear comment')
    }

    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      url: comment.url,
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'createLinearComment')
  }
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
  try {
    logger.debug(`Updating Linear issue ${identifier} state to: ${stateName}`)
    const client = createLinearClient()

    // Get issue by identifier
    const issue = await client.issue(identifier)
    if (!issue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
    }

    // Get team to find state
    const team = await issue.team
    if (!team) {
      throw new LinearServiceError('CLI_ERROR', 'Issue has no team')
    }

    // Find state by name
    const states = await team.states()
    const state = states.nodes.find((s) => s.name === stateName)

    if (!state) {
      throw new LinearServiceError(
        'NOT_FOUND',
        `State "${stateName}" not found in team ${team.key}`,
      )
    }

    // Update issue state
    await client.updateIssue(issue.id, {
      stateId: state.id,
    })
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'updateLinearIssueState')
  }
}

/**
 * Get a specific comment by ID
 * @param commentId - Linear comment UUID
 * @returns Comment details
 * @throws LinearServiceError if comment not found
 */
export async function getLinearComment(commentId: string): Promise<LinearComment> {
  try {
    logger.debug(`Fetching Linear comment: ${commentId}`)
    const client = createLinearClient()
    const comment = await client.comment({ id: commentId })

    if (!comment) {
      throw new LinearServiceError('NOT_FOUND', `Linear comment ${commentId} not found`)
    }

    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      url: comment.url,
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'getLinearComment')
  }
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
  try {
    logger.debug(`Updating Linear comment: ${commentId}`)
    const client = createLinearClient()

    const payload = await client.updateComment(commentId, { body })
    const comment = await payload.comment

    if (!comment) {
      throw new LinearServiceError('CLI_ERROR', 'Failed to update Linear comment')
    }

    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      url: comment.url,
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'updateLinearComment')
  }
}

/**
 * Fetch all comments for a Linear issue
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @returns Array of comments
 * @throws LinearServiceError on fetch failure
 */
export async function fetchLinearIssueComments(identifier: string): Promise<LinearComment[]> {
  try {
    logger.debug(`Fetching comments for Linear issue: ${identifier}`)
    const client = createLinearClient()

    // Get issue by identifier
    const issue = await client.issue(identifier)
    if (!issue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
    }

    // Fetch comments
    const comments = await issue.comments({ first: 100 })

    return comments.nodes.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      url: comment.url,
    }))
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'fetchLinearIssueComments')
  }
}

/**
 * Get child issues of a parent Linear issue
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @param options - Optional settings
 * @param options.apiToken - Optional API token (takes precedence over env var)
 * @returns Array of child issues
 * @throws LinearServiceError on fetch failure
 */
export async function getLinearChildIssues(
  identifier: string,
  options?: { apiToken?: string },
): Promise<Array<{ id: string; title: string; url: string; state: string }>> {
  try {
    logger.debug(`Fetching child issues for Linear issue: ${identifier}`)
    const client = createLinearClient(options?.apiToken)

    // Get issue by identifier
    const issue = await client.issue(identifier)
    if (!issue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
    }

    // Fetch child issues
    const children = await issue.children({ first: 100 })

    // Build results, fetching state in parallel
    const results = await Promise.all(
      children.nodes.map(async (child) => {
        const stateObj = await child.state
        const state = stateObj?.name ?? 'unknown'

        return {
          id: child.identifier,
          title: child.title,
          url: child.url,
          state,
        }
      }),
    )

    return results
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'getLinearChildIssues')
  }
}

// Linear Issue Dependency Operations

/**
 * Dependency result for Linear issues
 */
export interface LinearDependencyResult {
  id: string
  title: string
  url: string
  state: string
}

/**
 * Create a blocking relationship between two issues
 * @param blockingIssueId - UUID of the issue that blocks (the blocker)
 * @param blockedIssueId - UUID of the issue being blocked
 * @throws LinearServiceError on creation failure
 */
export async function createLinearIssueRelation(
  blockingIssueId: string,
  blockedIssueId: string,
): Promise<void> {
  try {
    logger.debug(`Creating Linear issue relation: ${blockingIssueId} blocks ${blockedIssueId}`)
    const client = createLinearClient()

    // Create a "blocks" relation from blockingIssue to blockedIssue
    // In Linear, the relation is created on the blocking issue pointing to the blocked issue
    const payload = await client.createIssueRelation({
      issueId: blockingIssueId,
      relatedIssueId: blockedIssueId,
      type: IssueRelationType.Blocks,
    })

    if (!payload.success) {
      throw new LinearServiceError('CLI_ERROR', 'Failed to create Linear issue relation')
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'createLinearIssueRelation')
  }
}

/**
 * Get dependencies for a Linear issue
 * @param identifier - Linear issue identifier (e.g., "ENG-123")
 * @param direction - 'blocking' for issues this blocks, 'blocked_by' for blockers, 'both' for all
 * @returns Object with blocking and blockedBy arrays
 * @throws LinearServiceError on fetch failure
 */
export async function getLinearIssueDependencies(
  identifier: string,
  direction: 'blocking' | 'blocked_by' | 'both',
): Promise<{ blocking: LinearDependencyResult[]; blockedBy: LinearDependencyResult[] }> {
  try {
    logger.debug(`Fetching Linear issue dependencies: ${identifier} (direction: ${direction})`)
    const client = createLinearClient()

    // Get issue by identifier
    const issue = await client.issue(identifier)
    if (!issue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${identifier} not found`)
    }

    // Fetch relations and inverse relations in parallel
    const [relations, inverseRelations] = await Promise.all([
      issue.relations(),
      issue.inverseRelations(),
    ])

    const blocking: LinearDependencyResult[] = []
    const blockedBy: LinearDependencyResult[] = []

    // Helper to build dependency result from a resolved issue
    const buildDependencyResult = async (
      relatedIssue: { identifier: string; title: string; url: string; state: unknown } | null | undefined,
    ): Promise<LinearDependencyResult | null> => {
      if (!relatedIssue) return null

      const stateObj = await (relatedIssue.state as Promise<{ name?: string } | null | undefined>)
      const state = stateObj?.name ?? 'unknown'

      return {
        id: relatedIssue.identifier,
        title: relatedIssue.title,
        url: relatedIssue.url,
        state,
      }
    }

    // Process blocking relations (this issue blocks the related issue)
    // relations with type 'blocks' mean this issue blocks the related issue
    if (direction === 'blocking' || direction === 'both') {
      const blockingRelations = relations.nodes.filter(
        (r) => r.type === IssueRelationType.Blocks,
      )
      // Resolve all related issues in parallel, then build results
      // Filter out undefined relatedIssue before Promise.all (LinearFetch<Issue> | undefined)
      const relatedIssuePromises = blockingRelations
        .map((r) => r.relatedIssue)
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
      const relatedIssues = await Promise.all(relatedIssuePromises)
      const blockingResults = await Promise.all(
        relatedIssues.map((issue) => buildDependencyResult(issue)),
      )
      blocking.push(...blockingResults.filter((r): r is LinearDependencyResult => r !== null))
    }

    // Process blocked by relations (the related issue blocks this issue)
    // inverseRelations with type 'blocks' mean the related issue blocks this issue
    if (direction === 'blocked_by' || direction === 'both') {
      const blockedByRelations = inverseRelations.nodes.filter(
        (r) => r.type === IssueRelationType.Blocks,
      )
      // Resolve all source issues in parallel, then build results
      // Filter out undefined issue before Promise.all (LinearFetch<Issue> | undefined)
      const sourceIssuePromises = blockedByRelations
        .map((r) => r.issue)
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
      const sourceIssues = await Promise.all(sourceIssuePromises)
      const blockedByResults = await Promise.all(
        sourceIssues.map((issue) => buildDependencyResult(issue)),
      )
      blockedBy.push(...blockedByResults.filter((r): r is LinearDependencyResult => r !== null))
    }

    return { blocking, blockedBy }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'getLinearIssueDependencies')
  }
}

/**
 * Delete an issue relation by ID
 * @param relationId - UUID of the relation to delete
 * @throws LinearServiceError on deletion failure
 */
export async function deleteLinearIssueRelation(relationId: string): Promise<void> {
  try {
    logger.debug(`Deleting Linear issue relation: ${relationId}`)
    const client = createLinearClient()

    const payload = await client.deleteIssueRelation(relationId)

    if (!payload.success) {
      throw new LinearServiceError('CLI_ERROR', 'Failed to delete Linear issue relation')
    }
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'deleteLinearIssueRelation')
  }
}

// Issue List Operations (for il issues command)

export interface LinearIssueListItem {
  id: string
  title: string
  updatedAt: string
  url: string
  state: string
}

/**
 * Fetch a list of active Linear issues for a team, sorted by recently updated
 * @param teamKey - Team key (e.g., "ENG", "PLAT")
 * @param options - Fetch options
 * @param options.limit - Maximum number of issues to return (default: 100)
 * @param options.apiToken - Optional API token (takes precedence over env var)
 * @returns Array of issues
 * @throws LinearServiceError on fetch failure
 */
export async function fetchLinearIssueList(
  teamKey: string,
  options?: { limit?: number; apiToken?: string; mine?: boolean },
): Promise<LinearIssueListItem[]> {
  try {
    const limit = options?.limit ?? 100

    logger.debug(`Fetching Linear issue list for team ${teamKey}`, { limit, mine: options?.mine })
    const client = createLinearClient(options?.apiToken)

    // Get team by key
    const teams = await client.teams()
    const team = teams.nodes.find((t) => t.key === teamKey)

    if (!team) {
      throw new LinearServiceError('NOT_FOUND', `Linear team ${teamKey} not found`)
    }

    // Build filter: always exclude completed/canceled states
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Linear SDK filter types are complex and not fully exported
    const filter: any = {
      state: {
        type: {
          nin: ['completed', 'canceled'],
        },
      },
    }

    // When --mine is set, filter to issues assigned to the authenticated user
    if (options?.mine) {
      filter.assignee = { isMe: { eq: true } }
    }

    // Fetch issues: filter out completed and canceled states, order by updatedAt
    const issues = await team.issues({
      first: limit,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PaginationOrderBy is a const enum incompatible with isolatedModules
      orderBy: 'updatedAt' as any,
      filter,
    })

    // Build results, resolving state names in parallel
    const results = await Promise.all(
      issues.nodes.map(async (issue) => {
        const stateObj = await issue.state
        const state = stateObj?.name ?? 'unknown'

        return {
          id: issue.identifier,
          title: issue.title,
          updatedAt: issue.updatedAt.toISOString(),
          url: issue.url,
          state,
        }
      }),
    )

    return results
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'fetchLinearIssueList')
  }
}

/**
 * Find the relation ID between two issues for removal
 * @param blockingIdentifier - Identifier of the blocking issue
 * @param blockedIdentifier - Identifier of the blocked issue
 * @returns The relation ID if found, null otherwise
 * @throws LinearServiceError on fetch failure
 */
export async function findLinearIssueRelation(
  blockingIdentifier: string,
  blockedIdentifier: string,
): Promise<string | null> {
  try {
    logger.debug(`Finding Linear issue relation: ${blockingIdentifier} blocks ${blockedIdentifier}`)
    const client = createLinearClient()

    // Get the blocking issue
    const blockingIssue = await client.issue(blockingIdentifier)
    if (!blockingIssue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${blockingIdentifier} not found`)
    }

    // Get the blocked issue to get its ID
    const blockedIssue = await client.issue(blockedIdentifier)
    if (!blockedIssue) {
      throw new LinearServiceError('NOT_FOUND', `Linear issue ${blockedIdentifier} not found`)
    }

    // Find the relation from blockingIssue that blocks blockedIssue
    const relations = await blockingIssue.relations()

    // Filter to only 'blocks' relations and fetch related issues in parallel
    const blockingRelations = relations.nodes.filter(
      (r) => r.type === IssueRelationType.Blocks,
    )

    const relationsWithIssues = await Promise.all(
      blockingRelations.map(async (relation) => ({
        relation,
        relatedIssue: await relation.relatedIssue,
      })),
    )

    const matchingRelation = relationsWithIssues.find(
      ({ relatedIssue }) => relatedIssue?.id === blockedIssue.id,
    )

    return matchingRelation?.relation.id ?? null
  } catch (error) {
    if (error instanceof LinearServiceError) {
      throw error
    }
    handleLinearError(error, 'findLinearIssueRelation')
  }
}
