import type { ParsedInput } from '../commands/start.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { extractIssueNumber, extractPRNumber } from './git.js'

/**
 * Result of parsing an issue identifier input
 */
export interface IssueIdentifierMatch {
  /** Whether the input matches an issue identifier pattern */
  isIssueIdentifier: boolean
  /** The type of identifier: 'numeric' (GitHub) or 'project-key' (project key format, e.g., Linear, Jira) */
  type?: 'numeric' | 'project-key'
  /** The extracted identifier (without # prefix for numeric) */
  identifier?: string
}

/**
 * Check if a string looks like an issue identifier
 *
 * Matches:
 * - Numeric patterns: "123", "#123" (GitHub format)
 * - Project key patterns: "ENG-123", "PLAT-456" (requires at least 2 letters before dash)
 *
 * This is a pure pattern match - it does NOT validate that the issue exists.
 * Use IssueTracker.detectInputType() to validate existence.
 *
 * @param input - The input string to check
 * @returns Object with isIssueIdentifier flag and optional type/identifier
 */
export function matchIssueIdentifier(input: string): IssueIdentifierMatch {
  const trimmed = input.trim()

  // Check for project key identifier format (TEAM-NUMBER, e.g., ENG-123, PLAT-456, PROJ-789)
  // Requires at least 2 letters before dash to avoid conflict with PR-123 format
  const projectKeyPattern = /^([A-Z]{2,}-\d+)$/i
  const projectKeyMatch = trimmed.match(projectKeyPattern)
  if (projectKeyMatch?.[1]) {
    return {
      isIssueIdentifier: true,
      type: 'project-key',
      identifier: projectKeyMatch[1].toUpperCase(),
    }
  }

  // Check for numeric pattern (GitHub format: 123 or #123)
  const numericPattern = /^#?(\d+)$/
  const numericMatch = trimmed.match(numericPattern)
  if (numericMatch?.[1]) {
    return {
      isIssueIdentifier: true,
      type: 'numeric',
      identifier: numericMatch[1],
    }
  }

  return { isIssueIdentifier: false }
}

/**
 * IdentifierParser provides consistent identifier parsing across commands
 * using pattern-based detection without GitHub API calls.
 *
 * Detection Strategy:
 * 1. For numeric input (e.g., "42", "#66"):
 *    - Check for PR worktree first (_pr_N pattern in path)
 *    - Then check for issue worktree (issue-N pattern in branch)
 * 2. For alphanumeric input (e.g., "ENG-123"):
 *    - Check for issue worktree with alphanumeric identifier
 * 3. For branch-style input (e.g., "feat/issue-42__description", "pr/123"):
 *    - Find matching worktree by branch name
 *    - Extract PR number from branch name if present (priority)
 *    - Extract issue number from branch name if present
 *    - Return as PR/issue type if number found, otherwise branch type
 *
 * This ensures:
 * - No unnecessary GitHub API calls
 * - Consistent behavior across finish/cleanup commands
 * - PR detection takes priority over issue detection
 * - Issue numbers are extracted from branch names for "Fixes #N" commit trailers
 */
export class IdentifierParser {
	constructor(private gitWorktreeManager: GitWorktreeManager) {}

	/**
	 * Parse identifier using pattern-based detection on existing worktrees.
	 * Does NOT make GitHub API calls - only checks local worktree patterns.
	 *
	 * @param identifier - The identifier to parse (e.g., "42", "#66", "ENG-123", "my-branch")
	 * @returns ParsedInput with type, number/branchName, and originalInput
	 * @throws Error if no matching worktree is found
	 */
	async parseForPatternDetection(identifier: string): Promise<ParsedInput> {
		// Remove # prefix if present and trim whitespace
		const cleanId = identifier.replace(/^#/, '').trim()
		const originalInput = identifier

		// Check if input is numeric (GitHub-style issue/PR numbers)
		const numericMatch = cleanId.match(/^(\d+)$/)

		if (numericMatch?.[1]) {
			const number = parseInt(numericMatch[1], 10)

			// Priority 1: Check for PR worktree (_pr_N pattern)
			// Pass empty string for branch name since we don't know it yet
			const prWorktree = await this.gitWorktreeManager.findWorktreeForPR(number, '')
			if (prWorktree) {
				return {
					type: 'pr',
					number,
					originalInput,
				}
			}

			// Priority 2: Check for issue worktree (issue-N pattern)
			const issueWorktree = await this.gitWorktreeManager.findWorktreeForIssue(number)
			if (issueWorktree) {
				return {
					type: 'issue',
					number,
					originalInput,
				}
			}

			// No matching worktree found for numeric input
			throw new Error(`No worktree found for identifier: ${identifier}`)
		}

		// Check if input is alphanumeric issue identifier (Linear/Jira-style: ABC-123, ENG-42)
		const alphanumericMatch = cleanId.match(/^([A-Za-z]+-\d+)$/)

		if (alphanumericMatch?.[1]) {
			const alphanumericId = alphanumericMatch[1]

			// Check for issue worktree with alphanumeric identifier
			const issueWorktree = await this.gitWorktreeManager.findWorktreeForIssue(alphanumericId)
			if (issueWorktree) {
				return {
					type: 'issue',
					number: alphanumericId,
					originalInput,
				}
			}

			// No matching worktree found for alphanumeric identifier
			throw new Error(`No worktree found for identifier: ${identifier}`)
		}

		// Non-numeric/non-alphanumeric input: treat as branch name
		const branchWorktree = await this.gitWorktreeManager.findWorktreeForBranch(cleanId)
		if (branchWorktree) {
			// Priority 1: Check for PR pattern in the input
			const prFromBranch = extractPRNumber(cleanId)
			if (prFromBranch !== null) {
				return {
					type: 'pr',
					number: prFromBranch,
					originalInput,
				}
			}

			// Priority 2: Try to extract issue number from branch name
			// This handles cases like "feat/issue-42__description" passed as explicit input
			const issueFromBranch = extractIssueNumber(cleanId)
			if (issueFromBranch !== null) {
				return {
					type: 'issue',
					number: issueFromBranch,
					originalInput,
				}
			}

			return {
				type: 'branch',
				branchName: cleanId,
				originalInput,
			}
		}

		// No matching worktree found for branch name
		throw new Error(`No worktree found for identifier: ${identifier}`)
	}
}
