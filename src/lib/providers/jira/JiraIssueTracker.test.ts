import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JiraIssueTracker, type JiraTrackerConfig } from './JiraIssueTracker.js'
import { JiraApiClient, type JiraIssue } from './JiraApiClient.js'

// Mock JiraApiClient
vi.mock('./JiraApiClient.js', () => ({
	JiraApiClient: vi.fn(),
}))

// Mock logger
vi.mock('../../../utils/logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

// Mock ADF converter
vi.mock('./AdfMarkdownConverter.js', () => ({
	adfToMarkdown: vi.fn((input: unknown) => typeof input === 'string' ? input : ''),
}))

function createConfig(overrides: Partial<JiraTrackerConfig> = {}): JiraTrackerConfig {
	return {
		host: 'https://mycompany.atlassian.net',
		username: 'user@example.com',
		apiToken: 'test-api-token',
		projectKey: 'PROJ',
		...overrides,
	}
}

function createJiraIssue(overrides: {
	key?: string
	summary?: string
	statusName?: string
} = {}): JiraIssue {
	return {
		id: '10001',
		key: overrides.key ?? 'PROJ-101',
		fields: {
			summary: overrides.summary ?? 'Child task',
			description: 'Description',
			status: { name: overrides.statusName ?? 'In Progress' },
			issuetype: { name: 'Task' },
			project: { key: 'PROJ', name: 'My Project' },
			assignee: null,
			reporter: { displayName: 'Reporter', emailAddress: 'reporter@example.com', accountId: 'acc-1' },
			labels: [],
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-02T00:00:00.000Z',
		},
	}
}

describe('JiraIssueTracker', () => {
	let tracker: JiraIssueTracker
	let mockSearchIssues: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockSearchIssues = vi.fn()

		vi.mocked(JiraApiClient).mockImplementation(() => ({
			searchIssues: mockSearchIssues,
			getIssue: vi.fn(),
			getTransitions: vi.fn(),
			transitionIssue: vi.fn(),
			createIssue: vi.fn(),
			getComments: vi.fn(),
			addComment: vi.fn(),
			updateComment: vi.fn(),
		}) as unknown as JiraApiClient)

		tracker = new JiraIssueTracker(createConfig())
	})

	describe('getChildIssues', () => {
		it('should query JQL "parent = KEY" via client.searchIssues()', async () => {
			const mockIssues: JiraIssue[] = [
				createJiraIssue({ key: 'PROJ-101', summary: 'Child 1', statusName: 'To Do' }),
				createJiraIssue({ key: 'PROJ-102', summary: 'Child 2', statusName: 'Done' }),
			]
			mockSearchIssues.mockResolvedValue(mockIssues)

			const result = await tracker.getChildIssues('PROJ-100')

			expect(mockSearchIssues).toHaveBeenCalledWith('parent = PROJ-100')
			expect(result).toEqual([
				{ id: 'PROJ-101', title: 'Child 1', url: 'https://mycompany.atlassian.net/browse/PROJ-101', state: 'to do' },
				{ id: 'PROJ-102', title: 'Child 2', url: 'https://mycompany.atlassian.net/browse/PROJ-102', state: 'done' },
			])
		})

		it('should normalize identifier to uppercase before querying', async () => {
			mockSearchIssues.mockResolvedValue([])

			await tracker.getChildIssues('proj-100')

			expect(mockSearchIssues).toHaveBeenCalledWith('parent = PROJ-100')
		})

		it('should construct URL using config.host + "/browse/" + key', async () => {
			vi.mocked(JiraApiClient).mockImplementation(() => ({
				searchIssues: mockSearchIssues,
				getIssue: vi.fn(),
				getTransitions: vi.fn(),
				transitionIssue: vi.fn(),
				createIssue: vi.fn(),
				getComments: vi.fn(),
				addComment: vi.fn(),
				updateComment: vi.fn(),
			}) as unknown as JiraApiClient)

			const customTracker = new JiraIssueTracker(createConfig({ host: 'https://custom.atlassian.net' }))
			mockSearchIssues.mockResolvedValue([
				createJiraIssue({ key: 'PROJ-201' }),
			])

			const result = await customTracker.getChildIssues('PROJ-200')

			expect(result[0].url).toBe('https://custom.atlassian.net/browse/PROJ-201')
		})

		it('should return empty array when no children found', async () => {
			mockSearchIssues.mockResolvedValue([])

			const result = await tracker.getChildIssues('PROJ-100')

			expect(result).toEqual([])
		})

		it('should return empty array for invalid Jira key format', async () => {
			const result = await tracker.getChildIssues('not-a-valid-key')

			expect(mockSearchIssues).not.toHaveBeenCalled()
			expect(result).toEqual([])
		})

		it('should propagate API errors from searchIssues', async () => {
			mockSearchIssues.mockRejectedValue(new Error('401 Unauthorized'))

			await expect(tracker.getChildIssues('PROJ-100')).rejects.toThrow('401 Unauthorized')
		})

		it('should map state to lowercase', async () => {
			mockSearchIssues.mockResolvedValue([
				createJiraIssue({ key: 'PROJ-101', statusName: 'In Progress' }),
			])

			const result = await tracker.getChildIssues('PROJ-100')

			expect(result[0].state).toBe('in progress')
		})
	})
})
