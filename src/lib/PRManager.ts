import { executeGhCommand } from '../utils/github.js'
import { launchClaude, detectClaudeCli } from '../utils/claude.js'
import { getEffectivePRTargetRemote, getConfiguredRepoFromSettings, parseGitRemotes } from '../utils/remote.js'
import { openBrowser } from '../utils/browser.js'
import { getLogger } from '../utils/logger-context.js'
import type { IloomSettings } from './SettingsManager.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'

interface ExistingPR {
	number: number
	url: string
}

interface PRCreationResult {
	url: string
	number: number
	wasExisting: boolean
}

export class PRManager {
	constructor(private settings: IloomSettings) {
		// Uses getLogger() for all logging operations
	}

	/**
	 * Get the issue prefix from the configured provider
	 */
	public get issuePrefix(): string {
		const providerType = this.settings.issueManagement?.provider ?? 'github'
		const provider = IssueManagementProviderFactory.create(providerType, this.settings)
		return provider.issuePrefix
	}

	/**
	 * Check if a PR already exists for the given branch
	 * @param branchName - Branch to check
	 * @param cwd - Working directory
	 * @returns Existing PR info or null if none found
	 */
	async checkForExistingPR(branchName: string, cwd?: string): Promise<ExistingPR | null> {
		try {
			const prList = await executeGhCommand<Array<{ number: number; url: string }>>(
				['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number,url'],
				cwd ? { cwd } : undefined
			)

			if (prList.length > 0) {
				return prList[0] ?? null // Return first match
			}

			return null
		} catch (error) {
		getLogger().debug('Error checking for existing PR', { error })
			return null
		}
	}

	/**
	 * Generate PR body using Claude if available, otherwise use simple template
	 * @param issueNumber - Issue number to include in body
	 * @param worktreePath - Path to worktree for context
	 * @returns PR body markdown
	 */
	async generatePRBody(issueNumber: string | number | undefined, worktreePath: string): Promise<string> {
		// Try Claude first for rich body generation
		const hasClaudeCli = await detectClaudeCli()

		if (hasClaudeCli) {
			try {
				const prompt = this.buildPRBodyPrompt(issueNumber)

				const body = await launchClaude(prompt, {
					headless: true,
					addDir: worktreePath,
					timeout: 30000,
					noSessionPersistence: true, // Utility operation - don't persist session
				})

				if (body && typeof body === 'string' && body.trim()) {
					const sanitized = this.sanitizeClaudeOutput(body)
					if (sanitized) {
						return sanitized
					}
				}
			} catch (error) {
			getLogger().debug('Claude PR body generation failed, using template', { error })
			}
		}

		// Fallback to simple template
		let body = 'This PR contains changes from the iloom workflow.\n\n'

		if (issueNumber) {
			body += `Fixes ${this.issuePrefix}${issueNumber}`
		}

		return body
	}

	/**
	 * Build structured XML prompt for PR body generation
	 * Uses XML format for clear task definition and output expectations
	 */
	private buildPRBodyPrompt(issueNumber?: string | number): string {
		const issueContext = issueNumber
			? `\n<IssueContext>
This PR is associated with issue ${this.issuePrefix}${issueNumber}.
Include "Fixes ${this.issuePrefix}${issueNumber}" at the end of the body on its own line.
</IssueContext>`
			: ''

		const examplePrefix = this.issuePrefix || ''  // Use empty string for Linear examples
		return `<Task>
You are a software engineer writing a pull request body for this repository.
Examine the changes in the git repository and generate a concise, professional PR description.
</Task>

<Requirements>
<Format>Write 2-3 sentences summarizing what was changed and why.${issueNumber ? `\n\nEnd with "Fixes ${this.issuePrefix}${issueNumber}" on its own line.` : ''}</Format>
<Tone>Professional and concise</Tone>
<Focus>Summarize the changes and their purpose</Focus>
<NoMeta>CRITICAL: Do NOT include ANY explanatory text, analysis, or meta-commentary. Output ONLY the raw PR body text.</NoMeta>
<Examples>
Good: "Add user authentication with JWT tokens to secure the API endpoints. This includes login and registration endpoints with proper password hashing.

Fixes ${examplePrefix}42"
Good: "Fix navigation bug in sidebar menu that caused incorrect highlighting on nested routes."
Bad: "Here's the PR body:\n\n---\n\nAdd user authentication..."
Bad: "Based on the changes, I'll write: Fix navigation bug..."
</Examples>
${issueContext}
</Requirements>

<Output>
IMPORTANT: Your entire response will be used directly as the GitHub pull request body.
Do not include any explanatory text, headers, or separators before or after the body.
Start your response immediately with the PR body text.
</Output>`
	}

