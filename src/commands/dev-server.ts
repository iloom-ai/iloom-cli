import path from 'path'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { DevServerManager } from '../lib/DevServerManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { loadWorkspaceEnv, isNoEnvFilesFoundError } from '../utils/env.js'
import { getWorkspacePort } from '../utils/port.js'
import { extractIssueNumber } from '../utils/git.js'
import { logger } from '../utils/logger.js'
import { extractSettingsOverrides } from '../utils/cli-overrides.js'
import type { GitWorktree } from '../types/worktree.js'

export interface DevServerCommandInput {
	identifier?: string | undefined
	json?: boolean | undefined
}

export interface DevServerResult {
	status: 'started' | 'already_running' | 'no_web_capability'
	url?: string
	port?: number
	pid?: number
	message: string
}

interface ParsedDevServerInput {
	type: 'issue' | 'pr' | 'branch'
	number?: string | number
	branchName?: string
	originalInput: string
	autoDetected: boolean
}

/**
 * DevServerCommand - Start dev server for workspace in foreground mode
 * Runs in foreground (blocking terminal until user stops it)
 */
export class DevServerCommand {
	constructor(
		private gitWorktreeManager = new GitWorktreeManager(),
		private capabilityDetector = new ProjectCapabilityDetector(),
		private identifierParser = new IdentifierParser(new GitWorktreeManager()),
		private devServerManager = new DevServerManager(),
		private settingsManager = new SettingsManager(),
		private metadataManager = new MetadataManager()
	) {}

	/**
	 * Output JSON to stdout (used for --json flag)
	 */
	private outputJson(data: DevServerResult | Record<string, unknown>): void {
		process.stdout.write(JSON.stringify(data, null, 2) + '\n')
	}

	async execute(input: DevServerCommandInput): Promise<DevServerResult> {
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

		// Build environment variables
		let envOverrides: Record<string, string> = {}

		if (shouldLoadEnv) {
			const envResult = loadWorkspaceEnv(worktree.path)
			if (envResult.parsed) {
				envOverrides = envResult.parsed
			}
			if (envResult.error && !isNoEnvFilesFoundError(envResult.error)) {
				logger.warn(`Failed to load env files: ${envResult.error.message}`)
			}
		}

		// 3b. Set ILOOM_LOOM for loom identification
		envOverrides.ILOOM_LOOM = this.formatLoomIdentifier(parsed)

		// 3c. Set ILOOM_COLOR_HEX from loom metadata if available
		const metadata = await this.metadataManager.readMetadata(worktree.path)
		if (metadata?.colorHex) {
			envOverrides.ILOOM_COLOR_HEX = metadata.colorHex
		}

		// 4. Detect project capabilities
		const { capabilities } =
			await this.capabilityDetector.detectCapabilities(worktree.path)

		logger.debug(`Detected capabilities: ${capabilities.join(', ')}`)

		// 4. If no web capability, return gracefully with info message
		if (!capabilities.includes('web')) {
			const message = 'No web capability detected in this workspace. Dev server not started.'
			if (input.json) {
				this.outputJson({
					status: 'no_web_capability',
					message,
				})
			} else {
				logger.info(message)
			}
			return {
				status: 'no_web_capability',
				message,
			}
		}

		// 5. Get port for workspace
		const cliOverrides = extractSettingsOverrides()
		const settingsForPort = await this.settingsManager.loadSettings(undefined, cliOverrides)
		const port = await getWorkspacePort({
			worktreePath: worktree.path,
			worktreeBranch: worktree.branch,
			basePort: settingsForPort.capabilities?.web?.basePort,
			checkEnvFile: true,
		})
		const url = `http://localhost:${port}`

		// 6. Check if server already running
		const isRunning = await this.devServerManager.isServerRunning(port)

		if (isRunning) {
			const message = `Dev server already running at ${url}`
			if (input.json) {
				this.outputJson({
					status: 'already_running',
					url,
					port,
					message,
				})
			} else {
				logger.info(message)
			}
			return {
				status: 'already_running',
				url,
				port,
				message,
			}
		}

		// 7. Start server in foreground
		const message = `Starting dev server at ${url}`
		if (!input.json) {
			logger.info(message)
		}

		let finalResult: DevServerResult = {
			status: 'started',
			url,
			port,
			message,
		}

		// This will block until user stops the server (Ctrl+C)
		// In JSON mode, redirect npm output to stderr so JSON can go to stdout
		const processInfo = await this.devServerManager.runServerForeground(
			worktree.path,
			port,
			!!input.json,
			// Callback called immediately when process starts (for JSON output)
			(pid) => {
				if (input.json && pid) {
					finalResult.pid = pid
					this.outputJson(finalResult)
				}
			},
			envOverrides
		)

		if (processInfo.pid) {
			finalResult.pid = processInfo.pid
		}

		return finalResult
	}

	/**
	 * Parse explicit identifier input
	 */
	private async parseExplicitInput(identifier: string): Promise<ParsedDevServerInput> {
		const parsed = await this.identifierParser.parseForPatternDetection(identifier)

		// Description type should never reach dev-server command
		if (parsed.type === 'description') {
			throw new Error('Description input type is not supported in dev-server command')
		}

		const result: ParsedDevServerInput = {
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
	private async autoDetectFromCurrentDirectory(): Promise<ParsedDevServerInput> {
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
	private async findWorktreeForIdentifier(parsed: ParsedDevServerInput): Promise<GitWorktree> {
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
	private formatParsedInput(parsed: ParsedDevServerInput): string {
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
	private formatLoomIdentifier(parsed: ParsedDevServerInput): string {
		return parsed.originalInput
	}
}
