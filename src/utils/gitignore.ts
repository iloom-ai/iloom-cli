import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { getLogger } from './logger-context.js'
import { executeGitCommand, GitCommandError } from './git.js'

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

/**
 * Remove a specific pattern from the global gitignore file.
 *
 * - Resolves the correct global gitignore path via `resolveGlobalGitignorePath()`
 * - Removes the line matching the pattern exactly (after trimming)
 * - Also removes the "# Added by iloom CLI" comment line immediately before it,
 *   if that comment is only associated with the removed pattern
 * - No-op if the file doesn't exist or the pattern is not present
 */
export async function removeGlobalGitignorePattern(pattern: string): Promise<void> {
	const resolvedPath = await resolveGlobalGitignorePath()

	let content: string
	try {
		content = await fs.readFile(resolvedPath, 'utf-8')
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			return // File doesn't exist - nothing to remove
		}
		throw error
	}

	const lines = content.split('\n')
	const patternIndex = lines.findIndex(line => line.trim() === pattern)
	if (patternIndex === -1) {
		return // Pattern not present
	}

	// Remove the pattern line
	const indicesToRemove = new Set<number>([patternIndex])

	// Check if the line immediately before is the "# Added by iloom CLI" comment
	// and if removing the pattern would leave that comment orphaned (i.e., the comment
	// is not followed by any other non-empty pattern lines besides the one being removed)
	const prevLine = patternIndex > 0 ? lines[patternIndex - 1] : undefined
	if (prevLine !== undefined && prevLine.trim() === '# Added by iloom CLI') {
		const commentIndex = patternIndex - 1
		// Check if any other non-empty, non-comment lines follow the comment
		// (besides the line we're removing)
		let hasOtherPatterns = false
		for (let i = commentIndex + 1; i < lines.length; i++) {
			if (indicesToRemove.has(i)) continue
			const line = lines[i]
			if (line === undefined) break
			const trimmed = line.trim()
			if (trimmed === '' || trimmed.startsWith('#')) break // End of this block
			hasOtherPatterns = true
			break
		}
		if (!hasOtherPatterns) {
			indicesToRemove.add(commentIndex)
			// Also remove the blank line before the comment if it exists
			const lineBeforeComment = commentIndex > 0 ? lines[commentIndex - 1] : undefined
			if (lineBeforeComment !== undefined && lineBeforeComment.trim() === '') {
				indicesToRemove.add(commentIndex - 1)
			}
		}
	}

	const newLines = lines.filter((_, i) => !indicesToRemove.has(i))
	const newContent = newLines.join('\n')

	if (newContent !== content) {
		await fs.writeFile(resolvedPath, newContent, 'utf-8')
	}
}
