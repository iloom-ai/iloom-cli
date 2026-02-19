import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShellCommand } from './shell.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import type { GitWorktree } from '../types/worktree.js'
import fs from 'fs-extra'
import { execa } from 'execa'

// Mock dependencies
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/MetadataManager.js')
vi.mock('../utils/IdentifierParser.js')
vi.mock('../lib/SettingsManager.js')
vi.mock('fs-extra')
vi.mock('execa')

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

// Mock env utilities
vi.mock('../utils/env.js', () => ({
	loadWorkspaceEnv: vi.fn(),
	getDotenvFlowFiles: vi.fn(),
}))

// Import env module after mock to get mocked versions
import { loadWorkspaceEnv, getDotenvFlowFiles } from '../utils/env.js'

describe('ShellCommand', () => {
	let command: ShellCommand
	let mockGitWorktreeManager: GitWorktreeManager
	let mockMetadataManager: MetadataManager
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
		mockIdentifierParser = new IdentifierParser(mockGitWorktreeManager)
		mockSettingsManager = new SettingsManager()

		// Default settings mock
		vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
			sourceEnvOnStart: true,
		})

		// Default metadata mock - return colorHex
		vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
			description: 'test',
			created_at: null,
			branchName: null,
			worktreePath: null,
			issueType: null,
			issueKey: null,
			issue_numbers: [],
			pr_numbers: [],
			issueTracker: null,
			colorHex: '#dcebff',
			sessionId: null,
			projectPath: null,
			issueUrls: {},
			prUrls: {},
			draftPrNumber: null,
			capabilities: [],
			parentLoom: null,
		})

		// Set up env mocks
		vi.mocked(loadWorkspaceEnv).mockReturnValue({ parsed: { PORT: '3087', NODE_ENV: 'development' } })
		vi.mocked(getDotenvFlowFiles).mockReturnValue(['.env', '.env.local', '.env.development', '.env.development.local'])

		command = new ShellCommand(
			mockGitWorktreeManager,
			mockIdentifierParser,
			mockSettingsManager,
			mockMetadataManager
		)
	})

	describe('workspace detection', () => {
		it('should auto-detect from PR worktree pattern (_pr_N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/project_pr_45')

			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(45, '')
			expect(execa).toHaveBeenCalled()

			process.cwd = originalCwd
		})

		it('should auto-detect from issue directory pattern (issue-N)', async () => {
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/test/worktrees/feat-issue-87-test')

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({})

			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith('87')
			expect(execa).toHaveBeenCalled()

			process.cwd = originalCwd
		})

		it('should parse explicit issue number', async () => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: '87' })

			expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith('87')
			expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(87)
			expect(execa).toHaveBeenCalled()
		})

		it('should parse explicit branch name', async () => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'branch',
				branchName: 'feature/my-branch',
				originalInput: 'feature/my-branch',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockWorktree)
			vi.mocked(fs.pathExists).mockResolvedValue(true)

			await command.execute({ identifier: 'feature/my-branch' })

			expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith('feature/my-branch')
			expect(execa).toHaveBeenCalled()
		})

		it('should throw error when no worktree found', async () => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 99,
				originalInput: '99',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)

			await expect(command.execute({ identifier: '99' })).rejects.toThrow(
				"No worktree found for issue #99. Run 'il start 99' to create one."
			)
		})
	})

	describe('execute', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(fs.pathExists).mockResolvedValue(true)
		})

		it('should launch shell with env vars when sourceEnvOnStart=true', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				sourceEnvOnStart: true,
			})

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				expect.any(String),
				[],
				expect.objectContaining({
					cwd: mockWorktree.path,
					stdio: 'inherit',
					env: expect.objectContaining({
						PORT: '3087',
						NODE_ENV: 'development',
						ILOOM_LOOM: 'issue-87',
					}),
				})
			)
		})

		it('should launch shell without env vars when sourceEnvOnStart=false', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				sourceEnvOnStart: false,
			})

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				expect.any(String),
				[],
				expect.objectContaining({
					cwd: mockWorktree.path,
					stdio: 'inherit',
					env: expect.objectContaining({
						ILOOM_LOOM: 'issue-87',
					}),
				})
			)

			// loadWorkspaceEnv should NOT have been called when sourceEnvOnStart is false
			expect(loadWorkspaceEnv).not.toHaveBeenCalled()
		})

		it('should set ILOOM_LOOM env var to loom identifier', async () => {
			await command.execute({ identifier: '87' })

			const execaCall = vi.mocked(execa).mock.calls[0]
			const envArg = execaCall[2]?.env as Record<string, string>
			expect(envArg.ILOOM_LOOM).toBe('issue-87')
		})

		it('should set ILOOM_LOOM for PR identifier', async () => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'pr',
				number: 42,
				originalInput: '#42',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

			await command.execute({ identifier: '#42' })

			const execaCall = vi.mocked(execa).mock.calls[0]
			const envArg = execaCall[2]?.env as Record<string, string>
			expect(envArg.ILOOM_LOOM).toBe('pr-42')
		})

		it('should set ILOOM_COLOR_HEX when metadata has colorHex', async () => {
			await command.execute({ identifier: '87' })

			const execaCall = vi.mocked(execa).mock.calls[0]
			const envArg = execaCall[2]?.env as Record<string, string>
			expect(envArg.ILOOM_COLOR_HEX).toBe('#dcebff')
		})

		it('should not set ILOOM_COLOR_HEX when metadata is null', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue(null)

			await command.execute({ identifier: '87' })

			const execaCall = vi.mocked(execa).mock.calls[0]
			const envArg = execaCall[2]?.env as Record<string, string>
			expect(envArg.ILOOM_COLOR_HEX).toBeUndefined()
		})

		it('should not set ILOOM_COLOR_HEX when metadata.colorHex is null', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				description: 'test',
				created_at: null,
				branchName: null,
				worktreePath: null,
				issueType: null,
				issueKey: null,
				issue_numbers: [],
				pr_numbers: [],
				issueTracker: null,
				colorHex: null,
				sessionId: null,
				projectPath: null,
				issueUrls: {},
				prUrls: {},
				draftPrNumber: null,
				capabilities: [],
				parentLoom: null,
			})

			await command.execute({ identifier: '87' })

			const execaCall = vi.mocked(execa).mock.calls[0]
			const envArg = execaCall[2]?.env as Record<string, string>
			expect(envArg.ILOOM_COLOR_HEX).toBeUndefined()
		})
	})

	describe('shell detection', () => {
		beforeEach(() => {
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 87,
				originalInput: '87',
			})

			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(fs.pathExists).mockResolvedValue(true)
		})

		it('should use ILOOM_SHELL when set', async () => {
			const originalEnv = { ...process.env }
			process.env.ILOOM_SHELL = '/usr/local/bin/fish'

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				'/usr/local/bin/fish',
				[],
				expect.any(Object)
			)

			process.env = originalEnv
		})

		it('should fall back to SHELL on Unix', async () => {
			const originalEnv = { ...process.env }
			const originalPlatform = process.platform

			delete process.env.ILOOM_SHELL
			process.env.SHELL = '/bin/zsh'
			Object.defineProperty(process, 'platform', { value: 'darwin' })

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				'/bin/zsh',
				[],
				expect.any(Object)
			)

			process.env = originalEnv
			Object.defineProperty(process, 'platform', { value: originalPlatform })
		})

		it('should fall back to COMSPEC on Windows', async () => {
			const originalEnv = { ...process.env }
			const originalPlatform = process.platform

			delete process.env.ILOOM_SHELL
			delete process.env.SHELL
			process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
			Object.defineProperty(process, 'platform', { value: 'win32' })

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				'C:\\Windows\\System32\\cmd.exe',
				[],
				expect.any(Object)
			)

			process.env = originalEnv
			Object.defineProperty(process, 'platform', { value: originalPlatform })
		})

		it('should use default /bin/bash when no env vars set on Unix', async () => {
			const originalEnv = { ...process.env }
			const originalPlatform = process.platform

			delete process.env.ILOOM_SHELL
			delete process.env.SHELL
			Object.defineProperty(process, 'platform', { value: 'linux' })

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				'/bin/bash',
				[],
				expect.any(Object)
			)

			process.env = originalEnv
			Object.defineProperty(process, 'platform', { value: originalPlatform })
		})

		it('should use default cmd.exe when no env vars set on Windows', async () => {
			const originalEnv = { ...process.env }
			const originalPlatform = process.platform

			delete process.env.ILOOM_SHELL
			delete process.env.COMSPEC
			Object.defineProperty(process, 'platform', { value: 'win32' })

			await command.execute({ identifier: '87' })

			expect(execa).toHaveBeenCalledWith(
				'cmd.exe',
				[],
				expect.any(Object)
			)

			process.env = originalEnv
			Object.defineProperty(process, 'platform', { value: originalPlatform })
		})
	})
})
