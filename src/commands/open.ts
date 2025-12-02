import path from 'path'
import fs from 'fs-extra'
import { execa } from 'execa'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { DevServerManager } from '../lib/DevServerManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { openBrowser } from '../utils/browser.js'
import { parseEnvFile, extractPort } from '../utils/env.js'
import { calculatePortForBranch } from '../utils/port.js'
import { extractIssueNumber } from '../utils/git.js'
import { logger } from '../utils/logger.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import type { GitWorktree } from '../types/worktree.js'

export interface OpenCommandInput {
	identifier?: string
	args?: string[]
}

interface ParsedOpenInput {
	type: 'issue' | 'pr' | 'branch'
	number?: string | number // For issues and PRs
	branchName?: string // For branches
	originalInput: string
	autoDetected: boolean
}

/**
 * OpenCommand - Opens workspace in browser or runs CLI tool
 * Priority: Web first, CLI fallback
 */
export class OpenCommand {
	constructor(
		private gitWorktreeManager = new GitWorktreeManager(),
		private capabilityDetector = new ProjectCapabilityDetector(),
		private identifierParser = new IdentifierParser(new GitWorktreeManager()),
		private devServerManager = new DevServerManager(),
		private settingsManager = new SettingsManager()
	) {}

	async execute(input: OpenCommandInput): Promise<void> {
		// 1. Parse or auto-detect identifier
		const parsed = input.identifier
			? await this.parseExplicitInput(input.identifier)
			: await this.autoDetectFromCurrentDirectory()

		logger.debug(`Parsed input: ${JSON.stringify(parsed)}`)

		// 2. Find worktree path based on identifier
		const worktree = await this.findWorktreeForIdentifier(parsed)

		logger.info(`Found worktree at: ${worktree.path}`)

		// 3. Detect project capabilities
		const { capabilities, binEntries } =
			await this.capabilityDetector.detectCapabilities(worktree.path)

		logger.debug(`Detected capabilities: ${capabilities.join(', ')}`)

		// 4. Execute based on capabilities (web first, CLI fallback)
		if (capabilities.includes('web')) {
			await this.openWebBrowser(worktree.path)
		} else if (capabilities.includes('cli')) {
			await this.runCLITool(worktree.path, binEntries, input.args ?? [])
		} else {
			throw new Error(
				`No web or CLI capabilities detected for workspace at ${worktree.path}`
			)
		}
	}

	/**
	 * Parse explicit identifier input
	 */
	private async parseExplicitInput(identifier: string): Promise<ParsedOpenInput> {
		const parsed = await this.identifierParser.parseForPatternDetection(identifier)

		// Description type should never reach open command (converted in start)
		if (parsed.type === 'description') {
			throw new Error('Description input type is not supported in open command')
		}

		const result: ParsedOpenInput = {
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
	 * Same logic as FinishCommand.autoDetectFromCurrentDirectory()
	 */
	private async autoDetectFromCurrentDirectory(): Promise<ParsedOpenInput> {
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
	private async findWorktreeForIdentifier(parsed: ParsedOpenInput): Promise<GitWorktree> {
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
	private formatParsedInput(parsed: ParsedOpenInput): string {
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
	 * Open web browser with workspace URL
	 * Auto-starts dev server if not already running
	 */
	private async openWebBrowser(worktreePath: string): Promise<void> {
		const port = await this.getWorkspacePort(worktreePath)

		// Ensure dev server is running on the port
		const serverReady = await this.devServerManager.ensureServerRunning(
			worktreePath,
			port
		)

		if (!serverReady) {
			logger.warn(
				`Dev server failed to start on port ${port}. Opening browser anyway...`
			)
		}

		// Construct URL and open browser
		const url = `http://localhost:${port}`
		logger.info(`Opening browser: ${url}`)
		await openBrowser(url)
		logger.success('Browser opened')
	}

	/**
	 * Get port for workspace - reads from .env or calculates based on workspace type
	 */
	private async getWorkspacePort(worktreePath: string): Promise<number> {
		// Load base port from settings with CLI overrides
		const cliOverrides = extractSettingsOverrides()
		const settings = await this.settingsManager.loadSettings(undefined, cliOverrides)
		const basePort = settings.capabilities?.web?.basePort ?? 3000

		// Try to read PORT from .env file (as override)
		const envPath = path.join(worktreePath, '.env')
		if (await fs.pathExists(envPath)) {
			const envContent = await fs.readFile(envPath, 'utf8')
			const envMap = parseEnvFile(envContent)
			const port = extractPort(envMap)

			if (port) {
				logger.debug(`Using PORT from .env: ${port}`)
				return port
			}
		}

		// PORT not in .env, calculate based on workspace identifier
		logger.debug('PORT not found in .env, calculating from workspace identifier')

		// Get worktree to determine type
		const worktrees = await this.gitWorktreeManager.listWorktrees()
		const worktree = worktrees.find(wt => wt.path === worktreePath)

		if (!worktree) {
			throw new Error(`Could not find worktree for path: ${worktreePath}`)
		}

		// Extract identifier from worktree path/branch
		const dirName = path.basename(worktreePath)

		// Check for PR pattern: _pr_N
		const prPattern = /_pr_(\d+)$/
		const prMatch = dirName.match(prPattern)
		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			const port = basePort + prNumber
			logger.debug(`Calculated PORT for PR #${prNumber}: ${port}`)
			return port
		}

		// Check for issue pattern: issue-N
		const issueId = extractIssueNumber(dirName) ?? extractIssueNumber(worktree.branch)
		if (issueId !== null) {
			const issueNumber = parseInt(issueId, 10)
			if (!isNaN(issueNumber)) {
				const port = basePort + issueNumber
				logger.debug(`Calculated PORT for issue #${issueId}: ${port}`)
				return port
			}
			// For alphanumeric IDs, fall through to branch-based hash
		}

		// Branch-based workspace - use deterministic hash
		const port = calculatePortForBranch(worktree.branch, basePort)
		logger.debug(`Calculated PORT for branch "${worktree.branch}": ${port}`)
		return port
	}

	/**
	 * Run CLI tool directly from worktree bin path (NO SYMLINKS!)
	 */
	private async runCLITool(
		worktreePath: string,
		binEntries: Record<string, string>,
		args: string[]
	): Promise<void> {
		// Validate binEntries exist
		if (Object.keys(binEntries).length === 0) {
			throw new Error('No bin entries found in package.json')
		}

		// Get first bin entry (deterministic)
		const firstEntry = Object.entries(binEntries)[0]
		if (!firstEntry) {
			throw new Error('No bin entries found in package.json')
		}
		const [binName, binPath] = firstEntry
		logger.debug(`Using bin entry: ${binName} -> ${binPath}`)

		// CRITICAL: Construct absolute path (NO SYMLINKS!)
		const binFilePath = path.resolve(worktreePath, binPath)
		logger.debug(`Resolved bin file path: ${binFilePath}`)

		// Verify file exists
		if (!(await fs.pathExists(binFilePath))) {
			throw new Error(
				`CLI executable not found: ${binFilePath}\n` +
					`Make sure the project is built (run 'il start' first)`
			)
		}

		// Execute with Node.js
		logger.info(`Running CLI: node ${binFilePath} ${args.join(' ')}`)
		await execa('node', [binFilePath, ...args], {
			stdio: 'inherit', // Allow interactive CLIs (prompts, colors, etc.)
			cwd: worktreePath, // Execute in worktree context
			env: process.env, // Inherit environment
		})
	}
}
