/**
 * GitHubPRPollingManager: Polls GitHub for PR states and triggers finish for closed PRs
 *
 * This manager is used by the remote daemon to periodically check the state of PRs
 * associated with active looms. When a PR is closed or merged, it triggers finish
 * of the corresponding loom (archiving metadata, handling sessions, merging changes).
 */
import { getLogger } from '../utils/logger-context.js'
import { executeGhCommand } from '../utils/github.js'
import { parseGitRemotes } from '../utils/remote.js'
import { MetadataManager, type LoomMetadata } from './MetadataManager.js'
import { CleanupSafetyError } from '../types/cleanup.js'
import type { PRState, PollResult, FinishTriggerResult, PRStateCheckResult, RateLimitBackoffState } from '../types/remote.js'

/**
 * Base backoff duration in seconds (starts at 60 seconds = 1 minute)
 */
const BASE_BACKOFF_SECONDS = 60

/**
 * Maximum backoff duration in seconds (30 minutes)
 */
const MAX_BACKOFF_SECONDS = 30 * 60

/**
 * Backoff multiplier for exponential backoff
 */
const BACKOFF_MULTIPLIER = 2

/**
 * Dependencies for GitHubPRPollingManager
 * Allows injection for testing
 */
export interface GitHubPRPollingManagerDeps {
	metadataManager?: MetadataManager
	finishFn?: (prNumber: string, projectPath: string) => Promise<FinishTriggerResult>
}

/**
 * Information about a loom with its associated PR
 */
interface LoomPRInfo {
	loom: LoomMetadata
	prNumber: string
	repo: string
}

/**
 * GitHubPRPollingManager polls GitHub for PR states and triggers finish
 */
export class GitHubPRPollingManager {
	private readonly metadataManager: MetadataManager
	private readonly finishFn: ((prNumber: string, projectPath: string) => Promise<FinishTriggerResult>) | undefined

	/** Rate limit backoff state */
	private backoffState: RateLimitBackoffState = {
		isBackingOff: false,
		consecutiveFailures: 0,
		backoffUntil: null,
		currentBackoffSeconds: 0,
	}

	constructor(deps: GitHubPRPollingManagerDeps = {}) {
		this.metadataManager = deps.metadataManager ?? new MetadataManager()
		this.finishFn = deps.finishFn ?? undefined
	}

	/**
	 * Get the current rate limit backoff state
	 * Useful for monitoring and debugging
	 */
	getBackoffState(): RateLimitBackoffState {
		return { ...this.backoffState }
	}

