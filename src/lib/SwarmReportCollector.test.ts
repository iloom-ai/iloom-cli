import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SwarmReportCollector } from './SwarmReportCollector.js'
import type { MetadataManager, LoomMetadata } from './MetadataManager.js'
import type { IssueManagementProvider, IssueResult } from '../mcp/types.js'
import type { IloomSettings } from './SettingsManager.js'

// Mock IssueManagementProviderFactory
vi.mock('../mcp/IssueManagementProviderFactory.js', () => ({
	IssueManagementProviderFactory: {
		create: vi.fn(),
	},
}))

// Mock resolveRecapFilePath from mcp utils
vi.mock('../utils/mcp.js', () => ({
	resolveRecapFilePath: vi.fn(),
	slugifyPath: vi.fn(),
	readRecapFile: vi.fn(),
}))

// Mock formatRecapMarkdown
vi.mock('../utils/recap-formatter.js', () => ({
	formatRecapMarkdown: vi.fn(),
}))

// Mock fs-extra
vi.mock('fs-extra', () => ({
	default: {
		pathExists: vi.fn(),
		readFile: vi.fn(),
	},
}))

// Mock logger-context
vi.mock('../utils/logger-context.js', () => ({
	getLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	})),
}))

import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { resolveRecapFilePath } from '../utils/mcp.js'
import { formatRecapMarkdown } from '../utils/recap-formatter.js'
import fs from 'fs-extra'

// Helpers
function makeIssueResult(overrides: Partial<IssueResult> & { comments?: IssueResult['comments'] } = {}): IssueResult {
	return {
		id: '1',
		title: 'Test Issue',
		body: 'Issue body',
		state: 'open',
		url: 'https://github.com/example/repo/issues/1',
		provider: 'github',
		author: null,
		comments: [],
		...overrides,
	}
}

function makeMetadata(overrides: Partial<LoomMetadata> = {}): LoomMetadata {
	return {
		description: 'Child loom',
		created_at: '2024-01-01T00:00:00Z',
		branchName: 'feat/issue-100__child',
		worktreePath: '/path/to/child',
		issueType: 'issue',
		issueKey: null,
		issue_numbers: ['100'],
		pr_numbers: [],
		issueTracker: 'github',
		colorHex: '#dcebff',
		sessionId: 'session-123',
		projectPath: '/path/to/project',
		issueUrls: {},
		prUrls: {},
		draftPrNumber: null,
		oneShot: null,
		dangerouslySkipPermissions: false,
		complexity: null,
		capabilities: [],
		state: null,
		childIssueNumbers: [],
		parentLoom: {
			type: 'epic',
			identifier: 42,
			branchName: 'feat/epic-42',
			worktreePath: '/path/to/epic',
		},
		childIssues: [],
		dependencyMap: {},
		mcpConfigPath: null,
		swarmTeamName: null,
		...overrides,
	}
}

const defaultSettings: IloomSettings = {
	issueManagement: {
		provider: 'github',
	},
}

