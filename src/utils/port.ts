import { createHash } from 'crypto'
import path from 'path'
import fs from 'fs-extra'
import { parseEnvFile, extractPort, findEnvFileContainingVariable } from './env.js'
import { extractIssueNumber } from './git.js'
import { logger } from './logger.js'

/**
 * Wrap a raw port that exceeds 65535 into the valid port range.
 * Uses modulo arithmetic to wrap back into [basePort+1, 65535].
 *
 * @param rawPort - The calculated port (basePort + issueNumber)
 * @param basePort - The base port (default: 3000)
 * @returns Port in valid range [basePort+1, 65535]
 */
export function wrapPort(rawPort: number, basePort: number): number {
	if (rawPort <= 65535) return rawPort
	const range = 65535 - basePort
	return ((rawPort - basePort - 1) % range) + basePort + 1
}

/**
 * Extract numeric suffix from alphanumeric issue ID (e.g., MARK-324 -> 324)
 * @returns The numeric part or null if no trailing number found
 */
export function extractNumericSuffix(issueId: string): number | null {
	// Match trailing digits after optional separator (-, _)
	const match = issueId.match(/[-_]?(\d+)$/)
	const digits = match?.[1]
	if (digits === undefined) return null
	return parseInt(digits, 10)
}

/**
 * Generate deterministic port offset from branch name using SHA256 hash
 * Range: 1-999 (matches existing random range for branches)
 *
 * @param branchName - Branch name to generate port offset from
 * @returns Port offset in range [1, 999]
 * @throws Error if branchName is empty
 */
export function generatePortOffsetFromBranchName(branchName: string): number {
	// Validate input
	if (!branchName || branchName.trim().length === 0) {
		throw new Error('Branch name cannot be empty')
	}

	// Generate SHA256 hash of branch name (same pattern as color.ts)
	const hash = createHash('sha256').update(branchName).digest('hex')

	// Take first 8 hex characters and convert to port offset (1-999)
	const hashPrefix = hash.slice(0, 8)
	const hashAsInt = parseInt(hashPrefix, 16)
	const portOffset = (hashAsInt % 999) + 1 // +1 ensures range is 1-999, not 0-998

	return portOffset
}

/**
 * Calculate deterministic port for branch-based workspace
 *
 * @param branchName - Branch name
 * @param basePort - Base port (default: 3000)
 * @returns Port number
 * @throws Error if branchName is empty
 */
// SYNC: If this default changes, update displayDefaultsBox() in src/utils/first-run-setup.ts
export function calculatePortForBranch(branchName: string, basePort: number = 3000): number {
	const offset = generatePortOffsetFromBranchName(branchName)
	const port = basePort + offset

	// Use wrap-around for port overflow
	return wrapPort(port, basePort)
}

/**
 * Calculate port from an identifier (issue number, PR number, or string).
 * This is the single source of truth for port calculation logic.
 *
 * Algorithm:
 * 1. Numeric identifiers: basePort + number (with wrapPort for overflow)
 * 2. String numeric (e.g., "42"): parse and same as above
 * 3. Alphanumeric with suffix (e.g., "MARK-324"): extract suffix and same as above
 * 4. Pure strings without numeric suffix: hash-based calculation via calculatePortForBranch
 *
 * @param identifier - The identifier (issue number, PR number, or string)
 * @param basePort - Base port (default: 3000)
 * @returns Port number in valid range
 */
// SYNC: If this default changes, update displayDefaultsBox() in src/utils/first-run-setup.ts
export function calculatePortFromIdentifier(
	identifier: string | number,
	basePort: number = 3000
): number {
	// Handle numeric identifiers directly
	if (typeof identifier === 'number') {
		return wrapPort(basePort + identifier, basePort)
	}

	// Handle string identifiers
	// First, try to parse as pure numeric string
	const numericValue = parseInt(identifier, 10)
	if (!isNaN(numericValue) && String(numericValue) === identifier) {
		return wrapPort(basePort + numericValue, basePort)
	}

	// Try extracting numeric suffix from alphanumeric identifiers (e.g., MARK-324 -> 324)
	const numericSuffix = extractNumericSuffix(identifier)
	if (numericSuffix !== null) {
		return wrapPort(basePort + numericSuffix, basePort)
	}

	// For non-numeric strings without numeric suffix, use hash-based calculation
	return calculatePortForBranch(`issue-${identifier}`, basePort)
}

