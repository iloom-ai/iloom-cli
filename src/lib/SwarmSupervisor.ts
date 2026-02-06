import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { setTimeout as sleep } from 'timers/promises'
import { execa, type ExecaChildProcess } from 'execa'
import type { BeadsManager, BeadsTask } from './BeadsManager.js'
import type { BeadsSyncService } from './BeadsSyncService.js'
import type { LoomManager } from './LoomManager.js'
import type { SwarmSettings } from './SettingsManager.js'
import { executeGhCommand } from '../utils/github.js'
import { logger } from '../utils/logger.js'

/**
 * Context for the epic loom (parent workspace) that the swarm operates on
 */
export interface EpicLoomContext {
	epicIssueNumber: string
	epicBranch: string
	epicLoomPath: string
	projectPath: string
}

/**
 * Tracks an active swarm agent process
 */
export interface ActiveAgent {
	issueId: string
	pid: number
	loomPath: string
	logFile: string
	process: ExecaChildProcess
	beadsTaskId: string
	/** Set when the process exits. Null means still running. */
	exitCode: number | null
	/** Write stream for agent log file; closed when agent completes */
	logStream: { end: () => void }
}

/**
 * Tracks a PR ready to be merged into the epic branch
 */
export interface MergeQueueEntry {
	issueId: string
	prNumber: number
	beadsTaskId: string
	/** Path to the child worktree for this task, used by conflict resolver */
	loomPath: string
}

/**
 * Aggregate result of a swarm run
 */
export interface SwarmResult {
	totalTasks: number
	completed: number
	failed: number
	mergedPRs: number
	failedMerges: number
	duration: number
}

/**
 * Tracks failure information for a specific task
 */
export interface TaskFailure {
	issue: string
	reason: string
	attempts: number
}

/**
 * Node in the progress DAG
 */
export interface ProgressNode {
	issue: string
	title: string
	status: 'completed' | 'in_progress' | 'blocked' | 'ready' | 'failed'
	agentPid: number | null
	logFile: string | null
	attempts: number
	prNumber: number | null
	startedAt: string | null
	completedAt: string | null
}

/**
 * Edge in the progress DAG
 */
export interface ProgressEdge {
	from: string
	to: string
}

/**
 * Progress file structure written to disk on every state change
 */
export interface SwarmProgress {
	epicIssue: string
	epicBranch: string
	status: 'running' | 'completed' | 'failed' | 'paused'
	startedAt: string
	updatedAt: string
	dag: {
		nodes: ProgressNode[]
		edges: ProgressEdge[]
	}
	stats: {
		total: number
		completed: number
		inProgress: number
		failed: number
		blocked: number
		ready: number
	}
	failures: TaskFailure[]
}

/**
 * Orchestrates headless Claude agents working on an epic's child issues.
 *
 * Uses Beads for DAG-based task ordering and atomic claiming.
 * Spawns `il spin -p` as child processes in minimal worktrees.
 * Merges PRs sequentially into the epic branch to prevent race conditions.
 *
 * Resilience features:
 * - Failure handling with configurable retries
 * - Merge conflict resolution via lightweight resolver agents
 * - Resume support: detects existing Beads state and picks up where left off
 * - Progress reporting: terminal output + JSON progress file
 *
 * Lifecycle:
 * 1. Init Beads and sync epic children into DAG
 * 2. Resume check: skip completed, recover dead in-progress tasks
 * 3. Loop: claim ready tasks, spawn agents, monitor, merge PRs
 * 4. Complete when DAG is empty and no agents are running
 */
export class SwarmSupervisor {
	private activeAgents: Map<string, ActiveAgent> = new Map()
	private mergeQueue: MergeQueueEntry[] = []
	private shuttingDown = false
	private signalHandlersInstalled = false

