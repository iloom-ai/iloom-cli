import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SummaryCommand } from '../../src/commands/summary.js'
import type { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import type { MetadataManager } from '../../src/lib/MetadataManager.js'
import type { SessionSummaryService } from '../../src/lib/SessionSummaryService.js'
import type { SettingsManager } from '../../src/lib/SettingsManager.js'
vi.mock('../../src/utils/logger-context.js', () => ({
	getLogger: vi.fn().mockReturnValue({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

vi.mock('../../src/utils/git.js', () => ({
	extractIssueNumber: vi.fn().mockReturnValue(42),
}))

describe('SummaryCommand - getPRNumberForPosting bitbucket-pr support', () => {
	let mockGitWorktreeManager: Partial<GitWorktreeManager>
	let mockMetadataManager: Partial<MetadataManager>
	let mockSessionSummaryService: Partial<SessionSummaryService>
	let mockSettingsManager: Partial<SettingsManager>
	let command: SummaryCommand

	const makeCommand = () => {
		return new SummaryCommand(
			mockGitWorktreeManager as GitWorktreeManager,
			mockMetadataManager as MetadataManager,
			mockSessionSummaryService as SessionSummaryService,
			mockSettingsManager as SettingsManager,
		)
	}

	beforeEach(() => {
		const mockWorktree = { path: '/test/worktree', branch: 'feat/issue-42-test' }

		mockGitWorktreeManager = {
			findWorktreeForIssue: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForPR: vi.fn().mockResolvedValue(null),
			findWorktreeForBranch: vi.fn().mockResolvedValue(null),
		}

		mockMetadataManager = {
			readMetadata: vi.fn().mockResolvedValue({
				issueType: 'issue',
				issue_numbers: ['42'],
			}),
		}

		mockSessionSummaryService = {
			generateSummary: vi.fn().mockResolvedValue({ summary: 'Test summary', sessionId: 'sess-1' }),
			applyAttribution: vi.fn().mockImplementation((s: string) => Promise.resolve(s)),
			postSummary: vi.fn().mockResolvedValue(undefined),
		}

		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({
				mergeBehavior: { mode: 'local' },
			}),
		}

		command = makeCommand()
	})

	it('posts to PR when merge mode is bitbucket-pr and draftPrNumber is set', async () => {
		vi.mocked(mockSettingsManager.loadSettings!).mockResolvedValue({
			mergeBehavior: { mode: 'bitbucket-pr' },
		})
		vi.mocked(mockMetadataManager.readMetadata!).mockResolvedValue({
			issueType: 'issue',
			issue_numbers: ['42'],
			draftPrNumber: 99,
		})

		await command.execute({
			identifier: '42',
			options: { withComment: true },
		})

		expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
			expect.anything(),
			'Test summary',
			expect.anything(),
			99 // PR number from metadata
		)
	})

	it('posts to issue (no PR number) when merge mode is bitbucket-pr and no draftPrNumber', async () => {
		vi.mocked(mockSettingsManager.loadSettings!).mockResolvedValue({
			mergeBehavior: { mode: 'bitbucket-pr' },
		})
		vi.mocked(mockMetadataManager.readMetadata!).mockResolvedValue({
			issueType: 'issue',
			issue_numbers: ['42'],
			draftPrNumber: null,
		})

		await command.execute({
			identifier: '42',
			options: { withComment: true },
		})

		expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
			expect.anything(),
			'Test summary',
			expect.anything(),
			undefined // No PR number - post to issue
		)
	})

	it('posts to issue when merge mode is local', async () => {
		vi.mocked(mockSettingsManager.loadSettings!).mockResolvedValue({
			mergeBehavior: { mode: 'local' },
		})

		await command.execute({
			identifier: '42',
			options: { withComment: true },
		})

		expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
			expect.anything(),
			'Test summary',
			expect.anything(),
			undefined // No PR number for local mode
		)
	})

	it('does not post when withComment is false', async () => {
		vi.mocked(mockSettingsManager.loadSettings!).mockResolvedValue({
			mergeBehavior: { mode: 'bitbucket-pr' },
		})
		vi.mocked(mockMetadataManager.readMetadata!).mockResolvedValue({
			issueType: 'issue',
			issue_numbers: ['42'],
			draftPrNumber: 99,
		})

		await command.execute({
			identifier: '42',
			options: { withComment: false },
		})

		expect(mockSessionSummaryService.postSummary).not.toHaveBeenCalled()
	})
})
