import { describe, it, expect, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { ensureWorktreeGitignore, resolveGlobalGitignorePath, ensureGlobalGitignorePatterns } from './gitignore.js'
import { executeGitCommand, GitCommandError } from './git.js'

vi.mock('fs-extra', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		ensureDir: vi.fn(),
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

vi.mock('./git.js', () => ({
	executeGitCommand: vi.fn(),
	GitCommandError: class GitCommandError extends Error {
		constructor(
			message: string,
			public readonly exitCode: number | undefined,
			public readonly stderr: string
		) {
			super(message)
			this.name = 'GitCommandError'
		}
	},
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

describe('resolveGlobalGitignorePath', () => {
	const xdgDefault = path.join(os.homedir(), '.config', 'git', 'ignore')

	it('returns configured path when core.excludesFile is set', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')

		const result = await resolveGlobalGitignorePath()

		expect(executeGitCommand).toHaveBeenCalledWith(['config', '--global', '--type=path', 'core.excludesFile'])
		expect(result).toBe('/Users/user/.gitignore_global')
	})

	it('returns XDG default when core.excludesFile is not set (exit code 1)', async () => {
		vi.mocked(executeGitCommand).mockRejectedValue(
			new GitCommandError('Git command failed', 1, '')
		)

		const result = await resolveGlobalGitignorePath()

		expect(result).toBe(xdgDefault)
	})

	it('returns XDG default and logs debug warning on unexpected git failure', async () => {
		vi.mocked(executeGitCommand).mockRejectedValue(
			new GitCommandError('Git command failed: fatal', 128, 'fatal: unknown error')
		)

		const result = await resolveGlobalGitignorePath()

		expect(result).toBe(xdgDefault)
	})

	it('expands tilde in returned path as safety net', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('~/.gitignore_global\n')

		const result = await resolveGlobalGitignorePath()

		expect(result).toBe(path.join(os.homedir(), '.gitignore_global'))
	})
})

describe('ensureGlobalGitignorePatterns', () => {
	it('appends missing patterns to gitignore file', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('*.log\n')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureGlobalGitignorePatterns(['**/.iloom/settings.local.json'])

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/Users/user/.gitignore_global',
			'*.log\n\n# Added by iloom CLI\n**/.iloom/settings.local.json\n',
			'utf-8'
		)
	})

	it('does not duplicate patterns that already exist (idempotent)', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('**/.iloom/settings.local.json\n')

		await ensureGlobalGitignorePatterns(['**/.iloom/settings.local.json'])

		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	it('creates file and parent directories if they do not exist', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		vi.mocked(fs.readFile).mockRejectedValue(enoentError)
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureGlobalGitignorePatterns(['**/.iloom/worktrees'])

		expect(fs.ensureDir).toHaveBeenCalledWith('/Users/user')
		expect(fs.writeFile).toHaveBeenCalledWith(
			'/Users/user/.gitignore_global',
			'\n# Added by iloom CLI\n**/.iloom/worktrees\n',
			'utf-8'
		)
	})

	it('handles multiple patterns, only appending missing ones', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('**/.iloom/settings.local.json\n')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureGlobalGitignorePatterns([
			'**/.iloom/settings.local.json',
			'**/.iloom/worktrees',
			'**/.claude/agents/iloom-*',
		])

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/Users/user/.gitignore_global',
			'**/.iloom/settings.local.json\n\n# Added by iloom CLI\n**/.iloom/worktrees\n**/.claude/agents/iloom-*\n',
			'utf-8'
		)
	})

	it('uses "# Added by iloom CLI" comment marker', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureGlobalGitignorePatterns(['**/.iloom/worktrees'])

		const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string
		expect(writtenContent).toContain('# Added by iloom CLI')
	})

	it('re-throws non-ENOENT errors from readFile', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
		vi.mocked(fs.readFile).mockRejectedValue(permError)

		await expect(ensureGlobalGitignorePatterns(['**/.iloom/worktrees'])).rejects.toThrow('EACCES: permission denied')
		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	it('handles file without trailing newline', async () => {
		vi.mocked(executeGitCommand).mockResolvedValue('/Users/user/.gitignore_global\n')
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('*.log')
		vi.mocked(fs.writeFile).mockResolvedValue()

		await ensureGlobalGitignorePatterns(['**/.iloom/worktrees'])

		expect(fs.writeFile).toHaveBeenCalledWith(
			'/Users/user/.gitignore_global',
			'*.log\n\n# Added by iloom CLI\n**/.iloom/worktrees\n',
			'utf-8'
		)
	})
})
