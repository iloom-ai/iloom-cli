import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { archiveRecap, findArchivedRecap, slugifyPath, RECAPS_DIR, ARCHIVED_DIR } from './recap-archiver.js'

// Mock fs-extra
vi.mock('fs-extra', () => ({
	default: {
		pathExists: vi.fn(),
		readFile: vi.fn(),
		ensureDir: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
	},
}))

// Mock logger
vi.mock('./logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	}),
}))

// Mock MetadataManager
vi.mock('../lib/MetadataManager.js', () => ({
	MetadataManager: vi.fn(),
}))

// Mock findMainWorktreePathWithSettings
vi.mock('./git.js', () => ({
	findMainWorktreePathWithSettings: vi.fn(),
}))

import { MetadataManager } from '../lib/MetadataManager.js'
import { findMainWorktreePathWithSettings } from './git.js'

describe('RecapArchiver', () => {
	describe('slugifyPath', () => {
		it('should convert path to filename with triple underscore separators', () => {
			const result = slugifyPath('/Users/jane/dev/repo')
			expect(result).toBe('___Users___jane___dev___repo.json')
		})

		it('should trim trailing slashes', () => {
			const result = slugifyPath('/Users/jane/dev/repo/')
			expect(result).toBe('___Users___jane___dev___repo.json')
		})

		it('should replace non-alphanumeric chars with hyphens', () => {
			const result = slugifyPath('/Users/jane/my project/repo')
			expect(result).toBe('___Users___jane___my-project___repo.json')
		})
	})

	describe('archiveRecap', () => {
		const worktreePath = '/Users/jane/dev/repo'
		const expectedFilename = slugifyPath(worktreePath)
		const sourcePath = path.join(RECAPS_DIR, expectedFilename)
		const destPath = path.join(ARCHIVED_DIR, expectedFilename)

		it('should move recap file to archived/ subdirectory with timestamp', async () => {
			const recapContent = {
				goal: 'Test goal',
				entries: [{ type: 'decision', content: 'Test decision' }],
				artifacts: [],
			}

			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(recapContent) as never)
			vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
			vi.mocked(fs.writeFile).mockResolvedValue(undefined as never)
			vi.mocked(fs.unlink).mockResolvedValue(undefined as never)

			await archiveRecap(worktreePath)

			// Verify file was read from source
			expect(fs.readFile).toHaveBeenCalledWith(sourcePath, 'utf8')

			// Verify archived directory was created
			expect(fs.ensureDir).toHaveBeenCalledWith(ARCHIVED_DIR, { mode: 0o755 })

			// Verify file was written to archived location with archivedAt timestamp
			expect(fs.writeFile).toHaveBeenCalledWith(
				destPath,
				expect.stringContaining('"archivedAt"'),
				{ mode: 0o644 }
			)

			// Verify original file was deleted
			expect(fs.unlink).toHaveBeenCalledWith(sourcePath)
		})

		it('should not throw if recap file does not exist (idempotent)', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			// Should not throw
			await expect(archiveRecap(worktreePath)).resolves.toBeUndefined()

			// Should not attempt to read, write, or delete
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(fs.writeFile).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it('should create archived directory if it does not exist', async () => {
			const recapContent = { goal: 'Test', entries: [], artifacts: [] }

			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(recapContent) as never)
			vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
			vi.mocked(fs.writeFile).mockResolvedValue(undefined as never)
			vi.mocked(fs.unlink).mockResolvedValue(undefined as never)

			await archiveRecap(worktreePath)

			expect(fs.ensureDir).toHaveBeenCalledWith(ARCHIVED_DIR, { mode: 0o755 })
		})

		it('should add archivedAt timestamp to archived file', async () => {
			const recapContent = {
				goal: 'Test goal',
				complexity: 'simple',
				entries: [],
				artifacts: [],
			}

			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(recapContent) as never)
			vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
			vi.mocked(fs.writeFile).mockResolvedValue(undefined as never)
			vi.mocked(fs.unlink).mockResolvedValue(undefined as never)

			await archiveRecap(worktreePath)

			// Capture the written content and verify it has archivedAt
			const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
			expect(writeCall).toBeDefined()
			const writtenContent = JSON.parse(writeCall![1] as string)
			expect(writtenContent).toHaveProperty('archivedAt')
			expect(writtenContent.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
			// Verify original content is preserved
			expect(writtenContent.goal).toBe('Test goal')
			expect(writtenContent.complexity).toBe('simple')
		})

		it('should throw on error so caller can handle it', async () => {
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)
			vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied') as never)

			// Should throw - caller (ResourceCleanup.ts) handles errors as non-fatal
			await expect(archiveRecap(worktreePath)).rejects.toThrow('Permission denied')
		})
	})

	describe('findArchivedRecap', () => {
		const currentProjectPath = '/Users/test/projects/my-repo'
		const worktreePath = '/Users/test/projects/my-repo-issue-42__fix'

		function setupMetadataMock(finishedLooms: unknown[]) {
			const mockListFinishedMetadata = vi.fn().mockResolvedValue(finishedLooms)
			vi.mocked(MetadataManager).mockImplementation(() => ({
				listFinishedMetadata: mockListFinishedMetadata,
			}) as unknown as MetadataManager)
			return mockListFinishedMetadata
		}

		it('should find archived recap by issue number using finished metadata', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			setupMetadataMock([
				{
					projectPath: currentProjectPath,
					worktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)

			const result = await findArchivedRecap('issue', 42)

			expect(result).toBe(path.join(ARCHIVED_DIR, slugifyPath(worktreePath)))
		})

		it('should find archived recap by PR number using finished metadata', async () => {
			const prWorktreePath = '/Users/test/projects/my-repo-feat__pr_123'
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			setupMetadataMock([
				{
					projectPath: currentProjectPath,
					worktreePath: prWorktreePath,
					issue_numbers: [],
					pr_numbers: ['123'],
				},
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)

			const result = await findArchivedRecap('pr', 123)

			expect(result).toBe(path.join(ARCHIVED_DIR, slugifyPath(prWorktreePath)))
		})

		it('should filter by projectPath to avoid cross-project false positives', async () => {
			const otherProjectWorktree = '/Users/test/projects/other-repo-issue-42__fix'
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			setupMetadataMock([
				{
					projectPath: '/Users/test/projects/other-repo',
					worktreePath: otherProjectWorktree,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
				{
					projectPath: currentProjectPath,
					worktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)

			const result = await findArchivedRecap('issue', 42)

			// Should return the match for the current project, not the other one
			expect(result).toBe(path.join(ARCHIVED_DIR, slugifyPath(worktreePath)))
		})

		it('should return null when no matching finished metadata exists', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			setupMetadataMock([
				{
					projectPath: currentProjectPath,
					worktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
			])

			const result = await findArchivedRecap('issue', 999)

			expect(result).toBeNull()
		})

		it('should return null when archived recap file does not exist on disk', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			setupMetadataMock([
				{
					projectPath: currentProjectPath,
					worktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
			])
			vi.mocked(fs.pathExists).mockResolvedValue(false as never)

			const result = await findArchivedRecap('issue', 42)

			expect(result).toBeNull()
		})

		it('should return most recent match when multiple finished looms match', async () => {
			const newerWorktreePath = '/Users/test/projects/my-repo-issue-42__fix-v2'
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			// listFinishedMetadata is pre-sorted by finishedAt desc, so first match is most recent
			setupMetadataMock([
				{
					projectPath: currentProjectPath,
					worktreePath: newerWorktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
				{
					projectPath: currentProjectPath,
					worktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
			])
			vi.mocked(fs.pathExists).mockResolvedValue(true as never)

			const result = await findArchivedRecap('issue', 42)

			// Should return the first (most recent) match
			expect(result).toBe(path.join(ARCHIVED_DIR, slugifyPath(newerWorktreePath)))
		})

		it('should skip metadata entries without projectPath (legacy looms)', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			setupMetadataMock([
				{
					projectPath: null,
					worktreePath,
					issue_numbers: ['42'],
					pr_numbers: [],
				},
			])

			const result = await findArchivedRecap('issue', 42)

			expect(result).toBeNull()
		})

		it('should handle errors from MetadataManager gracefully', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue(currentProjectPath)
			const mockListFinishedMetadata = vi.fn().mockRejectedValue(new Error('File system error'))
			vi.mocked(MetadataManager).mockImplementation(() => ({
				listFinishedMetadata: mockListFinishedMetadata,
			}) as unknown as MetadataManager)

			const result = await findArchivedRecap('issue', 42)

			expect(result).toBeNull()
		})

		it('should handle errors from findMainWorktreePathWithSettings gracefully', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockRejectedValue(new Error('Not a git repo'))

			const result = await findArchivedRecap('issue', 42)

			expect(result).toBeNull()
		})
	})

	describe('constants', () => {
		it('should have correct RECAPS_DIR path', () => {
			expect(RECAPS_DIR).toBe(path.join(os.homedir(), '.config', 'iloom-ai', 'recaps'))
		})

		it('should have correct ARCHIVED_DIR path', () => {
			expect(ARCHIVED_DIR).toBe(path.join(os.homedir(), '.config', 'iloom-ai', 'recaps', 'archived'))
		})
	})
})
