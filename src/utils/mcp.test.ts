import { describe, it, expect, vi } from 'vitest'
import { generateRecapMcpConfig, generateHarnessMcpConfig, generateWorktreeMcpConfig } from './mcp.js'
import os from 'os'
import path from 'path'
import type { LoomMetadata } from '../lib/MetadataManager.js'

// Mock the github module
vi.mock('./github.js', () => ({
	getRepoInfo: vi.fn().mockResolvedValue({ owner: 'test-owner', name: 'test-repo' }),
}))

// Mock the logger
vi.mock('./logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

// Helper to create mock LoomMetadata
function createMockMetadata(overrides: Partial<LoomMetadata> = {}): LoomMetadata {
	return {
		description: 'Test issue #123',
		created_at: '2025-01-01T00:00:00Z',
		branchName: 'feat/issue-123',
		worktreePath: '/Users/test/projects/my-repo',
		issueType: 'issue',
		issue_numbers: ['123'],
		databaseBranchName: null,
		parentLoomBranch: null,
		...overrides,
	}
}

describe('generateRecapMcpConfig', () => {
	it('should generate MCP config with correct structure', () => {
		const loomPath = '/Users/test/projects/my-repo'
		const loomMetadata = createMockMetadata()

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		expect(config).toHaveLength(1)
		expect(config[0]).toHaveProperty('mcpServers')
		expect(config[0].mcpServers).toHaveProperty('recap')
	})

	it('should include RECAP_FILE_PATH env var with slugified path', () => {
		const loomPath = '/Users/test/projects/my-repo'
		const loomMetadata = createMockMetadata()

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		const recapConfig = (config[0].mcpServers as Record<string, unknown>).recap as Record<string, unknown>
		const env = recapConfig.env as Record<string, string>

		expect(env.RECAP_FILE_PATH).toBeDefined()
		expect(env.RECAP_FILE_PATH).toContain(path.join(os.homedir(), '.config', 'iloom-ai', 'recaps'))
		expect(env.RECAP_FILE_PATH).toContain('___Users___test___projects___my-repo.json')
	})

	it('should include LOOM_METADATA_JSON env var with stringified metadata', () => {
		const loomPath = '/Users/test/projects/my-repo'
		const loomMetadata = createMockMetadata({ description: 'Test issue for JSON' })

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		const recapConfig = (config[0].mcpServers as Record<string, unknown>).recap as Record<string, unknown>
		const env = recapConfig.env as Record<string, string>

		expect(env.LOOM_METADATA_JSON).toBeDefined()
		const parsed = JSON.parse(env.LOOM_METADATA_JSON)
		expect(parsed.description).toBe('Test issue for JSON')
		expect(parsed.branchName).toBe('feat/issue-123')
		expect(parsed.issue_numbers).toEqual(['123'])
	})

	it('should use node as command and point to recap-server.js', () => {
		const loomPath = '/Users/test/projects/my-repo'
		const loomMetadata = createMockMetadata()

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		const recapConfig = (config[0].mcpServers as Record<string, unknown>).recap as Record<string, unknown>

		expect(recapConfig.transport).toBe('stdio')
		expect(recapConfig.command).toBe('node')
		expect(recapConfig.args).toBeInstanceOf(Array)
		expect((recapConfig.args as string[])[0]).toContain('recap-server.js')
	})

	it('should slugify path correctly - replacing separators with triple underscores', () => {
		const loomPath = '/a/b/c'
		const loomMetadata = createMockMetadata()

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		const recapConfig = (config[0].mcpServers as Record<string, unknown>).recap as Record<string, unknown>
		const env = recapConfig.env as Record<string, string>

		expect(env.RECAP_FILE_PATH).toContain('___a___b___c.json')
	})

	it('should handle paths with special characters', () => {
		const loomPath = '/path/with spaces/and.dots'
		const loomMetadata = createMockMetadata()

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		const recapConfig = (config[0].mcpServers as Record<string, unknown>).recap as Record<string, unknown>
		const env = recapConfig.env as Record<string, string>

		// Special chars become hyphens, path separators become ___
		expect(env.RECAP_FILE_PATH).toContain('___path___with-spaces___and-dots.json')
	})

	it('should strip trailing slashes from path', () => {
		const loomPath = '/path/to/dir/'
		const loomMetadata = createMockMetadata()

		const config = generateRecapMcpConfig(loomPath, loomMetadata)

		const recapConfig = (config[0].mcpServers as Record<string, unknown>).recap as Record<string, unknown>
		const env = recapConfig.env as Record<string, string>

		// Should not have trailing separator
		expect(env.RECAP_FILE_PATH).toContain('___path___to___dir.json')
		expect(env.RECAP_FILE_PATH).not.toContain('___path___to___dir___.json')
	})
})

describe('generateHarnessMcpConfig', () => {
	it('should generate MCP config with correct structure', () => {
		const socketPath = '/tmp/iloom-harness.sock'

		const config = generateHarnessMcpConfig(socketPath)

		expect(config).toHaveLength(1)
		expect(config[0]).toHaveProperty('mcpServers')
		expect(config[0].mcpServers).toHaveProperty('harness')
	})

	it('should set ILOOM_HARNESS_SOCKET env var to the socket path', () => {
		const socketPath = '/tmp/iloom-harness.sock'

		const config = generateHarnessMcpConfig(socketPath)

		const harnessConfig = (config[0].mcpServers as Record<string, unknown>).harness as Record<string, unknown>
		const env = harnessConfig.env as Record<string, string>

		expect(env.ILOOM_HARNESS_SOCKET).toBe(socketPath)
	})

	it('should use node as command and point to harness-server.js', () => {
		const socketPath = '/tmp/iloom-harness.sock'

		const config = generateHarnessMcpConfig(socketPath)

		const harnessConfig = (config[0].mcpServers as Record<string, unknown>).harness as Record<string, unknown>

		expect(harnessConfig.transport).toBe('stdio')
		expect(harnessConfig.command).toBe('node')
		expect(harnessConfig.args).toBeInstanceOf(Array)
		expect((harnessConfig.args as string[])[0]).toContain('harness-server.js')
	})

	it('should use different socket paths when called with different paths', () => {
		const config1 = generateHarnessMcpConfig('/tmp/socket-a.sock')
		const config2 = generateHarnessMcpConfig('/tmp/socket-b.sock')

		const env1 = ((config1[0].mcpServers as Record<string, unknown>).harness as Record<string, unknown>).env as Record<string, string>
		const env2 = ((config2[0].mcpServers as Record<string, unknown>).harness as Record<string, unknown>).env as Record<string, string>

		expect(env1.ILOOM_HARNESS_SOCKET).toBe('/tmp/socket-a.sock')
		expect(env2.ILOOM_HARNESS_SOCKET).toBe('/tmp/socket-b.sock')
	})

	it('should use absolute path for harness server JS file', () => {
		const socketPath = '/tmp/iloom-harness.sock'

		const config = generateHarnessMcpConfig(socketPath)

		const harnessConfig = (config[0].mcpServers as Record<string, unknown>).harness as Record<string, unknown>
		const serverPath = (harnessConfig.args as string[])[0]

		expect(path.isAbsolute(serverPath)).toBe(true)
	})
})

describe('generateWorktreeMcpConfig', () => {
	const defaultArgs = {
		epicWorktreePath: '/Users/test/projects/epic-worktree',
		epicBranch: 'epic/issue-100',
		mainWorktreePath: '/Users/test/projects/main',
		epicIssueNumber: '100',
		issueTracker: 'github',
	}

	it('should generate MCP config with correct structure', () => {
		const config = generateWorktreeMcpConfig(
			defaultArgs.epicWorktreePath,
			defaultArgs.epicBranch,
			defaultArgs.mainWorktreePath,
			defaultArgs.epicIssueNumber,
			defaultArgs.issueTracker,
		)

		expect(config).toHaveLength(1)
		expect(config[0]).toHaveProperty('mcpServers')
		expect(config[0].mcpServers).toHaveProperty('worktree')
	})

	it('should set all required env vars', () => {
		const config = generateWorktreeMcpConfig(
			defaultArgs.epicWorktreePath,
			defaultArgs.epicBranch,
			defaultArgs.mainWorktreePath,
			defaultArgs.epicIssueNumber,
			defaultArgs.issueTracker,
		)

		const worktreeConfig = (config[0].mcpServers as Record<string, unknown>).worktree as Record<string, unknown>
		const env = worktreeConfig.env as Record<string, string>

		expect(env.EPIC_WORKTREE_PATH).toBe(defaultArgs.epicWorktreePath)
		expect(env.EPIC_BRANCH).toBe(defaultArgs.epicBranch)
		expect(env.MAIN_WORKTREE_PATH).toBe(defaultArgs.mainWorktreePath)
		expect(env.EPIC_ISSUE_NUMBER).toBe(defaultArgs.epicIssueNumber)
		expect(env.ISSUE_TRACKER).toBe(defaultArgs.issueTracker)
	})

	it('should use node as command and point to worktree-server.js', () => {
		const config = generateWorktreeMcpConfig(
			defaultArgs.epicWorktreePath,
			defaultArgs.epicBranch,
			defaultArgs.mainWorktreePath,
			defaultArgs.epicIssueNumber,
			defaultArgs.issueTracker,
		)

		const worktreeConfig = (config[0].mcpServers as Record<string, unknown>).worktree as Record<string, unknown>

		expect(worktreeConfig.transport).toBe('stdio')
		expect(worktreeConfig.command).toBe('node')
		expect(worktreeConfig.args).toBeInstanceOf(Array)
		expect((worktreeConfig.args as string[])[0]).toContain('worktree-server.js')
	})

	it('should use absolute path for worktree server JS file', () => {
		const config = generateWorktreeMcpConfig(
			defaultArgs.epicWorktreePath,
			defaultArgs.epicBranch,
			defaultArgs.mainWorktreePath,
			defaultArgs.epicIssueNumber,
			defaultArgs.issueTracker,
		)

		const worktreeConfig = (config[0].mcpServers as Record<string, unknown>).worktree as Record<string, unknown>
		const serverPath = (worktreeConfig.args as string[])[0]

		expect(path.isAbsolute(serverPath)).toBe(true)
	})

	it('should work with different issue tracker providers', () => {
		const linearConfig = generateWorktreeMcpConfig(
			defaultArgs.epicWorktreePath,
			defaultArgs.epicBranch,
			defaultArgs.mainWorktreePath,
			defaultArgs.epicIssueNumber,
			'linear',
		)

		const worktreeConfig = (linearConfig[0].mcpServers as Record<string, unknown>).worktree as Record<string, unknown>
		const env = worktreeConfig.env as Record<string, string>

		expect(env.ISSUE_TRACKER).toBe('linear')
	})

	it('should pass different env values when called with different args', () => {
		const config1 = generateWorktreeMcpConfig(
			'/path/a',
			'branch-a',
			'/main/a',
			'101',
			'github',
		)
		const config2 = generateWorktreeMcpConfig(
			'/path/b',
			'branch-b',
			'/main/b',
			'202',
			'linear',
		)

		const env1 = ((config1[0].mcpServers as Record<string, unknown>).worktree as Record<string, unknown>).env as Record<string, string>
		const env2 = ((config2[0].mcpServers as Record<string, unknown>).worktree as Record<string, unknown>).env as Record<string, string>

		expect(env1.EPIC_WORKTREE_PATH).toBe('/path/a')
		expect(env2.EPIC_WORKTREE_PATH).toBe('/path/b')
		expect(env1.EPIC_ISSUE_NUMBER).toBe('101')
		expect(env2.EPIC_ISSUE_NUMBER).toBe('202')
	})
})
