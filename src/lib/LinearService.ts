/**
 * LinearService - IssueTracker implementation for Linear
 * Implements issue tracking operations using the @linear/sdk
 */

import type { Issue, PullRequest, IssueTrackerInputDetection } from '../types/index.js'
import type { LinearIssue } from '../types/linear.js'
import { LinearServiceError } from '../types/linear.js'
import {
  fetchLinearIssue,
  createLinearIssue,
  updateLinearIssueState,
} from '../utils/linear.js'
import { promptConfirmation } from '../utils/prompt.js'
import type { IssueTracker } from './IssueTracker.js'
import { getLogger } from '../utils/logger-context.js'

/**
 * Linear service configuration options
 */
export interface LinearServiceConfig {
  /** Linear team key (e.g., "ENG", "PLAT") */
  teamId?: string
  /** Branch naming template (e.g., "feat/{{key}}__{{title}}") */
  branchFormat?: string
  /** Linear API token (lin_api_...). If provided, sets process.env.LINEAR_API_TOKEN */
  apiToken?: string
}

/**
 * Linear implementation of IssueTracker interface
 */
export class LinearService implements IssueTracker {
  // IssueTracker interface implementation
  readonly providerName = 'linear'
  readonly supportsPullRequests = false // Linear doesn't have pull requests

  private config: LinearServiceConfig
  private prompter: (message: string) => Promise<boolean>

  constructor(
    config?: LinearServiceConfig,
    options?: { prompter?: (message: string) => Promise<boolean> },
  ) {
    this.config = config ?? {}
    this.prompter = options?.prompter ?? promptConfirmation

    // Set API token from config if provided (follows mcp.ts pattern)
    if (this.config.apiToken) {
      process.env.LINEAR_API_TOKEN = this.config.apiToken
    }
  }

  /**
   * Detect if input matches Linear identifier format (TEAM-NUMBER)
   * @param input - User input string
   * @param _repo - Repository (unused for Linear)
   * @returns Detection result with type and identifier
   */
  public async detectInputType(
    input: string,
    _repo?: string,
  ): Promise<IssueTrackerInputDetection> {
    getLogger().debug(`LinearService.detectInputType called with input: "${input}"`)

    // Pattern: TEAM-NUMBER (e.g., ENG-123, PLAT-456)
    // Requires at least 2 letters before dash to avoid conflict with PR-123 format
    const linearPattern = /^([A-Z]{2,}-\d+)$/i
    const match = input.match(linearPattern)

    if (!match?.[1]) {
      getLogger().debug(`LinearService: Input "${input}" does not match Linear pattern`)
      return { type: 'unknown', identifier: null, rawInput: input }
    }

    const identifier = match[1].toUpperCase()
    getLogger().debug(`LinearService: Matched Linear identifier: ${identifier}`)

    // Validate the issue exists in Linear
    getLogger().debug(`LinearService: Checking if ${identifier} is a valid Linear issue via SDK`)
    const issue = await this.isValidIssue(identifier)

    if (issue) {
      getLogger().debug(`LinearService: Issue ${identifier} found: "${issue.title}"`)
      return { type: 'issue', identifier, rawInput: input }
    }

    // Not found
    getLogger().debug(`LinearService: Issue ${identifier} NOT found by SDK`)
    return { type: 'unknown', identifier: null, rawInput: input }
  }

  /**
   * Fetch a Linear issue by identifier
   * @param identifier - Linear issue identifier (string or number)
   * @param _repo - Repository (unused for Linear)
   * @returns Generic Issue type
   * @throws LinearServiceError if issue not found
   */
  public async fetchIssue(identifier: string | number, _repo?: string): Promise<Issue> {
    const linearIssue = await fetchLinearIssue(String(identifier))
    return this.mapLinearIssueToIssue(linearIssue)
  }

  /**
   * Check if an issue identifier is valid (silent validation)
   * @param identifier - Linear issue identifier
   * @param _repo - Repository (unused for Linear)
   * @returns Issue if valid, false if not found
   */
  public async isValidIssue(identifier: string | number, _repo?: string): Promise<Issue | false> {
    try {
      return await this.fetchIssue(identifier)
    } catch (error) {
      // Return false for NOT_FOUND errors (expected during detection)
      if (error instanceof LinearServiceError && error.code === 'NOT_FOUND') {
        return false
      }
      // Re-throw unexpected errors
      throw error
    }
  }

