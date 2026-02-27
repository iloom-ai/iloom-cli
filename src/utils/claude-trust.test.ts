import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import lockfile from 'proper-lockfile'
import { preAcceptClaudeTrust, removeClaudeTrust, _internal } from './claude-trust.js'

vi.mock('fs-extra', () => ({
	default: {
		access: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		rename: vi.fn(),
	},
}))

vi.mock('proper-lockfile', () => ({
	default: {
		lock: vi.fn(),
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

describe('preAcceptClaudeTrust', () => {
	beforeEach(() => {
		// Default: file exists, lock succeeds, file has empty config
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('{}')
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(lockfile.lock).mockResolvedValue(vi.fn().mockResolvedValue(undefined))
	})

	it('should write hasTrustDialogAccepted: true for the given path to ~/.claude.json', async () => {
		const worktreePath = '/home/user/.config/iloom-ai/worktrees/myproject-a3f2/feat-issue-42'

		await preAcceptClaudeTrust(worktreePath)

		// Verify the written content
		expect(fs.writeFile).toHaveBeenCalledWith(
			expect.stringContaining('.tmp'),
			expect.any(String),
			expect.objectContaining({ encoding: 'utf-8', mode: 0o600 })
		)

		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)
		expect(parsed.projects[worktreePath]).toEqual({ hasTrustDialogAccepted: true })
	})

	it('should create ~/.claude.json if it does not exist', async () => {
		const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		vi.mocked(fs.access).mockRejectedValue(enoentError)

		await preAcceptClaudeTrust('/some/worktree')

		// Should create the file first
		expect(fs.writeFile).toHaveBeenCalledWith(
			_internal.CLAUDE_CONFIG_PATH,
			'{}',
			expect.objectContaining({ encoding: 'utf-8', mode: 0o600 })
		)
	})

	it('should preserve existing projects entries in ~/.claude.json', async () => {
		const existingConfig = {
			projects: {
				'/existing/project': { hasTrustDialogAccepted: true, someOtherSetting: 'value' },
			},
			someGlobalSetting: true,
		}
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

		await preAcceptClaudeTrust('/new/worktree')

		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)

		// Existing entry preserved
		expect(parsed.projects['/existing/project']).toEqual({
			hasTrustDialogAccepted: true,
			someOtherSetting: 'value',
		})
		// New entry added
		expect(parsed.projects['/new/worktree']).toEqual({ hasTrustDialogAccepted: true })
		// Global settings preserved
		expect(parsed.someGlobalSetting).toBe(true)
	})

	it('should use proper-lockfile for concurrent safety', async () => {
		const mockRelease = vi.fn().mockResolvedValue(undefined)
		vi.mocked(lockfile.lock).mockResolvedValue(mockRelease)

		await preAcceptClaudeTrust('/some/worktree')

		expect(lockfile.lock).toHaveBeenCalledWith(
			_internal.CLAUDE_CONFIG_PATH,
			expect.objectContaining({
				retries: expect.objectContaining({ retries: 5 }),
			})
		)
		// Lock should be released after write
		expect(mockRelease).toHaveBeenCalled()
	})

	it('should fall back to direct write if lock acquisition fails', async () => {
		vi.mocked(lockfile.lock).mockRejectedValue(new Error('Lock failed'))

		await preAcceptClaudeTrust('/some/worktree')

		// Should still write the file despite lock failure
		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)
		expect(parsed.projects['/some/worktree']).toEqual({ hasTrustDialogAccepted: true })
	})

	it('should set file mode 0o600 on ~/.claude.json', async () => {
		await preAcceptClaudeTrust('/some/worktree')

		// The atomic write should use mode 0o600
		const tmpWriteCall = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)
		expect(tmpWriteCall?.[2]).toEqual(expect.objectContaining({ mode: 0o600 }))
	})

	it('should be idempotent - no error if trust already set', async () => {
		const existingConfig = {
			projects: {
				'/some/worktree': { hasTrustDialogAccepted: true },
			},
		}
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

		// Should not throw
		await expect(preAcceptClaudeTrust('/some/worktree')).resolves.toBeUndefined()

		// Should still write (idempotent overwrite)
		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)
		expect(parsed.projects['/some/worktree']).toEqual({ hasTrustDialogAccepted: true })
	})

	it('should throw when the entire operation fails', async () => {
		const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		vi.mocked(fs.access).mockRejectedValue(enoentError)
		// Make the creation itself fail
		vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'))

		await expect(preAcceptClaudeTrust('/some/worktree')).rejects.toThrow('Permission denied')
	})

	it('should handle malformed JSON in existing ~/.claude.json', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('not valid json{{{')

		await preAcceptClaudeTrust('/some/worktree')

		// Should create fresh config with just the new entry
		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)
		expect(parsed.projects['/some/worktree']).toEqual({ hasTrustDialogAccepted: true })
	})

	it('should release the lock even if writing fails', async () => {
		const mockRelease = vi.fn().mockResolvedValue(undefined)
		vi.mocked(lockfile.lock).mockResolvedValue(mockRelease)
		vi.mocked(fs.readFile).mockResolvedValue('{}')
		// Fail on the temp file write
		vi.mocked(fs.writeFile).mockImplementation(async (filePath) => {
			if (String(filePath).endsWith('.tmp')) {
				throw new Error('Disk full')
			}
		})

		await expect(preAcceptClaudeTrust('/some/worktree')).rejects.toThrow('Disk full')

		// Lock should still be released
		expect(mockRelease).toHaveBeenCalled()
	})
})

