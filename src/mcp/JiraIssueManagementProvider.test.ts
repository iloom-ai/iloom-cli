import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JiraIssueManagementProvider } from './JiraIssueManagementProvider.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import type { JiraIssueLink, JiraIssue } from '../lib/providers/jira/JiraApiClient.js'

// Mock JiraIssueTracker
vi.mock('../lib/providers/jira/JiraIssueTracker.js', () => {
	return {
		JiraIssueTracker: vi.fn(),
	}
})

// Mock SettingsManager
vi.mock('../lib/SettingsManager.js', () => {
	return {
		SettingsManager: vi.fn(),
	}
})

// Helper to create a mock JiraIssueLink
function makeBlocksLink(opts: {
	id: string
	inwardKey?: string
	inwardSummary?: string
	outwardKey?: string
	outwardSummary?: string
}): JiraIssueLink {
	return {
		id: opts.id,
		type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
		...(opts.inwardKey && {
			inwardIssue: {
				id: `id-${opts.inwardKey}`,
				key: opts.inwardKey,
				fields: {
					summary: opts.inwardSummary ?? `Summary for ${opts.inwardKey}`,
					status: { name: 'Open' },
				},
			},
		}),
		...(opts.outwardKey && {
			outwardIssue: {
				id: `id-${opts.outwardKey}`,
				key: opts.outwardKey,
				fields: {
					summary: opts.outwardSummary ?? `Summary for ${opts.outwardKey}`,
					status: { name: 'In Progress' },
				},
			},
		}),
	}
}