export interface GetWorkspacePortOptions {
	basePort?: number | undefined
	worktreePath: string
	worktreeBranch: string
	/** If true, check .env files for PORT override before calculating. Defaults to false. */
	checkEnvFile?: boolean
}

export interface GetWorkspacePortDependencies {
	fileExists?: (path: string) => Promise<boolean>
	readFile?: (path: string) => Promise<string>
	listWorktrees?: () => Promise<Array<{ path: string; branch: string }>>
}

/**
 * Get port for workspace - calculates based on workspace type, optionally checking .env files first.
 * Consolidates logic previously duplicated across dev-server, run, open commands.
 *
 * Priority (when checkEnvFile is true):
 * 1. Read PORT from dotenv-flow files (if present)
 * 2. Calculate from PR pattern (_pr_N suffix in directory name)
 * 3. Calculate from issue pattern (issue-N or alphanumeric like MARK-324)
 * 4. Calculate from branch name using deterministic hash
 *
 * When checkEnvFile is false (default), skips step 1 and only calculates.
 */
export async function getWorkspacePort(
	options: GetWorkspacePortOptions,
	dependencies?: GetWorkspacePortDependencies
): Promise<number> {
	const basePort = options.basePort ?? 3000
	const checkEnvFile = options.checkEnvFile ?? false

	// Only check .env files if explicitly requested
	if (checkEnvFile) {
		const deps = {
			fileExists:
				dependencies?.fileExists ?? ((p: string): Promise<boolean> => fs.pathExists(p)),
			readFile:
				dependencies?.readFile ?? ((p: string): Promise<string> => fs.readFile(p, 'utf8')),
		}

		// Try to read PORT from any dotenv-flow file (as override)
		const envFile = await findEnvFileContainingVariable(
			options.worktreePath,
			'PORT',
			async (p) => deps.fileExists(p),
			async (p, varName) => {
				const content = await deps.readFile(p)
				const envMap = parseEnvFile(content)
				return envMap.get(varName) ?? null
			}
		)

		if (envFile) {
			const envPath = path.join(options.worktreePath, envFile)
			const envContent = await deps.readFile(envPath)
			const envMap = parseEnvFile(envContent)
			const port = extractPort(envMap)

			if (port) {
				logger.debug(`Using PORT from ${envFile}: ${port}`)
				return port
			}
		}

		logger.debug('PORT not found in any dotenv-flow file, calculating from workspace identifier')
	}

	// Calculate based on workspace identifier

	// Extract identifier from worktree path/branch
	const dirName = path.basename(options.worktreePath)

	// Check for PR pattern: _pr_N
	const prPattern = /_pr_(\d+)$/
	const prMatch = dirName.match(prPattern)
	if (prMatch?.[1]) {
		const prNumber = parseInt(prMatch[1], 10)
		const port = calculatePortFromIdentifier(prNumber, basePort)
		logger.debug(`Calculated PORT for PR #${prNumber}: ${port}`)
		return port
	}

	// Check for issue pattern: issue-N or alphanumeric like MARK-324
	const issueId = extractIssueNumber(dirName) ?? extractIssueNumber(options.worktreeBranch)
	if (issueId !== null) {
		const port = calculatePortFromIdentifier(issueId, basePort)
		logger.debug(`Calculated PORT for issue ${issueId}: ${port}`)
		return port
	}

	// Branch-based workspace - use deterministic hash
	const port = calculatePortForBranch(options.worktreeBranch, basePort)
	logger.debug(`Calculated PORT for branch "${options.worktreeBranch}": ${port}`)
	return port
}
