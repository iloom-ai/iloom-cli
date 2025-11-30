import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GitHubService } from './GitHubService.js'
import * as githubUtils from '../utils/github.js'
import type { BranchNameStrategy } from '../types/github.js'
import { GitHubError } from '../types/github.js'
import {
	SimpleBranchNameStrategy,
	ClaudeBranchNameStrategy,
} from '../utils/github.js'

vi.mock('execa')

// Mock only the functions we need
vi.mock('../utils/github.js', async () => {
	const actual = await vi.importActual<typeof githubUtils>('../utils/github.js')
	return {
		...actual,
		executeGhCommand: vi.fn(),
		hasProjectScope: vi.fn(),
		fetchGhIssue: vi.fn(),
		fetchGhPR: vi.fn(),
		fetchProjectList: vi.fn(),
		fetchProjectItems: vi.fn(),
		fetchProjectFields: vi.fn(),
		updateProjectItemField: vi.fn(),
		createIssue: vi.fn(),
	}
})

// Mock branch name strategy for testing
class MockBranchNameStrategy implements BranchNameStrategy {
	async generate(issueNumber: number, _title: string): Promise<string> {
		return `mock/branch-${issueNumber}`
	}
}

describe('GitHubService', () => {
	let service: GitHubService
	const mockPrompter = vi.fn()

	beforeEach(() => {
		mockPrompter.mockResolvedValue(true) // Default to confirming
		service = new GitHubService({
			branchNameStrategy: new SimpleBranchNameStrategy(),
			prompter: mockPrompter,
		})
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('detectInputType', () => {
		it('should detect PR when PR exists', async () => {
			// Mock PR fetch success - now returns data directly
			vi.mocked(githubUtils.fetchGhPR).mockResolvedValueOnce({
				number: 123,
				title: 'Fix bug',
				body: 'Description',
				state: 'OPEN',
				headRefName: 'fix/bug-123',
				baseRefName: 'main',
				url: 'https://github.com/owner/repo/pull/123',
				isDraft: false,
				mergeable: 'MERGEABLE',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const result = await service.detectInputType('#123')
			expect(result.type).toBe('pr')
			expect(result.identifier).toBe('123')
			expect(result.rawInput).toBe('#123')
		})

		it('should fall back to issue when PR not found', async () => {
			// Mock PR fetch failure - now throws exception
			const prError = new Error('Could not resolve to a PullRequest') as Error & { stderr?: string }
			prError.stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 123'
			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(prError)

			// Mock issue fetch success - returns data directly
			vi.mocked(githubUtils.fetchGhIssue).mockResolvedValueOnce({
				number: 123,
				title: 'Add feature',
				body: 'Description',
				state: 'OPEN',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/123',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const result = await service.detectInputType('123')
			expect(result.type).toBe('issue')
			expect(result.identifier).toBe('123')
		})

		it('should return unknown for non-numeric input', async () => {
			const result = await service.detectInputType('feature-branch')
			expect(result.type).toBe('unknown')
			expect(result.identifier).toBeNull()
		})

		it('should handle input with # prefix', async () => {
			// Mock PR fetch failure - throws exception
			const prError = new Error('Could not resolve to a PullRequest') as Error & { stderr?: string }
			prError.stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 456'
			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(prError)

			// Mock issue fetch success - returns data directly
			vi.mocked(githubUtils.fetchGhIssue).mockResolvedValueOnce({
				number: 456,
				title: 'Test',
				body: 'Test',
				state: 'OPEN',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/456',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const result = await service.detectInputType('#456')
			expect(result.type).toBe('issue')
			expect(result.identifier).toBe('456')
		})

		it('should return unknown when both PR and issue are not found', async () => {
			const prError = new Error('Could not resolve') as Error & { stderr?: string }
			prError.stderr = 'GraphQL: Could not resolve to a PullRequest'
			const issueError = new Error('Could not resolve') as Error & { stderr?: string }
			issueError.stderr = 'GraphQL: Could not resolve to an Issue'

			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(prError)
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(issueError)

			const result = await service.detectInputType('123')
			expect(result.type).toBe('unknown')
			expect(result.identifier).toBeNull()
		})

		it('should throw error when API calls fail with unexpected errors', async () => {
			const prError = new Error('Network error')
			const issueError = new Error('Network error')

			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(prError)
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(issueError)

			await expect(service.detectInputType('456')).rejects.toThrow('Network error')
		})
	})

	describe('isValidIssue', () => {
		it('should return issue when it exists', async () => {
			vi.mocked(githubUtils.fetchGhIssue).mockResolvedValueOnce({
				number: 10,
				title: 'Test Issue',
				body: 'Test body',
				state: 'OPEN',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/10',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const result = await service.isValidIssue(10)
			expect(result).not.toBe(false)
			expect(result && result.number).toBe(10)
		})

		it('should return false when issue not found', async () => {
			const error = new Error('Could not resolve') as Error & { stderr?: string }
			error.stderr = 'GraphQL: Could not resolve to an Issue'
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(error)

			const result = await service.isValidIssue(999)
			expect(result).toBe(false)
		})

		it('should throw on unexpected errors', async () => {
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(new Error('Network error'))

			await expect(service.isValidIssue(10)).rejects.toThrow('Network error')
		})
	})

	describe('isValidPR', () => {
		it('should return PR when it exists', async () => {
			vi.mocked(githubUtils.fetchGhPR).mockResolvedValueOnce({
				number: 20,
				title: 'Test PR',
				body: 'Test body',
				state: 'OPEN',
				headRefName: 'feature',
				baseRefName: 'main',
				url: 'https://github.com/owner/repo/pull/20',
				isDraft: false,
				mergeable: 'MERGEABLE',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const result = await service.isValidPR(20)
			expect(result).not.toBe(false)
			expect(result && result.number).toBe(20)
		})

		it('should return false when PR not found', async () => {
			const error = new Error('Could not resolve') as Error & { stderr?: string }
			error.stderr = 'GraphQL: Could not resolve to a PullRequest'
			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(error)

			const result = await service.isValidPR(999)
			expect(result).toBe(false)
		})

		it('should throw on unexpected errors', async () => {
			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(new Error('Network error'))

			await expect(service.isValidPR(20)).rejects.toThrow('Network error')
		})
	})

	describe('fetchIssue', () => {
		it('should fetch and map issue correctly', async () => {
			vi.mocked(githubUtils.fetchGhIssue).mockResolvedValueOnce({
				number: 25,
				title: 'Add authentication',
				body: 'Implement OAuth',
				state: 'OPEN',
				labels: [{ name: 'enhancement' }, { name: 'auth' }],
				assignees: [{ login: 'acreeger' }],
				url: 'https://github.com/acreeger/repo/issues/25',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const issue = await service.fetchIssue(25)

			expect(issue.number).toBe(25)
			expect(issue.title).toBe('Add authentication')
			expect(issue.state).toBe('open')
			expect(issue.labels).toEqual(['enhancement', 'auth'])
			expect(issue.assignees).toEqual(['acreeger'])
		})

		it('should throw error for non-existent issue', async () => {
			const error = new Error('Could not resolve to an Issue') as Error & { stderr?: string }
			error.stderr = 'GraphQL: Could not resolve to an Issue with the number of 999'
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(error)

			await expect(service.fetchIssue(999)).rejects.toThrow(
				'Issue #999 not found'
			)
		})

		it('should throw original error when gh command fails with invalid field', async () => {
			// Simulate gh command failure due to invalid JSON field
			const error = new Error('Unknown JSON field: "repository"') as Error & { stderr?: string }
			error.stderr = 'Unknown JSON field: "repository"'
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(error)

			// Should throw the original error, not wrap it as NOT_FOUND
			await expect(service.fetchIssue(3)).rejects.toThrow('Unknown JSON field: "repository"')
		})

		it('should map state to lowercase', async () => {
			vi.mocked(githubUtils.fetchGhIssue).mockResolvedValueOnce({
				number: 30,
				title: 'Test',
				body: 'Test',
				state: 'CLOSED',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/30',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const issue = await service.fetchIssue(30)
			expect(issue.state).toBe('closed')
		})
	})

	describe('fetchPR', () => {
		it('should fetch and map PR correctly', async () => {
			vi.mocked(githubUtils.fetchGhPR).mockResolvedValueOnce({
				number: 30,
				title: 'Fix timeout',
				body: 'Increase timeout value',
				state: 'OPEN',
				headRefName: 'fix/timeout',
				baseRefName: 'main',
				url: 'https://github.com/acreeger/repo/pull/30',
				isDraft: false,
				mergeable: 'MERGEABLE',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const pr = await service.fetchPR(30)

			expect(pr.number).toBe(30)
			expect(pr.title).toBe('Fix timeout')
			expect(pr.state).toBe('open')
			expect(pr.branch).toBe('fix/timeout')
			expect(pr.baseBranch).toBe('main')
			expect(pr.isDraft).toBe(false)
		})

		it('should handle merged PR state', async () => {
			vi.mocked(githubUtils.fetchGhPR).mockResolvedValueOnce({
				number: 31,
				title: 'Add tests',
				body: 'Added tests',
				state: 'MERGED',
				headRefName: 'test/coverage',
				baseRefName: 'main',
				url: 'https://github.com/owner/repo/pull/31',
				isDraft: false,
				mergeable: 'MERGEABLE',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-02',
			})

			const pr = await service.fetchPR(31)
			expect(pr.state).toBe('merged')
		})

		it('should throw error for non-existent PR', async () => {
			const error = new Error('Could not resolve to a PullRequest') as Error & { stderr?: string }
			error.stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 999'
			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(error)

			await expect(service.fetchPR(999)).rejects.toThrow('PR #999 not found')
		})

		it('should throw original error when gh command fails with invalid field', async () => {
			// Simulate gh command failure due to invalid JSON field
			const error = new Error('Unknown JSON field: "repository"') as Error & { stderr?: string }
			error.stderr = 'Unknown JSON field: "repository"'
			vi.mocked(githubUtils.fetchGhPR).mockRejectedValueOnce(error)

			// Should throw the original error, not wrap it as NOT_FOUND
			await expect(service.fetchPR(5)).rejects.toThrow('Unknown JSON field: "repository"')
		})
	})

	describe('validateIssueState', () => {
		it('should not throw for open issue', async () => {
			const issue = {
				number: 1,
				title: 'Test',
				body: 'Test',
				state: 'open' as const,
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/1',
			}

			await expect(service.validateIssueState(issue)).resolves.not.toThrow()
		})

		it('should warn and continue for closed issue', async () => {
			const issue = {
				number: 1,
				title: 'Test',
				body: 'Test',
				state: 'closed' as const,
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/1',
			}

			// Currently returns true, so should not throw
			await expect(service.validateIssueState(issue)).resolves.not.toThrow()
		})
	})

	describe('validatePRState', () => {
		it('should not throw for open PR', async () => {
			const pr = {
				number: 1,
				title: 'Test',
				body: 'Test',
				state: 'open' as const,
				branch: 'test',
				baseBranch: 'main',
				url: 'https://github.com/owner/repo/pull/1',
				isDraft: false,
			}

			await expect(service.validatePRState(pr)).resolves.not.toThrow()
		})

		it('should warn and continue for closed PR', async () => {
			const pr = {
				number: 1,
				title: 'Test',
				body: 'Test',
				state: 'closed' as const,
				branch: 'test',
				baseBranch: 'main',
				url: 'https://github.com/owner/repo/pull/1',
				isDraft: false,
			}

			// Currently returns true, so should not throw
			await expect(service.validatePRState(pr)).resolves.not.toThrow()
		})

		it('should warn and continue for merged PR', async () => {
			const pr = {
				number: 1,
				title: 'Test',
				body: 'Test',
				state: 'merged' as const,
				branch: 'test',
				baseBranch: 'main',
				url: 'https://github.com/owner/repo/pull/1',
				isDraft: false,
			}

			// Currently returns true, so should not throw
			await expect(service.validatePRState(pr)).resolves.not.toThrow()
		})
	})

	describe('generateBranchName', () => {
		it('should use default strategy when none provided', async () => {
			const branchName = await service.generateBranchName({
				issueNumber: 123,
				title: 'Add feature',
			})

			expect(branchName).toBe('feat/issue-123-add-feature')
		})

		it('should use custom strategy when provided', async () => {
			const customStrategy = new MockBranchNameStrategy()

			const branchName = await service.generateBranchName({
				issueNumber: 456,
				title: 'Fix bug',
				strategy: customStrategy,
			})

			expect(branchName).toBe('mock/branch-456')
		})

		it('should use strategy set on service', async () => {
			const customStrategy = new MockBranchNameStrategy()
			service.setDefaultBranchNameStrategy(customStrategy)

			const branchName = await service.generateBranchName({
				issueNumber: 789,
				title: 'Update docs',
			})

			expect(branchName).toBe('mock/branch-789')
		})
	})

	describe('createIssue', () => {
		it('should create GitHub issue with title and body', async () => {
			const issueData = {
				number: 123,
				url: 'https://github.com/owner/repo/issues/123'
			}

			vi.mocked(githubUtils.createIssue).mockResolvedValueOnce(issueData)

			const result = await service.createIssue('Test title', 'Test body')

			expect(result).toEqual(issueData)
			expect(githubUtils.createIssue).toHaveBeenCalledWith('Test title', 'Test body', { repo: undefined, labels: undefined })
		})

		it('should handle issue creation errors', async () => {
			vi.mocked(githubUtils.createIssue).mockRejectedValueOnce(
				new Error('Failed to create issue')
			)

			await expect(service.createIssue('Test', 'Body')).rejects.toThrow(
				'Failed to create issue'
			)
		})
	})

	describe('getIssueUrl', () => {
		it('should fetch and return issue URL', async () => {
			const mockIssue = {
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				url: 'https://github.com/owner/repo/issues/123',
				state: 'open',
				created_at: '2025-01-01T00:00:00Z',
				updated_at: '2025-01-01T00:00:00Z'
			}

			vi.mocked(githubUtils.fetchGhIssue).mockResolvedValueOnce(mockIssue)

			const url = await service.getIssueUrl(123)

			expect(url).toBe('https://github.com/owner/repo/issues/123')
			expect(githubUtils.fetchGhIssue).toHaveBeenCalledWith(123, undefined)
		})

		it('should handle fetch errors', async () => {
			vi.mocked(githubUtils.fetchGhIssue).mockRejectedValueOnce(
				new Error('Issue not found')
			)

			await expect(service.getIssueUrl(999)).rejects.toThrow('Issue not found')
		})
	})

	describe('moveIssueToInProgress', () => {
		it('should throw error when missing project scope', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(false)

			await expect(service.moveIssueToInProgress(123)).rejects.toThrow(
				GitHubError
			)
			await expect(service.moveIssueToInProgress(123)).rejects.toThrow(
				'GitHub CLI lacks project scope'
			)
		})

		it('should handle repository info fetch failure gracefully', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(true)
			vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
				new Error('Failed to fetch repo info')
			)

			// Should not throw, just return
			await expect(
				service.moveIssueToInProgress(123)
			).resolves.not.toThrow()
		})

		it('should handle no projects gracefully', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(true)
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				owner: { login: 'owner' },
				name: 'repo',
			})
			vi.mocked(githubUtils.fetchProjectList).mockResolvedValueOnce([])

			// Should not throw, just return
			await expect(
				service.moveIssueToInProgress(123)
			).resolves.not.toThrow()
		})

		it('should update issue status when found in project', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(true)
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				owner: { login: 'owner' },
				name: 'repo',
			})
			vi.mocked(githubUtils.fetchProjectList).mockResolvedValueOnce([
				{
					number: 1,
					id: 'project-1',
					name: 'Main Project',
					fields: [], // Fields are now fetched separately
				},
			])
			vi.mocked(githubUtils.fetchProjectItems).mockResolvedValueOnce([
				{
					id: 'item-1',
					content: {
						type: 'Issue',
						number: 123,
					},
					fieldValues: {},
				},
			])
			// Mock the separate fields fetch
			vi.mocked(githubUtils.fetchProjectFields).mockResolvedValueOnce({
				fields: [
					{
						id: 'field-1',
						name: 'Status',
						dataType: 'SINGLE_SELECT',
						options: [
							{ id: 'opt-1', name: 'Todo' },
							{ id: 'opt-2', name: 'In Progress' },
						],
					},
				],
			})
			vi.mocked(githubUtils.updateProjectItemField).mockResolvedValueOnce(undefined)

			await service.moveIssueToInProgress(123)

			expect(githubUtils.updateProjectItemField).toHaveBeenCalledWith(
				'item-1',
				'project-1',
				'field-1',
				'opt-2'
			)
		})

		it('should skip project when issue not found', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(true)
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				owner: { login: 'owner' },
				name: 'repo',
			})
			vi.mocked(githubUtils.fetchProjectList).mockResolvedValueOnce([
				{
					number: 1,
					id: 'project-1',
					name: 'Main Project',
					fields: [],
				},
			])
			vi.mocked(githubUtils.fetchProjectItems).mockResolvedValueOnce([
				{
					id: 'item-1',
					content: {
						type: 'Issue',
						number: 999, // Different issue
					},
					fieldValues: {},
				},
			])

			await service.moveIssueToInProgress(123)

			expect(githubUtils.updateProjectItemField).not.toHaveBeenCalled()
		})

		it('should skip project when Status field not found', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(true)
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				owner: { login: 'owner' },
				name: 'repo',
			})
			vi.mocked(githubUtils.fetchProjectList).mockResolvedValueOnce([
				{
					number: 1,
					id: 'project-1',
					name: 'Main Project',
					fields: [],
				},
			])
			vi.mocked(githubUtils.fetchProjectItems).mockResolvedValueOnce([
				{
					id: 'item-1',
					content: {
						type: 'Issue',
						number: 123,
					},
					fieldValues: {},
				},
			])
			// Mock fields fetch with no Status field
			vi.mocked(githubUtils.fetchProjectFields).mockResolvedValueOnce({
				fields: [
					{
						id: 'field-1',
						name: 'Priority', // Different field
						dataType: 'SINGLE_SELECT',
						options: [],
					},
				],
			})

			await service.moveIssueToInProgress(123)

			expect(githubUtils.updateProjectItemField).not.toHaveBeenCalled()
		})

		it('should skip project when In Progress option not found', async () => {
			vi.mocked(githubUtils.hasProjectScope).mockResolvedValueOnce(true)
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce({
				owner: { login: 'owner' },
				name: 'repo',
			})
			vi.mocked(githubUtils.fetchProjectList).mockResolvedValueOnce([
				{
					number: 1,
					id: 'project-1',
					name: 'Main Project',
					fields: [],
				},
			])
			vi.mocked(githubUtils.fetchProjectItems).mockResolvedValueOnce([
				{
					id: 'item-1',
					content: {
						type: 'Issue',
						number: 123,
					},
					fieldValues: {},
				},
			])
			// Mock fields fetch with Status field but no "In Progress" option
			vi.mocked(githubUtils.fetchProjectFields).mockResolvedValueOnce({
				fields: [
					{
						id: 'field-1',
						name: 'Status',
						dataType: 'SINGLE_SELECT',
						options: [
							{ id: 'opt-1', name: 'Todo' },
							{ id: 'opt-2', name: 'Done' }, // No "In Progress"
						],
					},
				],
			})

			await service.moveIssueToInProgress(123)

			expect(githubUtils.updateProjectItemField).not.toHaveBeenCalled()
		})
	})

	describe('extractContext', () => {
		it('should extract context from issue', () => {
			const issue = {
				number: 123,
				title: 'Add feature',
				body: 'Description',
				state: 'open' as const,
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/123',
			}

			const context = service.extractContext(issue)
			expect(context).toContain('GitHub Issue #123')
			expect(context).toContain('Add feature')
			expect(context).toContain('State: open')
		})

		it('should extract context from PR', () => {
			const pr = {
				number: 456,
				title: 'Fix bug',
				body: 'Description',
				state: 'open' as const,
				branch: 'fix/bug',
				baseBranch: 'main',
				url: 'https://github.com/owner/repo/pull/456',
				isDraft: false,
			}

			const context = service.extractContext(pr)
			expect(context).toContain('Pull Request #456')
			expect(context).toContain('Fix bug')
			expect(context).toContain('Branch: fix/bug')
			expect(context).toContain('State: open')
		})
	})

	describe('strategy management', () => {
		it('should allow getting current strategy', () => {
			const strategy = service.getBranchNameStrategy()
			expect(strategy).toBeInstanceOf(SimpleBranchNameStrategy)
		})

		it('should allow setting custom strategy', () => {
			const customStrategy = new MockBranchNameStrategy()
			service.setDefaultBranchNameStrategy(customStrategy)

			const strategy = service.getBranchNameStrategy()
			expect(strategy).toBe(customStrategy)
		})

		it('should use SimpleBranchNameStrategy when useClaude is false', () => {
			const serviceWithSimple = new GitHubService({ useClaude: false })
			const strategy = serviceWithSimple.getBranchNameStrategy()
			expect(strategy).toBeInstanceOf(SimpleBranchNameStrategy)
		})

		it('should use ClaudeBranchNameStrategy by default', () => {
			const serviceWithClaude = new GitHubService()
			const strategy = serviceWithClaude.getBranchNameStrategy()
			expect(strategy).toBeInstanceOf(ClaudeBranchNameStrategy)
		})

		it('should use custom strategy from constructor', () => {
			const customStrategy = new MockBranchNameStrategy()
			const serviceWithCustom = new GitHubService({
				branchNameStrategy: customStrategy,
			})
			const strategy = serviceWithCustom.getBranchNameStrategy()
			expect(strategy).toBe(customStrategy)
		})
	})
})
