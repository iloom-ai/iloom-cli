import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PRManager } from './PRManager.js'
import * as githubUtils from '../utils/github.js'
import * as claudeUtils from '../utils/claude.js'
import * as remoteUtils from '../utils/remote.js'
import * as browserUtils from '../utils/browser.js'
import type { IloomSettings } from './SettingsManager.js'

vi.mock('../utils/github.js')
vi.mock('../utils/claude.js')
vi.mock('../utils/remote.js')
vi.mock('../utils/browser.js')
vi.mock('./IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		formatIssueId: vi.fn((provider: string, id: string | number) => {
			if (provider === 'github') return `#${id}`
			return String(id).toUpperCase()
		}),
		getProviderName: vi.fn((settings: Record<string, unknown>) => {
			const issueManagement = settings.issueManagement as Record<string, unknown> | undefined
			return (issueManagement?.provider as string) ?? 'github'
		}),
	},
}))

describe('PRManager', () => {
	let prManager: PRManager
	let mockSettings: IloomSettings

	beforeEach(() => {
		mockSettings = {
			mergeBehavior: {
				mode: 'github-pr',
			},
			issueManagement: {
				github: {
					remote: 'origin',
				},
			},
		} as IloomSettings

		prManager = new PRManager(mockSettings)
	})

	describe('checkForExistingPR', () => {
		it('should detect existing open PR for branch', async () => {
			const mockPRList = [
				{ number: 123, url: 'https://github.com/owner/repo/pull/123' },
			]
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(mockPRList)

			const result = await prManager.checkForExistingPR('feature-branch')

			expect(result).toEqual({ number: 123, url: 'https://github.com/owner/repo/pull/123' })
			expect(githubUtils.executeGhCommand).toHaveBeenCalledWith(
				['pr', 'list', '--head', 'feature-branch', '--state', 'open', '--json', 'number,url'],
				undefined
			)
		})

		it('should return null when no PR exists for branch', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce([])

			const result = await prManager.checkForExistingPR('feature-branch')

			expect(result).toBeNull()
		})

		it('should handle gh CLI errors gracefully', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(new Error('gh command failed'))

			const result = await prManager.checkForExistingPR('feature-branch')

			expect(result).toBeNull()
		})
	})

	describe('generatePRBody', () => {
		it('should include issue context when issue number provided', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)

			const body = await prManager.generatePRBody(123, '/path/to/worktree')

			expect(body).toContain('Fixes #123')
		})

		it('should use empty prefix for Linear issues', async () => {
			// Create PRManager with Linear provider
			const linearSettings = {
				...mockSettings,
				issueManagement: {
					provider: 'linear' as const,
				},
			} as IloomSettings
			const linearPrManager = new PRManager(linearSettings)

			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)

			const body = await linearPrManager.generatePRBody('ENG-123', '/path/to/worktree')

			expect(body).toContain('Fixes ENG-123')
			expect(body).not.toContain('Fixes #ENG-123')
		})

		it('should use # prefix for GitHub issues (default)', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)

			const body = await prManager.generatePRBody(456, '/path/to/worktree')

			expect(body).toContain('Fixes #456')
		})

		it('should use Claude for body generation when available', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(true)
			vi.mocked(claudeUtils.launchClaude).mockResolvedValueOnce('Claude-generated PR body\n\nFixes #123')

			const body = await prManager.generatePRBody(123, '/path/to/worktree')

			expect(body).toBe('Claude-generated PR body\n\nFixes #123')
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('<Task>'),
				expect.objectContaining({
					headless: true,
					addDir: '/path/to/worktree',
				})
			)
		})

		it('should sanitize Claude output to remove meta-commentary', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(true)
			vi.mocked(claudeUtils.launchClaude).mockResolvedValueOnce(
				"Here's the PR body:\n\n---\n\nAdd user authentication with JWT tokens.\n\nFixes #123"
			)

			const body = await prManager.generatePRBody(123, '/path/to/worktree')

			expect(body).toBe('Add user authentication with JWT tokens.\n\nFixes #123')
		})

		it('should sanitize "Based on the changes" meta-commentary', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(true)
			vi.mocked(claudeUtils.launchClaude).mockResolvedValueOnce(
				'Based on the changes: Fix navigation bug in sidebar.\n\nFixes #42'
			)

			const body = await prManager.generatePRBody(42, '/path/to/worktree')

			expect(body).toBe('Fix navigation bug in sidebar.\n\nFixes #42')
		})

		it('should remove quotes wrapping the entire body', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(true)
			vi.mocked(claudeUtils.launchClaude).mockResolvedValueOnce(
				'"Add user authentication with JWT tokens.\n\nFixes #123"'
			)

			const body = await prManager.generatePRBody(123, '/path/to/worktree')

			expect(body).toBe('Add user authentication with JWT tokens.\n\nFixes #123')
		})

		it('should fallback to simple template when Claude unavailable', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)

			const body = await prManager.generatePRBody(123, '/path/to/worktree')

			expect(body).toContain('This PR contains changes from the iloom workflow')
			expect(body).toContain('Fixes #123')
		})

		it('should fallback to simple template when Claude fails', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(true)
			vi.mocked(claudeUtils.launchClaude).mockRejectedValueOnce(new Error('Claude failed'))

			const body = await prManager.generatePRBody(123, '/path/to/worktree')

			expect(body).toContain('This PR contains changes from the iloom workflow')
			expect(body).toContain('Fixes #123')
		})

		it('should handle undefined issue number', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)

			const body = await prManager.generatePRBody(undefined, '/path/to/worktree')

			expect(body).toContain('This PR contains changes from the iloom workflow')
			expect(body).not.toContain('Fixes #')
		})
	})

	describe('createPR', () => {
		it('should create PR with correct title and body', async () => {
			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('origin')
			// gh pr create returns plain text URL, not JSON
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(
				'https://github.com/owner/repo/pull/123'
			)

			const url = await prManager.createPR(
				'feature-branch',
				'My PR Title',
				'My PR Body',
				'main',
				'/path/to/worktree'
			)

			expect(url).toBe('https://github.com/owner/repo/pull/123')
			expect(githubUtils.executeGhCommand).toHaveBeenCalledWith(
				['pr', 'create', '--head', 'feature-branch', '--title', 'My PR Title', '--body', 'My PR Body', '--base', 'main'],
				{ cwd: '/path/to/worktree' }
			)
		})

		it('should target correct remote based on settings and use owner:branch format', async () => {
			mockSettings.mergeBehavior = { mode: 'github-pr', remote: 'upstream' }
			prManager = new PRManager(mockSettings)

			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('upstream')
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:myuser/repo.git', owner: 'myuser', repo: 'repo' },
				{ name: 'upstream', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(remoteUtils.getConfiguredRepoFromSettings).mockResolvedValueOnce('owner/repo')
			// gh pr create returns plain text URL, not JSON
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(
				'https://github.com/owner/repo/pull/123'
			)

			await prManager.createPR(
				'feature-branch',
				'My PR Title',
				'My PR Body',
				'main',
				'/path/to/worktree'
			)

			// For fork workflows, --head should use "owner:branch" format
			expect(githubUtils.executeGhCommand).toHaveBeenCalledWith(
				[
					'pr',
					'create',
					'--head',
					'myuser:feature-branch',
					'--title',
					'My PR Title',
					'--body',
					'My PR Body',
					'--base',
					'main',
					'--repo',
					'owner/repo',
				],
				{ cwd: '/path/to/worktree' }
			)
		})

		it('should use --repo flag for fork workflows', async () => {
			mockSettings.issueManagement = {
				github: {
					remote: 'upstream',
				},
			}
			prManager = new PRManager(mockSettings)

			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('upstream')
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:myuser/repo.git', owner: 'myuser', repo: 'repo' },
				{ name: 'upstream', url: 'git@github.com:upstream-owner/repo.git', owner: 'upstream-owner', repo: 'repo' },
			])
			vi.mocked(remoteUtils.getConfiguredRepoFromSettings).mockResolvedValueOnce('upstream-owner/repo')
			// gh pr create returns plain text URL, not JSON
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(
				'https://github.com/upstream-owner/repo/pull/123'
			)

			await prManager.createPR(
				'feature-branch',
				'My PR Title',
				'My PR Body',
				'main',
				'/path/to/worktree'
			)

			expect(remoteUtils.getConfiguredRepoFromSettings).toHaveBeenCalledWith(
				mockSettings,
				'/path/to/worktree'
			)
			expect(githubUtils.executeGhCommand).toHaveBeenCalledWith(
				expect.arrayContaining(['--repo', 'upstream-owner/repo']),
				expect.any(Object)
			)
		})

		it('should handle creation failure gracefully', async () => {
			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('origin')
			vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
				new Error('Failed to create PR')
			)

			await expect(
				prManager.createPR('feature-branch', 'Title', 'Body', 'main')
			).rejects.toThrow('Failed to create pull request')
		})

		it('should provide helpful error message for GraphQL SHA errors', async () => {
			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('origin')
			vi.mocked(githubUtils.executeGhCommand).mockRejectedValueOnce(
				new Error("GraphQL: Head sha can't be blank, Base sha can't be blank")
			)

			await expect(
				prManager.createPR('feature-branch', 'Title', 'Body', 'main')
			).rejects.toThrow(/branch was not fully pushed/)
		})
	})

	describe('openPRInBrowser', () => {
		it('should open PR URL in browser', async () => {
			vi.mocked(browserUtils.openBrowser).mockResolvedValueOnce()

			await prManager.openPRInBrowser('https://github.com/owner/repo/pull/123')

			expect(browserUtils.openBrowser).toHaveBeenCalledWith(
				'https://github.com/owner/repo/pull/123'
			)
		})

		it('should not throw when browser opening fails', async () => {
			vi.mocked(browserUtils.openBrowser).mockRejectedValueOnce(new Error('Browser failed'))

			// Should not throw
			await expect(
				prManager.openPRInBrowser('https://github.com/owner/repo/pull/123')
			).resolves.toBeUndefined()
		})
	})

	describe('createOrOpenPR', () => {
		it('should return existing PR when found', async () => {
			const existingPR = { number: 123, url: 'https://github.com/owner/repo/pull/123' }
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce([existingPR])
			vi.mocked(browserUtils.openBrowser).mockResolvedValueOnce()

			const result = await prManager.createOrOpenPR(
				'feature-branch',
				'Title',
				123,
				'main',
				'/path/to/worktree',
				true
			)

			expect(result).toEqual({
				url: existingPR.url,
				number: existingPR.number,
				wasExisting: true,
			})
			expect(browserUtils.openBrowser).toHaveBeenCalledWith(existingPR.url)
		})

		it('should create new PR when none exists', async () => {
			vi.mocked(githubUtils.executeGhCommand)
				.mockResolvedValueOnce([]) // checkForExistingPR
				// gh pr create returns plain text URL, not JSON
				.mockResolvedValueOnce('https://github.com/owner/repo/pull/124') // createPR

			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)
			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('origin')
			vi.mocked(browserUtils.openBrowser).mockResolvedValueOnce()

			const result = await prManager.createOrOpenPR(
				'feature-branch',
				'Title',
				123,
				'main',
				'/path/to/worktree',
				true
			)

			expect(result).toEqual({
				url: 'https://github.com/owner/repo/pull/124',
				number: 124,
				wasExisting: false,
			})
			expect(browserUtils.openBrowser).toHaveBeenCalledWith(
				'https://github.com/owner/repo/pull/124'
			)
		})

		it('should skip browser opening when requested', async () => {
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce([]) // No existing PR
			// gh pr create returns plain text URL, not JSON
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(
				'https://github.com/owner/repo/pull/124'
			)

			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)
			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('origin')

			await prManager.createOrOpenPR(
				'feature-branch',
				'Title',
				123,
				'main',
				'/path/to/worktree',
				false // Don't open browser
			)

			expect(browserUtils.openBrowser).not.toHaveBeenCalled()
		})
	})

	describe('Fork Workflow Integration', () => {
		it('should use issueManagement.github.remote as default target', async () => {
			mockSettings.issueManagement = {
				github: {
					remote: 'upstream',
				},
			}
			delete mockSettings.mergeBehavior?.remote
			prManager = new PRManager(mockSettings)

			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('upstream')
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:myuser/repo.git', owner: 'myuser', repo: 'repo' },
				{ name: 'upstream', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(remoteUtils.getConfiguredRepoFromSettings).mockResolvedValueOnce('owner/repo')
			// gh pr create returns plain text URL, not JSON
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(
				'https://github.com/owner/repo/pull/123'
			)

			await prManager.createPR('feature-branch', 'Title', 'Body', 'main', '/path/to/worktree')

			expect(remoteUtils.getEffectivePRTargetRemote).toHaveBeenCalledWith(
				mockSettings,
				'/path/to/worktree'
			)
		})

		it('should prefer mergeBehavior.remote over issueManagement.github.remote', async () => {
			mockSettings.mergeBehavior = { mode: 'github-pr', remote: 'upstream-custom' }
			mockSettings.issueManagement = {
				github: {
					remote: 'upstream-default',
				},
			}
			prManager = new PRManager(mockSettings)

			vi.mocked(remoteUtils.getEffectivePRTargetRemote).mockResolvedValueOnce('upstream-custom')
			vi.mocked(remoteUtils.parseGitRemotes).mockResolvedValueOnce([
				{ name: 'origin', url: 'git@github.com:myuser/repo.git', owner: 'myuser', repo: 'repo' },
				{ name: 'upstream-custom', url: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo' },
			])
			vi.mocked(remoteUtils.getConfiguredRepoFromSettings).mockResolvedValueOnce('owner/repo')
			// gh pr create returns plain text URL, not JSON
			vi.mocked(githubUtils.executeGhCommand).mockResolvedValueOnce(
				'https://github.com/owner/repo/pull/123'
			)

			await prManager.createPR('feature-branch', 'Title', 'Body', 'main', '/path/to/worktree')

			expect(remoteUtils.getEffectivePRTargetRemote).toHaveBeenCalledWith(
				mockSettings,
				'/path/to/worktree'
			)
		})
	})
})