	/** Tracks how many times each task has been attempted (for retry logic) */
	private taskAttempts: Map<string, number> = new Map()
	/** Tracks how many times conflict resolution has been attempted for a PR */
	private conflictRetries: Map<string, number> = new Map()
	/** Records of all task failures for progress reporting */
	private failures: TaskFailure[] = []
	/** Maps task IDs to their titles for progress reporting */
	private taskTitles: Map<string, string> = new Map()
	/** Maps task IDs to PR numbers discovered during merging */
	private taskPRNumbers: Map<string, number> = new Map()
	/** Maps task IDs to their start times */
	private taskStartTimes: Map<string, string> = new Map()
	/** Maps task IDs to their completion times */
	private taskCompleteTimes: Map<string, string> = new Map()
	/** Tracks which tasks have been permanently failed (exhausted retries) */
	private permanentlyFailed: Set<string> = new Set()
	/**
	 * Tracks tasks whose claims have been released but may not yet appear in ready().
	 * Prevents premature exit when Beads has internal delay re-surfacing released tasks.
	 */
	private pendingReleases: number = 0
	/** Start time for progress reporting */
	private startedAt: string = ''
	/** Log directory path */
	private logDir: string = ''
	/** Maps task IDs to their child worktree paths (retained after agent completes for merge queue use) */
	private taskLoomPaths: Map<string, string> = new Map()

	constructor(
		private readonly beadsManager: BeadsManager,
		private readonly syncService: BeadsSyncService,
		private readonly loomManager: LoomManager,
		private readonly settings: SwarmSettings,
	) {}

