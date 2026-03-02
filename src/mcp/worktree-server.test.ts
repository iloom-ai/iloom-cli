import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorktreeServerEnv } from './worktree-server.js'

// Mock all external dependencies
vi.mock('../utils/git.js', () => ({
	executeGitCommand: vi.fn(),
	generateWorktreePath: vi.fn(),
}))

vi.mock('../utils/claude-trust.js', () => ({
	preAcceptClaudeTrust: vi.fn(),
}))

vi.mock('../utils/package-manager.js', () => ({
	installDependencies: vi.fn(),
}))

vi.mock('../utils/mcp.js', () => ({
	generateAndWriteMcpConfigFile: vi.fn(),
}))

vi.mock('fs-extra', () => ({
	default: {
		pathExists: vi.fn(),
		ensureDir: vi.fn(),
		writeFile: vi.fn(),
		copy: vi.fn(),
	},
}))

vi.mock('../lib/MetadataManager.js', () => ({
	MetadataManager: vi.fn().mockImplementation(() => ({
		writeMetadata: vi.fn(),
		readMetadata: vi.fn(),
		updateMetadata: vi.fn(),
	})),
}))

vi.mock('../lib/SettingsManager.js', () => ({
	SettingsManager: vi.fn(),
}))

vi.mock('../lib/IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		getProviderName: vi.fn(),
	},
}))

import fs from 'fs-extra'
import { executeGitCommand, generateWorktreePath } from '../utils/git.js'
import { preAcceptClaudeTrust } from '../utils/claude-trust.js'
import { installDependencies } from '../utils/package-manager.js'
import { generateAndWriteMcpConfigFile } from '../utils/mcp.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { createWorktree } from './worktree-server.js'

/**
 * Tests for the worktree MCP server's create_worktree business logic.
 *
 * Uses mocked external dependencies to test createWorktree() without
 * creating real worktrees or touching the filesystem.
 */

function makeEnv(overrides: Partial<WorktreeServerEnv> = {}): WorktreeServerEnv {
	return {
		epicWorktreePath: '/Users/test/dev/project-looms/epic-42__feature',
		epicBranch: 'epic/42__feature',
		mainWorktreePath: '/Users/test/dev/project',
		epicIssueNumber: '42',
		issueTracker: 'github',
		...overrides,
	}
}

