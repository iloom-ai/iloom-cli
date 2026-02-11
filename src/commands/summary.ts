import path from 'path'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { SessionSummaryService } from '../lib/SessionSummaryService.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { PRManager } from '../lib/PRManager.js'
import { getLogger } from '../utils/logger-context.js'
import { extractIssueNumber } from '../utils/git.js'
import type { GitWorktree } from '../types/worktree.js'
import type { SummaryResult } from '../types/index.js'

/**
 * Options for the summary command
 */
export interface SummaryOptions {
	withComment?: boolean
	json?: boolean
}

/**
 * Input for the summary command
 */
export interface SummaryCommandInput {
	identifier?: string | undefined
	options: SummaryOptions
}

/**
 * Parsed input with loom information
 */
interface ParsedSummaryInput {
	worktree: GitWorktree
	loomType: 'issue' | 'pr' | 'branch'
	issueNumber?: string | number | undefined
}

/**
 * SummaryCommand - Generate and optionally post Claude session summaries
 *
 * This command allows generating the session summary without going through
 * the full `il finish` workflow. It can:
 * 1. Generate a summary and print it to stdout
 * 2. Optionally post the summary as a comment (--with-comment flag)
 */
export class SummaryCommand {
	constructor(
		private gitWorktreeManager = new GitWorktreeManager(),
		private metadataManager = new MetadataManager(),
		private sessionSummaryService = new SessionSummaryService(),
		private settingsManager = new SettingsManager()
	) {}

	/**
	 * Determine PR number based on merge mode and metadata
	 * Returns undefined if should post to issue instead
	 */
	private async getPRNumberForPosting(
		worktreePath: string,
		branchName: string
	): Promise<number | undefined> {
		const settings = await this.settingsManager.loadSettings(worktreePath)
		const mergeMode = settings.mergeBehavior?.mode ?? 'local'

		if (mergeMode === 'github-draft-pr') {
			const metadata = await this.metadataManager.readMetadata(worktreePath)
			return metadata?.draftPrNumber ?? undefined
		}

		if (mergeMode === 'github-pr') {
			const prManager = new PRManager(settings)
			const existingPR = await prManager.checkForExistingPR(branchName, worktreePath)
			return existingPR?.number
		}

		return undefined // local mode - post to issue
	}

	/**
	 * Execute the summary command
	 *
	 * @param input - Command input containing identifier and options
	 * @returns SummaryResult when in JSON mode, void otherwise
	 */
	async execute(input: SummaryCommandInput): Promise<SummaryResult | void> {
		const logger = getLogger()

		// 1. Find the loom by identifier (or auto-detect from current directory)
		const parsed = input.identifier?.trim()
			? await this.findLoom(input.identifier.trim())
			: await this.autoDetectFromCurrentDirectory()

		// 2. Generate the summary (service handles session ID internally, including deterministic fallback)
		const result = await this.sessionSummaryService.generateSummary(
			parsed.worktree.path,
			parsed.worktree.branch,
			parsed.loomType,
			parsed.issueNumber
		)

		// 4. Apply attribution if --with-comment is used (so output matches what will be posted)
		let displaySummary = result.summary
		if (input.options.withComment && parsed.loomType !== 'branch') {
			displaySummary = await this.sessionSummaryService.applyAttribution(
				result.summary,
				parsed.worktree.path
			)
		}

		// 5. In JSON mode, return the structured result
		if (input.options.json) {
			const jsonResult: SummaryResult = {
				summary: displaySummary,
				sessionId: result.sessionId,
				branchName: parsed.worktree.branch,
				loomType: parsed.loomType,
			}
			// Only include issueNumber if defined
			if (parsed.issueNumber !== undefined) {
				jsonResult.issueNumber = parsed.issueNumber
			}
			return jsonResult
		}

		// 6. Print the summary to stdout (intentionally using console.log for piping/redirection)
		// eslint-disable-next-line no-console
		console.log(displaySummary)

		// 7. Optionally post the summary as a comment
		if (input.options.withComment) {
			// Skip posting for branch type looms (no issue to comment on)
			if (parsed.loomType === 'branch') {
				logger.debug('Skipping comment posting: branch type looms have no associated issue')
			} else if (parsed.issueNumber !== undefined) {
				// Determine if we should post to PR instead of issue
				const prNumber = await this.getPRNumberForPosting(
					parsed.worktree.path,
					parsed.worktree.branch
				)
				await this.sessionSummaryService.postSummary(
					parsed.issueNumber,
					result.summary,
					parsed.worktree.path,
					prNumber
				)
			}
		}
	}

