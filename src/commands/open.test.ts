import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenCommand } from './open.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { DevServerManager } from '../lib/DevServerManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import type { GitWorktree } from '../types/worktree.js'
import type { ProjectCapabilities } from '../types/loom.js'
import fs from 'fs-extra'
import path from 'path'
import { execa } from 'execa'
import { openBrowser } from '../utils/browser.js'

// Mock dependencies
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/ProjectCapabilityDetector.js')
vi.mock('../lib/DevServerManager.js')
vi.mock('../utils/IdentifierParser.js')
vi.mock('fs-extra')
vi.mock('execa')
vi.mock('../lib/SettingsManager.js', () => {
	return {
		SettingsManager: class MockSettingsManager {
			async loadSettings() {
				return {}
			}
		},
	}
})

// Mock browser utilities
vi.mock('../utils/browser.js', () => ({
	openBrowser: vi.fn().mockResolvedValue(undefined),
	detectPlatform: vi.fn().mockReturnValue('darwin'),
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

describe('OpenCommand', () => {
	let command: OpenCommand
	let mockGitWorktreeManager: GitWorktreeManager
	let mockCapabilityDetector: ProjectCapabilityDetector
	let mockDevServerManager: DevServerManager
	let mockIdentifierParser: IdentifierParser

	const mockWorktree: GitWorktree = {
		path: '/test/worktrees/issue-87',
		branch: 'feat/issue-87-test',
		commit: 'abc123',
		prunable: 'no',
	}

	beforeEach(() => {
		mockGitWorktreeManager = new GitWorktreeManager()
		mockCapabilityDetector = new ProjectCapabilityDetector()
		mockDevServerManager = new DevServerManager()
		mockIdentifierParser = new IdentifierParser(mockGitWorktreeManager)

		// Mock DevServerManager to always return true (server ready)
		vi.mocked(mockDevServerManager.ensureServerRunning).mockResolvedValue(true)

		command = new OpenCommand(
			mockGitWorktreeManager,
			mockCapabilityDetector,
			mockIdentifierParser,
			mockDevServerManager
		)

		// Reset all mocks
		vi.clearAllMocks()
	})

	describe('workspace detection', () => {
		it('should auto-detect from PR worktree pattern (_pr_N)', async () => {
			// Mock process.cwd() to return PR worktree directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/project_pr_45')

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

			// Mock capability detection
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3045\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(45, '')

			// Restore
			process.cwd = originalCwd
		})

		it('should auto-detect from issue directory pattern (issue-N)', async () => {
			// Mock process.cwd() to return issue directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)

			// Mock capability detection
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(87)

			// Restore
			process.cwd = originalCwd
		})

		it('should auto-detect from git branch name', async () => {
			// Mock process.cwd() to return non-pattern directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/some-feature')

			// Mock getRepoInfo to return branch with issue pattern
			vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
				currentBranch: 'feat/issue-87-description',
				mainBranch: 'main',
				worktrees: [],
			})

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)

			// Mock capability detection
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(87)

			// Restore
			process.cwd = originalCwd
		})

		it('should fall back to branch name when no patterns match', async () => {
			// Mock process.cwd() to return non-pattern directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/some-feature')

			// Mock getRepoInfo to return branch without issue pattern
			vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
				currentBranch: 'my-custom-branch',
				mainBranch: 'main',
				worktrees: [],
			})

			// Mock worktree finding by branch name
			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(
				mockWorktree
			)

			// Mock capability detection
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3000\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith(
				'my-custom-branch'
			)

			// Restore
			process.cwd = originalCwd
		})

		it('should throw error when no identifier and auto-detection fails', async () => {
			// Mock process.cwd() to return non-pattern directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/some-feature')

			// Mock getRepoInfo to return null branch
			vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
				currentBranch: null,
				mainBranch: 'main',
				worktrees: [],
			})

			await expect(command.execute({})).rejects.toThrow(
				'Could not auto-detect identifier'
			)

			// Restore
			process.cwd = originalCwd
		})
	})

	describe('capability detection and execution', () => {
		beforeEach(() => {
			// Mock parseForPatternDetection for explicit identifier
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)
		})

		it('should open browser for web-only project', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({ identifier: '87' })

			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3087')
		})

		it('should run CLI for CLI-only project', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file exists
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith('node', [binPath], {
				stdio: 'inherit',
				cwd: mockWorktree.path,
				env: process.env,
			})
		})

		it('should open browser for web+CLI project (web takes precedence)', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web', 'cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({ identifier: '87' })

			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3087')
			expect(execa).not.toHaveBeenCalled()
		})

		it('should throw error for project with no capabilities', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: [],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			await expect(command.execute({ identifier: '87' })).rejects.toThrow(
				'No web or CLI capabilities detected'
			)
		})
	})

	describe('browser launching', () => {
		beforeEach(() => {
			// Mock parseForPatternDetection
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)

			// Mock capability detection
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)
		})

		it('should construct correct URL with port from .env', async () => {
			// Mock .env file
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\nOTHER_VAR=value\n')

			await command.execute({ identifier: '87' })

			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3087')
		})

		it('should calculate PORT when .env file not found', async () => {
			// Mock .env file not existing
			vi.mocked(fs.pathExists).mockResolvedValue(false)

			// Mock listWorktrees to return the worktree
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				{
					path: '/test/worktrees/issue-87',
					branch: 'feat/issue-87-test',
					isMain: false,
				},
			])

			await command.execute({ identifier: '87' })

			// Should calculate port as 3000 + 87 = 3087
			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3087')
		})

		it('should calculate PORT when missing from .env', async () => {
			// Mock .env file without PORT
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('OTHER_VAR=value\n')

			// Mock listWorktrees to return the worktree
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				{
					path: '/test/worktrees/issue-87',
					branch: 'feat/issue-87-test',
					isMain: false,
				},
			])

			await command.execute({ identifier: '87' })

			// Should calculate port as 3000 + 87 = 3087
			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3087')
		})
	})

	describe('CLI execution fallback', () => {
		beforeEach(() => {
			// Mock parseForPatternDetection
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)
		})

		it('should execute CLI when no web capability', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file exists
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith('node', [binPath], {
				stdio: 'inherit',
				cwd: mockWorktree.path,
				env: process.env,
			})
		})

		it('should construct correct path to bin file in worktree', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { iloom: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file exists
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			const expectedPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith('node', [expectedPath], {
				stdio: 'inherit',
				cwd: mockWorktree.path,
				env: process.env,
			})
		})

		it('should pass through additional arguments', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file exists
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87', args: ['--help', '--verbose'] })

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith('node', [binPath, '--help', '--verbose'], {
				stdio: 'inherit',
				cwd: mockWorktree.path,
				env: process.env,
			})
		})

		it('should use first bin entry when multiple exist', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: {
					il: './dist/cli.js',
					iloom: './dist/cli.js',
					other: './dist/other.js',
				},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file exists
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			// Should use first entry (il)
			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith('node', [binPath], {
				stdio: 'inherit',
				cwd: mockWorktree.path,
				env: process.env,
			})
		})

		it('should throw error when bin file does not exist', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file does not exist
			vi.mocked(fs.pathExists).mockResolvedValue(false)

			await expect(command.execute({ identifier: '87' })).rejects.toThrow(
				'CLI executable not found'
			)
		})
	})

	describe('argument passing', () => {
		beforeEach(() => {
			// Mock parseForPatternDetection
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)

			// Mock capability detection for CLI
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock bin file exists
			vi.mocked(fs.pathExists).mockResolvedValue(true)
		})

		it('should pass single argument to CLI', async () => {
			await command.execute({ identifier: '87', args: ['--help'] })

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith('node', [binPath, '--help'], {
				stdio: 'inherit',
				cwd: mockWorktree.path,
				env: process.env,
			})
		})

		it('should pass multiple arguments to CLI', async () => {
			await command.execute({
				identifier: '87',
				args: ['start', '--port', '4000'],
			})

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith(
				'node',
				[binPath, 'start', '--port', '4000'],
				{
					stdio: 'inherit',
					cwd: mockWorktree.path,
					env: process.env,
				}
			)
		})

		it('should handle arguments with spaces/quotes', async () => {
			await command.execute({
				identifier: '87',
				args: ['--message', 'hello world'],
			})

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith(
				'node',
				[binPath, '--message', 'hello world'],
				{
					stdio: 'inherit',
					cwd: mockWorktree.path,
					env: process.env,
				}
			)
		})

		it('should preserve argument order', async () => {
			await command.execute({
				identifier: '87',
				args: ['cmd1', '--flag1', 'cmd2', '--flag2', 'value'],
			})

			const binPath = path.resolve(mockWorktree.path, './dist/cli.js')
			expect(execa).toHaveBeenCalledWith(
				'node',
				[binPath, 'cmd1', '--flag1', 'cmd2', '--flag2', 'value'],
				{
					stdio: 'inherit',
					cwd: mockWorktree.path,
					env: process.env,
				}
			)
		})
	})

	describe('dev server auto-start', () => {
		beforeEach(() => {
			// Mock parseForPatternDetection
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			// Mock worktree finding
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
				mockWorktree
			)

			// Mock capability detection for web
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			// Mock .env file with PORT
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')
		})

		it('should auto-start dev server when opening browser', async () => {
			// Mock server not running, then started
			vi.mocked(mockDevServerManager.ensureServerRunning).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			expect(mockDevServerManager.ensureServerRunning).toHaveBeenCalledWith(
				mockWorktree.path,
				3087
			)
		})

		it('should open browser even if server fails to start', async () => {
			// Mock server failed to start
			vi.mocked(mockDevServerManager.ensureServerRunning).mockResolvedValue(false)

			await command.execute({ identifier: '87' })

			// Should still try to open browser
			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3087')
		})

		it('should use calculated port for server start', async () => {
			// Mock no .env file - should calculate port
			vi.mocked(fs.pathExists).mockResolvedValue(false)

			// Mock listWorktrees for port calculation
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				mockWorktree,
			])

			vi.mocked(mockDevServerManager.ensureServerRunning).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			// Should calculate port as 3000 + 87 = 3087
			expect(mockDevServerManager.ensureServerRunning).toHaveBeenCalledWith(
				mockWorktree.path,
				3087
			)
		})

		it('should use PORT from .env if available', async () => {
			// Mock .env with custom port
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=4500\n')

			vi.mocked(mockDevServerManager.ensureServerRunning).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			// Should use PORT from .env
			expect(mockDevServerManager.ensureServerRunning).toHaveBeenCalledWith(
				mockWorktree.path,
				4500
			)
		})

		it('should not auto-start server for CLI-only projects', async () => {
			// Mock CLI-only capability
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(
				mockCapabilities
			)

			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			// Should not call ensureServerRunning for CLI-only projects
			expect(mockDevServerManager.ensureServerRunning).not.toHaveBeenCalled()
		})
	})
})
