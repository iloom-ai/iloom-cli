import { logger } from '../utils/logger.js'
import { checkGhAuth, executeGhCommand } from '../utils/github.js'
import { executeGitCommand } from '../utils/git.js'
import { promptInput } from '../utils/prompt.js'
import { existsSync, accessSync, constants } from 'fs'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { InitCommand } from './init.js'
import chalk from 'chalk'
import { FirstRunManager } from '../utils/FirstRunManager.js'
import { TelemetryService } from '../lib/TelemetryService.js'

const DEFAULT_REPO = 'iloom-ai/iloom-cli'

// Maximum path length for most file systems
const MAX_PATH_LENGTH = 255

// Reserved names on Windows (also avoid on all platforms for portability)
const RESERVED_NAMES = [
	'CON', 'PRN', 'AUX', 'NUL',
	'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
	'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]

// Invalid characters for directory names (cross-platform)
// eslint-disable-next-line no-control-regex
const INVALID_CHARS_PATTERN = /[<>:"|?*\x00-\x1f]/


/**
 * Validation result for directory input
 */
interface DirectoryValidationResult {
	isValid: boolean
	error?: string
}

/**
 * Validate directory name format
 * @param directoryName - The directory name (not full path)
 * @returns Validation result with error message if invalid
 */
export function validateDirectoryName(directoryName: string): DirectoryValidationResult {
	// Check for empty or whitespace-only
	if (!directoryName || directoryName.trim() === '') {
		return { isValid: false, error: 'Directory name cannot be empty' }
	}

	const trimmed = directoryName.trim()
	const baseName = path.basename(trimmed)

	// Check for invalid characters
	if (INVALID_CHARS_PATTERN.test(baseName)) {
		return { isValid: false, error: 'Directory name contains invalid characters (<>:"|?*)' }
	}

	// Check for reserved names (case-insensitive)
	if (RESERVED_NAMES.includes(baseName.toUpperCase())) {
		return { isValid: false, error: `"${baseName}" is a reserved name and cannot be used` }
	}

	// Check for names that start/end with dots or spaces (problematic on some systems)
	if (baseName.startsWith('.') && baseName === '.') {
		return { isValid: false, error: 'Directory name cannot be just a dot' }
	}
	if (baseName.endsWith('.') || baseName.endsWith(' ')) {
		return { isValid: false, error: 'Directory name cannot end with a dot or space' }
	}

	return { isValid: true }
}

/**
 * Parse GitHub repository URL in multiple formats and return normalized 'owner/repo' format
 * Supported formats:
 *   - Full URL: https://github.com/owner/repo
 *   - Shortened: github.com/owner/repo
 *   - Direct: owner/repo
 * @param input - The repository URL/identifier to parse
 * @returns Normalized 'owner/repo' format
 * @throws Error if input doesn't match any supported format
 */
export function parseGitHubRepoUrl(input: string): string {
	const trimmed = input.trim()

	// Pattern 1: Full URL - https://github.com/owner/repo or http://github.com/owner/repo
	const fullUrlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
	if (fullUrlMatch) {
		return `${fullUrlMatch[1]}/${fullUrlMatch[2]}`
	}

	// Pattern 2: Shortened URL - github.com/owner/repo
	const shortUrlMatch = trimmed.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
	if (shortUrlMatch) {
		return `${shortUrlMatch[1]}/${shortUrlMatch[2]}`
	}

	// Pattern 3: Direct format - owner/repo (must have exactly one slash, no other special chars)
	const directMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/)
	if (directMatch) {
		return `${directMatch[1]}/${directMatch[2]}`
	}

	throw new Error(
		`Invalid repository format: "${input}". ` +
		`Expected formats: "owner/repo", "github.com/owner/repo", or "https://github.com/owner/repo"`
	)
}

/**
 * Validate that a GitHub repository exists
 * @param repoPath - Repository in 'owner/repo' format
 * @returns true if repository exists, false otherwise
 * @throws Error for unexpected API errors (not 404)
 */
export async function validateRepoExists(repoPath: string): Promise<boolean> {
	try {
		await executeGhCommand(['api', `repos/${repoPath}`])
		return true
	} catch (error) {
		// 404 means repo doesn't exist or user doesn't have access
		if (error instanceof Error && error.message.includes('Not Found')) {
			return false
		}
		// Re-throw unexpected errors
		throw error
	}
}

/**
 * Validate full directory path
 * @param directoryPath - The full directory path
 * @returns Validation result with error message if invalid
 */
export function validateDirectoryPath(directoryPath: string): DirectoryValidationResult {
	// First validate the directory name component
	const nameValidation = validateDirectoryName(directoryPath)
	if (!nameValidation.isValid) {
		return nameValidation
	}

	const trimmed = directoryPath.trim()
	const absolutePath = path.resolve(trimmed)

	// Check path length
	if (absolutePath.length > MAX_PATH_LENGTH) {
		return {
			isValid: false,
			error: `Path is too long (${absolutePath.length} characters). Maximum is ${MAX_PATH_LENGTH} characters.`
		}
	}

	// Check if directory already exists
	if (existsSync(absolutePath)) {
		return { isValid: false, error: `Directory already exists: ${trimmed}` }
	}

	// Check if parent directory exists
	const parentDir = path.dirname(absolutePath)
	if (!existsSync(parentDir)) {
		return { isValid: false, error: `Parent directory does not exist: ${parentDir}` }
	}

	// Check if parent directory is writable
	try {
		accessSync(parentDir, constants.W_OK)
	} catch {
		return { isValid: false, error: `Parent directory is not writable: ${parentDir}` }
	}

	return { isValid: true }
}


/**
 * ContributeCommand - Set up local development environment for contributing to iloom
 * Implements issue #220: streamlined contributor onboarding workflow
 */
export class ContributeCommand {
	constructor(_initCommand?: InitCommand) {}

	/**
	 * Main entry point for the contribute command
	 * Automates fork creation, cloning, and upstream configuration
	 * @param repository - Optional repository in various formats (owner/repo, github.com/owner/repo, or full URL)
	 */
	public async execute(repository?: string): Promise<void> {
		// Track contribute.started telemetry event
		try {
			TelemetryService.getInstance().track('contribute.started', { tracker: 'github' })
		} catch (error: unknown) {
			logger.debug(`Failed to track contribute.started telemetry: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Parse and validate repository if provided, otherwise use default
		let repoPath: string
		if (repository) {
			repoPath = parseGitHubRepoUrl(repository)
			logger.info(`Validating repository ${chalk.cyan(repoPath)}...`)
			const exists = await validateRepoExists(repoPath)
			if (!exists) {
				throw new Error(`Repository not found: ${repoPath}. Please check the repository exists and you have access.`)
			}
		} else {
			repoPath = DEFAULT_REPO
		}

		// Extract owner and repo name from path (guaranteed to be valid format after parseGitHubRepoUrl)
		const parts = repoPath.split('/')
		const owner = parts[0] as string
		const repoName = parts[1] as string
		const upstreamUrl = `https://github.com/${repoPath}.git`

		logger.info(chalk.bold(`Setting up contributor environment for ${chalk.cyan(repoPath)}...`))

		// Step 1: Verify gh CLI authenticated
		const username = await this.getAuthenticatedUsername()
		logger.success(`Authenticated as ${chalk.cyan(username)}`)

		// Step 2: Check for existing fork
		const hasFork = await this.forkExists(username, repoName)

		// Step 3: Create fork if needed
		if (!hasFork) {
			logger.info(`Creating fork of ${repoPath}...`)
			await this.createFork(repoPath)
			logger.success('Fork created successfully')
		} else {
			logger.info('Using existing fork')
		}

		// Step 4: Prompt for directory with validation and retry loop
		const directory = await this.promptForDirectory(repoName)

		// Handle cancelled input
		if (!directory) {
			logger.info('Setup cancelled by user')
			process.exit(0)
		}

		const absolutePath = path.resolve(directory)

		// Step 5: Clone repository (gh CLI handles SSH/HTTPS automatically based on git config)
		logger.info(`Cloning repository to ${directory}...`)
		await this.cloneRepository(username, repoName, directory)
		logger.success('Repository cloned successfully')

		// Step 6: Add upstream remote if it doesn't exist
		await this.addUpstreamRemote(absolutePath, upstreamUrl)

		// Step 7: Configure settings
		logger.info('Configuring iloom settings...')
		await this.configureSettings(absolutePath)
		logger.success('Settings configured')

		logger.success(chalk.bold.green('\nContributor environment setup complete!'))
		logger.info(`\nNext steps:`)
		logger.info(`  1. cd ${directory}`)
		if (repoPath === DEFAULT_REPO) {
			logger.info(`  2. pnpm install`)
			logger.info(`  3. iloom start <issue_number>`)
		} else {
			logger.info(`  2. See README.md or CONTRIBUTING.md for setup instructions`)
			logger.info(`  3. If this is not a JavaScript/TypeScript project, run:`)
			logger.info(`     iloom init "help me set up iloom for this non-javascript/typescript project"`)
		}
		logger.info(`\nHappy contributing to ${owner}/${repoName}!`)
	}

	/**
	 * Get authenticated GitHub username
	 * @throws Error if not authenticated
	 */
	private async getAuthenticatedUsername(): Promise<string> {
		const authStatus = await checkGhAuth()

		if (!authStatus.hasAuth) {
			throw new Error(
				'GitHub CLI is not authenticated. Please run: gh auth login'
			)
		}

		if (!authStatus.username) {
			// Try to fetch username from gh api if not in auth status
			try {
				const user = await executeGhCommand<{ login: string }>(['api', 'user', '--json', 'login'])
				return user.login
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(`Unable to determine GitHub username: ${message}`)
			}
		}

		return authStatus.username
	}

	/**
	 * Check if user already has a fork of the target repository
	 * @param username - GitHub username
	 * @param repoName - Repository name (e.g., 'iloom-cli' from 'iloom-ai/iloom-cli')
	 */
	private async forkExists(username: string, repoName: string): Promise<boolean> {
		try {
			await executeGhCommand(['api', `repos/${username}/${repoName}`])
			return true
		} catch (error) {
			// 404 means no fork exists
			if (error instanceof Error && error.message.includes('Not Found')) {
				return false
			}
			// Re-throw unexpected errors
			throw error
		}
	}

	/**
	 * Create a fork of the target repository without cloning
	 * @param repoPath - Full repository path (e.g., 'iloom-ai/iloom-cli')
	 */
	private async createFork(repoPath: string): Promise<void> {
		await executeGhCommand(['repo', 'fork', repoPath, '--clone=false'])
	}


	/**
	 * Clone the repository using simplified gh CLI approach
	 * @param username - GitHub username
	 * @param repoName - Repository name (e.g., 'iloom-cli')
	 * @param directory - Target directory for clone
	 */
	private async cloneRepository(
		username: string,
		repoName: string,
		directory: string
	): Promise<void> {
		const repoIdentifier = `${username}/${repoName}`
		// Always use gh repo clone - it handles SSH/HTTPS based on user's git config
		await executeGhCommand(['repo', 'clone', repoIdentifier, directory])
	}

	/**
	 * Add upstream remote if it doesn't already exist
	 * @param directory - Cloned repository directory
	 * @param upstreamUrl - URL for the upstream remote
	 */
	private async addUpstreamRemote(directory: string, upstreamUrl: string): Promise<void> {
		try {
			// Check if upstream remote exists
			await executeGitCommand(['remote', 'get-url', 'upstream'], { cwd: directory })
			logger.info('Upstream remote already configured')
		} catch {
			// Upstream doesn't exist, add it
			logger.info('Adding upstream remote...')
			await executeGitCommand(
				['remote', 'add', 'upstream', upstreamUrl],
				{ cwd: directory }
			)
			logger.success('Upstream remote configured')
		}
	}

	/**
	 * Prompt for directory with validation and retry loop
	 * @param repoName - Repository name for default directory suggestion
	 * @returns The validated directory path, or null if user cancels
	 */
	private async promptForDirectory(repoName: string): Promise<string | null> {
		const maxRetries = 3
		let attempts = 0
		const defaultDir = `./${repoName}`

		while (attempts < maxRetries) {
			const directory = await promptInput(
				'Where should the repository be cloned?',
				defaultDir
			)

			// Handle empty input (user cancelled by entering empty string after exhausting default)
			if (!directory || directory.trim() === '') {
				return null
			}

			const trimmed = directory.trim()

			// Validate the directory path
			const validation = validateDirectoryPath(trimmed)
			if (validation.isValid) {
				return trimmed
			}

			// Show error and increment attempts
			attempts++
			if (attempts < maxRetries) {
				logger.error(`${validation.error}`)
				logger.info(`Please try again (${maxRetries - attempts} attempts remaining)`)
			} else {
				logger.error(`${validation.error}`)
				logger.error('Maximum retry attempts reached')
				throw new Error(`Invalid directory after ${maxRetries} attempts: ${validation.error}`)
			}
		}

		return null
	}


	/**
	 * Configure .iloom/settings.json with upstream remote
	 */
	private async configureSettings(directory: string): Promise<void> {
		const iloomDir = path.join(directory, '.iloom')
		const settingsPath = path.join(iloomDir, 'settings.local.json')

		// Create .iloom directory
		await mkdir(iloomDir, { recursive: true })

		// Create settings.json with upstream remote configuration and github-pr mode
		const settings = {
			issueManagement: {
				github: {
					remote: 'upstream',
				},
			},
			mergeBehavior: {
				mode: 'github-draft-pr',
			},
		}

		await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')

		// Mark project as configured for il projects list and VSCode extension detection
		const firstRunManager = new FirstRunManager()
		await firstRunManager.markProjectAsConfigured(directory)
		logger.debug('Project marked as configured', { directory })
	}
}