	/**
	 * Find a loom by identifier
	 *
	 * Supports:
	 * - Numeric identifiers (issue numbers): "123", "#123"
	 * - PR identifiers: "pr/123"
	 * - Branch names: "my-feature-branch"
	 */
	private async findLoom(identifier: string): Promise<ParsedSummaryInput> {
		// Remove # prefix if present and trim whitespace
		const cleanId = identifier.replace(/^#/, '').trim()

		// Check for PR pattern: pr/123 or PR/123
		const prMatch = cleanId.match(/^pr\/(\d+)$/i)
		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			const worktree = await this.gitWorktreeManager.findWorktreeForPR(prNumber, '')
			if (worktree) {
				const metadata = await this.metadataManager.readMetadata(worktree.path)
				return {
					worktree,
					loomType: 'pr',
					issueNumber: metadata?.pr_numbers?.[0] ?? String(prNumber),
				}
			}
			throw new Error(`No loom found for identifier: ${identifier}`)
		}

		// Check if input is numeric (issue number)
		const numericMatch = cleanId.match(/^(\d+)$/)
		if (numericMatch?.[1]) {
			const issueNumber = parseInt(numericMatch[1], 10)

			// Try issue first
			const issueWorktree = await this.gitWorktreeManager.findWorktreeForIssue(issueNumber)
			if (issueWorktree) {
				const metadata = await this.metadataManager.readMetadata(issueWorktree.path)
				return {
					worktree: issueWorktree,
					loomType: metadata?.issueType ?? 'issue',
					issueNumber: metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? String(issueNumber),
				}
			}

			// Then try PR
			const prWorktree = await this.gitWorktreeManager.findWorktreeForPR(issueNumber, '')
			if (prWorktree) {
				const metadata = await this.metadataManager.readMetadata(prWorktree.path)
				return {
					worktree: prWorktree,
					loomType: 'pr',
					issueNumber: metadata?.pr_numbers?.[0] ?? String(issueNumber),
				}
			}

			throw new Error(`No loom found for identifier: ${identifier}`)
		}

		// Check for alphanumeric issue identifier (Linear/Jira style: ABC-123)
		const alphanumericMatch = cleanId.match(/^([A-Za-z]+-\d+)$/)
		if (alphanumericMatch?.[1]) {
			const alphanumericId = alphanumericMatch[1]
			const issueWorktree = await this.gitWorktreeManager.findWorktreeForIssue(alphanumericId)
			if (issueWorktree) {
				const metadata = await this.metadataManager.readMetadata(issueWorktree.path)
				return {
					worktree: issueWorktree,
					loomType: metadata?.issueType ?? 'issue',
					issueNumber: metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? alphanumericId,
				}
			}
			throw new Error(`No loom found for identifier: ${identifier}`)
		}

		// Treat as branch name
		const branchWorktree = await this.gitWorktreeManager.findWorktreeForBranch(cleanId)
		if (branchWorktree) {
			const metadata = await this.metadataManager.readMetadata(branchWorktree.path)
			const loomType = metadata?.issueType ?? 'branch'

			// For branch looms, try to get issue number from metadata
			let issueNumber: string | number | undefined
			if (loomType === 'issue' && (metadata?.issueKey || metadata?.issue_numbers?.[0])) {
				issueNumber = metadata?.issueKey ?? metadata?.issue_numbers?.[0]
			} else if (loomType === 'pr' && metadata?.pr_numbers?.[0]) {
				issueNumber = metadata.pr_numbers[0]
			}

			return {
				worktree: branchWorktree,
				loomType,
				issueNumber,
			}
		}

		throw new Error(`No loom found for identifier: ${identifier}`)
	}

