import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import { execa, type ExecaError } from 'execa'
import { logger } from '../utils/logger.js'
import { promptConfirmation, isInteractiveEnvironment } from '../utils/prompt.js'
import type { SwarmSettings } from './SettingsManager.js'

/**
 * Error class for Beads CLI failures
 * Preserves exit code and stderr for precise error handling
 */
export class BeadsError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number | undefined,
		public readonly stderr: string,
	) {
		super(message)
		this.name = 'BeadsError'
	}
}

/**
 * Represents a task in the Beads DAG
 */
export interface BeadsTask {
	id: string
	title: string
	status: string
	priority?: number
	blockers?: string[]
}

/**
 * Options for creating a Beads task
 */
export interface BeadsCreateOptions {
	priority?: number
	id?: string
}

/**
 * Manages Beads CLI integration for swarm mode DAG operations.
 *
 * Beads provides dependency-aware task resolution and atomic claiming
 * via SQLite WAL. State is stored outside the git repo to avoid pollution.
 *
 * All `bd` invocations set BEADS_DIR and BEADS_NO_DAEMON=1 in the environment.
 */
export class BeadsManager {
	private readonly beadsDir: string
	// TODO(security): This install script is fetched from an unpinned `main` branch via curl|bash.
	// There is no integrity verification (e.g., checksum or GPG signature). Pin to a specific
	// release tag or commit SHA when one becomes available to mitigate supply-chain risk.
	private readonly installScript = 'https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh'

	constructor(
		private readonly projectPath: string,
		swarmSettings?: Partial<SwarmSettings>,
	) {
		const baseDir = swarmSettings?.beadsDir ?? '~/.config/iloom-ai/beads'
		const resolvedBaseDir = baseDir.startsWith('~')
			? path.join(os.homedir(), baseDir.slice(1))
			: baseDir
		const projectHash = this.computeProjectHash(projectPath)
		this.beadsDir = path.join(resolvedBaseDir, projectHash)
	}

	/**
	 * Get the resolved BEADS_DIR path for this project
	 */
	getBeadsDir(): string {
		return this.beadsDir
	}

	/**
	 * Check if Beads CLI (bd) is installed and available on PATH
	 */
	async isInstalled(): Promise<boolean> {
		try {
			await execa('command', ['-v', 'bd'], {
				shell: true,
				timeout: 5000,
			})
			return true
		} catch {
			return false
		}
	}

	/**
	 * Ensure Beads CLI is installed.
	 *
	 * Detection and install logic:
	 * - If already installed, returns immediately
	 * - Interactive TTY: prompts user for confirmation
	 * - Non-interactive (no TTY or CI): auto-installs silently
	 * - autoInstall setting: auto-installs without prompting
	 *
	 * @param autoInstall - Whether to auto-install without prompting (from settings)
	 * @throws BeadsError if installation fails
	 */
	async ensureInstalled(autoInstall = false): Promise<void> {
		if (await this.isInstalled()) {
			logger.debug('Beads CLI (bd) already installed')
			return
		}

		logger.debug('Beads CLI (bd) not found on PATH')

		// Determine whether to prompt or auto-install
		if (!autoInstall && isInteractiveEnvironment()) {
			const shouldInstall = await promptConfirmation(
				'Swarm mode requires Beads. Install now?',
				true,
			)
			if (!shouldInstall) {
				throw new BeadsError(
					'Beads CLI is required for swarm mode. Install it manually or enable autoInstallBeads in settings.',
					undefined,
					'User declined installation',
				)
			}
		} else if (!autoInstall && !isInteractiveEnvironment()) {
			throw new BeadsError(
				'Beads CLI is required for swarm mode but is not installed. Install it manually or set autoInstallBeads: true in settings.',
				undefined,
				'Non-interactive environment requires autoInstallBeads or manual installation',
			)
		}

		logger.info('Installing Beads CLI...')
		await this.runInstallScript()

		// Append common install locations to PATH so isInstalled() can find the
		// newly installed binary without requiring a shell restart.
		const homeDir = os.homedir()
		const candidatePaths = [
			path.join(homeDir, '.local', 'bin'),
			path.join(homeDir, '.cargo', 'bin'),
			'/usr/local/bin',
		]
		const currentPath = process.env.PATH ?? ''
		const newPaths = candidatePaths.filter(p => !currentPath.split(path.delimiter).includes(p))
		if (newPaths.length > 0) {
			process.env.PATH = `${currentPath}${path.delimiter}${newPaths.join(path.delimiter)}`
		}

		// Verify installation succeeded
		if (!(await this.isInstalled())) {
			throw new BeadsError(
				'Beads CLI installation completed but bd is not available on PATH. Check your shell PATH configuration.',
				undefined,
				'Post-install verification failed',
			)
		}

		logger.info('Beads CLI installed successfully')
	}

	/**
	 * Initialize Beads for this project.
	 * Idempotent - safe to re-run. If the database already exists,
	 * the "already initialized" error is caught and treated as success.
	 *
	 * @throws BeadsError if init fails for reasons other than already being initialized
	 */
	async init(): Promise<void> {
		logger.debug('Initializing Beads', { beadsDir: this.beadsDir, projectPath: this.projectPath })

		try {
			await this.execBd([
				'init',
				'--quiet',
				'--skip-hooks',
				'--skip-merge-driver',
			], { cwd: this.projectPath })
		} catch (error) {
			if (error instanceof BeadsError && error.stderr.includes('already initialized')) {
				logger.debug('Beads already initialized, skipping')
				return
			}
			throw error
		}

		logger.debug('Beads initialized successfully')
	}

