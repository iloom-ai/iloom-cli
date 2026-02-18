import path from 'path'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { runScript } from '../utils/package-manager.js'
import { getPackageScripts } from '../utils/package-json.js'
import { extractIssueNumber } from '../utils/git.js'
import { logger } from '../utils/logger.js'
import type { GitWorktree } from '../types/worktree.js'

export interface ScriptCommandInput {
	identifier?: string
}

interface ParsedScriptInput {
	type: 'issue' | 'pr' | 'branch' | 'epic'
	number?: string | number
	branchName?: string
	originalInput: string
	autoDetected: boolean
}

/**
 * ScriptCommandBase - shared logic for build/lint/test/compile commands
 * Provides identifier parsing and worktree resolution using the same pattern as RunCommand
 */
export abstract class ScriptCommandBase {
	protected gitWorktreeManager: GitWorktreeManager
	protected identifierParser: IdentifierParser

	constructor(gitWorktreeManager?: GitWorktreeManager) {
		this.gitWorktreeManager = gitWorktreeManager ?? new GitWorktreeManager()
		this.identifierParser = new IdentifierParser(this.gitWorktreeManager)
	}

	/**
	 * Get the script name to run (e.g., 'build', 'lint', 'test')
	 */
	abstract getScriptName(): string

	/**
	 * Get the display name for logging (e.g., 'Build', 'Lint', 'Test')
	 */
	abstract getScriptDisplayName(): string

	/**
	 * Execute the script command
	 */
	async execute(input: ScriptCommandInput): Promise<void> {
		// 1. Parse or auto-detect identifier
		const parsed = input.identifier
			? await this.parseExplicitInput(input.identifier)
			: await this.autoDetectFromCurrentDirectory()

		logger.debug(`Parsed input: ${JSON.stringify(parsed)}`)

		// 2. Find worktree path based on identifier
		const worktree = await this.findWorktreeForIdentifier(parsed)
		logger.info(`Found worktree at: ${worktree.path}`)

		// 3. Check if script exists
		const scripts = await getPackageScripts(worktree.path)
		const scriptName = this.getScriptName()

		if (!scripts[scriptName]) {
			throw new Error(`No ${scriptName} script defined in package.json or package.iloom.json`)
		}

		// 4. Run the script
		logger.info(`Running ${this.getScriptDisplayName()}...`)
		await runScript(scriptName, worktree.path, [])
		logger.success(`${this.getScriptDisplayName()} completed successfully`)
	}

	/**
	 * Parse explicit identifier input
	 */
	protected async parseExplicitInput(identifier: string): Promise<ParsedScriptInput> {
		const parsed = await this.identifierParser.parseForPatternDetection(identifier)

		// Description type should never reach script command (converted in start)
		if (parsed.type === 'description') {
			throw new Error('Description input type is not supported in script commands')
		}

		const result: ParsedScriptInput = {
			type: parsed.type,
			originalInput: parsed.originalInput,
			autoDetected: false,
		}

		if (parsed.number !== undefined) {
			result.number = parsed.number
		}
		if (parsed.branchName !== undefined) {
			result.branchName = parsed.branchName
		}

		return result
	}

	/**
	 * Auto-detect identifier from current directory
	 * Same logic as RunCommand.autoDetectFromCurrentDirectory()
	 */
	protected async autoDetectFromCurrentDirectory(): Promise<ParsedScriptInput> {
		const currentDir = path.basename(process.cwd())

		// Check for PR worktree pattern: _pr_N suffix
		const prPattern = /_pr_(\d+)$/
		const prMatch = currentDir.match(prPattern)

		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			logger.debug(`Auto-detected PR #${prNumber} from directory: ${currentDir}`)
			return {
				type: 'pr',
				number: prNumber,
				originalInput: currentDir,
				autoDetected: true,
			}
		}

		// Check for issue pattern in directory
		const issueNumber = extractIssueNumber(currentDir)

		if (issueNumber !== null) {
			logger.debug(`Auto-detected issue #${issueNumber} from directory: ${currentDir}`)
			return {
				type: 'issue',
				number: issueNumber,
				originalInput: currentDir,
				autoDetected: true,
			}
		}

		// Fallback: get current branch name
		const repoInfo = await this.gitWorktreeManager.getRepoInfo()
		const currentBranch = repoInfo.currentBranch

		if (!currentBranch) {
			throw new Error(
				'Could not auto-detect identifier. Please provide an issue number, PR number, or branch name.\n' +
					'Expected directory pattern: feat/issue-XX-description OR worktree with _pr_N suffix'
			)
		}

		// Try to extract issue from branch name
		const branchIssueNumber = extractIssueNumber(currentBranch)
		if (branchIssueNumber !== null) {
			logger.debug(`Auto-detected issue #${branchIssueNumber} from branch: ${currentBranch}`)
			return {
				type: 'issue',
				number: branchIssueNumber,
				originalInput: currentBranch,
				autoDetected: true,
			}
		}

		// Last resort: use branch name
		return {
			type: 'branch',
			branchName: currentBranch,
			originalInput: currentBranch,
			autoDetected: true,
		}
	}

	/**
	 * Find worktree for the given identifier
	 */
	protected async findWorktreeForIdentifier(parsed: ParsedScriptInput): Promise<GitWorktree> {
		let worktree: GitWorktree | null = null

		if (parsed.type === 'issue' && parsed.number !== undefined) {
			worktree = await this.gitWorktreeManager.findWorktreeForIssue(parsed.number)
		} else if (parsed.type === 'pr' && parsed.number !== undefined) {
			// For PRs, ensure the number is numeric (PRs are always numeric per GitHub)
			const prNumber = typeof parsed.number === 'number' ? parsed.number : Number(parsed.number)
			if (isNaN(prNumber) || !isFinite(prNumber)) {
				throw new Error(`Invalid PR number: ${parsed.number}. PR numbers must be numeric.`)
			}
			// Pass empty string for branch name since we don't know it yet
			worktree = await this.gitWorktreeManager.findWorktreeForPR(prNumber, '')
		} else if (parsed.type === 'branch' && parsed.branchName) {
			worktree = await this.gitWorktreeManager.findWorktreeForBranch(parsed.branchName)
		}

		if (!worktree) {
			throw new Error(
				`No worktree found for ${this.formatParsedInput(parsed)}. ` +
					`Run 'il start ${parsed.originalInput}' to create one.`
			)
		}

		return worktree
	}

	/**
	 * Format parsed input for display
	 */
	protected formatParsedInput(parsed: ParsedScriptInput): string {
		const autoLabel = parsed.autoDetected ? ' (auto-detected)' : ''

		if (parsed.type === 'issue') {
			return `issue #${parsed.number}${autoLabel}`
		}
		if (parsed.type === 'pr') {
			return `PR #${parsed.number}${autoLabel}`
		}
		return `branch "${parsed.branchName}"${autoLabel}`
	}
}
