/**
 * SwarmReportCollector: Aggregates implementation data from child issues and recap files
 *
 * This service collects structured per-child implementation data for use in
 * epic swarm implementation reports. It gathers:
 * 1. Issue title and implementation comments from the issue tracker
 * 2. Recap file data (decisions, risks, assumptions, insights) from disk
 */

import fs from 'fs-extra'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import type { IssueManagementProvider, IssueProvider } from '../mcp/types.js'
import type { IloomSettings } from './SettingsManager.js'
import { MetadataManager } from './MetadataManager.js'
import { resolveRecapFilePath } from '../utils/mcp.js'
import type { RecapFile, RecapOutput } from '../mcp/recap-types.js'
import { formatRecapMarkdown } from '../utils/recap-formatter.js'
import { getLogger } from '../utils/logger-context.js'

export interface ChildImplementationData {
	issueNumber: string
	title: string
	status: 'success' | 'failure' | 'missing'
	implementationComment: string | null
	recapMarkdown: string | null
}

// Concurrency limit for API calls
const CONCURRENCY_LIMIT = 5

/**
 * Read and format the recap file for a worktree path.
 * Returns formatted recap markdown or null if not found/empty/error.
 * Shared between SwarmReportCollector and SessionSummaryService.
 */
export async function readRecapForWorktree(worktreePath: string): Promise<string | null> {
	try {
		const filePath = resolveRecapFilePath(worktreePath)
		if (!(await fs.pathExists(filePath))) return null

		const content = await fs.readFile(filePath, 'utf8')
		const recap = JSON.parse(content) as RecapFile

		const hasGoal = recap.goal !== null && recap.goal !== undefined
		const hasComplexity = recap.complexity !== null && recap.complexity !== undefined
		const hasEntries = Array.isArray(recap.entries) && recap.entries.length > 0
		const hasArtifacts = Array.isArray(recap.artifacts) && recap.artifacts.length > 0
		const hasContent = hasGoal || hasComplexity || hasEntries || hasArtifacts

		if (!hasContent) return null

		const recapOutput: RecapOutput = {
			filePath,
			goal: recap.goal ?? null,
			complexity: recap.complexity ?? null,
			entries: recap.entries ?? [],
			artifacts: recap.artifacts ?? [],
		}
		return formatRecapMarkdown(recapOutput)
	} catch {
		// Graceful degradation - return null on any error
		return null
	}
}

export class SwarmReportCollector {
	private metadataManager: MetadataManager

	constructor(metadataManager?: MetadataManager) {
		this.metadataManager = metadataManager ?? new MetadataManager()
	}

