import { describe, it, expect, vi } from 'vitest'
import fs from 'fs-extra'
import { ensureWorktreeGitignore } from './gitignore.js'

vi.mock('fs-extra', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
	},
}))

vi.mock('./logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	}),
}))

describe('ensureWorktreeGitignore', () => {
	it('should add .iloom/worktrees/ to .gitignore when file exists but entry missing', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('node_modules/\ndist/\n')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureWorktreeGitignore('/path/to/project')

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/path/to/project/.gitignore',
			'node_modules/\ndist/\n\n# iloom worktree directory\n.iloom/worktrees/\n',
			'utf-8'
		)
	})

	it('should create .gitignore with entry when file does not exist', async () => {
		const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
		vi.mocked(fs.readFile).mockRejectedValue(enoentError)
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureWorktreeGitignore('/path/to/project')

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/path/to/project/.gitignore',
			'\n# iloom worktree directory\n.iloom/worktrees/\n',
			'utf-8'
		)
	})

	it('should re-throw non-ENOENT errors from readFile', async () => {
		const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
		vi.mocked(fs.readFile).mockRejectedValue(permError)

		await expect(ensureWorktreeGitignore('/path/to/project')).rejects.toThrow('EACCES: permission denied')
		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	it('should be idempotent -- not duplicate entry if already present', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('node_modules/\n\n# iloom worktree directory\n.iloom/worktrees/\n')

		await ensureWorktreeGitignore('/path/to/project')

		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	it('should handle .gitignore with no trailing newline', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('node_modules/\ndist/')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureWorktreeGitignore('/path/to/project')

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/path/to/project/.gitignore',
			'node_modules/\ndist/\n\n# iloom worktree directory\n.iloom/worktrees/\n',
			'utf-8'
		)
	})

	it('should not modify .gitignore if entry already present without comment', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('.iloom/worktrees/\n')

		await ensureWorktreeGitignore('/path/to/project')

		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	it('should not match partial entries like .iloom/worktrees/foo', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('.iloom/worktrees/foo\n')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureWorktreeGitignore('/path/to/project')

		// The entry ".iloom/worktrees/foo" is not the same as ".iloom/worktrees/"
		// so it should add the correct entry
		expect(fs.writeFile).toHaveBeenCalled()
	})

	it('should handle empty .gitignore file', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureWorktreeGitignore('/path/to/project')

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/path/to/project/.gitignore',
			'\n# iloom worktree directory\n.iloom/worktrees/\n',
			'utf-8'
		)
	})

	it('should handle entry with surrounding whitespace in .gitignore', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('  .iloom/worktrees/  \n')

		await ensureWorktreeGitignore('/path/to/project')

		// Should detect the entry even with surrounding whitespace (via trim)
		expect(fs.writeFile).not.toHaveBeenCalled()
	})
})
