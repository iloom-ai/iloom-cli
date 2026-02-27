import lockfile from 'proper-lockfile'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { getLogger } from './logger-context.js'

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json')

const LOCK_OPTIONS: lockfile.LockOptions = {
	retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
	realpath: false, // ~/.claude.json may not exist yet; realpath would fail
}

/**
 * Pre-accept Claude Code trust for a worktree path by writing to ~/.claude.json.
 *
 * Sets `projects.<worktreePath>.hasTrustDialogAccepted = true` so that Claude Code
 * does not show the trust dialog when launching inside the worktree.
 *
 * Uses `proper-lockfile` to safely participate in Claude Code's own concurrency
 * protocol for ~/.claude.json writes.
 *
 * Throws on failure - callers should handle errors appropriately.
 */
export async function preAcceptClaudeTrust(worktreePath: string): Promise<void> {
	await modifyClaudeConfig((config) => {
		if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) {
			config.projects = {}
		}
		const projects = config.projects as Record<string, Record<string, unknown>>
		if (!projects[worktreePath] || typeof projects[worktreePath] !== 'object') {
			projects[worktreePath] = {}
		}
		const entry = projects[worktreePath]
		if (entry) {
			entry.hasTrustDialogAccepted = true
		}
	})
}

/**
 * Remove the Claude Code trust entry for a worktree path from ~/.claude.json.
 *
 * Called during worktree cleanup to prevent ~/.claude.json from accumulating
 * stale entries.
 *
 * Throws on failure - callers should handle errors appropriately.
 */
export async function removeClaudeTrust(worktreePath: string): Promise<void> {
	await modifyClaudeConfig((config) => {
		if (!config.projects || typeof config.projects !== 'object') {
			return
		}
		const projects = config.projects as Record<string, unknown>
		delete projects[worktreePath]
	})
}

/**
 * Shared helper that implements Claude Code's concurrency protocol:
 * 1. Ensure the config file exists (create empty JSON if missing)
 * 2. Acquire lock with proper-lockfile (with retries)
 * 3. Re-read file under lock (not from cache)
 * 4. Apply modifier function
 * 5. Atomic write: write to temp file, rename to target, mode 0o600
 * 6. Release lock
 *
 * Falls back to direct write if lock acquisition fails.
 */
async function modifyClaudeConfig(
	modifier: (config: Record<string, unknown>) => void
): Promise<void> {
	const logger = getLogger()

	// Ensure the file exists before locking (proper-lockfile requires the file to exist)
	await ensureClaudeConfigExists()

	let release: (() => Promise<void>) | null = null
	let lockAcquired = false

	try {
		release = await lockfile.lock(CLAUDE_CONFIG_PATH, LOCK_OPTIONS)
		lockAcquired = true
	} catch (lockError: unknown) {
		logger.warn(
			`Could not acquire lock on ${CLAUDE_CONFIG_PATH}, falling back to direct write: ${lockError instanceof Error ? lockError.message : String(lockError)}`
		)
	}

	try {
		// Re-read under lock (or without lock in fallback mode)
		const config = await readClaudeConfig()

		// Apply modification
		modifier(config)

		// Atomic write: temp file + rename, mode 0o600
		await atomicWriteClaudeConfig(config)
	} finally {
		if (lockAcquired && release) {
			try {
				await release()
			} catch (unlockError: unknown) {
				logger.debug(
					`Failed to release lock on ${CLAUDE_CONFIG_PATH}: ${unlockError instanceof Error ? unlockError.message : String(unlockError)}`
				)
			}
		}
	}
}

/**
 * Ensure ~/.claude.json exists. Creates an empty JSON object if missing.
 */
async function ensureClaudeConfigExists(): Promise<void> {
	try {
		await fs.access(CLAUDE_CONFIG_PATH)
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			// File doesn't exist - create with empty object and restricted permissions
			await fs.writeFile(CLAUDE_CONFIG_PATH, '{}', { encoding: 'utf-8', mode: 0o600 })
		} else {
			throw error
		}
	}
}

/**
 * Read and parse ~/.claude.json. Returns empty object for missing files or malformed JSON.
 * Re-throws other errors (e.g., permission denied).
 */
async function readClaudeConfig(): Promise<Record<string, unknown>> {
	const logger = getLogger()
	let content: string
	try {
		content = await fs.readFile(CLAUDE_CONFIG_PATH, 'utf-8')
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return {}
		}
		throw error
	}
	try {
		const parsed: unknown = JSON.parse(content)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		return {}
	} catch (error: unknown) {
		if (error instanceof SyntaxError) {
			logger.warn(`Malformed JSON in ${CLAUDE_CONFIG_PATH}, treating as empty config`)
			return {}
		}
		throw error
	}
}

/**
 * Atomically write config to ~/.claude.json via temp file + rename.
 * Sets file mode to 0o600 (owner read/write only).
 */
async function atomicWriteClaudeConfig(config: Record<string, unknown>): Promise<void> {
	const tmpPath = `${CLAUDE_CONFIG_PATH}.${crypto.randomUUID()}.tmp`
	const content = JSON.stringify(config, null, 2) + '\n'

	await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 })
	await fs.rename(tmpPath, CLAUDE_CONFIG_PATH)
}

// Exported for testing only
export const _internal = {
	CLAUDE_CONFIG_PATH,
	modifyClaudeConfig,
	ensureClaudeConfigExists,
	readClaudeConfig,
	atomicWriteClaudeConfig,
}
