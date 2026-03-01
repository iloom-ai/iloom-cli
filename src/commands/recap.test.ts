import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecapCommand, type RecapCommandInput } from './recap.js'
import type { RecapOutput } from '../mcp/recap-types.js'

// Mock fs-extra
vi.mock('fs-extra', () => ({
	default: {
		pathExists: vi.fn(),
		readFile: vi.fn(),
	},
}))

// Mock GitWorktreeManager
vi.mock('../lib/GitWorktreeManager.js', () => ({
	GitWorktreeManager: vi.fn().mockImplementation(() => ({
		findWorktreeForIssue: vi.fn(),
		findWorktreeForPR: vi.fn(),
		findWorktreeForBranch: vi.fn(),
	})),
}))

// Mock IdentifierParser
vi.mock('../utils/IdentifierParser.js', () => ({
	IdentifierParser: vi.fn().mockImplementation(() => ({
		parseForPatternDetection: vi.fn(),
	})),
}))

// Mock recap-archiver
vi.mock('../utils/recap-archiver.js', () => ({
	findArchivedRecap: vi.fn().mockResolvedValue(null),
}))

import fs from 'fs-extra'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { findArchivedRecap } from '../utils/recap-archiver.js'

describe('RecapCommand', () => {
	let command: RecapCommand

	beforeEach(() => {
		command = new RecapCommand()
	})

	describe('execute with JSON mode', () => {
		it('should return RecapOutput with filePath, goal, entries, and artifacts when recap file exists', async () => {
			const mockRecap = {
				goal: 'Implement feature X',
				entries: [
					{ id: 'uuid-1', timestamp: '2025-01-01T00:00:00Z', type: 'decision', content: 'Use TypeScript' },
					{ id: 'uuid-2', timestamp: '2025-01-01T00:01:00Z', type: 'insight', content: 'Found helper function' },
				],
				artifacts: [
					{
						id: 'artifact-1',
						type: 'comment',
						primaryUrl: 'https://github.com/org/repo/issues/123#issuecomment-456',
						urls: {},
						description: 'Progress update',
						timestamp: '2025-01-01T00:02:00Z',
					},
				],
			}

			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockRecap) as never)

			const input: RecapCommandInput = { json: true }
			const result = (await command.execute(input)) as RecapOutput

			expect(result).toBeDefined()
			expect(result.goal).toBe('Implement feature X')
			expect(result.entries).toHaveLength(2)
			expect(result.entries[0].type).toBe('decision')
			expect(result.entries[1].type).toBe('insight')
			expect(result.artifacts).toHaveLength(1)
			expect(result.artifacts[0].type).toBe('comment')
			expect(result.artifacts[0].primaryUrl).toBe('https://github.com/org/repo/issues/123#issuecomment-456')
			expect(result.filePath).toContain('.config/iloom-ai/recaps/')
			expect(result.filePath).toMatch(/\.json$/)
		})

		it('should return empty recap when file does not exist', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const input: RecapCommandInput = { json: true }
			const result = (await command.execute(input)) as RecapOutput

			expect(result).toBeDefined()
			expect(result.goal).toBeNull()
			expect(result.entries).toHaveLength(0)
			expect(result.artifacts).toHaveLength(0)
			expect(result.filePath).toContain('.config/iloom-ai/recaps/')
		})

		it('should return empty recap when file has invalid JSON', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue('invalid json {{{' as never)

			const input: RecapCommandInput = { json: true }
			const result = (await command.execute(input)) as RecapOutput

			expect(result).toBeDefined()
			expect(result.goal).toBeNull()
			expect(result.entries).toHaveLength(0)
			expect(result.artifacts).toHaveLength(0)
		})

		it('should return empty artifacts array when recap file has no artifacts field', async () => {
			const mockRecap = {
				goal: 'Test goal',
				entries: [],
				// No artifacts field
			}

			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockRecap) as never)

			const input: RecapCommandInput = { json: true }
			const result = (await command.execute(input)) as RecapOutput

			expect(result).toBeDefined()
			expect(result.artifacts).toHaveLength(0)
		})

		it('should derive filePath from current working directory using slugifyPath algorithm', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			// Mock process.cwd
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/Users/test/projects/my-repo')

			const input: RecapCommandInput = { json: true }
			const result = await command.execute(input) as RecapOutput

			// The path should be slugified: /Users/test/projects/my-repo -> ___Users___test___projects___my-repo.json
			expect(result.filePath).toContain('___Users___test___projects___my-repo.json')

			process.cwd = originalCwd
		})
	})

	describe('execute without JSON mode', () => {
		it('should print markdown-formatted output to console including artifacts', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			const mockRecap = {
				goal: 'Test goal',
				entries: [
					{ id: 'uuid-1', timestamp: '2025-01-01T00:00:00Z', type: 'decision', content: 'Test decision' },
				],
				artifacts: [
					{
						id: 'artifact-1',
						type: 'comment',
						primaryUrl: 'https://github.com/org/repo/issues/123#issuecomment-456',
						urls: {},
						description: 'Progress update',
						timestamp: '2025-01-01T00:02:00Z',
					},
				],
			}

			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockRecap) as never)

			const input: RecapCommandInput = { json: false }
			const result = await command.execute(input)

			expect(result).toBeUndefined()
			// Single console.log call with formatted markdown
			expect(consoleSpy).toHaveBeenCalledTimes(1)
			const output = consoleSpy.mock.calls[0][0] as string
			expect(output).toContain('# Loom Recap')
			expect(output).toContain('**File:**')
			expect(output).toContain('## Goal')
			expect(output).toContain('Test goal')
			expect(output).toContain('## Entries (1)')
			expect(output).toContain('- **[decision]** Test decision')
			expect(output).toContain('## Artifacts (1)')
			expect(output).toContain('- **[comment](https://github.com/org/repo/issues/123#issuecomment-456)** Progress update')

			consoleSpy.mockRestore()
		})

		it('should print (not set) when goal is null and show zero entries/artifacts', async () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const input: RecapCommandInput = { json: false }
			await command.execute(input)

			// Single console.log call with formatted markdown
			expect(consoleSpy).toHaveBeenCalledTimes(1)
			const output = consoleSpy.mock.calls[0][0] as string
			expect(output).toContain('# Loom Recap')
			expect(output).toContain('## Goal')
			expect(output).toContain('(not set)')
			expect(output).toContain('## Complexity')
			expect(output).toContain('## Entries (0)')
			expect(output).toContain('## Artifacts (0)')

			consoleSpy.mockRestore()
		})
	})

	describe('filePath derivation', () => {
		it('should use the same slugifyPath algorithm as MetadataManager', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			// Test with a path that has special characters
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/with spaces/and.dots')

			const input: RecapCommandInput = { json: true }
			const result = await command.execute(input) as RecapOutput

			// Path separators become ___, special chars become -
			expect(result.filePath).toContain('___path___with-spaces___and-dots.json')

			process.cwd = originalCwd
		})

		it('should handle Windows-style paths', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			// Test with a Windows-style path (simulated)
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('C:\\Users\\test\\projects')

			const input: RecapCommandInput = { json: true }
			const result = await command.execute(input) as RecapOutput

			// Path separators (both / and \) become ___
			expect(result.filePath).toContain('C-___Users___test___projects.json')

			process.cwd = originalCwd
		})

		it('should strip trailing slashes', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/dir/')

			const input: RecapCommandInput = { json: true }
			const result = await command.execute(input) as RecapOutput

			// Trailing slash should be stripped before slugification
			expect(result.filePath).toContain('___path___to___dir.json')
			expect(result.filePath).not.toContain('___path___to___dir___.json')

			process.cwd = originalCwd
		})
	})

	describe('execute with identifier parameter', () => {
		it('should resolve numeric issue identifier to loom path', async () => {
			const mockWorktreePath = '/Users/test/worktrees/feat-issue-42__test'
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn().mockResolvedValue({ path: mockWorktreePath, branch: 'feat/issue-42__test' }),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			const mockIdentifierParser = {
				parseForPatternDetection: vi.fn().mockResolvedValue({
					type: 'issue',
					number: 42,
					originalInput: '42',
				}),
			}
			vi.mocked(IdentifierParser).mockImplementation(() => mockIdentifierParser as unknown as IdentifierParser)

			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const input: RecapCommandInput = { identifier: '42', json: true }
			const result = await command.execute(input) as RecapOutput

			// Verify the path uses the worktree path, not cwd
			// slugifyPath: / -> ___, special chars (except _ and -) -> -
			expect(result.filePath).toContain('___Users___test___worktrees___feat-issue-42__test.json')
		})

		it('should resolve PR identifier (pr/123) to loom path', async () => {
			const mockWorktreePath = '/Users/test/worktrees/feat-feature__pr_123'
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn(),
				findWorktreeForPR: vi.fn().mockResolvedValue({ path: mockWorktreePath, branch: 'feat/feature' }),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const input: RecapCommandInput = { identifier: 'pr/123', json: true }
			const result = await command.execute(input) as RecapOutput

			// Verify the path uses the worktree path, not cwd
			// slugifyPath: / -> ___, underscores stay as underscores
			expect(result.filePath).toContain('___Users___test___worktrees___feat-feature__pr_123.json')
		})

		it('should fall back to cwd when no identifier provided', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/Users/test/projects/my-repo')

			const input: RecapCommandInput = { json: true }
			const result = await command.execute(input) as RecapOutput

			expect(result.filePath).toContain('___Users___test___projects___my-repo.json')

			process.cwd = originalCwd
		})

		it('should fall back to cwd when identifier is empty string', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/Users/test/projects/my-repo')

			const input: RecapCommandInput = { identifier: '', json: true }
			const result = await command.execute(input) as RecapOutput

			expect(result.filePath).toContain('___Users___test___projects___my-repo.json')

			process.cwd = originalCwd
		})

		it('should throw error when identifier has no matching worktree', async () => {
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn().mockResolvedValue(null),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			const mockIdentifierParser = {
				parseForPatternDetection: vi.fn().mockRejectedValue(new Error('No worktree found for identifier: 999')),
			}
			vi.mocked(IdentifierParser).mockImplementation(() => mockIdentifierParser as unknown as IdentifierParser)

			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const input: RecapCommandInput = { identifier: '999', json: true }

			await expect(command.execute(input)).rejects.toThrow("No worktree or archived recap found for #999")
		})

		it('should throw error when PR identifier has no matching worktree or archived recap', async () => {
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn(),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			vi.mocked(fs.pathExists).mockResolvedValue(false as never)
			vi.mocked(findArchivedRecap).mockResolvedValue(null)

			const input: RecapCommandInput = { identifier: 'pr/456', json: true }

			await expect(command.execute(input)).rejects.toThrow('No worktree or archived recap found for PR #456')
		})
	})

	describe('execute with identifier - archived fallback', () => {
		it('should fall back to archived recap when issue worktree not found', async () => {
			const archivedPath = '/mock/recaps/archived/___Users___test___worktrees___feat-issue-42__fix.json'
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn().mockResolvedValue(null),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			const mockIdentifierParser = {
				parseForPatternDetection: vi.fn().mockResolvedValue({
					type: 'issue',
					number: 42,
					originalInput: '42',
				}),
			}
			vi.mocked(IdentifierParser).mockImplementation(() => mockIdentifierParser as unknown as IdentifierParser)

			vi.mocked(findArchivedRecap).mockResolvedValue(archivedPath)

			// Mock fs.pathExists to return true for the archived path
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
				goal: 'Archived goal',
				entries: [],
				artifacts: [],
			}) as never)

			const input: RecapCommandInput = { identifier: '42', json: true }
			const result = await command.execute(input) as RecapOutput

			expect(result).toBeDefined()
			expect(result.filePath).toBe(archivedPath)
			expect(result.goal).toBe('Archived goal')
			expect(findArchivedRecap).toHaveBeenCalledWith('issue', 42)
		})

		it('should fall back to archived recap when PR worktree not found (pr/ prefix)', async () => {
			const archivedPath = '/mock/recaps/archived/___Users___test___worktrees___feat__pr_123.json'
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn(),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			vi.mocked(findArchivedRecap).mockResolvedValue(archivedPath)
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
				goal: 'Archived PR goal',
				entries: [],
				artifacts: [],
			}) as never)

			const input: RecapCommandInput = { identifier: 'pr/123', json: true }
			const result = await command.execute(input) as RecapOutput

			expect(result).toBeDefined()
			expect(result.filePath).toBe(archivedPath)
			expect(result.goal).toBe('Archived PR goal')
			expect(findArchivedRecap).toHaveBeenCalledWith('pr', 123)
		})

		it('should still throw when neither worktree nor archived recap exists for issue', async () => {
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn().mockResolvedValue(null),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			const mockIdentifierParser = {
				parseForPatternDetection: vi.fn().mockResolvedValue({
					type: 'issue',
					number: 999,
					originalInput: '999',
				}),
			}
			vi.mocked(IdentifierParser).mockImplementation(() => mockIdentifierParser as unknown as IdentifierParser)

			vi.mocked(findArchivedRecap).mockResolvedValue(null)

			const input: RecapCommandInput = { identifier: '999', json: true }

			await expect(command.execute(input)).rejects.toThrow('No worktree or archived recap found for issue #999')
		})

		it('should handle string number from IdentifierParser for issue lookup', async () => {
			const archivedPath = '/mock/recaps/archived/___Users___test___worktrees___feat-issue-55__fix.json'
			const mockGitWorktreeManager = {
				findWorktreeForIssue: vi.fn().mockResolvedValue(null),
				findWorktreeForPR: vi.fn().mockResolvedValue(null),
				findWorktreeForBranch: vi.fn(),
			}
			vi.mocked(GitWorktreeManager).mockImplementation(() => mockGitWorktreeManager as unknown as GitWorktreeManager)

			const mockIdentifierParser = {
				parseForPatternDetection: vi.fn().mockResolvedValue({
					type: 'issue',
					number: '55', // string type from IdentifierParser
					originalInput: 'ENG-55',
				}),
			}
			vi.mocked(IdentifierParser).mockImplementation(() => mockIdentifierParser as unknown as IdentifierParser)

			vi.mocked(findArchivedRecap).mockResolvedValue(archivedPath)
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
				goal: 'Archived issue',
				entries: [],
				artifacts: [],
			}) as never)

			const input: RecapCommandInput = { identifier: 'ENG-55', json: true }
			const result = await command.execute(input) as RecapOutput

			expect(result).toBeDefined()
			expect(result.filePath).toBe(archivedPath)
			// parseInt('55') = 55
			expect(findArchivedRecap).toHaveBeenCalledWith('issue', 55)
		})
	})
})