	/**
	 * Sanitize Claude output to remove meta-commentary and clean formatting
	 * Handles cases where Claude includes explanatory text despite instructions
	 */
	private sanitizeClaudeOutput(rawOutput: string): string {
		let cleaned = rawOutput.trim()

		// Remove common meta-commentary patterns (case-insensitive)
		const metaPatterns = [
			/^.*?based on.*?changes.*?:/i,
			/^.*?looking at.*?files.*?:/i,
			/^.*?examining.*?:/i,
			/^.*?analyzing.*?:/i,
			/^.*?i'll.*?generate.*?:/i,
			/^.*?let me.*?:/i,
			/^.*?here.*?is.*?(?:the\s+)?(?:pr|pull request).*?body.*?:/i,
			/^.*?here's.*?(?:the\s+)?(?:pr|pull request).*?body.*?:/i,
		]

		for (const pattern of metaPatterns) {
			cleaned = cleaned.replace(pattern, '').trim()
		}

		// Remove leading separator lines (---, ===, etc.)
		cleaned = cleaned.replace(/^[-=]{3,}\s*/m, '').trim()

		// Extract content after separators only if it looks like meta-commentary
		if (cleaned.includes(':')) {
			const colonIndex = cleaned.indexOf(':')
			const beforeColon = cleaned.substring(0, colonIndex).trim().toLowerCase()

			// Only split if the text before colon looks like meta-commentary
			const metaIndicators = [
				'here is the pr body',
				'here is the pull request body',
				'pr body',
				'pull request body',
				'here is',
				"here's",
				'the body should be',
				'i suggest',
				'my suggestion'
			]

			const isMetaCommentary = metaIndicators.some(indicator => beforeColon.includes(indicator))

			if (isMetaCommentary) {
				const afterColon = cleaned.substring(colonIndex + 1).trim()
				// Remove leading separator after colon
				const afterSeparator = afterColon.replace(/^[-=]{3,}\s*/m, '').trim()
				if (afterSeparator && afterSeparator.length > 10) {
					cleaned = afterSeparator
				}
			}
		}

		// Remove quotes if the entire message is wrapped in them
		if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
			(cleaned.startsWith("'") && cleaned.endsWith("'"))) {
			cleaned = cleaned.slice(1, -1).trim()
		}

