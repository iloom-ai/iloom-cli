import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestCommand } from './test.js'
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

describe('TestCommand', () => {
	let command: TestCommand
	let mockGitWorktreeManager: GitWorktreeManager

	const mockWorktree: GitWorktree = {
		path: '/test/worktrees/issue-87',
		branch: 'feat/issue-87__test',
		commit: 'abc123',
		prunable: 'no',
	}

	beforeEach(() => {
		mockGitWorktreeManager = new GitWorktreeManager()
		command = new TestCommand(mockGitWorktreeManager)
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
				test: { command: 'vitest', source: 'package-manager' },
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
				test: { command: 'vitest', source: 'package-manager' },
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

	describe('script execution', () => {
		beforeEach(() => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			return () => {
				process.cwd = originalCwd
			}
		})

		it('should run test script via runScript()', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				test: { command: 'vitest', source: 'package-manager' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

			await command.execute({})

			expect(packageManager.runScript).toHaveBeenCalledWith('test', mockWorktree.path, [], { packages: [] })
		})

		it('should pass worktree path to runScript()', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				test: { command: 'go test ./...', source: 'iloom-config' },
			})
			vi.mocked(packageManager.runScript).mockResolvedValue({})

			await command.execute({})

			expect(packageManager.runScript).toHaveBeenCalledWith(
				'test',
				mockWorktree.path,
				[],
				{ packages: [] }
			)
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

		it('should throw with "No test script defined in package.iloom.json" when script missing', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({
				build: { command: 'tsc', source: 'package-manager' },
				lint: { command: 'eslint', source: 'package-manager' },
			})

			await expect(command.execute({})).rejects.toThrow(
				'No test script defined in package.json or package.iloom.json'
			)
		})

		it('should throw when no package configuration found', async () => {
			vi.mocked(packageJson.getPackageScripts).mockResolvedValue({})

			await expect(command.execute({})).rejects.toThrow(
				'No test script defined in package.json or package.iloom.json'
			)
		})
	})
})
