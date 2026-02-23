/**
 * RecapCommand - Fast read-only command for VS Code extension
 *
 * Reads ~/.config/iloom-ai/recaps/{current-loom}.json and outputs it.
 * Skips config validation for fast startup.
 * Includes filePath in output so extension can set up file watcher.
 */
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import type { RecapFile, RecapOutput } from '../mcp/recap-types.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { formatRecapMarkdown } from '../utils/recap-formatter.js'
import { findArchivedRecap } from '../utils/recap-archiver.js'

const RECAPS_DIR = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')

/**
 * Reuse MetadataManager.slugifyPath() algorithm
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

export interface RecapCommandInput {
	identifier?: string | undefined // Optional identifier (issue number, PR number, branch name)
	json?: boolean | undefined
}

export class RecapCommand {
	/**
	 * Execute the recap command
	 * Returns RecapOutput in JSON mode, void otherwise
	 */
	async execute(input: RecapCommandInput): Promise<RecapOutput | void> {
		// Resolve recap file path from identifier or fall back to cwd
		const filePath = await this.resolveRecapFilePath(input.identifier)

		// Read recap file (return empty object if not found)
		let recap: RecapFile = {}
		try {
			if (await fs.pathExists(filePath)) {
				const content = await fs.readFile(filePath, 'utf8')
				recap = JSON.parse(content) as RecapFile
			}
		} catch {
			// Graceful degradation - return empty recap on read error
			// This is intentional for fast startup
		}

		// Build output with filePath for file watching (provide defaults for optional fields)
		const goal = recap.goal ?? null
		const complexity = recap.complexity ?? null
		const entries = recap.entries ?? []
		const artifacts = recap.artifacts ?? []
		const result: RecapOutput = { filePath, goal, complexity, entries, artifacts }

		if (input.json) {
			return result
		}

		// Non-JSON mode: print markdown format (intentionally using console.log for piping/redirection)
		// eslint-disable-next-line no-console
		console.log(formatRecapMarkdown(result))
	}

	/**
	 * Resolve identifier to a full recap file path.
	 * Returns the path to the active recap file, or falls back to an archived
	 * recap when the worktree no longer exists (e.g., after cleanup --archive).
	 * Falls back to cwd when no identifier is provided (backward compatible).
	 */
	private async resolveRecapFilePath(identifier: string | undefined): Promise<string> {
		// Default: use current working directory
		if (!identifier?.trim()) {
			return path.join(RECAPS_DIR, slugifyPath(process.cwd()))
		}

		const trimmedId = identifier.trim()
		const gitWorktreeManager = new GitWorktreeManager()
		const identifierParser = new IdentifierParser(gitWorktreeManager)

		// Check for PR-specific formats: pr/123, PR-123, PR/123
		const prPattern = /^(?:pr|PR)[/-](\d+)$/
		const prMatch = trimmedId.match(prPattern)
		if (prMatch?.[1]) {
			const prNumber = parseInt(prMatch[1], 10)
			const worktree = await gitWorktreeManager.findWorktreeForPR(prNumber, '')
			if (worktree) {
				return path.join(RECAPS_DIR, slugifyPath(worktree.path))
			}
			// Try archived recap before throwing
			const archivedPath = await findArchivedRecap('pr', prNumber)
			if (archivedPath) return archivedPath
			throw new Error(`No worktree or archived recap found for PR #${prNumber}`)
		}

		// Use IdentifierParser for pattern-based detection
		try {
			const parsed = await identifierParser.parseForPatternDetection(trimmedId)

			// Find worktree based on parsed type
			if (parsed.type === 'pr' && typeof parsed.number === 'number') {
				const worktree = await gitWorktreeManager.findWorktreeForPR(parsed.number, '')
				if (worktree) {
					return path.join(RECAPS_DIR, slugifyPath(worktree.path))
				}
				// Try archived recap before throwing
				const archivedPath = await findArchivedRecap('pr', parsed.number)
				if (archivedPath) return archivedPath
				throw new Error(`No worktree or archived recap found for PR #${parsed.number}`)
			}

			if (parsed.type === 'issue' && parsed.number !== undefined) {
				const worktree = await gitWorktreeManager.findWorktreeForIssue(parsed.number)
				if (worktree) {
					return path.join(RECAPS_DIR, slugifyPath(worktree.path))
				}
				// Try archived recap before throwing
				const issueNum = typeof parsed.number === 'string' ? parseInt(parsed.number, 10) : parsed.number
				if (isNaN(issueNum)) {
					throw new Error(`No worktree found for identifier: ${identifier}`)
				}
				const archivedPath = await findArchivedRecap('issue', issueNum)
				if (archivedPath) return archivedPath
				throw new Error(`No worktree or archived recap found for issue #${parsed.number}`)
			}

			if (parsed.type === 'branch' && parsed.branchName) {
				const worktree = await gitWorktreeManager.findWorktreeForBranch(parsed.branchName)
				if (worktree) {
					return path.join(RECAPS_DIR, slugifyPath(worktree.path))
				}
				// Branch lookups cannot match archived metadata -- no fallback
				throw new Error(`No worktree found for branch: ${parsed.branchName}`)
			}
		} catch (error) {
			// Let "not found" errors from our own lookups pass through without wrapping --
			// these are valid parse results where no worktree/archive was found
			if (error instanceof Error && (
				error.message.startsWith('No worktree or archived recap found') ||
				error.message.startsWith('No worktree found for branch:')
			)) {
				throw error
			}

			// IdentifierParser throws "No worktree found for identifier: N" when no active
			// worktree exists for a numeric input. For plain numbers, still try archived recaps
			// before giving up -- this is the primary archived-lookup path.
			if (
				error instanceof Error &&
				error.message === `No worktree found for identifier: ${trimmedId}`
			) {
				const numericMatch = trimmedId.match(/^(\d+)$/)
				if (numericMatch?.[1]) {
					const num = parseInt(numericMatch[1], 10)
					// Try issue first, then PR
					const archivedIssue = await findArchivedRecap('issue', num)
					if (archivedIssue) return archivedIssue
					const archivedPr = await findArchivedRecap('pr', num)
					if (archivedPr) return archivedPr
					throw new Error(`No worktree or archived recap found for #${num}`)
				}
			}

			// Re-throw IdentifierParser errors with context
			if (error instanceof Error) {
				throw new Error(`Could not resolve identifier '${identifier}': ${error.message}`)
			}
			throw error
		}

		// Should not reach here, but provide a fallback error
		throw new Error(`Could not resolve identifier: ${identifier}`)
	}
}