		return cleaned
	}

	/**
	 * Create a GitHub PR for the branch
	 * @param branchName - Branch to create PR from (used as --head)
	 * @param title - PR title
	 * @param body - PR body
	 * @param baseBranch - Base branch to target (usually main/master)
	 * @param cwd - Working directory
	 * @returns PR URL
	 */
	async createPR(
		branchName: string,
		title: string,
		body: string,
		baseBranch: string,
		cwd?: string
	): Promise<string> {
		try {
			// Get the target remote for the PR
			const targetRemote = await getEffectivePRTargetRemote(this.settings, cwd)

			// Determine the correct --head value
			// For fork workflows (target != origin), we need "username:branch" format
			// See: https://github.com/cli/cli/issues/2691
			let headValue = branchName

			if (targetRemote !== 'origin') {
				// Fork workflow: need to specify the head as "owner:branch"
				// Get the owner of the origin remote (where we pushed the branch)
				const remotes = await parseGitRemotes(cwd)
				const originRemote = remotes.find(r => r.name === 'origin')

				if (originRemote) {
					headValue = `${originRemote.owner}:${branchName}`
				getLogger().debug(`Fork workflow detected, using head: ${headValue}`)
				}
			}

			// Build gh pr create command
			// Note: gh pr create returns a plain URL string, not JSON
			const args = ['pr', 'create', '--head', headValue, '--title', title, '--body', body, '--base', baseBranch]

			// If target remote is not 'origin', we need to specify the repo
			if (targetRemote !== 'origin') {
				const repo = await getConfiguredRepoFromSettings(this.settings, cwd)
				args.push('--repo', repo)
			}

			// gh pr create returns the PR URL as plain text (not JSON)
			const result = await executeGhCommand<string>(args, cwd ? { cwd } : undefined)

			// Result is a string URL like "https://github.com/owner/repo/pull/123"
			const url = typeof result === 'string' ? result.trim() : String(result).trim()

			if (!url.includes('github.com') || !url.includes('/pull/')) {
				throw new Error(`Unexpected response from gh pr create: ${url}`)
			}

			return url
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)

			// Provide helpful error message for common GraphQL errors
			if (errorMessage.includes("Head sha can't be blank") || errorMessage.includes("No commits between")) {
				throw new Error(
					`Failed to create pull request: ${errorMessage}\n\n` +
					`This error typically occurs when:\n` +
					`  - The branch was not fully pushed to the remote\n` +
					`  - There's a race condition between push and PR creation\n` +
					`  - The branch has no commits ahead of the base branch\n\n` +
					`Try running: git push -u origin ${branchName}\n` +
					`Then retry: il finish`
				)
			}

			throw new Error(`Failed to create pull request: ${errorMessage}`)
		}
	}

	/**
	 * Open PR URL in browser
	 * @param url - PR URL to open
	 */
	async openPRInBrowser(url: string): Promise<void> {
		try {
			await openBrowser(url)
		getLogger().debug('Opened PR in browser', { url })
		} catch (error) {
			// Don't fail the whole operation if browser opening fails
		getLogger().warn('Failed to open PR in browser', { error })
		}
	}

	/**
	 * Complete PR workflow: check for existing, create if needed, optionally open in browser
	 * @param branchName - Branch to create PR from
	 * @param title - PR title
	 * @param issueNumber - Optional issue number for body generation
	 * @param baseBranch - Base branch to target
	 * @param worktreePath - Path to worktree
	 * @param openInBrowser - Whether to open PR in browser
	 * @returns PR creation result
	 */
	async createOrOpenPR(
		branchName: string,
		title: string,
		issueNumber: string | number | undefined,
		baseBranch: string,
		worktreePath: string,
		openInBrowser: boolean
	): Promise<PRCreationResult> {
		// Check for existing PR
		const existingPR = await this.checkForExistingPR(branchName, worktreePath)

		if (existingPR) {
		getLogger().info(`Pull request already exists: ${existingPR.url}`)

			if (openInBrowser) {
				await this.openPRInBrowser(existingPR.url)
			}

			return {
				url: existingPR.url,
				number: existingPR.number,
				wasExisting: true,
			}
		}

		// Generate PR body
		const body = await this.generatePRBody(issueNumber, worktreePath)

		// Create new PR
	getLogger().info('Creating pull request...')
		const url = await this.createPR(branchName, title, body, baseBranch, worktreePath)

		// Extract PR number from URL
		const prNumber = this.extractPRNumberFromUrl(url)

		if (openInBrowser) {
			await this.openPRInBrowser(url)
		}

		return {
			url,
			number: prNumber,
			wasExisting: false,
		}
	}

	/**
	 * Extract PR number from GitHub PR URL
	 * @param url - PR URL (e.g., https://github.com/owner/repo/pull/123)
	 * @returns PR number
	 */
	private extractPRNumberFromUrl(url: string): number {
		const match = url.match(/\/pull\/(\d+)/)
		if (match?.[1]) {
			return parseInt(match[1], 10)
		}
		throw new Error(`Could not extract PR number from URL: ${url}`)
	}

	/**
	 * Create a draft PR for the branch
	 * Used by github-draft-pr mode during il start
	 * @param branchName - Branch to create PR from (used as --head)
	 * @param title - PR title
	 * @param body - PR body
	 * @param baseBranch - Base branch to target (used as --base)
	 * @param cwd - Working directory
	 * @returns PR URL and number
	 */
	async createDraftPR(
		branchName: string,
		title: string,
		body: string,
		baseBranch: string,
		cwd?: string
	): Promise<{ url: string; number: number }> {
		try {
			// Get the target remote for the PR
			const targetRemote = await getEffectivePRTargetRemote(this.settings, cwd)

			// Determine the correct --head value
			// For fork workflows (target != origin), we need "username:branch" format
			let headValue = branchName

			if (targetRemote !== 'origin') {
				// Fork workflow: need to specify the head as "owner:branch"
				const remotes = await parseGitRemotes(cwd)
				const originRemote = remotes.find(r => r.name === 'origin')

				if (originRemote) {
					headValue = `${originRemote.owner}:${branchName}`
					getLogger().debug(`Fork workflow detected, using head: ${headValue}`)
				}
			}

			// Build gh pr create command with --draft flag
			const args = ['pr', 'create', '--head', headValue, '--title', title, '--body', body, '--base', baseBranch, '--draft']

			// If target remote is not 'origin', we need to specify the repo
			if (targetRemote !== 'origin') {
				const repo = await getConfiguredRepoFromSettings(this.settings, cwd)
				args.push('--repo', repo)
			}

			// gh pr create returns the PR URL as plain text (not JSON)
			const result = await executeGhCommand<string>(args, cwd ? { cwd } : undefined)

			// Result is a string URL like "https://github.com/owner/repo/pull/123"
			const url = typeof result === 'string' ? result.trim() : String(result).trim()

			if (!url.includes('github.com') || !url.includes('/pull/')) {
				throw new Error(`Unexpected response from gh pr create --draft: ${url}`)
			}

			const number = this.extractPRNumberFromUrl(url)

			return { url, number }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)

			// Provide helpful error message for common errors
			if (errorMessage.includes("Head sha can't be blank") || errorMessage.includes("No commits between")) {
				throw new Error(
					`Failed to create draft pull request: ${errorMessage}\n\n` +
					`This error typically occurs when:\n` +
					`  - The branch was not fully pushed to the remote\n` +
					`  - The branch has no commits ahead of the base branch\n\n` +
					`Try running: git push -u origin ${branchName}\n` +
					`Then retry: il start`
				)
			}

			throw new Error(`Failed to create draft pull request: ${errorMessage}`)
		}
	}

	/**
	 * Mark a draft PR as ready for review
	 * Used by github-draft-pr mode during il finish
	 * @param prNumber - PR number to mark ready
	 * @param cwd - Working directory
	 */
	async markPRReady(prNumber: number, cwd?: string): Promise<void> {
		const args = ['pr', 'ready', String(prNumber)]
		await executeGhCommand(args, cwd ? { cwd } : undefined)
		getLogger().info(`Marked PR #${prNumber} as ready for review`)
	}
}