	/**
	 * Create a new task in the Beads DAG
	 *
	 * @param title - Task title/description
	 * @param options - Optional creation options (priority, custom id)
	 * @returns The created task ID
	 * @throws BeadsError if creation fails
	 */
	async create(title: string, options?: BeadsCreateOptions): Promise<string> {
		const args = ['create', title]

		if (options?.id) {
			args.push('--id', options.id)
		}

		if (options?.priority !== undefined) {
			args.push('--priority', String(options.priority))
		}

		const result = await this.execBd(args)
		// bd create outputs the task ID
		return result.stdout.trim()
	}

	/**
	 * Add a blocking dependency between tasks.
	 * The parent task must be completed before the child can start.
	 *
	 * @param child - Task ID that is blocked
	 * @param parent - Task ID that blocks
	 * @throws BeadsError if dependency creation fails
	 */
	async addDependency(child: string, parent: string): Promise<void> {
		await this.execBd(['dep', 'add', child, parent])
	}

	/**
	 * List tasks with no open blockers (ready to be worked on).
	 * Returns parsed JSON array of ready tasks.
	 *
	 * @returns Array of tasks ready for claiming
	 * @throws BeadsError if the command fails
	 */
	async ready(): Promise<BeadsTask[]> {
		const result = await this.execBd(['ready', '--json'])
		try {
			return JSON.parse(result.stdout) as BeadsTask[]
		} catch (error) {
			throw new BeadsError(
				`Failed to parse bd ready output as JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
				undefined,
				`stdout: ${result.stdout}`,
			)
		}
	}

	/**
	 * Atomically claim a task for processing.
	 * Uses SQLite WAL for atomic claiming to prevent race conditions.
	 *
	 * @param taskId - Task ID to claim
	 * @throws BeadsError if claiming fails (e.g., already claimed)
	 */
	async claim(taskId: string): Promise<void> {
		await this.execBd(['update', '--claim', taskId])
	}

	/**
	 * Mark a task as complete.
	 *
	 * @param taskId - Task ID to close
	 * @param reason - Optional reason for closing
	 * @throws BeadsError if close fails
	 */
	async close(taskId: string, reason?: string): Promise<void> {
		const args = ['close', taskId]
		if (reason) {
			args.push('--reason', reason)
		}
		await this.execBd(args)
	}

	/**
	 * Release a claimed task (for failure recovery).
	 * Returns the task to ready state if it has no open blockers.
	 *
	 * @param taskId - Task ID to release
	 * @throws BeadsError if release fails
	 */
	async releaseClaim(taskId: string): Promise<void> {
		await this.execBd(['update', '--release', taskId])
	}

	/**
	 * List all tasks in the Beads DAG regardless of status.
	 * Returns parsed JSON array of all tasks.
	 *
	 * @returns Array of all tasks
	 * @throws BeadsError if the command fails
	 */
	async list(): Promise<BeadsTask[]> {
		const result = await this.execBd(['list', '--json'])
		try {
			return JSON.parse(result.stdout) as BeadsTask[]
		} catch (error) {
			throw new BeadsError(
				`Failed to parse bd list output as JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
				undefined,
				`stdout: ${result.stdout}`,
			)
		}
	}

	/**
	 * Execute a bd CLI command with proper environment variables set.
	 * All bd commands must have BEADS_DIR and BEADS_NO_DAEMON=1.
	 */
	private async execBd(
		args: string[],
		options?: { cwd?: string },
	): Promise<{ stdout: string; stderr: string }> {
		// Only pass necessary environment variables to the bd subprocess to
		// avoid leaking secrets (e.g., API keys, tokens) from the parent process.
		const allowedKeys = ['PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'LANG', 'LC_ALL']
		const filteredEnv: Record<string, string> = {}
		for (const key of allowedKeys) {
			if (process.env[key] !== undefined) {
				filteredEnv[key] = process.env[key] as string
			}
		}
		// Include any BD_* or BEADS_* prefixed vars that bd may need
		for (const [key, value] of Object.entries(process.env)) {
			if ((key.startsWith('BD_') || key.startsWith('BEADS_')) && value !== undefined) {
				filteredEnv[key] = value
			}
		}
		const env = {
			...filteredEnv,
			BEADS_DIR: this.beadsDir,
			BEADS_NO_DAEMON: '1',
		}

		try {
			const result = await execa('bd', args, {
				cwd: options?.cwd ?? this.projectPath,
				timeout: 30000,
				encoding: 'utf8',
				env,
				extendEnv: false,
			})
			return { stdout: result.stdout, stderr: result.stderr }
		} catch (error) {
			const execaError = error as ExecaError
			const stderr = execaError.stderr ?? execaError.message ?? 'Unknown Beads error'
			throw new BeadsError(
				`Beads command failed: bd ${args.join(' ')}: ${stderr}`,
				execaError.exitCode,
				stderr,
			)
		}
	}

	/**
	 * Run the Beads install script
	 */
	private async runInstallScript(): Promise<void> {
		try {
			await execa('bash', ['-c', `curl -fsSL ${this.installScript} | bash`], {
				timeout: 120000,
				encoding: 'utf8',
				stdio: 'inherit',
			})
		} catch (error) {
			const execaError = error as ExecaError
			const stderr = execaError.stderr ?? execaError.message ?? 'Unknown error'
			throw new BeadsError(
				`Failed to install Beads CLI: ${stderr}`,
				execaError.exitCode,
				stderr,
			)
		}
	}

	/**
	 * Compute a stable hash from the project path to avoid collisions
	 * between different projects using the same beads base directory.
	 */
	private computeProjectHash(projectPath: string): string {
		return createHash('sha256').update(projectPath).digest('hex').slice(0, 12)
	}
}
