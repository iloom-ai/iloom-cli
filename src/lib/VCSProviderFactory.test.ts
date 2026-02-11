import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VCSProviderFactory } from './VCSProviderFactory.js'
import { BitBucketVCSProvider } from './providers/bitbucket/index.js'
import type { IloomSettings } from './SettingsManager.js'

// Mock the BitBucketVCSProvider
vi.mock('./providers/bitbucket/index.js', () => ({
	BitBucketVCSProvider: vi.fn().mockImplementation((config) => ({
		providerName: 'bitbucket',
		config,
	})),
}))

// Mock the logger
vi.mock('../utils/logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

describe('VCSProviderFactory', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('create', () => {
		it('should return null for github provider', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'github',
				},
			}

			const result = VCSProviderFactory.create(settings)
			expect(result).toBeNull()
		})

		it('should return null when no provider is configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
			}

			const result = VCSProviderFactory.create(settings)
			expect(result).toBeNull()
		})

		it('should create BitBucketVCSProvider with basic config', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
					bitbucket: {
						username: 'testuser',
						apiToken: 'test-token',
					},
				},
			}

			VCSProviderFactory.create(settings)

			expect(BitBucketVCSProvider).toHaveBeenCalledWith({
				username: 'testuser',
				apiToken: 'test-token',
			})
		})

		it('should pass workspace and repoSlug when configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
					bitbucket: {
						username: 'testuser',
						apiToken: 'test-token',
						workspace: 'my-workspace',
						repoSlug: 'my-repo',
					},
				},
			}

			VCSProviderFactory.create(settings)

			expect(BitBucketVCSProvider).toHaveBeenCalledWith({
				username: 'testuser',
				apiToken: 'test-token',
				workspace: 'my-workspace',
				repoSlug: 'my-repo',
			})
		})

		it('should pass reviewers when configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
					bitbucket: {
						username: 'testuser',
						apiToken: 'test-token',
						reviewers: ['alice@example.com', 'bob@example.com'],
					},
				},
			}

			VCSProviderFactory.create(settings)

			expect(BitBucketVCSProvider).toHaveBeenCalledWith({
				username: 'testuser',
				apiToken: 'test-token',
				reviewers: ['alice@example.com', 'bob@example.com'],
			})
		})

		it('should pass all config options together', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
					bitbucket: {
						username: 'testuser',
						apiToken: 'test-token',
						workspace: 'my-workspace',
						repoSlug: 'my-repo',
						reviewers: ['alice@example.com'],
					},
				},
			}

			VCSProviderFactory.create(settings)

			expect(BitBucketVCSProvider).toHaveBeenCalledWith({
				username: 'testuser',
				apiToken: 'test-token',
				workspace: 'my-workspace',
				repoSlug: 'my-repo',
				reviewers: ['alice@example.com'],
			})
		})

		it('should throw when bitbucket username is missing', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
					bitbucket: {
						username: '',
						apiToken: 'test-token',
					},
				},
			}

			expect(() => VCSProviderFactory.create(settings)).toThrow(
				'BitBucket username is required'
			)
		})

		it('should throw when bitbucket apiToken is missing', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
					bitbucket: {
						username: 'testuser',
					},
				},
			}

			expect(() => VCSProviderFactory.create(settings)).toThrow(
				'BitBucket API token is required'
			)
		})
	})

	describe('isConfigured', () => {
		it('should return true for bitbucket provider', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
				},
			}

			expect(VCSProviderFactory.isConfigured(settings)).toBe(true)
		})

		it('should return false for github provider', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'github',
				},
			}

			expect(VCSProviderFactory.isConfigured(settings)).toBe(false)
		})

		it('should return false when no provider is configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
			}

			expect(VCSProviderFactory.isConfigured(settings)).toBe(false)
		})
	})

	describe('getProviderName', () => {
		it('should return bitbucket when configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'bitbucket',
				},
			}

			expect(VCSProviderFactory.getProviderName(settings)).toBe('bitbucket')
		})

		it('should return github when configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
				versionControl: {
					provider: 'github',
				},
			}

			expect(VCSProviderFactory.getProviderName(settings)).toBe('github')
		})

		it('should return undefined when no provider is configured', () => {
			const settings: IloomSettings = {
				sourceEnvOnStart: false,
				attribution: 'upstreamOnly',
			}

			expect(VCSProviderFactory.getProviderName(settings)).toBeUndefined()
		})
	})
})