describe('worktree-server', () => {
	const defaultWorktreePath = '/Users/test/dev/project-looms/issue-123'
	const defaultBranchName = 'issue/123'
	const defaultMcpConfigPath = '/Users/test/.config/iloom-ai/mcp-configs/test.json'

	let mockMetadataManager: {
		writeMetadata: ReturnType<typeof vi.fn>
		readMetadata: ReturnType<typeof vi.fn>
		updateMetadata: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		// Set up default mocks
		vi.mocked(generateWorktreePath).mockReturnValue(defaultWorktreePath)
		vi.mocked(fs.pathExists).mockResolvedValue(false as never)
		vi.mocked(executeGitCommand).mockResolvedValue('')
		vi.mocked(preAcceptClaudeTrust).mockResolvedValue(undefined)
		vi.mocked(installDependencies).mockResolvedValue(undefined)
		vi.mocked(generateAndWriteMcpConfigFile).mockResolvedValue(defaultMcpConfigPath)
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined as never)
		vi.mocked(fs.copy).mockResolvedValue(undefined as never)

		// Set up IssueTrackerFactory mock
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github' as never)

		// Set up SettingsManager mock
		vi.mocked(SettingsManager).mockImplementation(() => ({
			loadSettings: vi.fn().mockResolvedValue({
				issueManagement: { provider: 'github' },
			}),
		}) as unknown as SettingsManager)

		// Set up MetadataManager mock
		mockMetadataManager = {
			writeMetadata: vi.fn().mockResolvedValue(undefined),
			readMetadata: vi.fn().mockResolvedValue({
				description: 'Child issue 123',
				branchName: defaultBranchName,
				worktreePath: defaultWorktreePath,
				issueType: 'issue',
				issue_numbers: ['123'],
				pr_numbers: [],
				issueTracker: 'github',
				colorHex: '#808080',
				state: 'pending',
			}),
			updateMetadata: vi.fn().mockResolvedValue(undefined),
		}
		vi.mocked(MetadataManager).mockImplementation(() => mockMetadataManager as unknown as MetadataManager)
	})

	describe('create_worktree tool', () => {
		it('creates worktree from current epic branch HEAD', async () => {
			const env = makeEnv()

			await createWorktree('123', env)

			expect(executeGitCommand).toHaveBeenCalledWith(
				['worktree', 'add', '-b', 'issue/123', defaultWorktreePath, 'epic/42__feature'],
				{ cwd: env.mainWorktreePath, timeout: 300000 },
			)
		})

		it('returns worktreePath and branchName on success', async () => {
			const result = await createWorktree('123', makeEnv())

			expect(result).toEqual({
				worktreePath: defaultWorktreePath,
				branchName: 'issue/123',
				alreadyExisted: false,
			})
		})

		it('pre-accepts Claude trust in the new worktree', async () => {
			await createWorktree('123', makeEnv())

			expect(preAcceptClaudeTrust).toHaveBeenCalledWith(defaultWorktreePath)
		})

		it('updates metadata with state pending and parentLoom', async () => {
			const env = makeEnv()

			await createWorktree('123', env)

			expect(mockMetadataManager.updateMetadata).toHaveBeenCalledWith(
				defaultWorktreePath,
				expect.objectContaining({
					branchName: 'issue/123',
					worktreePath: defaultWorktreePath,
					state: 'pending',
					parentLoom: {
						type: 'epic',
						identifier: '42',
						branchName: 'epic/42__feature',
						worktreePath: env.epicWorktreePath,
					},
				}),
			)
		})

		it('generates and writes MCP config file', async () => {
			await createWorktree('123', makeEnv())

			expect(generateAndWriteMcpConfigFile).toHaveBeenCalledWith(
				defaultWorktreePath,
				expect.objectContaining({ branchName: defaultBranchName }),
				'github',
				expect.any(Object),
			)
		})

		it('writes .claude/iloom-swarm-mcp-config-path', async () => {
			await createWorktree('123', makeEnv())

			expect(fs.ensureDir).toHaveBeenCalledWith(
				expect.stringContaining('.claude'),
			)
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('iloom-swarm-mcp-config-path'),
				defaultMcpConfigPath,
				'utf-8',
			)
		})

		it('installs dependencies in the new worktree', async () => {
			await createWorktree('123', makeEnv())

			expect(installDependencies).toHaveBeenCalledWith(defaultWorktreePath, true, true)
		})

		it('copies agent files from epic worktree to child worktree', async () => {
			// Mock pathExists to return true for source agents dir
			vi.mocked(fs.pathExists).mockImplementation(async (p: unknown) => {
				const pathStr = String(p)
				if (pathStr.includes('.claude/agents') && pathStr.includes('epic')) {
					return true as never
				}
				return false as never
			})

			const env = makeEnv()
			await createWorktree('123', env)

			const expectedSourceDir = `${env.epicWorktreePath}/.claude/agents`
			const expectedTargetDir = `${defaultWorktreePath}/.claude/agents`

			expect(fs.copy).toHaveBeenCalledWith(
				expectedSourceDir,
				expectedTargetDir,
				{ overwrite: true },
			)
		})

		it('is idempotent - returns existing worktree if already created', async () => {
			// Mock pathExists to return true for worktree path
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)

			const result = await createWorktree('123', makeEnv())

			expect(result).toEqual({
				worktreePath: defaultWorktreePath,
				branchName: 'issue/123',
				alreadyExisted: true,
			})
			// Should NOT call git worktree add
			expect(executeGitCommand).not.toHaveBeenCalled()
			// Should NOT update metadata
			expect(mockMetadataManager.updateMetadata).not.toHaveBeenCalled()
		})

		it('cleans up worktree on metadata update failure', async () => {
			mockMetadataManager.updateMetadata.mockRejectedValue(new Error('Metadata write failed'))

			await expect(createWorktree('123', makeEnv())).rejects.toThrow('Metadata write failed')

			// Should clean up the worktree
			expect(executeGitCommand).toHaveBeenCalledWith(
				['worktree', 'remove', '--force', defaultWorktreePath],
				{ cwd: makeEnv().mainWorktreePath, timeout: 30000 },
			)
		})

		it('returns error on git worktree creation failure', async () => {
			vi.mocked(executeGitCommand).mockRejectedValue(new Error('fatal: branch already exists'))

			await expect(createWorktree('123', makeEnv())).rejects.toThrow(
				'Failed to create git worktree: fatal: branch already exists',
			)
		})

		it('sanitizes issue number with hash prefix', async () => {
			vi.mocked(generateWorktreePath).mockReturnValue('/tmp/worktree')

			await createWorktree('#456', makeEnv())

			expect(executeGitCommand).toHaveBeenCalledWith(
				expect.arrayContaining(['-b', 'issue/456']),
				expect.any(Object),
			)
		})

		it('sanitizes Linear-style issue numbers for branch names', async () => {
			vi.mocked(generateWorktreePath).mockReturnValue('/tmp/worktree')

			await createWorktree('ENG-123', makeEnv())

			expect(executeGitCommand).toHaveBeenCalledWith(
				expect.arrayContaining(['-b', 'issue/ENG-123']),
				expect.any(Object),
			)
		})

		it('continues when Claude trust pre-acceptance fails', async () => {
			vi.mocked(preAcceptClaudeTrust).mockRejectedValue(new Error('Trust failed'))

			const result = await createWorktree('123', makeEnv())

			// Should still succeed
			expect(result.alreadyExisted).toBe(false)
			expect(result.worktreePath).toBe(defaultWorktreePath)
			// Metadata should still be updated
			expect(mockMetadataManager.updateMetadata).toHaveBeenCalled()
		})

		it('continues when dependency installation fails', async () => {
			vi.mocked(installDependencies).mockRejectedValue(new Error('npm install failed'))

			const result = await createWorktree('123', makeEnv())

			// Should still succeed
			expect(result.alreadyExisted).toBe(false)
			expect(result.worktreePath).toBe(defaultWorktreePath)
		})

		it('continues when MCP config generation fails', async () => {
			mockMetadataManager.readMetadata.mockRejectedValue(new Error('Read failed'))

			const result = await createWorktree('123', makeEnv())

			// Should still succeed
			expect(result.alreadyExisted).toBe(false)
			expect(result.worktreePath).toBe(defaultWorktreePath)
		})

		it('continues when agent file copying fails', async () => {
			// Mock pathExists to return true for source agents dir
			vi.mocked(fs.pathExists).mockImplementation(async (p: unknown) => {
				const pathStr = String(p)
				if (pathStr.includes('.claude/agents') && pathStr.includes('epic')) {
					return true as never
				}
				return false as never
			})
			vi.mocked(fs.copy).mockRejectedValue(new Error('Permission denied') as never)

			const result = await createWorktree('123', makeEnv())

			// Should still succeed
			expect(result.alreadyExisted).toBe(false)
			expect(result.worktreePath).toBe(defaultWorktreePath)
		})

		it('does not clean up worktree when git worktree add fails (nothing to clean)', async () => {
			vi.mocked(executeGitCommand).mockRejectedValue(new Error('fatal: already exists'))

			await expect(createWorktree('123', makeEnv())).rejects.toThrow()

			// executeGitCommand was only called once (the failed 'worktree add')
			// There should be no cleanup call because the worktree was never created
			expect(executeGitCommand).toHaveBeenCalledTimes(1)
		})

		it('uses generateWorktreePath with correct arguments', async () => {
			const env = makeEnv()

			await createWorktree('789', env)

			expect(generateWorktreePath).toHaveBeenCalledWith(
				'issue/789',
				env.mainWorktreePath,
			)
		})

		it('updates metadata with mcpConfigPath after MCP config generation', async () => {
			await createWorktree('123', makeEnv())

			expect(mockMetadataManager.updateMetadata).toHaveBeenCalledWith(
				defaultWorktreePath,
				{ mcpConfigPath: defaultMcpConfigPath },
			)
		})
	})
})
