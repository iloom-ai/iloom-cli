/**
 * RecapArchiver - Archive recap files during cleanup/finish operations
 *
 * Follows the MetadataManager.archiveMetadata() pattern:
 * - Move recap file to archived/ subdirectory
 * - Add archivedAt timestamp
 * - Idempotent: silently succeeds if file doesn't exist
 * - Non-fatal: logs warning on errors but doesn't throw
 */
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { getLogger } from './logger-context.js'
import type { RecapFile } from '../mcp/recap-types.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { findMainWorktreePathWithSettings } from './git.js'

const RECAPS_DIR = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')
const ARCHIVED_DIR = path.join(RECAPS_DIR, 'archived')

/**
 * Convert worktree path to filename slug
 * Uses the same algorithm as MetadataManager.slugifyPath() and RecapCommand
 *
 * Algorithm:
 * 1. Trim trailing slashes
 * 2. Replace all path separators (/ or \) with ___ (triple underscore)
 * 3. Replace any other non-alphanumeric characters (except _ and -) with -
 * 4. Append .json
 */
function slugifyPath(loomPath: string): string {
	let slug = loomPath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

/**
 * Archive recap file for a finished/cleaned up worktree
 *
 * Moves the recap file to the archived/ subdirectory and adds
 * an archivedAt timestamp field.
 *
 * Idempotent: silently succeeds if source file doesn't exist
 * Throws on errors: caller (ResourceCleanup.ts) handles errors as non-fatal
 *
 * @param worktreePath - Absolute path to the worktree
 */
export async function archiveRecap(worktreePath: string): Promise<void> {
	const filename = slugifyPath(worktreePath)
	const sourcePath = path.join(RECAPS_DIR, filename)

	// Check if source file exists - silently return if not (idempotent)
	if (!(await fs.pathExists(sourcePath))) {
		getLogger().debug(`No recap file to archive for worktree: ${worktreePath}`)
		return
	}

	// Read existing recap content
	const content = await fs.readFile(sourcePath, 'utf8')
	const data: RecapFile = JSON.parse(content)

	// Add archived timestamp
	const archivedData = {
		...data,
		archivedAt: new Date().toISOString(),
	}

	// Ensure archived directory exists
	await fs.ensureDir(ARCHIVED_DIR, { mode: 0o755 })

	// Write to archived subdirectory
	const destPath = path.join(ARCHIVED_DIR, filename)
	await fs.writeFile(destPath, JSON.stringify(archivedData, null, 2), { mode: 0o644 })

	// Delete original file
	await fs.unlink(sourcePath)

	getLogger().debug(`Recap archived for worktree: ${worktreePath}`)
}

/**
 * Find an archived recap file by issue or PR number.
 * Uses finished metadata to filter by project and derive the recap filename.
 *
 * Approach:
 * 1. Get current project's main worktree path via findMainWorktreePathWithSettings()
 * 2. List all finished metadata via MetadataManager.listFinishedMetadata()
 * 3. Filter by projectPath matching current project
 * 4. Filter by issue_numbers or pr_numbers containing the target number
 * 5. From matching metadata, get worktreePath and derive archived recap filename
 * 6. Check if that file exists in ARCHIVED_DIR
 * 7. Return the path if found, null otherwise
 */
export async function findArchivedRecap(
	type: 'issue' | 'pr',
	number: number
): Promise<string | null> {
	try {
		const currentProjectPath = await findMainWorktreePathWithSettings()

		const metadataManager = new MetadataManager()
		const finishedLooms = await metadataManager.listFinishedMetadata()

		const numberStr = String(number)
		const match = finishedLooms.find(loom => {
			// Skip legacy metadata without projectPath
			if (!loom.projectPath || loom.projectPath !== currentProjectPath) return false
			// Must have worktreePath to derive filename
			if (!loom.worktreePath) return false
			// Match by issue or PR number
			if (type === 'issue') return loom.issue_numbers?.includes(numberStr) ?? false
			if (type === 'pr') return loom.pr_numbers?.includes(numberStr) ?? false
			return false
		})

		if (!match?.worktreePath) return null

		const archivedPath = path.join(ARCHIVED_DIR, slugifyPath(match.worktreePath))
		if (await fs.pathExists(archivedPath)) {
			return archivedPath
		}

		return null
	} catch (error) {
		getLogger().debug(`Failed to find archived recap: ${error instanceof Error ? error.message : String(error)}`)
		return null
	}
}

// Export for testing
export { RECAPS_DIR, ARCHIVED_DIR, slugifyPath }