describe('SwarmReportCollector', () => {
	let mockProvider: IssueManagementProvider
	let mockMetadataManager: MetadataManager
	let collector: SwarmReportCollector

	beforeEach(() => {
		mockProvider = {
			providerName: 'github',
			issuePrefix: '#',
			getIssue: vi.fn(),
			getPR: vi.fn(),
			getComment: vi.fn(),
			createComment: vi.fn(),
			updateComment: vi.fn(),
			createIssue: vi.fn(),
			createChildIssue: vi.fn(),
			createDependency: vi.fn(),
			getDependencies: vi.fn(),
			removeDependency: vi.fn(),
			getChildIssues: vi.fn(),
			closeIssue: vi.fn(),
			reopenIssue: vi.fn(),
			editIssue: vi.fn(),
		} as unknown as IssueManagementProvider

		mockMetadataManager = {
			listAllMetadata: vi.fn().mockResolvedValue([]),
			readMetadata: vi.fn(),
			writeMetadata: vi.fn(),
			deleteMetadata: vi.fn(),
			slugifyPath: vi.fn(),
			getMetadataFilePath: vi.fn(),
		} as unknown as MetadataManager

		vi.mocked(IssueManagementProviderFactory.create).mockReturnValue(mockProvider)
		vi.mocked(fs.pathExists).mockResolvedValue(false as never)
		vi.mocked(fs.readFile).mockResolvedValue('{}' as never)
		vi.mocked(resolveRecapFilePath).mockReturnValue('/path/to/recaps/child.json')
		vi.mocked(formatRecapMarkdown).mockReturnValue('# Loom Recap\n\n## Goal\nDone')

		collector = new SwarmReportCollector(mockMetadataManager)
	})

	describe('collectChildData', () => {
		it('returns empty array when childIssueNumbers is empty', async () => {
			const result = await collector.collectChildData([], '/path/to/epic', defaultSettings)
			expect(result).toEqual([])
		})

		it('returns ChildImplementationData[] with title, comment, and recap for each child', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({
					title: 'Feature A',
					state: 'closed',
					comments: [{ id: '1', body: '# Implementation Complete\nDone!', author: null, createdAt: '2024-01-01' }],
				})
			)
			vi.mocked(mockMetadataManager.listAllMetadata).mockResolvedValue([
				makeMetadata({ issue_numbers: ['100'], worktreePath: '/path/to/child' }),
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({ goal: 'Implement feature', entries: [{ id: '1', timestamp: '', type: 'decision', content: 'Used approach X' }], artifacts: [] }) as never
			)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)

			expect(result).toHaveLength(1)
			expect(result[0].issueNumber).toBe('100')
			expect(result[0].title).toBe('Feature A')
			expect(result[0].status).toBe('success')
			expect(result[0].implementationComment).toBe('# Implementation Complete\nDone!')
			expect(result[0].recapMarkdown).toBe('# Loom Recap\n\n## Goal\nDone')
		})

		it('returns status "success" when both comment and recap data are available', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({
					state: 'closed',
					comments: [{ id: '1', body: 'Implementation summary', author: null, createdAt: '2024-01-01' }],
				})
			)
			vi.mocked(mockMetadataManager.listAllMetadata).mockResolvedValue([
				makeMetadata({ issue_numbers: ['100'] }),
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({ goal: 'Test goal', entries: [], artifacts: [] }) as never
			)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].status).toBe('success')
			expect(result[0].recapMarkdown).toBe('# Loom Recap\n\n## Goal\nDone')
		})

		it('returns status "success" with null recapMarkdown when recap file is missing', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({
					state: 'closed',
					comments: [{ id: '1', body: 'Implementation summary', author: null, createdAt: '2024-01-01' }],
				})
			)
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].status).toBe('success')
			expect(result[0].recapMarkdown).toBeNull()
		})

		it('returns status "failure" when issue fetch throws an API error', async () => {
			vi.mocked(mockProvider.getIssue).mockRejectedValue(new Error('API rate limit exceeded'))

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].status).toBe('failure')
			expect(result[0].implementationComment).toBeNull()
			expect(result[0].recapMarkdown).toBeNull()
		})

		it('returns status "missing" when issue has no comments', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({ comments: [] })
			)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].status).toBe('missing')
			expect(result[0].implementationComment).toBeNull()
		})

		it('handles mixed results - some succeed, some fail, some missing', async () => {
			vi.mocked(mockProvider.getIssue)
				.mockResolvedValueOnce(
					makeIssueResult({
						id: '100',
						title: 'Issue 100',
						state: 'closed',
						comments: [{ id: '1', body: 'Implementation complete', author: null, createdAt: '2024-01-01' }],
					})
				)
				.mockRejectedValueOnce(new Error('Not found'))
				.mockResolvedValueOnce(
					makeIssueResult({ id: '102', title: 'Issue 102', comments: [] })
				)

			const result = await collector.collectChildData(['100', '101', '102'], '/path/to/epic', defaultSettings)

			expect(result).toHaveLength(3)
			expect(result[0].status).toBe('success')
			expect(result[1].status).toBe('failure')
			expect(result[2].status).toBe('missing')
		})

		it('extracts implementation comment using markers over last comment when marker match found', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({
					comments: [
						{ id: '1', body: 'Starting work on this issue', author: null, createdAt: '2024-01-01' },
						{ id: '2', body: '# Implementation Complete\n\n## Summary\nDone the work.', author: null, createdAt: '2024-01-02' },
						{ id: '3', body: 'Looks good!', author: null, createdAt: '2024-01-03' },
					],
				})
			)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			// Should find comment with implementation markers, not the last one
			expect(result[0].implementationComment).toBe('# Implementation Complete\n\n## Summary\nDone the work.')
		})

		it('falls back to last comment when no implementation markers found', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({
					comments: [
						{ id: '1', body: 'First comment', author: null, createdAt: '2024-01-01' },
						{ id: '2', body: 'Last comment - final update', author: null, createdAt: '2024-01-02' },
					],
				})
			)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].implementationComment).toBe('Last comment - final update')
		})

		it('limits concurrency by processing children in batches of 5', async () => {
			const issueNumbers = ['100', '101', '102', '103', '104', '105', '106']
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({ comments: [] })
			)

			const result = await collector.collectChildData(issueNumbers, '/path/to/epic', defaultSettings)

			// All children processed
			expect(result).toHaveLength(7)
			expect(mockProvider.getIssue).toHaveBeenCalledTimes(7)
		})

		it('gracefully handles all children failing - returns all with failure status', async () => {
			vi.mocked(mockProvider.getIssue).mockRejectedValue(new Error('Service unavailable'))

			const result = await collector.collectChildData(['100', '101', '102'], '/path/to/epic', defaultSettings)

			expect(result).toHaveLength(3)
			expect(result.every(r => r.status === 'failure')).toBe(true)
		})

		it('passes settings to IssueManagementProviderFactory.create()', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(makeIssueResult({ comments: [] }))
			const customSettings: IloomSettings = {
				issueManagement: { provider: 'linear' },
			}

			await collector.collectChildData(['100'], '/path/to/epic', customSettings)

			expect(IssueManagementProviderFactory.create).toHaveBeenCalledWith('linear', customSettings)
		})

		it('uses MetadataManager to resolve child worktree paths from issue numbers', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({ comments: [{ id: '1', body: 'Done', author: null, createdAt: '2024-01-01' }] })
			)
			vi.mocked(mockMetadataManager.listAllMetadata).mockResolvedValue([
				makeMetadata({ issue_numbers: ['100'], worktreePath: '/specific/child/path' }),
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({ goal: 'goal', entries: [], artifacts: [] }) as never
			)

			await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)

			expect(mockMetadataManager.listAllMetadata).toHaveBeenCalled()
			expect(resolveRecapFilePath).toHaveBeenCalledWith('/specific/child/path')
		})

		it('returns null recapMarkdown when child has no matching loom metadata', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({ comments: [{ id: '1', body: 'Done', author: null, createdAt: '2024-01-01' }] })
			)
			// No metadata matching this issue
			vi.mocked(mockMetadataManager.listAllMetadata).mockResolvedValue([])

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].recapMarkdown).toBeNull()
		})

		it('does not include metadata from different epic worktrees', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({ comments: [{ id: '1', body: 'Done', author: null, createdAt: '2024-01-01' }] })
			)
			// Metadata belongs to a different epic
			vi.mocked(mockMetadataManager.listAllMetadata).mockResolvedValue([
				makeMetadata({
					issue_numbers: ['100'],
					worktreePath: '/path/to/other-child',
					parentLoom: {
						type: 'epic',
						identifier: 999,
						branchName: 'feat/epic-999',
						worktreePath: '/path/to/different-epic', // Different from our epic
					},
				}),
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			// Recap should be null since the metadata belongs to a different epic
			expect(result[0].recapMarkdown).toBeNull()
		})

		it('returns null recapMarkdown when recap file has no meaningful content', async () => {
			vi.mocked(mockProvider.getIssue).mockResolvedValue(
				makeIssueResult({ comments: [{ id: '1', body: 'Done', author: null, createdAt: '2024-01-01' }] })
			)
			vi.mocked(mockMetadataManager.listAllMetadata).mockResolvedValue([
				makeMetadata({ issue_numbers: ['100'] }),
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			// Empty recap file with no meaningful content
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ entries: [], artifacts: [] }) as never)

			const result = await collector.collectChildData(['100'], '/path/to/epic', defaultSettings)
			expect(result[0].recapMarkdown).toBeNull()
		})
	})
})
