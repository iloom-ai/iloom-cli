import type { ParsedInput } from '../commands/start.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'

/**
 * IdentifierParser provides consistent identifier parsing across commands
 * using pattern-based detection without GitHub API calls.
 *
 * Detection Strategy:
 * 1. For numeric input (e.g., "42", "#66"):
 *    - Check for PR worktree first (_pr_N pattern in path)
 *    - Then check for issue worktree (issue-N pattern in branch)
 * 2. For non-numeric input:
 *    - Treat as branch name and verify worktree exists
 *
 * This ensures:
 * - No unnecessary GitHub API calls
 * - Consistent behavior across finish/cleanup commands
 * - PR detection takes priority over issue detection
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