	/**
	 * Check if an error indicates GitHub API rate limiting
	 *
	 * GitHub rate limit errors typically include:
	 * - HTTP 403 with "rate limit" in the message
	 * - HTTP 403 with "API rate limit exceeded" message
	 * - Messages containing "secondary rate limit"
	 *
	 * @param error - The error to check
	 * @returns true if the error indicates rate limiting
	 */
	isRateLimitError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false
		}

		const errorMessage = error.message.toLowerCase()
		const stderr = ('stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string')
			? ((error as { stderr: string }).stderr).toLowerCase()
			: ''

		const combinedError = `${errorMessage} ${stderr}`

		// Check for common rate limit indicators
		const rateLimitIndicators = [
			'rate limit',
			'api rate limit exceeded',
			'secondary rate limit',
			'you have exceeded',
			'too many requests',
			'abuse detection',
		]

		// Also check for HTTP 403 which is commonly returned for rate limits
		const is403Error = combinedError.includes('403') || combinedError.includes('forbidden')
		const hasRateLimitMessage = rateLimitIndicators.some(indicator =>
			combinedError.includes(indicator)
		)

		return hasRateLimitMessage || (is403Error && combinedError.includes('limit'))
	}

	/**
	 * Record a rate limit error and update backoff state
	 * Uses exponential backoff with a maximum duration
	 */
	recordRateLimitError(): void {
		this.backoffState.consecutiveFailures++

		// Calculate backoff duration with exponential growth
		// Formula: base * (multiplier ^ (failures - 1)), capped at max
		const exponent = Math.min(this.backoffState.consecutiveFailures - 1, 10) // Cap exponent to prevent overflow
		const backoffSeconds = Math.min(
			BASE_BACKOFF_SECONDS * Math.pow(BACKOFF_MULTIPLIER, exponent),
			MAX_BACKOFF_SECONDS
		)

		this.backoffState.currentBackoffSeconds = backoffSeconds
		this.backoffState.backoffUntil = new Date(Date.now() + backoffSeconds * 1000)
		this.backoffState.isBackingOff = true

		getLogger().warn(
			`GitHub API rate limit detected. Backing off for ${backoffSeconds} seconds ` +
			`(attempt ${this.backoffState.consecutiveFailures}). ` +
			`Will retry at ${this.backoffState.backoffUntil.toISOString()}`
		)
	}

	/**
	 * Record a successful API call and reset backoff state
	 */
	recordSuccess(): void {
		if (this.backoffState.consecutiveFailures > 0) {
			getLogger().info('GitHub API call succeeded, resetting rate limit backoff state')
		}

		this.backoffState = {
			isBackingOff: false,
			consecutiveFailures: 0,
			backoffUntil: null,
			currentBackoffSeconds: 0,
		}
	}

	/**
	 * Check if we're currently in a backoff period
	 * @returns true if we should skip the poll due to backoff
	 */
	isInBackoffPeriod(): boolean {
		if (!this.backoffState.isBackingOff || !this.backoffState.backoffUntil) {
			return false
		}

		const now = new Date()
		if (now >= this.backoffState.backoffUntil) {
			// Backoff period has expired, but don't reset state yet
			// Wait for a successful request to confirm rate limit has lifted
			getLogger().info('Rate limit backoff period expired, will attempt next poll')
			this.backoffState.isBackingOff = false
			return false
		}

		return true
	}

	/**
	 * Get remaining backoff time in seconds
	 * @returns seconds remaining, or 0 if not in backoff
	 */
	getBackoffRemainingSeconds(): number {
		if (!this.backoffState.backoffUntil) {
			return 0
		}

		const remaining = Math.max(0, this.backoffState.backoffUntil.getTime() - Date.now())
		return Math.ceil(remaining / 1000)
	}

	/**
	 * Main polling function: check all active looms and cleanup those with closed PRs
	 *
	 * @returns PollResult with statistics about the polling cycle
	 */
	async pollAndCleanup(): Promise<PollResult> {
		const result: PollResult = {
			checked: 0,
			cleaned: 0,
			skipped: 0,
			errors: [],
			timestamp: new Date(),
		}

		// Check if we're in a rate limit backoff period
		if (this.isInBackoffPeriod()) {
			const remainingSeconds = this.getBackoffRemainingSeconds()
			getLogger().info(
				`Skipping poll due to rate limit backoff. ${remainingSeconds} seconds remaining.`
			)
			result.rateLimited = true
			result.backoffRemainingSeconds = remainingSeconds
			return result
		}

		try {
			// Step 1: Get all active looms with PR numbers
			const looms = await this.metadataManager.listAllMetadata()
			const loomsWithPRs = looms.filter(loom =>
				loom.pr_numbers && loom.pr_numbers.length > 0 && loom.projectPath
			)

			if (loomsWithPRs.length === 0) {
				getLogger().debug('No looms with PRs to monitor')
				return result
			}

			getLogger().debug(`Found ${loomsWithPRs.length} looms with PRs to check`)

			// Step 2: Build list of unique PR/repo combinations
			const loomPRInfos = await this.buildLoomPRInfoList(loomsWithPRs)

			// Step 3: Group by unique PR numbers to avoid redundant API calls
			const uniquePRs = this.getUniquePRs(loomPRInfos)
			result.checked = uniquePRs.size
			result.monitoredPRs = Array.from(uniquePRs.keys())

			// Track if we encountered any rate limit errors this cycle
			let rateLimitEncountered = false

			// Step 4: Check PR states and trigger cleanup for closed PRs
			for (const [prKey, infos] of uniquePRs) {
				const firstInfo = infos[0]
				if (!firstInfo) continue

				// If we hit a rate limit, skip remaining PR checks
				if (rateLimitEncountered) {
					getLogger().debug(`Skipping PR ${prKey} due to rate limit in this cycle`)
					continue
				}

				try {
					const prState = await this.checkPRState(
						parseInt(firstInfo.prNumber, 10),
						firstInfo.repo
					)

					// Check if the PR state check returned a rate limit error
					if (prState.error && prState.rateLimited) {
						rateLimitEncountered = true
						result.rateLimited = true
						result.backoffRemainingSeconds = this.getBackoffRemainingSeconds()
						result.errors.push(`Rate limit exceeded checking PR ${prKey}`)
						continue
					}

					// Record success only if we actually made an API call without error
					if (!prState.error) {
						this.recordSuccess()
					}

					if (prState.state === 'closed' || prState.state === 'merged') {
						// Trigger finish for all looms associated with this PR
						for (const info of infos) {
							if (!info.loom.projectPath) continue

							const finishResult = await this.triggerFinish(
								info.prNumber,
								info.loom.projectPath
							)

							if (finishResult.success) {
								result.cleaned++
								getLogger().info(
									`Finished loom for PR #${info.prNumber} (${prState.state})`
								)
							} else if (finishResult.skipped) {
								result.skipped++
								getLogger().info(
									`Skipped finish for PR #${info.prNumber}: ${finishResult.skipReason}`
								)
							} else {
								result.errors.push(
									finishResult.error ?? `Failed to finish PR #${info.prNumber}`
								)
							}
						}
					}
				} catch (error) {
					// Check for rate limit errors
					if (this.isRateLimitError(error)) {
						this.recordRateLimitError()
						rateLimitEncountered = true
						result.rateLimited = true
						result.backoffRemainingSeconds = this.getBackoffRemainingSeconds()
						result.errors.push(`Rate limit exceeded checking PR ${prKey}`)
						continue
					}

					const errorMsg = error instanceof Error ? error.message : String(error)
					result.errors.push(`Error checking PR ${prKey}: ${errorMsg}`)
					getLogger().warn(`Error checking PR ${prKey}: ${errorMsg}`)
				}
			}
		} catch (error) {
			// Check for rate limit errors at the top level
			if (this.isRateLimitError(error)) {
				this.recordRateLimitError()
				result.rateLimited = true
				result.backoffRemainingSeconds = this.getBackoffRemainingSeconds()
				result.errors.push('Rate limit exceeded during polling')
				return result
			}

			const errorMsg = error instanceof Error ? error.message : String(error)
			result.errors.push(`Polling error: ${errorMsg}`)
			getLogger().error(`Polling error: ${errorMsg}`)
		}

		return result
	}

	/**
	 * Check the state of a PR using gh CLI
	 *
	 * @param prNumber - The PR number to check
	 * @param repo - Repository in owner/repo format
	 * @returns PRStateCheckResult with the PR state
	 */
	async checkPRState(prNumber: number, repo: string): Promise<PRStateCheckResult> {
		try {
			const result = await executeGhCommand<{ state: string; merged: boolean }>([
				'pr',
				'view',
				String(prNumber),
				'--repo',
				repo,
				'--json',
				'state,merged',
			])

			// Determine effective state
			let state: PRState
			if (result.merged) {
				state = 'merged'
			} else if (result.state.toLowerCase() === 'closed') {
				state = 'closed'
			} else {
				state = 'open'
			}

			return {
				prNumber,
				state,
				repo,
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)

			// Check for rate limit errors
			if (this.isRateLimitError(error)) {
				this.recordRateLimitError()
				getLogger().warn(`Rate limit error checking PR #${prNumber}: ${errorMsg}`)
				return {
					prNumber,
					state: 'open', // Default to open to prevent accidental cleanup
					repo,
					error: errorMsg,
					rateLimited: true,
				}
			}

			getLogger().debug(`Failed to check PR #${prNumber} state: ${errorMsg}`)

			// Return error result for handling by caller
			return {
				prNumber,
				state: 'open', // Default to open on error to prevent accidental cleanup
				repo,
				error: errorMsg,
			}
		}
	}

	/**
	 * Extract repository (owner/repo) from a project path by reading git remotes
	 *
	 * @param projectPath - Path to the project directory
	 * @returns Repository in owner/repo format, or null if not determinable
	 */
	async extractRepoFromProjectPath(projectPath: string): Promise<string | null> {
		try {
			const remotes = await parseGitRemotes(projectPath)

			// Prefer 'origin' remote, fall back to first available
			const origin = remotes.find(r => r.name === 'origin')
			const remote = origin ?? remotes[0]

			if (!remote) {
				getLogger().debug(`No git remotes found for ${projectPath}`)
				return null
			}

			return `${remote.owner}/${remote.repo}`
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			getLogger().debug(`Failed to extract repo from ${projectPath}: ${errorMsg}`)
			return null
		}
	}

	/**
	 * Trigger cleanup for a loom associated with a PR
	 *
	 * Uses CleanupCommand with archive: true to properly:
	 * - Archive loom metadata to finished/ directory
	 * - Clean up worktree, branch, database, processes
	 *
	 * Note: Does NOT use FinishCommand because:
	 * - FinishCommand has interactive rebasing that won't work headless
	 * - The --archive flag on CleanupCommand provides metadata archival
	 * - The daemon doesn't need to generate session summaries by default
	 *
	 * @param prNumber - The PR number to cleanup
	 * @param projectPath - Path to the project
	 * @returns FinishTriggerResult with success/failure status
	 */
	async triggerFinish(prNumber: string, projectPath: string): Promise<FinishTriggerResult> {
		// Validate PR number format to prevent injection attacks
		if (!/^\d+$/.test(prNumber)) {
			throw new Error('Invalid PR number format')
		}

		const baseResult: Omit<FinishTriggerResult, 'success' | 'skipped'> = {
			prNumber: parseInt(prNumber, 10),
			loomId: prNumber,
			projectPath,
		}

		// If a custom finish function is provided (for testing or custom behavior), use it
		if (this.finishFn) {
			return this.finishFn(prNumber, projectPath)
		}

		// Default implementation: dynamically import and call CleanupCommand
		// NOTE: We use dynamic import here to avoid a circular dependency.
		// GitHubPRPollingManager is imported by RemoteDaemonRunner which is a separate
		// entry point built by tsup. CleanupCommand imports many modules that create
		// a complex dependency graph. Using dynamic import defers the resolution until
		// runtime when cleanup is actually needed, breaking the circular chain.
		try {
			const { CleanupCommand } = await import('../commands/cleanup.js')

			const cleanupCommand = new CleanupCommand()

			// Execute cleanup with:
			// - force=false to respect safety checks
			// - json=true to avoid interactive prompts
			// - archive=true to archive metadata before cleanup
			// - summary=false (default) - daemon doesn't generate summaries
			const result = await cleanupCommand.execute({
				identifier: prNumber,
				options: {
					force: false,
					dryRun: false,
					json: true,
					archive: true,  // Archive metadata before cleanup
				},
			})

			if (result?.success) {
				return {
					...baseResult,
					success: true,
					skipped: false,
				}
			} else {
				// Cleanup was blocked (e.g., uncommitted changes, child looms exist)
				const failedOp = result?.operations?.find(op => !op.success)
				const skipReason = failedOp?.error ?? failedOp?.message ?? 'Cleanup blocked by safety check'
				return {
					...baseResult,
					success: false,
					skipped: true,
					skipReason,
				}
			}
		} catch (error) {
			// Check if this is a safety check block (not a real error)
			// Using instanceof check instead of fragile string matching
			if (error instanceof CleanupSafetyError) {
				return {
					...baseResult,
					success: false,
					skipped: true,
					skipReason: error.message,
				}
			}

			const errorMsg = error instanceof Error ? error.message : String(error)
			return {
				...baseResult,
				success: false,
				skipped: false,
				error: errorMsg,
			}
		}
	}

	/**
	 * Build a list of LoomPRInfo objects from looms with PRs
	 * Extracts repo information for each loom
	 */
	private async buildLoomPRInfoList(looms: LoomMetadata[]): Promise<LoomPRInfo[]> {
		const result: LoomPRInfo[] = []

		for (const loom of looms) {
			if (!loom.projectPath || !loom.pr_numbers) continue

			const repo = await this.extractRepoFromProjectPath(loom.projectPath)
			if (!repo) {
				getLogger().debug(`Could not determine repo for loom at ${loom.projectPath}`)
				continue
			}

			// Add an entry for each PR number
			for (const prNumber of loom.pr_numbers) {
				result.push({
					loom,
					prNumber,
					repo,
				})
			}
		}

		return result
	}

	/**
	 * Group loom PR info by unique PR key (repo/prNumber)
	 * This prevents redundant API calls when multiple looms reference the same PR
	 */
	private getUniquePRs(infos: LoomPRInfo[]): Map<string, LoomPRInfo[]> {
		const map = new Map<string, LoomPRInfo[]>()

		for (const info of infos) {
			const key = `${info.repo}#${info.prNumber}`
			const existing = map.get(key) ?? []
			existing.push(info)
			map.set(key, existing)
		}

		return map
	}
}
