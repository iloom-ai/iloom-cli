import fs from 'fs-extra'
import path from 'path'
import { getLogger } from './logger-context.js'

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
