import path from 'path'
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
}

/**
 * Tracks a PR ready to be merged into the epic branch
 */
export interface MergeQueueEntry {
	issueId: string
	prNumber: number
	beadsTaskId: string
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
 * Orchestrates headless Claude agents working on an epic's child issues.
 *
 * Uses Beads for DAG-based task ordering and atomic claiming.
 * Spawns `il spin -p` as child processes in minimal worktrees.
 * Merges PRs sequentially into the epic branch to prevent race conditions.
 *
 * Lifecycle:
 * 1. Init Beads and sync epic children into DAG
 * 2. Loop: claim ready tasks, spawn agents, monitor, merge PRs
 * 3. Complete when DAG is empty and no agents are running
 */
export class SwarmSupervisor {
	private activeAgents: Map<string, ActiveAgent> = new Map()
	private mergeQueue: MergeQueueEntry[] = []
	private shuttingDown = false
	private signalHandlersInstalled = false

	constructor(
		private readonly beadsManager: BeadsManager,
		private readonly syncService: BeadsSyncService,
		private readonly loomManager: LoomManager,
		private readonly settings: SwarmSettings,
	) {}

	/**
	 * Run the swarm supervisor loop.
	 *
	 * Orchestrates the full lifecycle: init, sync, claim, spawn, monitor, merge.
	 * Returns aggregate stats when all tasks are complete or shutdown is requested.
	 */
	async run(epicLoom: EpicLoomContext): Promise<SwarmResult> {
		const startTime = Date.now()
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

			// Step 3: Ensure agent-logs directory exists
			const logDir = path.join(epicLoom.epicLoomPath, 'agent-logs')
			await fs.ensureDir(logDir)

			// Step 4: Main supervisor loop
			while (!this.isComplete()) {
				// 4a: Query ready tasks
				const readyTasks = await this.beadsManager.ready()

				// 4b: Claim and spawn agents for unblocked tasks
				if (!this.shuttingDown) {
					const slotsAvailable = this.settings.maxConcurrent - this.activeAgents.size
					const tasksToClaim = readyTasks.slice(0, slotsAvailable)

					for (const task of tasksToClaim) {
						try {
							await this.claimAndSpawnAgent(task, epicLoom, logDir)
						} catch (error) {
							logger.error(`Failed to claim/spawn agent for task ${task.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
							result.failed++
						}
					}
				}

				// 4c: Check for completed agents
				await this.checkCompletedAgents(result, epicLoom)

				// 4d: Process merge queue
				await this.processMergeQueue(result, epicLoom)

				// 4e: Check if we're done
				if (readyTasks.length === 0 && this.activeAgents.size === 0 && this.mergeQueue.length === 0) {
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
		}

		logger.info(`Swarm complete: ${result.completed} completed, ${result.failed} failed, ${result.mergedPRs} PRs merged`)
		return result
	}

	/**
	 * Claim a Beads task and spawn an agent process for it.
	 */
	private async claimAndSpawnAgent(
		task: BeadsTask,
		epicLoom: EpicLoomContext,
		logDir: string,
	): Promise<void> {
		// Atomically claim the task
		await this.beadsManager.claim(task.id)
		logger.info(`Claimed task ${task.id}: ${task.title}`)

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

			if (agent.exitCode === 0) {
				logger.info(`Agent for issue ${issueId} completed successfully`)

				// Find the PR created by the agent
				const prNumber = await this.findPRForBranch(issueId, epicLoom)

				if (prNumber) {
					this.mergeQueue.push({
						issueId,
						prNumber,
						beadsTaskId: agent.beadsTaskId,
					})
					logger.info(`Enqueued PR #${prNumber} for merge (issue ${issueId})`)
				} else {
					// Agent succeeded but no PR found - still mark as complete
					logger.warn(`Agent for issue ${issueId} completed but no PR found, marking task as closed`)
					await this.closeTask(agent.beadsTaskId, 'completed without PR')
					result.completed++
				}
			} else {
				logger.error(`Agent for issue ${issueId} failed with exit code ${agent.exitCode}. See log: ${agent.logFile}`)
				result.failed++
				// Release claim so task can be retried (failure handling in #563)
				try {
					await this.beadsManager.releaseClaim(agent.beadsTaskId)
				} catch (releaseError) {
					logger.error(`Failed to release claim for task ${agent.beadsTaskId}: ${releaseError instanceof Error ? releaseError.message : 'Unknown error'}`)
				}
			}
		}
	}

	/**
	 * Process the merge queue sequentially - one PR at a time.
	 */
	private async processMergeQueue(
		result: SwarmResult,
		_epicLoom: EpicLoomContext,
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

				result.mergedPRs++
				result.completed++
			} catch (error) {
				logger.error(`Failed to merge PR #${entry.prNumber} for issue ${entry.issueId}: ${error instanceof Error ? error.message : 'Unknown error'}`)
				result.failedMerges++
				result.failed++
			}
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
			const prList = await executeGhCommand<Array<{ number: number }>>(
				['pr', 'list', '--state', 'open', '--json', 'number', '--search', `is:pr is:open ${issueId} in:title`],
			)

			if (prList.length > 0 && prList[0]) {
				return prList[0].number
			}
			return null
		} catch {
			return null
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
		while (this.activeAgents.size > 0) {
			await this.checkCompletedAgents(result, epicLoom)
			await this.processMergeQueue(result, epicLoom)

			if (this.activeAgents.size > 0) {
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
		const numericId = parseInt(taskId, 10)
		return isNaN(numericId) ? taskId : numericId
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
			logger.warn('Forced shutdown requested. Exiting immediately.')
			process.exit(1)
		}

		this.shuttingDown = true
		logger.info(`Shutting down gracefully. Waiting for ${this.activeAgents.size} running agent(s) to complete...`)
	}

}
