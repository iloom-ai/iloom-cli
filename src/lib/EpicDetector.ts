import { getLogger } from '../utils/logger-context.js'
import type { IssueManagementProvider, ChildIssueResult, DependenciesResult } from '../mcp/types.js'
import type { Issue } from '../types/index.js'

/**
 * Result of epic detection analysis
 */
export interface EpicDetectionResult {
	/** Whether the issue qualifies as an epic for swarm mode */
	isEpic: boolean
	/** Total number of child issues */
	totalChildren: number
	/** Number of child issues that are ready (no open blockers) */
	readyChildren: number
	/** Number of child issues that are blocked */
	blockedChildren: number
	/** Whether the epic has dependency information between children */
	hasDependencies: boolean
	/** Warning message if label is present but conditions aren't fully met */
	warning?: string
}

/**
 * Detects whether an issue is an epic suitable for swarm mode.
 *
 * An issue qualifies as an epic when:
 * 1. It has the `iloom-epic` label
 * 2. It has child issues (sub-issues)
 * 3. Child issues have dependencies defined
 *
 * If the label is present but children or dependencies are missing,
 * warnings are returned to inform the user.
 */
export class EpicDetector {
	constructor(
		private readonly issueProvider: IssueManagementProvider,
	) {}

	/**
	 * Detect if an issue is an epic with child issues and dependencies.
	 *
	 * @param issue - The fetched issue data (must include labels)
	 * @param issueIdentifier - The issue identifier string (for API calls)
	 * @returns EpicDetectionResult with detection details
	 */
	async detect(issue: Issue, issueIdentifier: string): Promise<EpicDetectionResult> {
		// Check for iloom-epic label
		const hasEpicLabel = issue.labels.some(
			label => label.toLowerCase() === 'iloom-epic'
		)

		if (!hasEpicLabel) {
			return {
				isEpic: false,
				totalChildren: 0,
				readyChildren: 0,
				blockedChildren: 0,
				hasDependencies: false,
			}
		}

		getLogger().debug('Found iloom-epic label, checking for child issues...')

		// Fetch child issues
		let children: ChildIssueResult[]
		try {
			children = await this.issueProvider.getChildIssues({
				number: String(issueIdentifier),
			})
		} catch (error) {
			getLogger().warn(
				`Failed to fetch child issues: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
			return {
				isEpic: false,
				totalChildren: 0,
				readyChildren: 0,
				blockedChildren: 0,
				hasDependencies: false,
				warning: 'Issue has iloom-epic label but child issues could not be fetched.',
			}
		}

		// Filter to open children only
		const openChildren = children.filter(
			child => child.state === 'open' || child.state === 'OPEN'
		)

		if (openChildren.length === 0) {
			return {
				isEpic: false,
				totalChildren: children.length,
				readyChildren: 0,
				blockedChildren: 0,
				hasDependencies: false,
				warning: children.length === 0
					? 'Issue has iloom-epic label but no child issues. Proceeding as normal issue.'
					: 'Issue has iloom-epic label but all child issues are closed. Proceeding as normal issue.',
			}
		}

		// Fetch dependencies for each child to determine ready vs blocked
		let hasDependencies = false
		let readyCount = 0
		let blockedCount = 0

		for (const child of openChildren) {
			try {
				const deps: DependenciesResult = await this.issueProvider.getDependencies({
					number: child.id,
					direction: 'blocked_by',
				})

				// A child has dependencies if it is blocked by at least one issue
				const openBlockers = deps.blockedBy.filter(
					b => b.state === 'open' || b.state === 'OPEN'
				)

				if (deps.blockedBy.length > 0) {
					hasDependencies = true
				}

				if (openBlockers.length > 0) {
					blockedCount++
				} else {
					readyCount++
				}
			} catch (error) {
				// If dependencies can't be fetched, treat the child as ready
				getLogger().debug(
					`Failed to fetch dependencies for child ${child.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
				readyCount++
			}
		}

		const result: EpicDetectionResult = {
			isEpic: true,
			totalChildren: openChildren.length,
			readyChildren: readyCount,
			blockedChildren: blockedCount,
			hasDependencies,
		}

		if (!hasDependencies) {
			result.warning = 'Epic has child issues but no dependencies defined between them. All tasks will run in parallel.'
		}

		return result
	}
}
