import { execa } from 'execa'
import type { IloomSettings } from '../lib/SettingsManager.js'
import logger from './logger.js'

/**
 * Represents a parsed git remote
 */
export interface GitRemote {
	name: string
	url: string
	owner: string
	repo: string
}

/**
 * Parse git remotes from `git remote -v` output
 * Deduplicates fetch/push entries and extracts owner/repo from URLs
 */
export async function parseGitRemotes(cwd?: string): Promise<GitRemote[]> {
	const result = await execa('git', ['remote', '-v'], {
		cwd: cwd ?? process.cwd(),
		encoding: 'utf8',
	})

	const lines = result.stdout.trim().split('\n')
	const remoteMap = new Map<string, GitRemote>()

	for (const line of lines) {
		// Format: "origin  git@github.com:owner/repo.git (fetch)"
		// Format: "origin  https://github.com/owner/repo.git (fetch)"
		const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/)
		if (!match) continue

		const name = match[1]
		const url = match[2]
		if (!name || !url) continue

		// Skip if we already processed this remote
		if (remoteMap.has(name)) continue

		// Extract owner/repo from URL
		const ownerRepo = extractOwnerRepoFromUrl(url)
		if (!ownerRepo) continue

		remoteMap.set(name, {
			name,
			url,
			owner: ownerRepo.owner,
			repo: ownerRepo.repo,
		})
	}

	return Array.from(remoteMap.values())
}

/**
 * Extract owner and repo from Git remote URL
 * Supports both HTTPS and SSH formats for GitHub and BitBucket
 */
function extractOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
	// Remove .git suffix if present
	const cleanUrl = url.replace(/\.git$/, '')

	// GitHub HTTPS format: https://github.com/owner/repo
	const githubHttpsMatch = cleanUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+)/)
	if (githubHttpsMatch?.[1] && githubHttpsMatch?.[2]) {
		return { owner: githubHttpsMatch[1], repo: githubHttpsMatch[2] }
	}

	// GitHub SSH format: git@github.com:owner/repo
	const githubSshMatch = cleanUrl.match(/git@github\.com:([^/]+)\/(.+)/)
	if (githubSshMatch?.[1] && githubSshMatch?.[2]) {
		return { owner: githubSshMatch[1], repo: githubSshMatch[2] }
	}

	// BitBucket HTTPS format: https://bitbucket.org/workspace/repo
	const bitbucketHttpsMatch = cleanUrl.match(/https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+)/)
	if (bitbucketHttpsMatch?.[1] && bitbucketHttpsMatch?.[2]) {
		return { owner: bitbucketHttpsMatch[1], repo: bitbucketHttpsMatch[2] }
	}

	// BitBucket SSH format: git@bitbucket.org:workspace/repo
	const bitbucketSshMatch = cleanUrl.match(/git@bitbucket\.org:([^/]+)\/(.+)/)
	if (bitbucketSshMatch?.[1] && bitbucketSshMatch?.[2]) {
		return { owner: bitbucketSshMatch[1], repo: bitbucketSshMatch[2] }
	}

	return null
}

/**
 * Check if repository has multiple remotes
 */
export async function hasMultipleRemotes(cwd?: string): Promise<boolean> {
	try {
		const remotes = await parseGitRemotes(cwd)
		return remotes.length > 1
	} catch (error) {
		// if error is "not a git repository" then just log a debug message, otherwise log a warning message
		const errMsg = error instanceof Error ? error.message : String(error)
		if (/not a git repository/i.test(errMsg)) {
			logger.debug('Skipping git remote check: not a git repository')
		} else {
			logger.warn(`Unable to check git remotes: ${errMsg}`)
		}
		return false
	}
}

/**
 * Get configured repository string from settings
 * Returns "owner/repo" format for use with gh CLI --repo flag
 * Throws if configured remote not found
 */
export async function getConfiguredRepoFromSettings(
	settings: IloomSettings,
	cwd?: string,
): Promise<string> {
	const remoteName = settings.issueManagement?.github?.remote

	if (!remoteName) {
		throw new Error(
			'GitHub remote not configured. Run "il init" to configure which repository to use for GitHub operations.',
		)
	}

	// Validate configured remote exists
	await validateConfiguredRemote(remoteName, cwd)

	// Parse remotes and find the configured one
	const remotes = await parseGitRemotes(cwd)
	const remote = remotes.find((r) => r.name === remoteName)

	if (!remote) {
		throw new Error(
			`Configured remote "${remoteName}" not found in git remotes. Run "il init" to reconfigure.`,
		)
	}

	return `${remote.owner}/${remote.repo}`
}

/**
 * Validate that a remote exists in git config
 * Throws if remote doesn't exist
 */
export async function validateConfiguredRemote(remoteName: string, cwd?: string): Promise<void> {
	try {
		await execa('git', ['remote', 'get-url', remoteName], {
			cwd: cwd ?? process.cwd(),
			encoding: 'utf8',
		})
	} catch {
		throw new Error(
			`Remote "${remoteName}" does not exist in git configuration. Run "il init" to reconfigure.`,
		)
	}
}

/**
 * Get the effective PR target remote based on settings
 * Priority: mergeBehavior.remote > issueManagement.github.remote > 'origin'
 */
export async function getEffectivePRTargetRemote(
	settings: IloomSettings,
	cwd?: string,
): Promise<string> {
	const prRemote =
		settings.mergeBehavior?.remote ?? settings.issueManagement?.github?.remote ?? 'origin'
	await validateConfiguredRemote(prRemote, cwd)
	return prRemote
}
