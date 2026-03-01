import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SummaryCommand, type SummaryCommandInput } from './summary.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { MetadataManager, LoomMetadata } from '../lib/MetadataManager.js'
import type { SessionSummaryService, SessionSummaryResult } from '../lib/SessionSummaryService.js'
import type { SettingsManager, IloomSettings } from '../lib/SettingsManager.js'
import type { GitWorktree } from '../types/worktree.js'
import type { SummaryResult } from '../types/index.js'

// Mock the PRManager
vi.mock('../lib/PRManager.js', () => ({
	PRManager: vi.fn().mockImplementation(() => ({
		checkForExistingPR: vi.fn().mockResolvedValue(null),
	})),
}))

// Mock the git utilities
vi.mock('../utils/git.js', () => ({
	extractIssueNumber: vi.fn((input: string) => {
		// Simple mock implementation that extracts numbers after 'issue-' or '-'
		const match = input.match(/issue-(\d+)|[-_](\d+)[-_]/)
		if (match) {
			return parseInt(match[1] ?? match[2], 10)
		}
		return null
	})
}))

// Mock the claude utilities
vi.mock('../utils/claude.js', () => ({
	generateDeterministicSessionId: vi.fn(() => 'deterministic-session-id-12345')
}))

describe('SummaryCommand', () => {
	let mockGitWorktreeManager: GitWorktreeManager
	let mockMetadataManager: MetadataManager
	let mockSessionSummaryService: SessionSummaryService
	let mockSettingsManager: SettingsManager
	let command: SummaryCommand

	const defaultWorktree: GitWorktree = {
		path: '/path/to/worktree',
		branch: 'feat/issue-123__test-feature',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	const defaultMetadata: LoomMetadata = {
		description: 'Test loom',
		created_at: '2024-01-01T00:00:00Z',
		branchName: 'feat/issue-123__test-feature',
		worktreePath: '/path/to/worktree',
		issueType: 'issue',
		issue_numbers: ['123'],
		pr_numbers: [],
		issueTracker: 'github',
		colorHex: '#dcebff',
		sessionId: 'test-session-id-12345',
		projectPath: '/path/to/project',
		issueUrls: {},
		prUrls: {},
		draftPrNumber: null,
		capabilities: [],
		parentLoom: null,
	}

	const defaultSummaryResult: SessionSummaryResult = {
		summary: '## Session Summary\n\n### Key Insights\n- Test insight',
		sessionId: 'test-session-id-12345',
	}

	const defaultSettings: IloomSettings = {
		mergeBehavior: {
			mode: 'local',
		},
		sourceEnvOnStart: false,
		attribution: 'upstreamOnly',
	}

	beforeEach(() => {
		// Create mock GitWorktreeManager
		mockGitWorktreeManager = {
			findWorktreeForIssue: vi.fn().mockResolvedValue(defaultWorktree),
			findWorktreeForPR: vi.fn().mockResolvedValue(defaultWorktree),
			findWorktreeForBranch: vi.fn().mockResolvedValue(defaultWorktree),
			listWorktrees: vi.fn().mockResolvedValue([defaultWorktree]),
			getRepoInfo: vi.fn().mockResolvedValue({ currentBranch: 'feat/issue-123__test-feature' }),
		} as unknown as GitWorktreeManager

		// Create mock MetadataManager
		mockMetadataManager = {
			readMetadata: vi.fn().mockResolvedValue(defaultMetadata),
		} as unknown as MetadataManager

		// Create mock SessionSummaryService
		mockSessionSummaryService = {
			generateSummary: vi.fn().mockResolvedValue(defaultSummaryResult),
			postSummary: vi.fn().mockResolvedValue(undefined),
			applyAttribution: vi.fn().mockImplementation((summary: string) => Promise.resolve(summary)),
		} as unknown as SessionSummaryService

		// Create mock SettingsManager
		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue(defaultSettings),
		} as unknown as SettingsManager

		command = new SummaryCommand(
			mockGitWorktreeManager,
			mockMetadataManager,
			mockSessionSummaryService,
			mockSettingsManager
		)
	})

	describe('execute with identifier', () => {
		it('should generate and print summary for issue identifier', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: {},
			}

			await command.execute(input)

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(123)
			expect(mockMetadataManager.readMetadata).toHaveBeenCalledWith('/path/to/worktree')
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'issue',
				'123'
			)
			expect(consoleSpy).toHaveBeenCalledWith(defaultSummaryResult.summary)

			consoleSpy.mockRestore()
		})

		it('should generate and print summary for PR identifier', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'pr',
				pr_numbers: ['123'],
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: 'pr/123',
				options: {},
			}

			await command.execute(input)

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(123, '')
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'pr',
				'123'
			)

			consoleSpy.mockRestore()
		})

		it('should generate and print summary for branch identifier', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'branch',
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: 'my-feature-branch',
				options: {},
			}

			await command.execute(input)

			expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith('my-feature-branch')
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'branch',
				undefined
			)

			consoleSpy.mockRestore()
		})

		it('should post summary when --with-comment flag is provided for issue loom', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: { withComment: true },
			}

			await command.execute(input)

			// In local merge mode (default), prNumber is undefined (posts to issue)
			expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
				'123',
				defaultSummaryResult.summary,
				'/path/to/worktree',
				undefined
			)

			consoleSpy.mockRestore()
		})

		it('should post summary when --with-comment flag is provided for PR loom', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'pr',
				pr_numbers: ['456'],
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: 'pr/456',
				options: { withComment: true },
			}

			await command.execute(input)

			// In local merge mode (default), prNumber is undefined (posts to issue)
			expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
				'456',
				defaultSummaryResult.summary,
				'/path/to/worktree',
				undefined
			)

			consoleSpy.mockRestore()
		})

		it('should skip posting when --with-comment is provided but loom type is branch', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'branch',
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: 'my-feature-branch',
				options: { withComment: true },
			}

			await command.execute(input)

			// Summary should be generated and printed
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalled()
			expect(consoleSpy).toHaveBeenCalledWith(defaultSummaryResult.summary)
			// But not posted
			expect(mockSessionSummaryService.postSummary).not.toHaveBeenCalled()

			consoleSpy.mockRestore()
		})

		it('should throw error when loom is not found', async () => {
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(null)

			const input: SummaryCommandInput = {
				identifier: 'nonexistent',
				options: {},
			}

			await expect(command.execute(input)).rejects.toThrow('No loom found for identifier: nonexistent')
		})

		it('should still work when metadata is not found (service generates deterministic session ID)', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue(null)
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: {},
			}

			// Should not throw - the service will generate a deterministic session ID
			await command.execute(input)

			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'issue',
				'123'
			)

			consoleSpy.mockRestore()
		})
	})

	describe('auto-detection from current directory', () => {
		it('should auto-detect loom when no identifier provided', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Mock process.cwd() to return a directory with issue pattern
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/some/path/feat-issue-123__test-feature')

			const input: SummaryCommandInput = {
				identifier: undefined,
				options: {},
			}

			await command.execute(input)

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(123)
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalled()

			process.cwd = originalCwd
			consoleSpy.mockRestore()
		})

		it('should auto-detect PR loom from directory with _pr_N suffix', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Mock process.cwd() to return a directory with PR pattern
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/some/path/worktree_pr_456')

			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'pr',
				pr_numbers: ['456'],
			})

			const input: SummaryCommandInput = {
				identifier: undefined,
				options: {},
			}

			await command.execute(input)

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(456, '')
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'pr',
				'456'
			)

			process.cwd = originalCwd
			consoleSpy.mockRestore()
		})

		it('should fall back to branch detection when directory has no issue pattern', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Mock process.cwd() to return a directory without issue pattern
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/some/path/random-directory')

			// extractIssueNumber will return null for this
			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'branch',
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: undefined,
				options: {},
			}

			await command.execute(input)

			expect(mockGitWorktreeManager.getRepoInfo).toHaveBeenCalled()
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalled()

			process.cwd = originalCwd
			consoleSpy.mockRestore()
		})
	})

	describe('deterministic session ID generation', () => {
		it('should generate deterministic session ID when metadata has no sessionId', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Mock metadata with null sessionId
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				sessionId: null,
			})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: {},
			}

			// Should not throw - instead it generates session ID deterministically
			await command.execute(input)

			// Verify the deterministic session ID is passed to generateSummary
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'issue',
				'123'
			)
			expect(consoleSpy).toHaveBeenCalledWith(defaultSummaryResult.summary)

			consoleSpy.mockRestore()
		})

		it('should generate deterministic session ID when metadata sessionId is undefined', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Mock metadata without sessionId field
			const metadataWithoutSessionId = { ...defaultMetadata }
			delete (metadataWithoutSessionId as { sessionId?: string | null }).sessionId
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue(metadataWithoutSessionId)

			const input: SummaryCommandInput = {
				identifier: '123',
				options: {},
			}

			// Should not throw - instead it generates session ID deterministically
			await command.execute(input)

			// Verify the deterministic session ID is passed to generateSummary
			expect(mockSessionSummaryService.generateSummary).toHaveBeenCalledWith(
				'/path/to/worktree',
				'feat/issue-123__test-feature',
				'issue',
				'123'
			)
			expect(consoleSpy).toHaveBeenCalledWith(defaultSummaryResult.summary)

			consoleSpy.mockRestore()
		})
	})

	describe('JSON mode', () => {
		it('should return SummaryResult when --json flag is provided', async () => {
			const input: SummaryCommandInput = {
				identifier: '123',
				options: { json: true },
			}

			const result = await command.execute(input) as SummaryResult

			expect(result).toBeDefined()
			expect(result.summary).toBe(defaultSummaryResult.summary)
			expect(result.sessionId).toBe(defaultSummaryResult.sessionId)
			expect(result.branchName).toBe('feat/issue-123__test-feature')
			expect(result.loomType).toBe('issue')
			expect(result.issueNumber).toBe('123')
		})

		it('should not print to console.log in JSON mode', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: { json: true },
			}

			await command.execute(input)

			// console.log should not be called in JSON mode
			expect(consoleSpy).not.toHaveBeenCalled()

			consoleSpy.mockRestore()
		})

		it('should include issueNumber in JSON result for issue type loom', async () => {
			const input: SummaryCommandInput = {
				identifier: '123',
				options: { json: true },
			}

			const result = await command.execute(input) as SummaryResult

			expect(result.issueNumber).toBe('123')
		})

		it('should include issueNumber in JSON result for PR type loom', async () => {
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'pr',
				pr_numbers: ['456'],
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: 'pr/456',
				options: { json: true },
			}

			const result = await command.execute(input) as SummaryResult

			expect(result.loomType).toBe('pr')
			expect(result.issueNumber).toBe('456')
		})

		it('should not include issueNumber in JSON result for branch type loom', async () => {
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(null)
			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(defaultWorktree)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				issueType: 'branch',
				issue_numbers: [],
			})

			const input: SummaryCommandInput = {
				identifier: 'my-feature-branch',
				options: { json: true },
			}

			const result = await command.execute(input) as SummaryResult

			expect(result.loomType).toBe('branch')
			expect(result.issueNumber).toBeUndefined()
		})

		it('should return void and print to stdout when --json flag is not provided', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: {},
			}

			const result = await command.execute(input)

			expect(result).toBeUndefined()
			expect(consoleSpy).toHaveBeenCalledWith(defaultSummaryResult.summary)

			consoleSpy.mockRestore()
		})
	})

	describe('postSummary PR routing', () => {
		it('should post to PR when mergeMode is draft-pr and draftPrNumber exists', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Configure draft-pr mode with draftPrNumber in metadata
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				mergeBehavior: { mode: 'draft-pr' },
			})
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				draftPrNumber: 789,
			})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: { withComment: true },
			}

			await command.execute(input)

			// Should post with prNumber = 789
			expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
				'123',
				defaultSummaryResult.summary,
				'/path/to/worktree',
				789
			)

			consoleSpy.mockRestore()
		})

		it('should post to PR when mergeMode is pr and PR exists for branch', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Configure pr mode
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				mergeBehavior: { mode: 'pr' },
			})

			// Mock PRManager to return an existing PR
			const { PRManager } = await import('../lib/PRManager.js')
			vi.mocked(PRManager).mockImplementation(() => ({
				checkForExistingPR: vi.fn().mockResolvedValue({ number: 456, url: 'https://github.com/test/repo/pull/456' }),
			}) as unknown as InstanceType<typeof PRManager>)

			const input: SummaryCommandInput = {
				identifier: '123',
				options: { withComment: true },
			}

			await command.execute(input)

			// Should post with prNumber = 456
			expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
				'123',
				defaultSummaryResult.summary,
				'/path/to/worktree',
				456
			)

			consoleSpy.mockRestore()
		})

		it('should fall back to issue when pr mode but no PR found', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Configure pr mode
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				mergeBehavior: { mode: 'pr' },
			})

			// Mock PRManager to return no existing PR
			const { PRManager } = await import('../lib/PRManager.js')
			vi.mocked(PRManager).mockImplementation(() => ({
				checkForExistingPR: vi.fn().mockResolvedValue(null),
			}) as unknown as InstanceType<typeof PRManager>)

			const input: SummaryCommandInput = {
				identifier: '123',
				options: { withComment: true },
			}

			await command.execute(input)

			// Should post without prNumber (undefined)
			expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
				'123',
				defaultSummaryResult.summary,
				'/path/to/worktree',
				undefined
			)

			consoleSpy.mockRestore()
		})

		it('should post to issue when mergeMode is local', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			// Configure local mode (default)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				mergeBehavior: { mode: 'local' },
			})

			const input: SummaryCommandInput = {
				identifier: '123',
				options: { withComment: true },
			}

			await command.execute(input)

			// Should post without prNumber (undefined) - posts to issue
			expect(mockSessionSummaryService.postSummary).toHaveBeenCalledWith(
				'123',
				defaultSummaryResult.summary,
				'/path/to/worktree',
				undefined
			)

			consoleSpy.mockRestore()
		})
	})
})