describe('JiraIssueManagementProvider - dependencies', () => {
	let provider: JiraIssueManagementProvider
	let mockCreateIssueLink: ReturnType<typeof vi.fn>
	let mockGetIssue: ReturnType<typeof vi.fn>
	let mockDeleteIssueLink: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockCreateIssueLink = vi.fn().mockResolvedValue(undefined)
		mockGetIssue = vi.fn()
		mockDeleteIssueLink = vi.fn().mockResolvedValue(undefined)

		const mockApiClient = {
			createIssueLink: mockCreateIssueLink,
			getIssue: mockGetIssue,
			deleteIssueLink: mockDeleteIssueLink,
		}

		const mockTracker = {
			normalizeIdentifier: (id: string) => id.toUpperCase(),
			getApiClient: () => mockApiClient,
			getConfig: () => ({ host: 'https://jira.example.com' }),
		}

		// Create provider and inject mock tracker via private field
		const settings = {
			issueManagement: {
				jira: {
					host: 'https://jira.example.com',
					username: 'user',
					apiToken: 'token',
					projectKey: 'PROJ',
				},
			},
		}

		provider = new JiraIssueManagementProvider(settings as IloomSettings)
		// Override the private tracker with our mock
		;(provider as unknown as { tracker: typeof mockTracker }).tracker = mockTracker
	})

	describe('createDependency', () => {
		it('passes blockingKey as inwardKey and blockedKey as outwardKey to createIssueLink', async () => {
			await provider.createDependency({ blockingIssue: 'PROJ-1', blockedIssue: 'PROJ-2' })

			expect(mockCreateIssueLink).toHaveBeenCalledWith('PROJ-1', 'PROJ-2', 'Blocks')
		})

		it('normalizes identifiers to uppercase', async () => {
			await provider.createDependency({ blockingIssue: 'proj-1', blockedIssue: 'proj-2' })

			expect(mockCreateIssueLink).toHaveBeenCalledWith('PROJ-1', 'PROJ-2', 'Blocks')
		})
	})

	describe('getDependencies', () => {
		it('maps outwardIssue to blocking and inwardIssue to blockedBy', async () => {
			mockGetIssue.mockResolvedValue({
				fields: {
					issuelinks: [
						// outwardIssue = this issue blocks PROJ-2
						makeBlocksLink({ id: 'link-1', outwardKey: 'PROJ-2' }),
						// inwardIssue = PROJ-3 blocks this issue (this issue is blocked by PROJ-3)
						makeBlocksLink({ id: 'link-2', inwardKey: 'PROJ-3' }),
					],
				},
			} as Partial<JiraIssue>)

			const result = await provider.getDependencies({ number: 'PROJ-1', direction: 'both' })

			expect(result.blocking).toHaveLength(1)
			expect(result.blocking[0].id).toBe('PROJ-2')
			expect(result.blockedBy).toHaveLength(1)
			expect(result.blockedBy[0].id).toBe('PROJ-3')
		})

		it('filters by direction=blocking (returns only blocking, empty blockedBy)', async () => {
			mockGetIssue.mockResolvedValue({
				fields: {
					issuelinks: [
						makeBlocksLink({ id: 'link-1', outwardKey: 'PROJ-2' }),
						makeBlocksLink({ id: 'link-2', inwardKey: 'PROJ-3' }),
					],
				},
			} as Partial<JiraIssue>)

			const result = await provider.getDependencies({ number: 'PROJ-1', direction: 'blocking' })

			expect(result.blocking).toHaveLength(1)
			expect(result.blocking[0].id).toBe('PROJ-2')
			expect(result.blockedBy).toHaveLength(0)
		})

		it('filters by direction=blocked_by (returns only blockedBy, empty blocking)', async () => {
			mockGetIssue.mockResolvedValue({
				fields: {
					issuelinks: [
						makeBlocksLink({ id: 'link-1', outwardKey: 'PROJ-2' }),
						makeBlocksLink({ id: 'link-2', inwardKey: 'PROJ-3' }),
					],
				},
			} as Partial<JiraIssue>)

			const result = await provider.getDependencies({ number: 'PROJ-1', direction: 'blocked_by' })

			expect(result.blocking).toHaveLength(0)
			expect(result.blockedBy).toHaveLength(1)
			expect(result.blockedBy[0].id).toBe('PROJ-3')
		})

		it('ignores non-Blocks link types', async () => {
			mockGetIssue.mockResolvedValue({
				fields: {
					issuelinks: [
						{
							id: 'link-1',
							type: { id: '10001', name: 'Relates', inward: 'relates to', outward: 'relates to' },
							outwardIssue: {
								id: 'id-PROJ-2',
								key: 'PROJ-2',
								fields: { summary: 'Related issue', status: { name: 'Open' } },
							},
						},
					],
				},
			} as Partial<JiraIssue>)

			const result = await provider.getDependencies({ number: 'PROJ-1', direction: 'both' })

			expect(result.blocking).toHaveLength(0)
			expect(result.blockedBy).toHaveLength(0)
		})
	})

	describe('removeDependency', () => {
		it('finds link by matching inwardIssue.key to blockingKey and deletes it', async () => {
			mockGetIssue.mockResolvedValue({
				fields: {
					issuelinks: [
						// On blocked issue PROJ-2, the blocker PROJ-1 appears as inwardIssue
						makeBlocksLink({ id: 'link-42', inwardKey: 'PROJ-1' }),
					],
				},
			} as Partial<JiraIssue>)

			await provider.removeDependency({ blockingIssue: 'PROJ-1', blockedIssue: 'PROJ-2' })

			expect(mockGetIssue).toHaveBeenCalledWith('PROJ-2')
			expect(mockDeleteIssueLink).toHaveBeenCalledWith('link-42')
		})

		it('throws when no matching dependency found', async () => {
			mockGetIssue.mockResolvedValue({
				fields: {
					issuelinks: [],
				},
			} as Partial<JiraIssue>)

			await expect(
				provider.removeDependency({ blockingIssue: 'PROJ-1', blockedIssue: 'PROJ-2' })
			).rejects.toThrow('No "Blocks" dependency found from PROJ-1 to PROJ-2')
		})
	})
})
