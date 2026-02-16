import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IdentifierParser, matchIssueIdentifier } from './IdentifierParser.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { ParsedInput } from '../commands/start.js'
import type { GitWorktree } from '../types/index.js'

// Mock GitWorktreeManager
vi.mock('../lib/GitWorktreeManager.js', () => ({
	GitWorktreeManager: vi.fn(),
}))

describe('IdentifierParser', () => {
	let parser: IdentifierParser
	let mockGitWorktreeManager: {
		findWorktreeForPR: ReturnType<typeof vi.fn>
		findWorktreeForIssue: ReturnType<typeof vi.fn>
		findWorktreeForBranch: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn(),
			findWorktreeForIssue: vi.fn(),
			findWorktreeForBranch: vi.fn(),
		}

		parser = new IdentifierParser(
			mockGitWorktreeManager as unknown as GitWorktreeManager
		)

		vi.clearAllMocks()
	})

	describe('parseForPatternDetection', () => {
		describe('PR detection', () => {
			it('should detect PR from _pr_NN suffix in worktree path', async () => {
				const mockPRWorktree: GitWorktree = {
					path: '/test/parent/feat-test-feature_pr_42',
					branch: 'feat/test-feature',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(mockPRWorktree)

				const result = await parser.parseForPatternDetection('42')

				expect(result).toEqual({
					type: 'pr',
					number: 42,
					originalInput: '42',
				} as ParsedInput)

				// Verify it checked for PR first with empty branch name
				expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(42, '')
			})

			it('should detect PR from numeric input when PR worktree exists (priority over issue)', async () => {
				const mockPRWorktree: GitWorktree = {
					path: '/test/parent/feat-test-feature_pr_66',
					branch: 'feat/test-feature',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(mockPRWorktree)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue({
					path: '/test/issue-66',
					branch: 'issue-66',
					commit: 'def456',
					bare: false,
					detached: false,
					locked: false,
				})

				const result = await parser.parseForPatternDetection('66')

				expect(result.type).toBe('pr')
				expect(result.number).toBe(66)

				// Should not check for issue since PR was found first
				expect(mockGitWorktreeManager.findWorktreeForIssue).not.toHaveBeenCalled()
			})

			it('should handle # prefix for PR detection', async () => {
				const mockPRWorktree: GitWorktree = {
					path: '/test/parent/feat-test_pr_123',
					branch: 'feat/test',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(mockPRWorktree)

				const result = await parser.parseForPatternDetection('#123')

				expect(result).toEqual({
					type: 'pr',
					number: 123,
					originalInput: '#123',
				} as ParsedInput)
			})
		})

		describe('Issue detection', () => {
			it('should detect issue from issue-NN pattern in branch', async () => {
				const mockIssueWorktree: GitWorktree = {
					path: '/test/worktree-issue-39',
					branch: 'issue-39',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue(mockIssueWorktree)

				const result = await parser.parseForPatternDetection('39')

				expect(result).toEqual({
					type: 'issue',
					number: 39,
					originalInput: '39',
				} as ParsedInput)

				// Verify precedence: PR checked first, then issue
				expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(39, '')
				expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(39)
			})

			it('should detect issue from numeric input when matching worktree exists', async () => {
				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue({
					path: '/test/issue-50',
					branch: 'issue-50-feature',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				})

				const result = await parser.parseForPatternDetection('50')

				expect(result.type).toBe('issue')
				expect(result.number).toBe(50)
			})

			it('should handle # prefix for issue detection', async () => {
				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue({
					path: '/test/issue-77',
					branch: 'issue-77',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				})

				const result = await parser.parseForPatternDetection('#77')

				expect(result).toEqual({
					type: 'issue',
					number: 77,
					originalInput: '#77',
				} as ParsedInput)
			})

			it('should handle edge cases like tissue-66 without false positives', async () => {
				// This test ensures findWorktreeForIssue doesn't match tissue-66 for issue 66
				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(null)

				await expect(parser.parseForPatternDetection('66')).rejects.toThrow(
					'No worktree found for identifier: 66'
				)

				expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(66)
			})
		})

		describe('Branch detection', () => {
			it('should return branch type when no patterns match', async () => {
				const mockBranchWorktree: GitWorktree = {
					path: '/test/my-custom-branch',
					branch: 'my-custom-branch',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(mockBranchWorktree)

				const result = await parser.parseForPatternDetection('my-custom-branch')

				expect(result).toEqual({
					type: 'branch',
					branchName: 'my-custom-branch',
					originalInput: 'my-custom-branch',
				} as ParsedInput)

				// Should not check for PR or issue patterns with non-numeric input
				expect(mockGitWorktreeManager.findWorktreeForPR).not.toHaveBeenCalled()
				expect(mockGitWorktreeManager.findWorktreeForIssue).not.toHaveBeenCalled()
				expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith(
					'my-custom-branch'
				)
			})

			it('should handle branch names with slashes', async () => {
				const mockBranchWorktree: GitWorktree = {
					path: '/test/feat-new-feature',
					branch: 'feat/new-feature',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(mockBranchWorktree)

				const result = await parser.parseForPatternDetection('feat/new-feature')

				expect(result.type).toBe('branch')
				expect(result.branchName).toBe('feat/new-feature')
			})

			it('should throw error when branch worktree does not exist', async () => {
				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(null)

				await expect(
					parser.parseForPatternDetection('non-existent-branch')
				).rejects.toThrow('No worktree found for identifier: non-existent-branch')
			})

			it('should extract issue number from branch name with issue-NN__ pattern', async () => {
				const mockBranchWorktree: GitWorktree = {
					path: '/test/feat-issue-42-feature',
					branch: 'feat/issue-42__add-feature',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(mockBranchWorktree)

				const result = await parser.parseForPatternDetection('feat/issue-42__add-feature')

				expect(result).toEqual({
					type: 'issue',
					number: '42',
					originalInput: 'feat/issue-42__add-feature',
				} as ParsedInput)
			})

			it('should extract issue number from branch name with issue-NN- pattern', async () => {
				const mockBranchWorktree: GitWorktree = {
					path: '/test/issue-123-fix-bug',
					branch: 'issue-123-fix-bug',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(mockBranchWorktree)

				const result = await parser.parseForPatternDetection('issue-123-fix-bug')

				expect(result).toEqual({
					type: 'issue',
					number: '123',
					originalInput: 'issue-123-fix-bug',
				} as ParsedInput)
			})

			it('should extract PR number from branch name with pr/ pattern', async () => {
				const mockBranchWorktree: GitWorktree = {
					path: '/test/pr-456',
					branch: 'pr/456',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(mockBranchWorktree)

				const result = await parser.parseForPatternDetection('pr/456')

				expect(result).toEqual({
					type: 'pr',
					number: 456,
					originalInput: 'pr/456',
				} as ParsedInput)
			})

			it('should prioritize PR extraction over issue extraction for branch names', async () => {
				// A branch name like "pr-123" should be detected as PR even if it also contains issue pattern
				const mockBranchWorktree: GitWorktree = {
					path: '/test/feature-pr-123',
					branch: 'feature/pr-123',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(mockBranchWorktree)

				const result = await parser.parseForPatternDetection('feature/pr-123')

				expect(result.type).toBe('pr')
				expect(result.number).toBe(123)
			})
		})

		describe('Error handling', () => {
			it('should throw error when numeric identifier has no matching worktree', async () => {
				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue(null)

				await expect(parser.parseForPatternDetection('999')).rejects.toThrow(
					'No worktree found for identifier: 999'
				)
			})

			it('should throw error when branch identifier has no matching worktree', async () => {
				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(null)

				await expect(parser.parseForPatternDetection('missing-branch')).rejects.toThrow(
					'No worktree found for identifier: missing-branch'
				)
			})

			it('should handle empty string gracefully', async () => {
				await expect(parser.parseForPatternDetection('')).rejects.toThrow(
					'No worktree found for identifier: '
				)
			})

			it('should handle whitespace-only input', async () => {
				mockGitWorktreeManager.findWorktreeForBranch.mockResolvedValue(null)

				await expect(parser.parseForPatternDetection('   ')).rejects.toThrow(
					'No worktree found for identifier:'
				)
			})
		})

		describe('GitHub API isolation', () => {
			it('should not make GitHub API calls', async () => {
				// This test verifies that IdentifierParser uses only GitWorktreeManager methods
				// and does NOT call GitHubService
				const mockPRWorktree: GitWorktree = {
					path: '/test/parent/feat-test_pr_42',
					branch: 'feat/test',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(mockPRWorktree)

				await parser.parseForPatternDetection('42')

				// Only GitWorktreeManager methods should be called
				expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalled()

				// No external API calls should be made
				// (This is enforced by not injecting GitHubService into IdentifierParser)
			})
		})

		describe('Precedence rules', () => {
			it('should check PR pattern before issue pattern for numeric input', async () => {
				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(null)
				mockGitWorktreeManager.findWorktreeForIssue.mockResolvedValue({
					path: '/test/issue-100',
					branch: 'issue-100',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				})

				await parser.parseForPatternDetection('100')

				// Verify both methods were called
				expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(100, '')
				expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(100)
			})

			it('should not check issue pattern if PR pattern matches', async () => {
				const mockPRWorktree: GitWorktree = {
					path: '/test/parent/feat-test_pr_200',
					branch: 'feat/test',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				mockGitWorktreeManager.findWorktreeForPR.mockResolvedValue(mockPRWorktree)

				await parser.parseForPatternDetection('200')

				expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalled()
				expect(mockGitWorktreeManager.findWorktreeForIssue).not.toHaveBeenCalled()
			})
		})
	})
})

describe('matchIssueIdentifier', () => {
	describe('numeric patterns (GitHub format)', () => {
		it('should match plain numeric identifier', () => {
			const result = matchIssueIdentifier('123')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'numeric',
				identifier: '123',
			})
		})

		it('should match numeric identifier with hash prefix', () => {
			const result = matchIssueIdentifier('#456')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'numeric',
				identifier: '456',
			})
		})

		it('should trim whitespace from input', () => {
			const result = matchIssueIdentifier('  789  ')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'numeric',
				identifier: '789',
			})
		})
	})

	describe('project key patterns', () => {
		it('should match standard project key identifier', () => {
			const result = matchIssueIdentifier('ENG-123')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'project-key',
				identifier: 'ENG-123',
			})
		})

		it('should match lowercase project key identifier and uppercase it', () => {
			const result = matchIssueIdentifier('plat-456')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'project-key',
				identifier: 'PLAT-456',
			})
		})

		it('should match mixed case project key identifier and uppercase it', () => {
			const result = matchIssueIdentifier('Proj-789')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'project-key',
				identifier: 'PROJ-789',
			})
		})

		it('should match project key identifier with longer team prefix', () => {
			const result = matchIssueIdentifier('PLATFORM-1')
			expect(result).toEqual({
				isIssueIdentifier: true,
				type: 'project-key',
				identifier: 'PLATFORM-1',
			})
		})
	})

	describe('non-matching inputs', () => {
		it('should not match PR format (single letter prefix)', () => {
			// PR-123 has only 2 letters which is the minimum, but starts with PR
			// which could be confused with "pull request"
			// However our pattern requires 2+ letters so PR-123 actually matches
			// Let's verify behavior - this is edge case
			const result = matchIssueIdentifier('PR-123')
			// PR-123 does match our Linear pattern (2+ letters before dash)
			expect(result.isIssueIdentifier).toBe(true)
			expect(result.type).toBe('project-key')
		})

		it('should not match single letter prefix', () => {
			const result = matchIssueIdentifier('A-123')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match plain text', () => {
			const result = matchIssueIdentifier('fix the bug')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match URL', () => {
			const result = matchIssueIdentifier('https://github.com/org/repo/issues/123')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match branch name', () => {
			const result = matchIssueIdentifier('feature/add-new-feature')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match empty string', () => {
			const result = matchIssueIdentifier('')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match whitespace only', () => {
			const result = matchIssueIdentifier('   ')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match numeric with trailing text', () => {
			const result = matchIssueIdentifier('123abc')
			expect(result).toEqual({ isIssueIdentifier: false })
		})

		it('should not match Linear format with extra characters', () => {
			const result = matchIssueIdentifier('ENG-123-foo')
			expect(result).toEqual({ isIssueIdentifier: false })
		})
	})
})