	/**
	 * Collect implementation data from child issues and their recap files.
	 *
	 * @param childIssueNumbers - Array of child issue identifiers to collect data for
	 * @param epicWorktreePath - Worktree path of the parent epic loom
	 * @param settings - IloomSettings for configuring the issue management provider
	 * @returns Array of ChildImplementationData, one per child
	 */
	async collectChildData(
		childIssueNumbers: string[],
		epicWorktreePath: string,
		settings: IloomSettings
	): Promise<ChildImplementationData[]> {
		if (childIssueNumbers.length === 0) return []

		// Create issue management provider from settings
		const providerType = (settings.issueManagement?.provider ?? 'github') as IssueProvider
		const provider = IssueManagementProviderFactory.create(providerType, settings)

		// Build map of issueNumber -> worktreePath from loom metadata
		const worktreeMap = await this.buildChildWorktreeMap(childIssueNumbers, epicWorktreePath)

		// Process children in batches using Promise.allSettled for bounded concurrency
		const results: ChildImplementationData[] = []
		for (let i = 0; i < childIssueNumbers.length; i += CONCURRENCY_LIMIT) {
			const batch = childIssueNumbers.slice(i, i + CONCURRENCY_LIMIT)
			const batchResults = await Promise.allSettled(
				batch.map(num => this.fetchChildData(num, provider, worktreeMap))
			)
			for (let j = 0; j < batchResults.length; j++) {
				const result = batchResults[j]
				const issueNumber = batch[j] ?? '?'
				if (!result) continue
				if (result.status === 'fulfilled') {
					results.push(result.value)
				} else {
					// fetchChildData catches internally; this branch is a defensive fallback
					getLogger().error(
						`SwarmReportCollector: unexpected rejection for issue ${issueNumber}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
					)
					results.push({
						issueNumber,
						title: 'Unknown',
						status: 'failure',
						implementationComment: null,
						recapMarkdown: null,
					})
				}
			}
		}
		return results
	}

	/**
	 * Build a map of issueNumber -> worktreePath by scanning all loom metadata
	 * for children whose parentLoom.worktreePath matches the epic worktree.
	 */
	private async buildChildWorktreeMap(
		childIssueNumbers: string[],
		epicWorktreePath: string
	): Promise<Map<string, string>> {
		const map = new Map<string, string>()
		try {
			const allMetadata = await this.metadataManager.listAllMetadata()
			for (const metadata of allMetadata) {
				// Only consider child looms that belong to this epic
				if (metadata.parentLoom?.worktreePath !== epicWorktreePath) continue
				if (!metadata.worktreePath) continue

				// Map each issue number associated with this child loom
				for (const issueNum of metadata.issue_numbers) {
					if (childIssueNumbers.includes(issueNum)) {
						map.set(issueNum, metadata.worktreePath)
					}
				}
			}
		} catch (error) {
			getLogger().debug(
				`SwarmReportCollector: failed to build worktree map: ${error instanceof Error ? error.message : String(error)}`
			)
		}
		return map
	}

	/**
	 * Fetch issue data and recap for a single child.
	 * Returns status='failure' on API errors, status='missing' when issue has no comments.
	 */
	private async fetchChildData(
		issueNumber: string,
		provider: IssueManagementProvider,
		worktreeMap: Map<string, string>
	): Promise<ChildImplementationData> {
		try {
			const issue = await provider.getIssue({ number: issueNumber, includeComments: true })

			const comments = issue.comments ?? []
			const implementationComment = this.extractImplementationComment(comments)

			const worktreePath = worktreeMap.get(issueNumber) ?? null
			const recapMarkdown = worktreePath ? await this.readChildRecap(worktreePath) : null

			// Determine status based on issue state and comments:
			// - No comments at all: 'missing' (child may not have started)
			// - Issue closed (state includes 'closed' or 'done'): 'success' (completed normally)
			// - Issue still open with comments: 'failure' (child started but didn't finish)
			let status: 'success' | 'failure' | 'missing'
			if (comments.length === 0) {
				status = 'missing'
			} else {
				const issueState = issue.state.toLowerCase()
				status = (issueState === 'closed' || issueState === 'done') ? 'success' : 'failure'
			}

			return {
				issueNumber,
				title: issue.title,
				status,
				implementationComment,
				recapMarkdown,
			}
		} catch (error) {
			getLogger().debug(
				`SwarmReportCollector: failed to fetch data for issue ${issueNumber}: ${error instanceof Error ? error.message : String(error)}`
			)
			return {
				issueNumber,
				title: 'Unknown',
				status: 'failure',
				implementationComment: null,
				recapMarkdown: null,
			}
		}
	}

	/**
	 * Extract the implementation comment from an issue's comment list.
	 * Prefers comments that contain implementation markers; falls back to the last comment.
	 */
	private extractImplementationComment(
		comments: Array<{ id: string; body: string; author: unknown; createdAt: string; [key: string]: unknown }>
	): string | null {
		if (comments.length === 0) return null

		// Prefer a comment with clear implementation markers
		const implementationMarkers = [
			'implementation complete',
			'# implementation',
			'## summary',
			'changes made',
			'validation results',
		]

		for (let i = comments.length - 1; i >= 0; i--) {
			const comment = comments[i]
			if (!comment) continue
			const body = comment.body.toLowerCase()
			if (implementationMarkers.some(marker => body.includes(marker))) {
				return comment.body
			}
		}

		// Fall back to the last comment
		const lastComment = comments[comments.length - 1]
		return lastComment ? lastComment.body : null
	}

	/**
	 * Read and format the recap file for a child worktree path.
	 * Returns null if the recap file is missing or cannot be read.
	 */
	private async readChildRecap(worktreePath: string): Promise<string | null> {
		return readRecapForWorktree(worktreePath)
	}
}
