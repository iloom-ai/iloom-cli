import { logger } from '../utils/logger.js'
import type { BeadsManager } from './BeadsManager.js'
import type { IssueManagementProvider, DependenciesResult } from '../mcp/types.js'

/**
 * Mapping between issue tracker IDs and Beads task IDs
 */
export interface TaskMapping {
	issueId: string
	beadsTaskId: string
	title: string
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
	created: TaskMapping[]
	skipped: string[]
	dependenciesCreated: number
}

/**
 * Syncs GitHub/Linear child issues and their dependency graph into a Beads DAG.
 *
 * Handles re-sync by skipping tasks that already exist in Beads (for resume scenarios).
 * Only syncs open issues; closed issues are skipped.
 */
export class BeadsSyncService {
	constructor(
		private readonly beadsManager: BeadsManager,
		private readonly issueProvider: IssueManagementProvider,
	) {}

	/**
	 * Sync an epic's child issues and dependencies into Beads.
	 *
	 * 1. Fetches child issues via issue tracker API
	 * 2. Fetches dependency graph for each child
	 * 3. Creates Beads tasks for each open child issue (skipping existing)
	 * 4. Creates Beads dependencies matching the issue tracker graph
	 *
	 * @param epicId - The parent epic issue identifier
	 * @returns SyncResult with created tasks, skipped tasks, and dependency count
	 */
	async syncEpicToBeads(epicId: string): Promise<SyncResult> {
		logger.debug('Starting Beads sync for epic', { epicId })

		// Step 1: Fetch child issues
		const children = await this.issueProvider.getChildIssues({ number: epicId })
		logger.debug('Fetched child issues', { count: children.length })

		// Filter to only open issues
		const openChildren = children.filter(child => child.state === 'open' || child.state === 'OPEN')
		logger.debug('Open child issues', { count: openChildren.length })

		// Step 2: Get existing Beads tasks to detect already-synced issues
		let existingTaskIds: Set<string>
		try {
			const readyTasks = await this.beadsManager.ready()
			existingTaskIds = new Set(readyTasks.map(t => t.id))
		} catch {
			// If ready() fails (e.g., no tasks yet), start with empty set
			existingTaskIds = new Set()
		}

		// Step 3: Create Beads tasks for each open child issue
		const created: TaskMapping[] = []
		const skipped: string[] = []

		for (const child of openChildren) {
			if (existingTaskIds.has(child.id)) {
				logger.debug('Skipping already-synced task', { issueId: child.id })
				skipped.push(child.id)
				continue
			}

			try {
				const beadsTaskId = await this.beadsManager.create(child.title, {
					id: child.id,
				})
				created.push({
					issueId: child.id,
					beadsTaskId,
					title: child.title,
				})
				logger.debug('Created Beads task', { issueId: child.id, beadsTaskId })
			} catch (error) {
				// If task creation fails with "already exists", skip it
				if (error instanceof Error && error.message.includes('already exists')) {
					logger.debug('Task already exists in Beads, skipping', { issueId: child.id })
					skipped.push(child.id)
				} else {
					throw error
				}
			}
		}

		// Step 4: Sync dependencies
		let dependenciesCreated = 0
		const childIds = new Set(openChildren.map(c => c.id))

		for (const child of openChildren) {
			try {
				const deps = await this.fetchDependencies(child.id)

				for (const blocker of deps.blockedBy) {
					// Only create dependencies between children of this epic
					if (!childIds.has(blocker.id)) {
						logger.debug('Skipping dependency - blocker not in epic', {
							child: child.id,
							blocker: blocker.id,
						})
						continue
					}

					try {
						await this.beadsManager.addDependency(child.id, blocker.id)
						dependenciesCreated++
						logger.debug('Created Beads dependency', {
							child: child.id,
							parent: blocker.id,
						})
					} catch (error) {
						// If dependency already exists, skip
						if (error instanceof Error && error.message.includes('already exists')) {
							logger.debug('Dependency already exists, skipping', {
								child: child.id,
								parent: blocker.id,
							})
						} else {
							throw error
						}
					}
				}
			} catch (error) {
				// Log but don't fail sync for individual dependency fetch failures
				logger.warn(`Failed to fetch dependencies for issue ${child.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		}

		const result: SyncResult = {
			created,
			skipped,
			dependenciesCreated,
		}

		logger.info(
			`Beads sync complete: ${created.length} tasks created, ${skipped.length} skipped, ${dependenciesCreated} dependencies`,
		)

		return result
	}

	/**
	 * Fetch dependencies for a single issue
	 */
	private async fetchDependencies(issueId: string): Promise<DependenciesResult> {
		return this.issueProvider.getDependencies({
			number: issueId,
			direction: 'both',
		})
	}
}