	/**
	 * Auto-detect loom from current working directory
	 * Ports logic from FinishCommand.autoDetectFromCurrentDirectory()
	 *
	 * Detection strategy:
	 * 1. Check current directory name for PR pattern (_pr_N suffix)
	 * 2. Check current directory name for issue pattern (issue-N or -N-)
	 * 3. Get current branch and check for issue pattern
	 * 4. Fall back to using current branch as branch loom
	 */
	private async autoDetectFromCurrentDirectory(): Promise<ParsedSummaryInput> {
		const logger = getLogger()
		const currentDir = path.basename(process.cwd())

		// Check for PR worktree pattern: _pr_N suffix
		const prPattern = /_pr_(\d+)$/
		const prMatch = currentDir.match(prPattern)

		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			logger.debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)

			const worktree = await this.gitWorktreeManager.findWorktreeForPR(prNumber, '')
			if (worktree) {
				const metadata = await this.metadataManager.readMetadata(worktree.path)
				return {
					worktree,
					loomType: 'pr',
					issueNumber: metadata?.pr_numbers?.[0] ?? String(prNumber),
				}
			}
			throw new Error(`No loom found for auto-detected PR #${prNumber}`)
		}

		// Check for issue pattern in directory name
		const issueNumber = extractIssueNumber(currentDir)

		if (issueNumber !== null) {
			logger.debug(`Auto-detected issue #${issueNumber} from directory: ${currentDir}`)

			const worktree = await this.gitWorktreeManager.findWorktreeForIssue(issueNumber)
			if (worktree) {
				const metadata = await this.metadataManager.readMetadata(worktree.path)
				return {
					worktree,
					loomType: metadata?.issueType ?? 'issue',
					issueNumber: metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? String(issueNumber),
				}
			}
			throw new Error(`No loom found for auto-detected issue #${issueNumber}`)
		}

		// Fallback: get current branch name
		const repoInfo = await this.gitWorktreeManager.getRepoInfo()
		const currentBranch = repoInfo.currentBranch

		if (!currentBranch) {
			throw new Error(
				'Could not auto-detect loom. Please provide an issue number, PR number, or branch name.\n' +
				'Expected directory pattern: feat/issue-XX-description OR worktree with _pr_N suffix'
			)
		}

		// Try to extract issue from branch name
		const branchIssueNumber = extractIssueNumber(currentBranch)
		if (branchIssueNumber !== null) {
			logger.debug(`Auto-detected issue #${branchIssueNumber} from branch: ${currentBranch}`)

			const worktree = await this.gitWorktreeManager.findWorktreeForIssue(branchIssueNumber)
			if (worktree) {
				const metadata = await this.metadataManager.readMetadata(worktree.path)
				return {
					worktree,
					loomType: metadata?.issueType ?? 'issue',
					issueNumber: metadata?.issueKey ?? metadata?.issue_numbers?.[0] ?? String(branchIssueNumber),
				}
			}
		}

		// Last resort: use current branch as branch loom
		const branchWorktree = await this.gitWorktreeManager.findWorktreeForBranch(currentBranch)
		if (branchWorktree) {
			const metadata = await this.metadataManager.readMetadata(branchWorktree.path)
			const loomType = metadata?.issueType ?? 'branch'

			// For branch looms, try to get issue number from metadata
			let resolvedIssueNumber: string | number | undefined
			if (loomType === 'issue' && (metadata?.issueKey || metadata?.issue_numbers?.[0])) {
				resolvedIssueNumber = metadata?.issueKey ?? metadata?.issue_numbers?.[0]
			} else if (loomType === 'pr' && metadata?.pr_numbers?.[0]) {
				resolvedIssueNumber = metadata.pr_numbers[0]
			}

			return {
				worktree: branchWorktree,
				loomType,
				issueNumber: resolvedIssueNumber,
			}
		}

		throw new Error(
			`Could not auto-detect loom from current directory or branch: ${currentBranch}\n` +
			'Please provide an issue number, PR number, or branch name.'
		)
	}
}
