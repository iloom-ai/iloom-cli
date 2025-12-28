import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { logger } from './logger.js'

/**
 * FirstRunManager: Detect and track first-time spin usage via marker file
 *
 * Follows the same pattern as UpdateNotifier for file-based state tracking
 * in ~/.config/iloom-ai/ directory.
 *
 * Also supports project-level tracking for config wizard completion using
 * individual marker files per project in ~/.config/iloom-ai/projects/
 */
export class FirstRunManager {
	private markerFilePath: string
	private configDir: string

	constructor(feature: string = 'spin') {
		this.configDir = path.join(os.homedir(), '.config', 'iloom-ai')
		this.markerFilePath = path.join(this.configDir, `${feature}-first-run`)
		logger.debug('FirstRunManager initialized', {
			feature,
			markerFilePath: this.markerFilePath
		})
	}

	/**
	 * Get the directory for project marker files
	 */
	private getProjectsDir(): string {
		return path.join(this.configDir, 'projects')
	}

	/**
	 * Resolve symlinks in project path to get canonical path
	 * Falls back to original path on errors (broken symlinks, permissions, etc.)
	 */
	private async resolveProjectPath(projectPath: string): Promise<string> {
		try {
			return await fs.realpath(projectPath)
		} catch {
			logger.debug('resolveProjectPath: Failed to resolve symlink, using original path', { projectPath })
			return projectPath
		}
	}

	/**
	 * Convert a project path to a readable filename
	 * /Users/adam/Projects/my-app -> Users__adam__Projects__my-app
	 */
	private projectPathToFileName(projectPath: string): string {
		const normalized = path.normalize(projectPath)
		return normalized.replace(/^[/\\]+/, '').replace(/[/\\]+/g, '__')
	}

	/**
	 * Get full path to a project's marker file
	 */
	private getProjectMarkerPath(projectPath: string): string {
		return path.join(this.getProjectsDir(), this.projectPathToFileName(projectPath))
	}

	/**
	 * Extract project name from path
	 */
	private getProjectName(projectPath: string): string {
		return path.basename(projectPath)
	}

	/**
	 * Check if a project has been configured
	 * Returns true if project marker file exists
	 */
	async isProjectConfigured(projectPath?: string): Promise<boolean> {
		const inputPath = projectPath ?? process.cwd()
		const resolvedPath = await this.resolveProjectPath(inputPath)
		const markerPath = this.getProjectMarkerPath(resolvedPath)
		logger.debug('isProjectConfigured: Checking for marker file', { markerPath })
		try {
			const exists = await fs.pathExists(markerPath)
			logger.debug(`isProjectConfigured: Marker file exists=${exists}`)
			return exists
		} catch (error) {
			// On error, treat as not configured to allow wizard to run
			logger.debug(`isProjectConfigured: Error checking marker file, treating as not configured: ${error}`)
			return false
		}
	}

	/**
	 * Mark a project as configured
	 * Creates a marker file with project metadata
	 * Idempotent - skips if already configured
	 */
	async markProjectAsConfigured(projectPath?: string): Promise<void> {
		const inputPath = projectPath ?? process.cwd()
		const resolvedPath = await this.resolveProjectPath(inputPath)
		const markerPath = this.getProjectMarkerPath(resolvedPath)

		// TEMP DEBUG: Throw if this looks like a worktree (has .git file instead of directory)
		const gitPath = path.join(resolvedPath, '.git')
		try {
			const stat = await fs.stat(gitPath)
			if (stat.isFile()) {
				const content = await fs.readFile(gitPath, 'utf8')
				if (content.trim().startsWith('gitdir:')) {
					throw new Error(`🚨 TEMP DEBUG: Attempted to create marker for worktree: ${resolvedPath}`)
				}
			}
		} catch (error) {
			// Only rethrow if it's our debug error, ignore stat errors (e.g., .git doesn't exist)
			if (error instanceof Error && error.message.includes('TEMP DEBUG')) {
				throw error
			}
		}

		// Idempotency check - skip if already configured
		if (await this.isProjectConfigured(resolvedPath)) {
			logger.debug('markProjectAsConfigured: Project already configured, skipping', { markerPath })
			return
		}

		logger.debug('markProjectAsConfigured: Creating marker file', { markerPath })
		try {
			await fs.ensureDir(this.getProjectsDir())
			const markerContent = {
				configuredAt: new Date().toISOString(),
				projectPath: resolvedPath,
				projectName: this.getProjectName(resolvedPath)
			}
			await fs.writeFile(markerPath, JSON.stringify(markerContent, null, 2), 'utf8')
			logger.debug('markProjectAsConfigured: Marker file created successfully')
		} catch (error) {
			// Don't throw on errors - just log debug message
			logger.debug(`markProjectAsConfigured: Failed to create marker file: ${error}`)
		}
	}

	/**
	 * Check if this is the first run of the feature
	 * Returns true if marker file doesn't exist
	 * Handles errors gracefully by returning true (treat as first-run on error)
	 */
	async isFirstRun(): Promise<boolean> {
		logger.debug('isFirstRun: Checking for marker file', { markerFilePath: this.markerFilePath })
		try {
			const exists = await fs.pathExists(this.markerFilePath)
			logger.debug(`isFirstRun: Marker file exists=${exists}`)
			return !exists
		} catch (error) {
			// On error, gracefully degrade by treating as first-run
			logger.debug(`isFirstRun: Error checking marker file, treating as first-run: ${error}`)
			return true
		}
	}

	/**
	 * Mark the feature as having been run
	 * Creates the marker file in config directory
	 * Handles errors gracefully without throwing
	 */
	async markAsRun(): Promise<void> {
		logger.debug('markAsRun: Attempting to create marker file', { markerFilePath: this.markerFilePath })
		try {
			// Ensure directory exists
			const configDir = path.dirname(this.markerFilePath)
			logger.debug(`markAsRun: Ensuring config directory exists: ${configDir}`)
			await fs.ensureDir(configDir)

			// Write marker file with timestamp for debugging
			const markerContent = {
				firstRun: new Date().toISOString(),
			}
			await fs.writeFile(this.markerFilePath, JSON.stringify(markerContent, null, 2), 'utf8')
			logger.debug('markAsRun: Marker file created successfully')
		} catch (error) {
			// Don't throw on errors - just log debug message
			// Failing to write marker shouldn't break the workflow
			logger.debug(`markAsRun: Failed to create marker file: ${error}`)
		}
	}
}
