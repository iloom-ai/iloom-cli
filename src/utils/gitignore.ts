import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { getLogger } from './logger-context.js'
import { executeGitCommand, GitCommandError } from './git.js'

const WORKTREE_GITIGNORE_ENTRY = '.iloom/worktrees/'

/**
 * Ensure .iloom/worktrees/ is in the project's .gitignore
 * Idempotent: safe to call multiple times
 * Creates .gitignore if it doesn't exist
 */
export async function ensureWorktreeGitignore(projectRoot: string): Promise<void> {
	const gitignorePath = path.join(projectRoot, '.gitignore')

	let content = ''
	try {
		content = await fs.readFile(gitignorePath, 'utf-8')
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			// File doesn't exist -- will create
		} else {
			throw error
		}
	}

	// Check if entry already exists (line-by-line to avoid partial matches)
	const lines = content.split('\n')
	if (lines.some(line => line.trim() === WORKTREE_GITIGNORE_ENTRY)) {
		return
	}

	// Append entry with a section comment
	const separator = content.endsWith('\n') || content === '' ? '' : '\n'
	const newContent = content + separator + '\n# iloom worktree directory\n' + WORKTREE_GITIGNORE_ENTRY + '\n'
	await fs.writeFile(gitignorePath, newContent, 'utf-8')
	getLogger().debug(`Added ${WORKTREE_GITIGNORE_ENTRY} to .gitignore`)
}

/**
 * Resolve the absolute path to the global gitignore file.
 *
 * Queries `git config --global --type=path core.excludesFile` to find the
 * user's configured path. Falls back to the XDG default (`~/.config/git/ignore`)
 * when the config key is unset (exit code 1) or on unexpected git failures.
 *
 * Note: `--type=path` handles tilde expansion natively. The manual tilde
 * replacement below is a safety net for edge cases where git might return
 * an unexpanded path (e.g., older git versions or unusual configurations).
 */
export async function resolveGlobalGitignorePath(): Promise<string> {
	const logger = getLogger()
	const xdgDefault = path.join(os.homedir(), '.config', 'git', 'ignore')

	try {
		const result = await executeGitCommand(['config', '--global', '--type=path', 'core.excludesFile'])
		let resolvedPath = result.trim()

		// Safety net: replace leading tilde with homedir if --type=path didn't expand it
		if (resolvedPath.startsWith('~')) {
			resolvedPath = resolvedPath.replace(/^~/, os.homedir())
		}

		return resolvedPath
	} catch (error: unknown) {
		if (error instanceof GitCommandError && error.exitCode === 1) {
			// Exit code 1 means the config key is not set - use XDG default
			return xdgDefault
		}

		// Unexpected git failure - fall back to XDG default with a debug warning
		const errorMessage = error instanceof Error ? error.message : String(error)
		logger.debug(`Unexpected error resolving global gitignore path, using XDG default: ${errorMessage}`)
		return xdgDefault
	}
}

/**
 * Append missing gitignore patterns to the resolved global gitignore file.
 *
 * - Resolves the correct global gitignore path via `resolveGlobalGitignorePath()`
 * - Creates the file and parent directories if they don't exist
 * - Only appends patterns not already present (idempotent)
 * - Uses "# Added by iloom CLI" comment marker consistent with existing migrations
 */
export async function ensureGlobalGitignorePatterns(patterns: string[]): Promise<void> {
	const resolvedPath = await resolveGlobalGitignorePath()

	// Ensure parent directory exists
	await fs.ensureDir(path.dirname(resolvedPath))

	// Read existing content or empty string if file doesn't exist
	let content = ''
	try {
		content = await fs.readFile(resolvedPath, 'utf-8')
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			// File doesn't exist - will create
		} else {
			throw error
		}
	}

	// Filter to only patterns not already present
	const missingPatterns = patterns.filter(pattern => !content.includes(pattern))
	if (missingPatterns.length === 0) {
		return
	}

	// Append missing patterns with comment marker
	const separator = content.endsWith('\n') || content === '' ? '' : '\n'
	const newContent = content + separator + '\n# Added by iloom CLI\n' + missingPatterns.join('\n') + '\n'
	await fs.writeFile(resolvedPath, newContent, 'utf-8')
}
