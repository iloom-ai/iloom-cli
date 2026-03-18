import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CompileCommand } from './compile.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import type { GitWorktree } from '../types/worktree.js'
import * as packageJson from '../utils/package-json.js'
import * as packageManager from '../utils/package-manager.js'

// Mock dependencies
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../utils/IdentifierParser.js', () => ({
	IdentifierParser: vi.fn().mockImplementation(() => ({
		parseForPatternDetection: vi.fn(),
	})),
}))
vi.mock('../lib/MetadataManager.js')

// Mock package utilities
vi.mock('../utils/package-json.js', () => ({
	getPackageScripts: vi.fn(),
}))

vi.mock('../utils/package-manager.js', () => ({
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

describe('CompileCommand', () => {
	let command: CompileCommand
	let mockGitWorktreeManager: GitWorktreeManager

	const mockWorktree: GitWorktree = {
		path: '/test/worktrees/issue-87',
		branch: 'feat/issue-87__test',
		commit: 'abc123',
		prunable: 'no',
	}

	beforeEach(() => {
		mockGitWorktreeManager = new GitWorktreeManager()
		command = new CompileCommand(mockGitWorktreeManager)
		// Set up MetadataManager mock to return no packagesToValidate by default
		vi.mocked(MetadataManager).mockImplementation(() => ({
			readMetadata: vi.fn().mockResolvedValue(null),
		} as unknown as MetadataManager))
	})

	describe('identifier parsing', () => {
		it('should auto-detect from PR worktree pattern (_pr_N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/project_pr_45')

			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				compile: { command: 'tsc --noEmit', source: 'package-manager' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(45, '')

			process.cwd = originalCwd
		})

		it('should auto-detect from issue directory pattern (issue-N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				compile: { command: 'tsc --noEmit', source: 'package-manager' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

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

	describe('script priority', () => {
		beforeEach(() => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			return () => {
				process.cwd = originalCwd
			}
		})

		it('should run compile script if it exists', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				compile: { command: 'tsc --noEmit', source: 'package-manager' },
				typecheck: { command: 'tsc --noEmit --watch', source: 'package-manager' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

			await command.execute({})

			expect(packageManager.runScript).toHaveBeenCalledWith('compile', mockWorktree.path, [], { packages: [] })
		})

		it('should fallback to typecheck if compile does not exist', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				typecheck: { command: 'tsc --noEmit', source: 'package-manager' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

			await command.execute({})

			expect(packageManager.runScript).toHaveBeenCalledWith('typecheck', mockWorktree.path, [], { packages: [] })
		})

		it('should skip silently if neither compile nor typecheck exist', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				build: { command: 'tsc', source: 'package-manager' },
				lint: { command: 'eslint', source: 'package-manager' },
			})

			// Should not throw
			await expect(command.execute({})).resolves.toBeUndefined()

			// Should not call runScript
			expect(packageManager.runScript).not.toHaveBeenCalled()
		})

		it('should prefer compile over typecheck when both exist', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				compile: { command: 'go build ./...', source: 'iloom-config' },
				typecheck: { command: 'tsc --noEmit', source: 'package-manager' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

			await command.execute({})

			expect(packageManager.runScript).toHaveBeenCalledWith('compile', mockWorktree.path, [], { packages: [] })
			expect(packageManager.runScript).toHaveBeenCalledTimes(1)
		})
	})

	describe('missing script handling', () => {
		beforeEach(() => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			return () => {
				process.cwd = originalCwd
			}
		})

		it('should NOT throw when neither script exists (skip silently)', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				build: { command: 'tsc', source: 'package-manager' },
			})

			// Should not throw - just skip silently
			await expect(command.execute({})).resolves.toBeUndefined()
		})

		it('should not call runScript when no compile/typecheck scripts exist', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({})

			await command.execute({})

			expect(packageManager.runScript).not.toHaveBeenCalled()
		})
	})
})