describe('removeClaudeTrust', () => {
	beforeEach(() => {
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('{}')
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(lockfile.lock).mockResolvedValue(vi.fn().mockResolvedValue(undefined))
	})

	it('should remove the trust entry for the given path from ~/.claude.json', async () => {
		const existingConfig = {
			projects: {
				'/worktree/to/remove': { hasTrustDialogAccepted: true },
				'/worktree/to/keep': { hasTrustDialogAccepted: true },
			},
		}
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

		await removeClaudeTrust('/worktree/to/remove')

		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)

		expect(parsed.projects['/worktree/to/remove']).toBeUndefined()
		expect(parsed.projects['/worktree/to/keep']).toEqual({ hasTrustDialogAccepted: true })
	})

	it('should not throw if path does not exist in ~/.claude.json', async () => {
		const existingConfig = {
			projects: {
				'/some/other/worktree': { hasTrustDialogAccepted: true },
			},
		}
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

		await expect(removeClaudeTrust('/nonexistent/worktree')).resolves.toBeUndefined()
	})

	it('should not throw if ~/.claude.json does not exist', async () => {
		const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		vi.mocked(fs.access).mockRejectedValue(enoentError)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue('{}')

		await expect(removeClaudeTrust('/some/worktree')).resolves.toBeUndefined()
	})

	it('should preserve other projects entries', async () => {
		const existingConfig = {
			projects: {
				'/worktree/a': { hasTrustDialogAccepted: true, custom: 'data' },
				'/worktree/b': { hasTrustDialogAccepted: true },
				'/worktree/c': { hasTrustDialogAccepted: true },
			},
			globalSetting: 'preserved',
		}
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

		await removeClaudeTrust('/worktree/b')

		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)

		expect(parsed.projects['/worktree/a']).toEqual({ hasTrustDialogAccepted: true, custom: 'data' })
		expect(parsed.projects['/worktree/b']).toBeUndefined()
		expect(parsed.projects['/worktree/c']).toEqual({ hasTrustDialogAccepted: true })
		expect(parsed.globalSetting).toBe('preserved')
	})

	it('should throw when the entire operation fails', async () => {
		const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		vi.mocked(fs.access).mockRejectedValue(enoentError)
		// Make the creation itself fail
		vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'))

		await expect(removeClaudeTrust('/some/worktree')).rejects.toThrow('Permission denied')
	})

	it('should handle config with no projects key gracefully', async () => {
		vi.mocked(fs.readFile).mockResolvedValue('{"someOther": "setting"}')

		await removeClaudeTrust('/some/worktree')

		// Should still write, just without modifying anything structurally
		const writtenContent = vi.mocked(fs.writeFile).mock.calls.find(
			(call) => String(call[0]).endsWith('.tmp')
		)?.[1] as string
		const parsed = JSON.parse(writtenContent)
		expect(parsed.someOther).toBe('setting')
	})
})