	/**
	 * Run the swarm supervisor loop.
	 *
	 * Orchestrates the full lifecycle: init, sync, resume, claim, spawn, monitor, merge.
	 * Returns aggregate stats when all tasks are complete or shutdown is requested.
	 */
	async run(epicLoom: EpicLoomContext): Promise<SwarmResult> {
		const startTime = Date.now()
		this.startedAt = new Date().toISOString()
		const result: SwarmResult = {
			totalTasks: 0,
			completed: 0,
			failed: 0,
			mergedPRs: 0,
			failedMerges: 0,
			duration: 0,
		}

		this.installSignalHandlers()

		try {
			// Step 1: Initialize Beads
			logger.info('Initializing Beads DAG...')
			await this.beadsManager.init()

			// Step 2: Sync epic children to Beads
			logger.info('Syncing epic children to Beads...')
			const syncResult = await this.syncService.syncEpicToBeads(epicLoom.epicIssueNumber)
			result.totalTasks = syncResult.created.length + syncResult.skipped.length
			logger.info(`Synced ${result.totalTasks} tasks (${syncResult.created.length} new, ${syncResult.skipped.length} existing)`)

			// Store task titles for progress reporting
			for (const mapping of syncResult.created) {
				this.taskTitles.set(mapping.issueId, mapping.title)
			}

			// Step 3: Ensure agent-logs directory exists
			this.logDir = path.join(epicLoom.epicLoomPath, 'agent-logs')
			await fs.ensureDir(this.logDir)

			// Step 4: Resume check - recover state from previous run
			const resumeResult = await this.resumeFromExistingState(epicLoom, result)
			if (resumeResult.resumed) {
				logger.info(
					`Resuming swarm: ${resumeResult.completed} completed, ${resumeResult.inProgress} in progress, ${resumeResult.remaining} remaining`,
				)
			}

			// Write initial progress
			await this.writeProgress(epicLoom, result, 'running')

			// Step 5: Main supervisor loop
			while (!this.isComplete()) {
				// 5a: Query ready tasks
				const readyTasks = await this.beadsManager.ready()

				// 5b: Claim and spawn agents for unblocked tasks
				if (!this.shuttingDown) {
					const slotsAvailable = this.settings.maxConcurrent - this.activeAgents.size
					const tasksToClaim = readyTasks.slice(0, slotsAvailable)

					for (const task of tasksToClaim) {
						// Skip tasks that have been permanently failed
						if (this.permanentlyFailed.has(task.id)) {
							continue
						}

						try {
							await this.claimAndSpawnAgent(task, epicLoom, this.logDir)
						} catch (error) {
							logger.error(`Failed to claim/spawn agent for task ${task.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
							result.failed++
						}
					}
				}

				// 5c: Check for completed agents
				await this.checkCompletedAgents(result, epicLoom)

				// 5d: Process merge queue
				await this.processMergeQueue(result, epicLoom)

				// 5e: Log periodic progress summary
				this.logProgressSummary(result)

				// 5f: Write progress file
				await this.writeProgress(epicLoom, result, 'running')

				// 5g: Check if we're done
				// Filter out permanently failed tasks - they will never be actioned and should
				// not prevent the supervisor from exiting when all actionable work is complete.
				const actionableReadyTasks = readyTasks.filter(t => !this.permanentlyFailed.has(t.id))
				if (actionableReadyTasks.length === 0 && this.activeAgents.size === 0 && this.mergeQueue.length === 0 && this.pendingReleases === 0) {
					break
				}

				// Poll interval - avoid tight loop
				await sleep(2000)
			}

			// If shutting down, wait for remaining agents
			if (this.shuttingDown && this.activeAgents.size > 0) {
				logger.info(`Shutting down gracefully. Waiting for ${this.activeAgents.size} running agent(s) to complete...`)
				await this.waitForRemainingAgents(result, epicLoom)
			}
		} finally {
			this.removeSignalHandlers()
			result.duration = Date.now() - startTime

			// Write final progress
			const finalStatus = result.failed > 0 && result.completed === 0 ? 'failed' : 'completed'
			await this.writeProgress(epicLoom, result, finalStatus)
		}

		logger.info(`Swarm complete: ${result.completed} completed, ${result.failed} failed, ${result.mergedPRs} PRs merged`)
		return result
	}

	/**
	 * Attempt to resume from existing Beads state.
	 *
	 * When the supervisor starts and detects existing Beads state:
	 * 1. Read all task statuses via `beadsManager.list()`
	 * 2. Skip tasks marked as `closed` (already completed)
	 * 3. For tasks `in_progress`: release claim, treat as failure (retry applies)
	 * 4. For tasks `open`/`ready`: proceed normally
	 */
	private async resumeFromExistingState(
		_epicLoom: EpicLoomContext,
		result: SwarmResult,
	): Promise<{ resumed: boolean; completed: number; inProgress: number; remaining: number }> {
		let allTasks: BeadsTask[]
		try {
			allTasks = await this.beadsManager.list()
		} catch {
			// No existing state to resume from
			return { resumed: false, completed: 0, inProgress: 0, remaining: 0 }
		}

		if (allTasks.length === 0) {
			return { resumed: false, completed: 0, inProgress: 0, remaining: 0 }
		}

		let completed = 0
		let inProgress = 0
		let remaining = 0

		for (const task of allTasks) {
			// Store title for progress reporting
			if (task.title) {
				this.taskTitles.set(task.id, task.title)
			}

			if (task.status === 'closed') {
				completed++
				result.completed++
				this.taskCompleteTimes.set(task.id, new Date().toISOString())
			} else if (task.status === 'in_progress') {
				inProgress++
				// The process from a previous run is dead - release claim and let retry logic handle it
				try {
					await this.beadsManager.releaseClaim(task.id)
					logger.info(`Released stale claim on task ${task.id}`)
				} catch (releaseError) {
					logger.warn(`Failed to release stale claim for task ${task.id}: ${releaseError instanceof Error ? releaseError.message : 'Unknown error'}`)
				}
				// Increment attempt counter so retry limit is respected
				const currentAttempts = this.taskAttempts.get(task.id) ?? 0
				this.taskAttempts.set(task.id, currentAttempts + 1)
				remaining++
			} else {
				// open / ready
				remaining++
			}
		}

		const hasExistingState = completed > 0 || inProgress > 0
		return { resumed: hasExistingState, completed, inProgress, remaining }
	}

	/**
	 * Claim a Beads task and spawn an agent process for it.
	 */
	private async claimAndSpawnAgent(
		task: BeadsTask,
		epicLoom: EpicLoomContext,
		logDir: string,
	): Promise<void> {
		// Track attempt
		const attempt = (this.taskAttempts.get(task.id) ?? 0) + 1
		this.taskAttempts.set(task.id, attempt)
		this.taskStartTimes.set(task.id, new Date().toISOString())

		// Atomically claim the task
		await this.beadsManager.claim(task.id)
		// If this task was pending release from a previous failure, clear the counter
		if (this.pendingReleases > 0 && attempt > 1) {
			this.pendingReleases--
		}
		logger.info(`Claimed task ${task.id}: ${task.title} (attempt ${attempt})`)

		// Store title for progress reporting
		this.taskTitles.set(task.id, task.title)

		// Create child loom (minimal worktree)
		const loom = await this.loomManager.createIloom({
			type: 'issue',
			identifier: this.parseIssueIdentifier(task.id),
			originalInput: task.id,
			baseBranch: epicLoom.epicBranch,
			parentLoom: {
				type: 'issue',
				identifier: epicLoom.epicIssueNumber,
				branchName: epicLoom.epicBranch,
				worktreePath: epicLoom.epicLoomPath,
			},
			options: {
				swarmMode: true,
			},
		})

		// Store loom path for later use by conflict resolver (after agent is removed from activeAgents)
		this.taskLoomPaths.set(task.id, loom.path)

		// Set up log file
		const logFile = path.join(logDir, `${task.id}.log`)
		const logStream = fs.createWriteStream(logFile, { flags: 'a' })

		// Spawn il spin -p in the child loom directory
		const childProcess = execa('il', ['spin', '-p'], {
			cwd: loom.path,
			env: {
				...process.env,
				ILOOM_SWARM_MODE: '1',
				ILOOM_EPIC_BRANCH: epicLoom.epicBranch,
				ILOOM_EPIC_ISSUE: epicLoom.epicIssueNumber,
			},
			reject: false,
			all: true,
		})

		// Pipe output to log file
		if (childProcess.all) {
			childProcess.all.pipe(logStream)
		}

		const agent: ActiveAgent = {
			issueId: task.id,
			pid: childProcess.pid ?? 0,
			loomPath: loom.path,
			logFile,
			process: childProcess,
			beadsTaskId: task.id,
			exitCode: null,
			logStream,
		}

		// Track process completion via callback
		childProcess.then(
			(r: { exitCode: number }) => { agent.exitCode = r.exitCode },
			() => { agent.exitCode = 1 },
		)

		this.activeAgents.set(task.id, agent)
		logger.info(`Spawned agent for issue ${task.id} (PID: ${agent.pid}) in ${loom.path}`)
	}

	/**
	 * Check for completed agent processes and handle their results.
	 * Includes retry logic for failed agents.
	 */
	private async checkCompletedAgents(
		result: SwarmResult,
		epicLoom: EpicLoomContext,
	): Promise<void> {
		for (const [issueId, agent] of this.activeAgents) {
			if (agent.exitCode === null) {
				continue
			}

			this.activeAgents.delete(issueId)

			// Close the log file stream to avoid leaking file descriptors
			try {
				agent.logStream.end()
			} catch {
				// Ignore errors closing log stream
			}

			if (agent.exitCode === 0) {
				logger.info(`Agent for issue ${issueId} completed successfully`)

				// Find the PR created by the agent
				let prNumber: number | null = null
				try {
					prNumber = await this.findPRForBranch(issueId, epicLoom)
				} catch (prSearchError) {
					// findPRForBranch only throws on unexpected errors (network, auth, rate limit).
					// Log the error and treat as "no PR found" to avoid losing the agent's work.
					logger.error(`Failed to search for PR for issue ${issueId}: ${prSearchError instanceof Error ? prSearchError.message : 'Unknown error'}`)
				}

				if (prNumber) {
					this.taskPRNumbers.set(issueId, prNumber)
					this.mergeQueue.push({
						issueId,
						prNumber,
						beadsTaskId: agent.beadsTaskId,
						loomPath: agent.loomPath,
					})
					logger.info(`Enqueued PR #${prNumber} for merge (issue ${issueId})`)
				} else {
					// Agent succeeded but no PR found - still mark as complete
					logger.warn(`Agent for issue ${issueId} completed but no PR found, marking task as closed`)
					await this.closeTask(agent.beadsTaskId, 'completed without PR')
					this.taskCompleteTimes.set(issueId, new Date().toISOString())
					result.completed++
				}
			} else {
				await this.handleAgentFailure(agent, result, epicLoom)
			}
		}
	}

	/**
	 * Handle a failed agent by releasing its claim and retrying if below maxRetries.
	 *
	 * Note on maxRetries semantics: maxRetries represents the total number of attempts allowed
	 * (not additional retries after the first). e.g., maxRetries=1 means 1 total attempt (no retries),
	 * maxRetries=2 means 2 total attempts (1 retry).
	 */
	private async handleAgentFailure(
		agent: ActiveAgent,
		result: SwarmResult,
		_epicLoom: EpicLoomContext,
	): Promise<void> {
		const issueId = agent.issueId
		const attempts = this.taskAttempts.get(issueId) ?? 1
		const failureReason = `Agent exited with code ${agent.exitCode}`

		logger.error(`Agent for issue ${issueId} failed with exit code ${agent.exitCode}. See log: ${agent.logFile}`)

		// Release the Beads claim
		try {
			await this.beadsManager.releaseClaim(agent.beadsTaskId)
		} catch (releaseError) {
			logger.error(`Failed to release claim for task ${agent.beadsTaskId}: ${releaseError instanceof Error ? releaseError.message : 'Unknown error'}`)
		}

		// Check if we should retry
		if (attempts < this.settings.maxRetries) {
			logger.info(`Retrying task ${issueId} (attempt ${attempts + 1} of ${this.settings.maxRetries})...`)
			// The task's claim was released, so it will appear in ready() on the next loop iteration
			// and be re-claimed and re-spawned. The attempt counter is already incremented.
			// Track as pending release so the supervisor doesn't exit prematurely before Beads
			// re-surfaces the task in ready().
			this.pendingReleases++
		} else {
			// Exhausted retries - mark as permanently failed
			logger.error(`Task ${issueId} failed after ${attempts} attempt(s). Marking as permanently failed.`)
			this.permanentlyFailed.add(issueId)

			// Mark as failed in Beads
			await this.closeTask(agent.beadsTaskId, `failed after ${attempts} attempts: ${failureReason}`)

			this.failures.push({
				issue: issueId,
				reason: failureReason,
				attempts,
			})

			result.failed++
		}
	}

	/**
	 * Process the merge queue sequentially - one PR at a time.
	 * Includes conflict detection and resolution.
	 */
	private async processMergeQueue(
		result: SwarmResult,
		epicLoom: EpicLoomContext,
	): Promise<void> {
		while (this.mergeQueue.length > 0) {
			const entry = this.mergeQueue.shift()
			if (!entry) break

			try {
				logger.info(`Merging PR #${entry.prNumber} for issue ${entry.issueId}...`)
				await this.mergePR(entry.prNumber)
				logger.info(`Successfully merged PR #${entry.prNumber}`)

				// Close the Beads task
				await this.closeTask(entry.beadsTaskId, `merged PR #${entry.prNumber}`)

				// Close the issue via GitHub
				await this.closeIssue(entry.issueId)

				this.taskCompleteTimes.set(entry.issueId, new Date().toISOString())
				this.conflictRetries.delete(entry.issueId)
				result.mergedPRs++
				result.completed++
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error'

				// Check if this is a merge conflict
				if (this.isMergeConflict(errorMessage)) {
					await this.handleMergeConflict(entry, result, epicLoom)
				} else {
					logger.error(`Failed to merge PR #${entry.prNumber} for issue ${entry.issueId}: ${errorMessage}`)
					result.failedMerges++
					result.failed++
					this.failures.push({
						issue: entry.issueId,
						reason: `Merge failed: ${errorMessage}`,
						attempts: this.taskAttempts.get(entry.issueId) ?? 1,
					})
				}
			}
		}
	}

	/**
	 * Detect whether a merge error is a conflict.
	 */
	private isMergeConflict(errorMessage: string): boolean {
		const conflictPatterns = [
			'merge conflict',
			'CONFLICT',
			'could not merge',
			'not possible to fast-forward',
			'conflicts',
		]
		const lowerMessage = errorMessage.toLowerCase()
		return conflictPatterns.some(pattern => lowerMessage.includes(pattern.toLowerCase()))
	}

	/**
	 * Handle a merge conflict by spawning a resolver agent.
	 *
	 * 1. Detect merge failure
	 * 2. Spawn a lightweight Claude Code agent to rebase and resolve
	 * 3. Retry merge after resolution
	 * 4. If still failing after maxConflictRetries, mark as failed
	 */
	private async handleMergeConflict(
		entry: MergeQueueEntry,
		result: SwarmResult,
		epicLoom: EpicLoomContext,
	): Promise<void> {
		const retries = this.conflictRetries.get(entry.issueId) ?? 0

		if (retries >= this.settings.maxConflictRetries) {
			logger.error(
				`Merge conflict for PR #${entry.prNumber} (issue ${entry.issueId}) could not be resolved after ${retries} attempt(s). Marking as failed.`,
			)
			result.failedMerges++
			result.failed++
			this.permanentlyFailed.add(entry.issueId)
			this.failures.push({
				issue: entry.issueId,
				reason: `Unresolvable merge conflict after ${retries} resolution attempts`,
				attempts: this.taskAttempts.get(entry.issueId) ?? 1,
			})
			return
		}

		this.conflictRetries.set(entry.issueId, retries + 1)
		logger.info(`Merge conflict detected for PR #${entry.prNumber}. Spawning resolver (attempt ${retries + 1} of ${this.settings.maxConflictRetries})...`)

		try {
			await this.spawnConflictResolver(entry, epicLoom)

			// Retry the merge after conflict resolution
			logger.info(`Retrying merge for PR #${entry.prNumber} after conflict resolution...`)
			await this.mergePR(entry.prNumber)
			logger.info(`Successfully merged PR #${entry.prNumber} after conflict resolution`)

			await this.closeTask(entry.beadsTaskId, `merged PR #${entry.prNumber} (after conflict resolution)`)
			await this.closeIssue(entry.issueId)

			this.taskCompleteTimes.set(entry.issueId, new Date().toISOString())
			this.conflictRetries.delete(entry.issueId)
			result.mergedPRs++
			result.completed++
		} catch (retryError) {
			const retryMessage = retryError instanceof Error ? retryError.message : 'Unknown error'

			if (this.isMergeConflict(retryMessage)) {
				// Still conflicting - re-enqueue for another attempt
				logger.warn(`PR #${entry.prNumber} still has conflicts after resolution attempt ${retries + 1}`)
				this.mergeQueue.push(entry)
			} else {
				logger.error(`Merge failed for PR #${entry.prNumber} after conflict resolution: ${retryMessage}`)
				result.failedMerges++
				result.failed++
				this.failures.push({
					issue: entry.issueId,
					reason: `Merge failed after conflict resolution: ${retryMessage}`,
					attempts: this.taskAttempts.get(entry.issueId) ?? 1,
				})
			}
		}
	}

	/**
	 * Spawn a lightweight Claude Code agent to resolve merge conflicts.
	 *
	 * The resolver rebases the branch onto the epic branch, resolves conflicts,
	 * and force-pushes.
	 */
	private async spawnConflictResolver(
		entry: MergeQueueEntry,
		epicLoom: EpicLoomContext,
	): Promise<void> {
		// Use the stored loom path for this task. By the time a task reaches the merge queue,
		// the agent has already been removed from activeAgents, so we use the loomPath stored
		// directly on the merge queue entry, or fall back to the taskLoomPaths map.
		const cwd = entry.loomPath ?? this.taskLoomPaths.get(entry.issueId) ?? epicLoom.epicLoomPath

		const resolverProcess = execa('il', ['spin', '-p'], {
			cwd,
			env: {
				...process.env,
				ILOOM_SWARM_MODE: '1',
				ILOOM_EPIC_BRANCH: epicLoom.epicBranch,
				ILOOM_EPIC_ISSUE: epicLoom.epicIssueNumber,
				ILOOM_CONFLICT_RESOLUTION: '1',
				ILOOM_CONFLICT_PR: String(entry.prNumber),
			},
			reject: false,
			all: true,
			timeout: 300000, // 5 minute timeout for conflict resolution
		})

		const resolverResult = await resolverProcess

		if (resolverResult.exitCode !== 0) {
			throw new Error(`Conflict resolver exited with code ${resolverResult.exitCode}`)
		}
	}

	/**
	 * Merge a PR into the epic branch using gh CLI.
	 */
	private async mergePR(prNumber: number): Promise<void> {
		await executeGhCommand(
			['pr', 'merge', String(prNumber), '--merge', '--delete-branch'],
		)
	}

	/**
	 * Close a GitHub issue via gh CLI.
	 */
	private async closeIssue(issueId: string): Promise<void> {
		try {
			await executeGhCommand(
				['issue', 'close', issueId],
			)
			logger.info(`Closed issue ${issueId}`)
		} catch (error) {
			// Log but don't fail - issue closure is not critical
			logger.warn(`Failed to close issue ${issueId}: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Close a Beads task with an optional reason.
	 */
	private async closeTask(taskId: string, reason?: string): Promise<void> {
		try {
			await this.beadsManager.close(taskId, reason)
		} catch (error) {
			logger.warn(`Failed to close Beads task ${taskId}: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Find a PR for a given issue branch.
	 * Looks for open PRs created by the swarm agent.
	 */
	private async findPRForBranch(issueId: string, _epicLoom: EpicLoomContext): Promise<number | null> {
		try {
			// Note: Searching by `issueId in:title` may match unrelated PRs if the issue ID
			// appears in other PR titles. A more robust approach would filter by head branch
			// pattern, but GitHub's search API doesn't support exact branch matching via `gh pr list --search`.
			const prList = await executeGhCommand<Array<{ number: number; headRefName: string }>>(
				['pr', 'list', '--state', 'open', '--json', 'number,headRefName', '--search', `is:pr is:open ${issueId} in:title`],
			)

			// Prefer PRs whose branch name contains the issue ID for more precise matching
			const exactMatch = prList.find(pr => pr.headRefName.includes(issueId))
			if (exactMatch) {
				return exactMatch.number
			}

			if (prList.length > 0 && prList[0]) {
				return prList[0].number
			}
			return null
		} catch (error: unknown) {
			// Only return null for "no PR found" scenarios (empty result from gh pr list).
			// gh pr list with --json returns exit code 0 with an empty array when no PRs match,
			// so a caught error here indicates an unexpected failure (network, auth, rate limit, etc.).
			// Propagate unexpected errors so callers can handle them appropriately.
			if (error instanceof Error) {
				// gh cli returns exit code 1 with no stderr for genuinely empty results in some edge cases
				const msg = error.message.toLowerCase()
				if (msg.includes('no pull requests match') || msg.includes('no open pull requests')) {
					return null
				}
			}
			throw error
		}
	}

	/**
	 * Wait for all remaining active agents to complete.
	 * Called during graceful shutdown.
	 */
	private async waitForRemainingAgents(
		result: SwarmResult,
		epicLoom: EpicLoomContext,
	): Promise<void> {
		const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000
		const shutdownDeadline = Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS

		while (this.activeAgents.size > 0) {
			await this.checkCompletedAgents(result, epicLoom)
			await this.processMergeQueue(result, epicLoom)

			if (this.activeAgents.size > 0) {
				if (Date.now() >= shutdownDeadline) {
					logger.warn(`Graceful shutdown timed out after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS / 1000}s. Force-killing ${this.activeAgents.size} remaining agent(s).`)
					for (const [, agent] of this.activeAgents) {
						try {
							agent.process.kill('SIGTERM')
						} catch {
							// Process may have already exited
						}
						try {
							agent.logStream.end()
						} catch {
							// Ignore log stream close errors
						}
					}
					this.activeAgents.clear()
					break
				}
				await sleep(2000)
			}
		}
	}

	/**
	 * Check if the supervisor loop should exit.
	 */
	private isComplete(): boolean {
		return this.shuttingDown && this.activeAgents.size === 0 && this.mergeQueue.length === 0
	}

	/**
	 * Parse an issue identifier from a Beads task ID.
	 * Task IDs may be numeric (GitHub) or alphanumeric (Linear).
	 */
	private parseIssueIdentifier(taskId: string): string | number {
		// Use strict regex to avoid parseInt truncating mixed-format IDs
		// e.g., parseInt("100-fix-login", 10) returns 100, which is wrong
		if (/^\d+$/.test(taskId)) {
			return parseInt(taskId, 10)
		}
		return taskId
	}

	/**
	 * Log a periodic progress summary to the terminal.
	 */
	private logProgressSummary(result: SwarmResult): void {
		logger.info(
			`Active: ${this.activeAgents.size}/${this.settings.maxConcurrent} | Completed: ${result.completed}/${result.totalTasks} | Failed: ${result.failed} | Blocked: ${this.permanentlyFailed.size}`,
		)
	}

	/**
	 * Write a progress file to disk. Called on every state change.
	 *
	 * Written to ~/.config/iloom-ai/looms/<epicLoomId>/swarm-progress.json
	 * where epicLoomId is derived from the epicLoomPath directory name.
	 */
	private async writeProgress(
		epicLoom: EpicLoomContext,
		result: SwarmResult,
		status: 'running' | 'completed' | 'failed' | 'paused',
	): Promise<void> {
		try {
			const progressDir = this.getProgressDir(epicLoom)
			await fs.ensureDir(progressDir)

			const progressFile = path.join(progressDir, 'swarm-progress.json')

			// Build DAG nodes from all known tasks
			const nodes: ProgressNode[] = []
			for (const [taskId, title] of this.taskTitles) {
				const agent = this.activeAgents.get(taskId)
				let taskStatus: ProgressNode['status'] = 'ready'

				if (this.taskCompleteTimes.has(taskId)) {
					taskStatus = 'completed'
				} else if (this.permanentlyFailed.has(taskId)) {
					taskStatus = 'failed'
				} else if (agent) {
					taskStatus = 'in_progress'
				} else if (this.mergeQueue.some(e => e.issueId === taskId)) {
					taskStatus = 'in_progress'
				}

				nodes.push({
					issue: taskId,
					title,
					status: taskStatus,
					agentPid: agent?.pid ?? null,
					logFile: agent?.logFile ?? (this.logDir ? path.join(this.logDir, `${taskId}.log`) : null),
					attempts: this.taskAttempts.get(taskId) ?? 0,
					prNumber: this.taskPRNumbers.get(taskId) ?? null,
					startedAt: this.taskStartTimes.get(taskId) ?? null,
					completedAt: this.taskCompleteTimes.get(taskId) ?? null,
				})
			}

			const inProgressCount = this.activeAgents.size + this.mergeQueue.length
			const failedCount = this.permanentlyFailed.size
			const completedCount = result.completed
			const readyCount = Math.max(0, result.totalTasks - completedCount - inProgressCount - failedCount)

			const progress: SwarmProgress = {
				epicIssue: epicLoom.epicIssueNumber,
				epicBranch: epicLoom.epicBranch,
				status,
				startedAt: this.startedAt,
				updatedAt: new Date().toISOString(),
				dag: {
					nodes,
					edges: [], // Edges could be populated from Beads dependency data in the future
				},
				stats: {
					total: result.totalTasks,
					completed: completedCount,
					inProgress: inProgressCount,
					failed: failedCount,
					blocked: 0, // Tasks blocked by failed dependencies
					ready: readyCount,
				},
				failures: [...this.failures],
			}

			// Write atomically: write to a temp file, then rename (atomic on POSIX).
			// This prevents readers from seeing partial JSON if they read mid-write.
			const tmpFile = progressFile + '.tmp'
			await fs.writeJson(tmpFile, progress, { spaces: 2 })
			await fs.rename(tmpFile, progressFile)
		} catch (error) {
			// Progress file writing should never fail the swarm
			logger.debug(`Failed to write progress file: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Get the progress directory for this epic.
	 */
	private getProgressDir(epicLoom: EpicLoomContext): string {
		const loomId = path.basename(epicLoom.epicLoomPath)
		return path.join(os.homedir(), '.config', 'iloom-ai', 'looms', loomId)
	}

	/**
	 * Install signal handlers for graceful shutdown.
	 */
	private installSignalHandlers(): void {
		if (this.signalHandlersInstalled) return

		this.handleSignal = this.handleSignal.bind(this)
		process.on('SIGINT', this.handleSignal)
		process.on('SIGTERM', this.handleSignal)
		this.signalHandlersInstalled = true
	}

	/**
	 * Remove signal handlers.
	 */
	private removeSignalHandlers(): void {
		if (!this.signalHandlersInstalled) return

		process.removeListener('SIGINT', this.handleSignal)
		process.removeListener('SIGTERM', this.handleSignal)
		this.signalHandlersInstalled = false
	}

	/**
	 * Handle SIGINT/SIGTERM for graceful shutdown.
	 */
	private handleSignal(): void {
		if (this.shuttingDown) {
			logger.warn('Forced shutdown requested. Killing child processes and exiting.')
			// Attempt to kill all active agent child processes before force exit
			for (const [, agent] of this.activeAgents) {
				try {
					agent.process.kill('SIGTERM')
				} catch {
					// Process may have already exited
				}
				try {
					agent.logStream.end()
				} catch {
					// Ignore log stream close errors
				}
			}
			// Brief grace period then force exit
			global.setTimeout(() => process.exit(1), 2000)
			return
		}

		this.shuttingDown = true
		logger.info(`Shutting down gracefully. Waiting for ${this.activeAgents.size} running agent(s) to complete...`)
	}

}
