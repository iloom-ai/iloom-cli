import path from 'path'
import { execa } from 'execa'
import fs from 'fs-extra'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { loadWorkspaceEnv, getDotenvFlowFiles } from '../utils/env.js'
import { extractIssueNumber } from '../utils/git.js'
import { logger } from '../utils/logger.js'
import type { GitWorktree } from '../types/worktree.js'

export interface ShellCommandInput {
	identifier?: string | undefined
}

interface ParsedShellInput {
	type: 'issue' | 'pr' | 'branch' | 'epic'
	number?: string | number
	branchName?: string
	originalInput: string
	autoDetected: boolean
}

/**
 * ShellCommand - Open interactive shell with workspace environment
 * Loads dotenv-flow files when sourceEnvOnStart is configured
 */
export class ShellCommand {
	constructor(
		private gitWorktreeManager = new GitWorktreeManager(),
		private identifierParser = new IdentifierParser(new GitWorktreeManager()),
		private settingsManager = new SettingsManager(),
		private metadataManager = new MetadataManager()
	) {}

	async execute(input: ShellCommandInput): Promise<void> {
		// 1. Parse or auto-detect identifier
		const parsed = input.identifier
			? await this.parseExplicitInput(input.identifier)
			: await this.autoDetectFromCurrentDirectory()

		logger.debug(`Parsed input: ${JSON.stringify(parsed)}`)

		// 2. Find worktree path based on identifier
		const worktree = await this.findWorktreeForIdentifier(parsed)

		logger.debug(`Found worktree at: ${worktree.path}`)

		// 3. Load settings to check sourceEnvOnStart
		const settings = await this.settingsManager.loadSettings()
		const shouldLoadEnv = settings.sourceEnvOnStart ?? false

		// 4. Build environment variables
		let envVars: Record<string, string> = { ...process.env as Record<string, string> }
		let loadedEnvFiles: string[] = []

		if (shouldLoadEnv) {
			const envResult = loadWorkspaceEnv(worktree.path)
			if (envResult.parsed) {
				envVars = { ...envVars, ...envResult.parsed }
			}
			// Determine which files were actually loaded
			loadedEnvFiles = await this.getExistingEnvFiles(worktree.path)
		}

		// 5. Set ILOOM_LOOM for PS1 customization
		const loomIdentifier = this.formatLoomIdentifier(parsed)
		envVars.ILOOM_LOOM = loomIdentifier

		// 5b. Set ILOOM_COLOR_HEX from loom metadata if available
		const metadata = await this.metadataManager.readMetadata(worktree.path)
		if (metadata?.colorHex) {
			envVars.ILOOM_COLOR_HEX = metadata.colorHex
		}

		// 6. Detect shell
		const shell = this.detectShell()

		// 7. Print summary
		this.printSummary(worktree.path, shell, loadedEnvFiles, envVars, shouldLoadEnv)

		// 8. Launch interactive shell
		await execa(shell, [], {
			cwd: worktree.path,
			env: envVars,
			stdio: 'inherit',
		})
	}

	/**
	 * Parse explicit identifier input
	 */
	private async parseExplicitInput(identifier: string): Promise<ParsedShellInput> {
		const parsed = await this.identifierParser.parseForPatternDetection(identifier)

		// Description type should never reach terminal command
		if (parsed.type === 'description') {
			throw new Error('Description input type is not supported in terminal command')
		}

		const result: ParsedShellInput = {
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
	 */
	private async autoDetectFromCurrentDirectory(): Promise<ParsedShellInput> {
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
	private async findWorktreeForIdentifier(parsed: ParsedShellInput): Promise<GitWorktree> {
		let worktree: GitWorktree | null = null

		if (parsed.type === 'issue' && parsed.number !== undefined) {
			worktree = await this.gitWorktreeManager.findWorktreeForIssue(parsed.number)
		} else if (parsed.type === 'pr' && parsed.number !== undefined) {
			const prNumber = typeof parsed.number === 'number' ? parsed.number : Number(parsed.number)
			if (isNaN(prNumber) || !isFinite(prNumber)) {
				throw new Error(`Invalid PR number: ${parsed.number}. PR numbers must be numeric.`)
			}
			worktree = await this.gitWorktreeManager.findWorktreeForPR(prNumber, '')
		} else if (parsed.type === 'branch' && parsed.branchName) {
			worktree = await this.gitWorktreeManager.findWorktreeForBranch(
				parsed.branchName
			)
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
	private formatParsedInput(parsed: ParsedShellInput): string {
		const autoLabel = parsed.autoDetected ? ' (auto-detected)' : ''

		if (parsed.type === 'issue') {
			return `issue #${parsed.number}${autoLabel}`
		}
		if (parsed.type === 'pr') {
			return `PR #${parsed.number}${autoLabel}`
		}
		return `branch "${parsed.branchName}"${autoLabel}`
	}

	/**
	 * Format loom identifier for ILOOM_LOOM env var
	 */
	private formatLoomIdentifier(parsed: ParsedShellInput): string {
		if (parsed.type === 'issue') {
			return `issue-${parsed.number}`
		}
		if (parsed.type === 'pr') {
			return `pr-${parsed.number}`
		}
		return parsed.branchName ?? parsed.originalInput
	}

	/**
	 * Detect shell based on platform and environment variables
	 */
	private detectShell(): string {
		// ILOOM_SHELL takes highest priority
		if (process.env.ILOOM_SHELL) {
			return process.env.ILOOM_SHELL
		}

		// Platform-specific detection
		if (process.platform === 'win32') {
			// Windows: prefer PowerShell, fall back to COMSPEC (cmd.exe)
			return process.env.COMSPEC ?? 'cmd.exe'
		}

		// Unix/macOS: use SHELL or fall back to /bin/bash
		return process.env.SHELL ?? '/bin/bash'
	}

	/**
	 * Get list of existing dotenv-flow files in workspace
	 */
	private async getExistingEnvFiles(workspacePath: string): Promise<string[]> {
		const files = getDotenvFlowFiles()
		const existing: string[] = []

		for (const file of files) {
			const fullPath = path.join(workspacePath, file)
			if (await fs.pathExists(fullPath)) {
				existing.push(file)
			}
		}

		return existing
	}

	/**
	 * Print summary of shell session
	 */
	private printSummary(
		workspacePath: string,
		shell: string,
		loadedEnvFiles: string[],
		envVars: Record<string, string>,
		envEnabled: boolean
	): void {
		logger.info('Opening interactive shell')
		logger.info(`  Workspace: ${workspacePath}`)
		logger.info(`  Shell: ${shell}`)

		if (envEnabled) {
			if (loadedEnvFiles.length > 0) {
				logger.info(`  Env files: ${loadedEnvFiles.join(', ')}`)
			} else {
				logger.info('  Env files: (none found)')
			}

			// Print key environment variables if present
			const keyVars = ['PORT', 'DATABASE_URL', 'NODE_ENV']
			const presentVars = keyVars.filter(v => envVars[v])
			if (presentVars.length > 0) {
				const varSummary = presentVars.map(v => {
					const value = envVars[v]
					// Truncate long values like DATABASE_URL
					const displayValue = value && value.length > 40
						? value.substring(0, 37) + '...'
						: value
					return `${v}=${displayValue}`
				}).join(', ')
				logger.info(`  Key vars: ${varSummary}`)
			}
		} else {
			logger.info('  Env loading: disabled (set sourceEnvOnStart in settings to enable)')
		}

		logger.info('')
	}
}
