import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VCSProviderFactory } from './VCSProviderFactory.js'
import type { IloomSettings } from './SettingsManager.js'

// Mock the BitBucketVCSProvider
const { mockBBInstance, mockFromSettings } = vi.hoisted(() => {
	const mockBBInstance = { providerName: 'bitbucket' }
	const mockFromSettings = vi.fn().mockReturnValue(mockBBInstance)
	return { mockBBInstance, mockFromSettings }
})
vi.mock('./providers/bitbucket/index.js', () => ({
	BitBucketVCSProvider: {
		fromSettings: mockFromSettings,
	},
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
		mockFromSettings.mockReturnValue(mockBBInstance)
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

		it('should delegate to BitBucketVCSProvider.fromSettings for bitbucket provider', () => {
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

			const result = VCSProviderFactory.create(settings)

			expect(mockFromSettings).toHaveBeenCalledWith(settings)
			expect(result).toEqual({ providerName: 'bitbucket' })
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
