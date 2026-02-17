import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execa } from 'execa'
import type { ExecaReturnValue } from 'execa'
import {
	parseGitRemotes,
	hasMultipleRemotes,
	getConfiguredRepoFromSettings,
	validateConfiguredRemote,
} from './remote.js'
import type { IloomSettings } from '../lib/SettingsManager.js'

vi.mock('execa')

describe('remote utils', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('parseGitRemotes', () => {
		it('should parse single remote', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'git@github.com:user/repo.git',
					owner: 'user',
					repo: 'repo',
				},
			])
		})

		it('should parse multiple remotes', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout:
					'origin\tgit@github.com:user/fork.git (fetch)\n' +
					'origin\tgit@github.com:user/fork.git (push)\n' +
					'upstream\tgit@github.com:org/repo.git (fetch)\n' +
					'upstream\tgit@github.com:org/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'git@github.com:user/fork.git',
					owner: 'user',
					repo: 'fork',
				},
				{
					name: 'upstream',
					url: 'git@github.com:org/repo.git',
					owner: 'org',
					repo: 'repo',
				},
			])
		})

		it('should extract owner/repo from HTTPS URL', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'https://github.com/user/repo.git',
					owner: 'user',
					repo: 'repo',
				},
			])
		})

		it('should extract owner/repo from SSH URL', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'git@github.com:user/repo.git',
					owner: 'user',
					repo: 'repo',
				},
			])
		})

		it('should handle remotes with .git suffix', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes[0].repo).toBe('repo')
		})

		it('should handle remotes without .git suffix', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\thttps://github.com/user/repo (fetch)\norigin\thttps://github.com/user/repo (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes[0].repo).toBe('repo')
		})

		it('should parse BitBucket HTTPS remote with .git', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\thttps://bitbucket.org/workspace/repo.git (fetch)\norigin\thttps://bitbucket.org/workspace/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'https://bitbucket.org/workspace/repo.git',
					owner: 'workspace',
					repo: 'repo',
				},
			])
		})

		it('should parse BitBucket HTTPS remote without .git', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\thttps://bitbucket.org/workspace/repo (fetch)\norigin\thttps://bitbucket.org/workspace/repo (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'https://bitbucket.org/workspace/repo',
					owner: 'workspace',
					repo: 'repo',
				},
			])
		})

		it('should parse BitBucket SSH remote with .git', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\tgit@bitbucket.org:workspace/repo.git (fetch)\norigin\tgit@bitbucket.org:workspace/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'git@bitbucket.org:workspace/repo.git',
					owner: 'workspace',
					repo: 'repo',
				},
			])
		})

		it('should parse BitBucket SSH remote without .git', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\tgit@bitbucket.org:workspace/repo (fetch)\norigin\tgit@bitbucket.org:workspace/repo (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toEqual([
				{
					name: 'origin',
					url: 'git@bitbucket.org:workspace/repo',
					owner: 'workspace',
					repo: 'repo',
				},
			])
		})

		it('should deduplicate fetch/push entries', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const remotes = await parseGitRemotes()

			expect(remotes).toHaveLength(1)
		})
	})

	describe('hasMultipleRemotes', () => {
		it('should return false for single remote', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const result = await hasMultipleRemotes()

			expect(result).toBe(false)
		})

		it('should return true for multiple remotes', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout:
					'origin\tgit@github.com:user/fork.git (fetch)\n' +
					'origin\tgit@github.com:user/fork.git (push)\n' +
					'upstream\tgit@github.com:org/repo.git (fetch)\n' +
					'upstream\tgit@github.com:org/repo.git (push)',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			const result = await hasMultipleRemotes()

			expect(result).toBe(true)
		})

		it('should return false when git command fails', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('fatal: not a git repository'))

			const result = await hasMultipleRemotes()

			expect(result).toBe(false)
		})
	})

	describe('getConfiguredRepoFromSettings', () => {
		it('should return repo string from configured remote', async () => {
			const settings: IloomSettings = {
				issueManagement: {
					github: {
						remote: 'origin',
					},
				},
			}

			vi.mocked(execa)
				.mockResolvedValueOnce({
					stdout: 'git@github.com:user/repo.git',
				} as Partial<ExecaReturnValue> as ExecaReturnValue) // validateConfiguredRemote
				.mockResolvedValueOnce({
					stdout: 'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
				} as Partial<ExecaReturnValue> as ExecaReturnValue) // parseGitRemotes

			const repo = await getConfiguredRepoFromSettings(settings)

			expect(repo).toBe('user/repo')
		})

		it('should throw if configured remote not found', async () => {
			const settings: IloomSettings = {
				issueManagement: {
					github: {
						remote: 'nonexistent',
					},
				},
			}

			vi.mocked(execa).mockRejectedValue(new Error('Remote not found'))

			await expect(getConfiguredRepoFromSettings(settings)).rejects.toThrow(
				'Remote "nonexistent" does not exist in git configuration',
			)
		})

		it('should throw if issueManagement config missing', async () => {
			const settings: IloomSettings = {}

			await expect(getConfiguredRepoFromSettings(settings)).rejects.toThrow(
				'GitHub remote not configured. Run "il init" to configure',
			)
		})

		it('should throw if github config missing', async () => {
			const settings: IloomSettings = {
				issueManagement: {},
			}

			await expect(getConfiguredRepoFromSettings(settings)).rejects.toThrow(
				'GitHub remote not configured. Run "il init" to configure',
			)
		})

		it('should throw if remote config missing', async () => {
			const settings: IloomSettings = {
				issueManagement: {
					github: {},
				},
			}

			await expect(getConfiguredRepoFromSettings(settings)).rejects.toThrow(
				'GitHub remote not configured. Run "il init" to configure',
			)
		})
	})

	describe('validateConfiguredRemote', () => {
		it('should not throw for valid remote', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'git@github.com:user/repo.git',
			} as Partial<ExecaReturnValue> as ExecaReturnValue)

			await expect(validateConfiguredRemote('origin')).resolves.not.toThrow()
		})

		it('should throw for invalid remote', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('Remote not found'))

			await expect(validateConfiguredRemote('nonexistent')).rejects.toThrow(
				'Remote "nonexistent" does not exist in git configuration',
			)
		})
	})
})
