import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InstallDepsCommand } from './install-deps.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { GitWorktree } from '../types/worktree.js'
import * as packageManager from '../utils/package-manager.js'

// Mock dependencies
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../utils/IdentifierParser.js', () => ({
	IdentifierParser: vi.fn().mockImplementation(() => ({
		parseForPatternDetection: vi.fn(),
	})),
}))

// Mock package utilities
vi.mock('../utils/package-json.js', () => ({
	getPackageScripts: vi.fn(),
}))

vi.mock('../utils/package-manager.js', () => ({
	installDependencies: vi.fn(),
	runScript: vi.fn(),
}))

// Mock the logger to prevent console output during tests
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

describe('InstallDepsCommand', () => {
	let command: InstallDepsCommand
	let mockGitWorktreeManager: GitWorktreeManager

	const mockWorktree: GitWorktree = {
		path: '/test/worktrees/issue-87',
		branch: 'feat/issue-87__test',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	beforeEach(() => {
		mockGitWorktreeManager = new GitWorktreeManager()
		command = new InstallDepsCommand(mockGitWorktreeManager)
	})

	describe('identifier parsing', () => {
		it('should auto-detect from PR worktree pattern (_pr_N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/project_pr_45')

			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)
			vi.mocked(packageManager.installDependencies).mockResolvedValue(undefined)

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(45, '')

			process.cwd = originalCwd
		})

		it('should auto-detect from issue directory pattern (issue-N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(packageManager.installDependencies).mockResolvedValue(undefined)

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith('87')

			process.cwd = originalCwd
		})

		it('should throw when no worktree found for identifier', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-99-test')

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)

			await expect(command.execute({})).rejects.toThrow("No worktree found for issue #99")

			process.cwd = originalCwd
		})
	})

	describe('install execution', () => {
		beforeEach(() => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			return () => {
				process.cwd = originalCwd
			}
		})

		it('should call installDependencies with frozen=true, quiet=false by default', async () => {
			vi.mocked(packageManager.installDependencies).mockResolvedValue(undefined)

			await command.execute({})

			expect(packageManager.installDependencies).toHaveBeenCalledWith(
				mockWorktree.path,
				true,
				false,
			)
		})

		it('should call installDependencies with frozen=false when specified', async () => {
			vi.mocked(packageManager.installDependencies).mockResolvedValue(undefined)

			await command.execute({ frozen: false })

			expect(packageManager.installDependencies).toHaveBeenCalledWith(
				mockWorktree.path,
				false,
				false,
			)
		})

		it('should propagate errors from installDependencies', async () => {
			vi.mocked(packageManager.installDependencies).mockRejectedValue(
				new Error('Failed to install dependencies: npm ci failed'),
			)

			await expect(command.execute({})).rejects.toThrow('Failed to install dependencies')
		})
	})
})
