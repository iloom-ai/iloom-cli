import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevServerCommand } from './dev-server.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { ProjectCapabilityDetector } from '../lib/ProjectCapabilityDetector.js'
import { DevServerManager } from '../lib/DevServerManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { loadWorkspaceEnv, isNoEnvFilesFoundError } from '../utils/env.js'
import type { GitWorktree } from '../types/worktree.js'
import type { ProjectCapabilities } from '../types/loom.js'
import fs from 'fs-extra'

// Mock dependencies
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/MetadataManager.js')
vi.mock('../lib/ProjectCapabilityDetector.js')
vi.mock('../lib/DevServerManager.js')
vi.mock('../utils/IdentifierParser.js')
vi.mock('fs-extra')
vi.mock('../lib/SettingsManager.js')
vi.mock('../utils/env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/env.js')>()
	return {
		...actual,
		loadWorkspaceEnv: vi.fn(() => ({ parsed: {} })),
		isNoEnvFilesFoundError: vi.fn(() => false),
	}
})

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

describe('DevServerCommand', () => {
	let command: DevServerCommand
	let mockGitWorktreeManager: GitWorktreeManager
	let mockMetadataManager: MetadataManager
	let mockCapabilityDetector: ProjectCapabilityDetector
	let mockDevServerManager: DevServerManager
	let mockIdentifierParser: IdentifierParser
	let mockSettingsManager: SettingsManager

	const mockWorktree: GitWorktree = {
		path: '/test/worktrees/issue-87',
		branch: 'feat/issue-87__test',
		commit: 'abc123',
		prunable: 'no',
	}

	beforeEach(() => {
		mockGitWorktreeManager = new GitWorktreeManager()
		mockMetadataManager = new MetadataManager()
		mockCapabilityDetector = new ProjectCapabilityDetector()
		mockDevServerManager = new DevServerManager()
		mockIdentifierParser = new IdentifierParser(mockGitWorktreeManager)
		mockSettingsManager = new SettingsManager()

		// Mock MetadataManager - default to returning metadata with color
		vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
			colorHex: '#dcebff',
		})

		// Mock DevServerManager methods
		vi.mocked(mockDevServerManager.isServerRunning).mockResolvedValue(false)
		vi.mocked(mockDevServerManager.runServerForeground).mockImplementation(
			async (_path, _port, _redirect, onProcessStarted) => {
				// Call the callback with the mock PID if provided
				if (onProcessStarted) {
					onProcessStarted(12345)
				}
				return { pid: 12345 }
			}
		)

		// Mock SettingsManager - default to sourceEnvOnStart: false
		vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({})

		// Reset env loading mocks
		vi.mocked(loadWorkspaceEnv).mockReturnValue({ parsed: {} })
		vi.mocked(isNoEnvFilesFoundError).mockReturnValue(false)

		command = new DevServerCommand(
			mockGitWorktreeManager,
			mockCapabilityDetector,
			mockIdentifierParser,
			mockDevServerManager,
			mockSettingsManager,
			mockMetadataManager
		)
	})

	describe('workspace detection', () => {
		it('should auto-detect from PR worktree pattern (_pr_N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/project_pr_45')

			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3045\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(45, '')

			process.cwd = originalCwd
		})

		it('should auto-detect from issue directory pattern (issue-N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith('87')

			process.cwd = originalCwd
		})

		it('should auto-detect from git branch name', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/some-feature')

			vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
				currentBranch: 'feat/issue-87__description',
				mainBranch: 'main',
				worktrees: [],
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith('87')

			process.cwd = originalCwd
		})

		it('should throw error when no identifier and auto-detection fails', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/some-feature')

			vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
				currentBranch: null,
				mainBranch: 'main',
				worktrees: [],
			})

			await expect(command.execute({})).rejects.toThrow(
				'Could not auto-detect identifier'
			)

			process.cwd = originalCwd
		})
	})

	describe('capability detection', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
		})

		it('should start server for web project', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			const result = await command.execute({ identifier: '87' })

			expect(result.status).toBe('started')
			expect(result.url).toBe('http://localhost:3087')
			expect(result.port).toBe(3087)
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.any(Object)
			)
		})

		it('should return gracefully for non-web project with info message', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['cli'],
				binEntries: { il: './dist/cli.js' },
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			const result = await command.execute({ identifier: '87' })

			expect(result.status).toBe('no_web_capability')
			expect(result.message).toContain('No web capability detected')
			expect(mockDevServerManager.runServerForeground).not.toHaveBeenCalled()
		})

		it('should return gracefully for project with no capabilities', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: [],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			const result = await command.execute({ identifier: '87' })

			expect(result.status).toBe('no_web_capability')
			expect(result.message).toContain('No web capability detected')
			expect(mockDevServerManager.runServerForeground).not.toHaveBeenCalled()
		})
	})

	describe('server state detection', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)
		})

		it('should start server when not running', async () => {
			vi.mocked(mockDevServerManager.isServerRunning).mockResolvedValue(false)
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			const result = await command.execute({ identifier: '87' })

			expect(result.status).toBe('started')
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalled()
		})

		it('should silently succeed when server already running', async () => {
			vi.mocked(mockDevServerManager.isServerRunning).mockResolvedValue(true)
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			const result = await command.execute({ identifier: '87' })

			expect(result.status).toBe('already_running')
			expect(result.url).toBe('http://localhost:3087')
			expect(mockDevServerManager.runServerForeground).not.toHaveBeenCalled()
		})

		it('should use PORT from .env if available', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=4500\n')

			await command.execute({ identifier: '87' })

			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				4500,
				false,
				expect.any(Function),
				expect.any(Object)
			)
		})

		it('should calculate PORT when not in .env', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false)
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				{
					path: '/test/worktrees/issue-87',
					branch: 'feat/issue-87__test',
					isMain: false,
				},
			])

			await command.execute({ identifier: '87' })

			// Should calculate port as 3000 + 87 = 3087
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.any(Object)
			)
		})
	})

	describe('JSON output', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
		})

		it('should output JSON with url and status when --json flag', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

			await command.execute({ identifier: '87', json: true })

			expect(stdoutSpy).toHaveBeenCalled()
			const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string)
			expect(output.status).toBe('started')
			expect(output.url).toBe('http://localhost:3087')
			expect(output.port).toBe(3087)
			expect(output.pid).toBe(12345)

			stdoutSpy.mockRestore()
		})

		it('should output JSON for non-web projects when --json flag', async () => {
			const mockCapabilities: ProjectCapabilities = {
				capabilities: [],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

			await command.execute({ identifier: '87', json: true })

			expect(stdoutSpy).toHaveBeenCalled()
			const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string)
			expect(output.status).toBe('no_web_capability')
			expect(output.message).toContain('No web capability detected')

			stdoutSpy.mockRestore()
		})
	})

	describe('foreground execution', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)
		})

		it('should run server with foreground execution (blocking)', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({ identifier: '87' })

			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.any(Object)
			)
		})

		it('should redirect output to stderr when using JSON mode', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')

			await command.execute({ identifier: '87', json: true })

			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				true,
				expect.any(Function),
				expect.any(Object)
			)
		})
	})

	describe('environment variable loading', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')
		})

		it('should load env vars when sourceEnvOnStart is true', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				sourceEnvOnStart: true,
			})
			vi.mocked(loadWorkspaceEnv).mockReturnValue({
				parsed: { DATABASE_URL: 'postgres://test', API_KEY: 'secret' },
			})

			await command.execute({ identifier: '87' })

			expect(loadWorkspaceEnv).toHaveBeenCalledWith(mockWorktree.path)
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.objectContaining({ DATABASE_URL: 'postgres://test', API_KEY: 'secret', ILOOM_LOOM: '87' })
			)
		})

		it('should NOT load env vars when sourceEnvOnStart is false (default)', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				sourceEnvOnStart: false,
			})

			await command.execute({ identifier: '87' })

			expect(loadWorkspaceEnv).not.toHaveBeenCalled()
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.objectContaining({ ILOOM_LOOM: '87' })
			)
		})

		it('should NOT load env vars when sourceEnvOnStart is undefined', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({})

			await command.execute({ identifier: '87' })

			expect(loadWorkspaceEnv).not.toHaveBeenCalled()
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.objectContaining({ ILOOM_LOOM: '87' })
			)
		})

		it('should handle loadWorkspaceEnv returning error gracefully', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				sourceEnvOnStart: true,
			})
			const error = new Error('Failed to read .env')
			vi.mocked(loadWorkspaceEnv).mockReturnValue({
				error,
			})
			vi.mocked(isNoEnvFilesFoundError).mockReturnValue(false)

			// Should not throw - server should still start
			const result = await command.execute({ identifier: '87' })

			expect(result.status).toBe('started')
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalledWith(
				mockWorktree.path,
				3087,
				false,
				expect.any(Function),
				expect.objectContaining({ ILOOM_LOOM: '87' })
			)
		})

		it('should not warn when loadWorkspaceEnv returns "no env files found" error', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				sourceEnvOnStart: true,
			})
			const error = new Error('no ".env*" files matching pattern')
			vi.mocked(loadWorkspaceEnv).mockReturnValue({
				error,
			})
			vi.mocked(isNoEnvFilesFoundError).mockReturnValue(true)

			await command.execute({ identifier: '87' })

			// Should proceed without warning since "no env files" is harmless
			expect(mockDevServerManager.runServerForeground).toHaveBeenCalled()
		})
	})

	describe('loom environment variables', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			const mockCapabilities: ProjectCapabilities = {
				capabilities: ['web'],
				binEntries: {},
			}
			vi.mocked(mockCapabilityDetector.detectCapabilities).mockResolvedValue(mockCapabilities)

			vi.mocked(fs.pathExists).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('PORT=3087\n')
		})

		it('should set ILOOM_LOOM env var to original input', async () => {
			await command.execute({ identifier: '87' })

			const envArg = vi.mocked(mockDevServerManager.runServerForeground).mock.calls[0]?.[4]
			expect(envArg).toHaveProperty('ILOOM_LOOM', '87')
		})

		it('should set ILOOM_LOOM for PR identifier', async () => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'pr',
				number: 42,
				originalInput: '42',
			})
			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

			await command.execute({ identifier: '42' })

			const envArg = vi.mocked(mockDevServerManager.runServerForeground).mock.calls[0]?.[4]
			expect(envArg).toHaveProperty('ILOOM_LOOM', '42')
		})

		it('should set ILOOM_COLOR_HEX from metadata', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				colorHex: '#dcebff',
			})

			await command.execute({ identifier: '87' })

			const envArg = vi.mocked(mockDevServerManager.runServerForeground).mock.calls[0]?.[4]
			expect(envArg).toHaveProperty('ILOOM_COLOR_HEX', '#dcebff')
		})

		it('should not set ILOOM_COLOR_HEX when metadata has no colorHex', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				colorHex: null,
			})

			await command.execute({ identifier: '87' })

			const envArg = vi.mocked(mockDevServerManager.runServerForeground).mock.calls[0]?.[4]
			expect(envArg).not.toHaveProperty('ILOOM_COLOR_HEX')
		})

		it('should not set ILOOM_COLOR_HEX when metadata is null', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue(null)

			await command.execute({ identifier: '87' })

			const envArg = vi.mocked(mockDevServerManager.runServerForeground).mock.calls[0]?.[4]
			expect(envArg).not.toHaveProperty('ILOOM_COLOR_HEX')
		})
	})
})