  /**
   * Validate issue state and prompt user if closed
   * @param issue - Issue to validate
   * @throws LinearServiceError if user cancels due to closed issue
   */
  public async validateIssueState(issue: Issue): Promise<void> {
    if (issue.state === 'closed') {
      const shouldContinue = await this.prompter(
        `Issue ${issue.number} is closed. Continue anyway?`,
      )

      if (!shouldContinue) {
        throw new LinearServiceError('INVALID_STATE', 'User cancelled due to closed issue')
      }
    }
  }

  /**
   * Create a new Linear issue
   * @param title - Issue title
   * @param body - Issue description (markdown)
   * @param _repository - Repository (unused for Linear)
   * @param labels - Optional label names
   * @returns Created issue identifier and URL
   * @throws LinearServiceError if teamId not configured or creation fails
   */
  public async createIssue(
    title: string,
    body: string,
    _repository?: string,
    labels?: string[],
  ): Promise<{ number: string | number; url: string }> {
    // Require teamId configuration
    if (!this.config.teamId) {
      throw new LinearServiceError(
        'INVALID_STATE',
        'Linear teamId not configured. Run `il init` to configure Linear settings.',
      )
    }

    getLogger().info(`Creating Linear issue in team ${this.config.teamId}: ${title}`)

    const result = await createLinearIssue(title, body, this.config.teamId, labels)

    return {
      number: result.identifier,
      url: result.url,
    }
  }

  /**
   * Get the web URL for a Linear issue
   * @param identifier - Linear issue identifier
   * @param _repo - Repository (unused for Linear)
   * @returns Issue URL
   */
  public async getIssueUrl(identifier: string | number, _repo?: string): Promise<string> {
    const issue = await this.fetchIssue(identifier)
    return issue.url
  }

  /**
   * Move a Linear issue to "In Progress" state
   * @param identifier - Linear issue identifier
   * @throws LinearServiceError if state update fails
   */
  public async moveIssueToInProgress(identifier: string | number): Promise<void> {
    getLogger().info(`Moving Linear issue ${identifier} to In Progress`)
    await updateLinearIssueState(String(identifier), 'In Progress')
  }

  /**
   * Move a Linear issue to "In Review" state
   * @param identifier - Linear issue identifier
   * @throws LinearServiceError if state update fails
   */
  public async moveIssueToReadyForReview(identifier: string | number): Promise<void> {
    getLogger().info(`Moving Linear issue ${identifier} to In Review`)
    await updateLinearIssueState(String(identifier), 'In Review')
  }

  /**
   * Normalize identifier to canonical form (uppercase for Linear keys)
   * @param identifier - Linear issue identifier (e.g., "eng-123" or "ENG-123")
   * @returns Uppercase identifier (e.g., "ENG-123")
   */
  public normalizeIdentifier(identifier: string | number): string {
    return String(identifier).toUpperCase()
  }

  /**
   * Extract issue context for AI prompts
   * @param entity - Issue (Linear doesn't have PRs)
   * @returns Formatted context string
   */
  public extractContext(entity: Issue | PullRequest): string {
    // Linear doesn't have PRs, always an issue
    const issue = entity as Issue
    return `Linear Issue ${issue.number}: ${issue.title}\nState: ${issue.state}\n\n${issue.body}`
  }

  /**
   * Map Linear API issue to generic Issue type
   * @param linear - Linear issue from SDK
   * @returns Generic Issue type
   */
  private mapLinearIssueToIssue(linear: LinearIssue): Issue {
    return {
      number: linear.identifier, // Keep as string (e.g., "ENG-123")
      title: linear.title,
      body: linear.description ?? '',
      state: linear.state ? (linear.state.toLowerCase().includes('done') || linear.state.toLowerCase().includes('completed') || linear.state.toLowerCase().includes('canceled') ? 'closed' : 'open') : 'open',
      labels: [],
      assignees: [],
      url: linear.url,
    }
  }
}
