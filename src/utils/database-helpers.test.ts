import { describe, expect, it, vi } from 'vitest'
import { NeonProvider } from '../lib/providers/NeonProvider.js'
import { SupabaseProvider } from '../lib/providers/SupabaseProvider.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import { createDatabaseProviderFromSettings } from './database-helpers.js'

vi.mock('../lib/providers/NeonProvider.js', () => {
	const NeonProvider = vi.fn(function (this: { projectId: string; parentBranch: string; isConfigured: () => boolean }, config: { projectId: string; parentBranch: string }) {
		this.projectId = config.projectId
		this.parentBranch = config.parentBranch
		this.isConfigured = () => !!(config.projectId && config.parentBranch)
	})
	return { NeonProvider }
})

vi.mock('../lib/providers/SupabaseProvider.js', () => {
	const SupabaseProvider = vi.fn(function (this: { projectRef: string; parentBranch: string; isConfigured: () => boolean }, config: { projectRef: string; parentBranch: string; withData?: boolean }) {
		this.projectRef = config.projectRef
		this.parentBranch = config.parentBranch
		this.isConfigured = () => !!(config.projectRef && config.parentBranch)
	})
	return { SupabaseProvider }
})

function makeSettings(overrides: Partial<IloomSettings> = {}): IloomSettings {
	return overrides as IloomSettings
}

describe('createDatabaseProviderFromSettings', () => {
	describe('when neon is configured', () => {
		it('returns a NeonProvider configured with the neon settings', () => {
			const settings = makeSettings({
				databaseProviders: { neon: { projectId: 'proj-123', parentBranch: 'main' } },
			})

			const provider = createDatabaseProviderFromSettings(settings)

			expect(NeonProvider).toHaveBeenCalledWith({ projectId: 'proj-123', parentBranch: 'main' })
			expect(provider.isConfigured()).toBe(true)
		})
	})

	describe('when supabase is configured', () => {
		it('returns a SupabaseProvider configured with the supabase settings', () => {
			const settings = makeSettings({
				databaseProviders: {
					supabase: { projectRef: 'ref-abc', parentBranch: 'main', withData: true },
				},
			})

			createDatabaseProviderFromSettings(settings)

			expect(SupabaseProvider).toHaveBeenCalledWith({
				projectRef: 'ref-abc',
				parentBranch: 'main',
				withData: true,
			})
		})

		it('omits withData when not specified in settings', () => {
			const settings = makeSettings({
				databaseProviders: {
					supabase: { projectRef: 'ref-abc', parentBranch: 'main' },
				},
			})

			createDatabaseProviderFromSettings(settings)

			expect(SupabaseProvider).toHaveBeenCalledWith({
				projectRef: 'ref-abc',
				parentBranch: 'main',
			})
		})
	})

	describe('when neither is configured', () => {
		it('returns an unconfigured NeonProvider when databaseProviders is undefined', () => {
			const settings = makeSettings({})

			const provider = createDatabaseProviderFromSettings(settings)

			expect(NeonProvider).toHaveBeenCalledWith({ projectId: '', parentBranch: '' })
			expect(provider.isConfigured()).toBe(false)
		})

		it('returns an unconfigured NeonProvider when databaseProviders is empty', () => {
			const settings = makeSettings({ databaseProviders: {} })

			const provider = createDatabaseProviderFromSettings(settings)

			expect(NeonProvider).toHaveBeenCalledWith({ projectId: '', parentBranch: '' })
			expect(provider.isConfigured()).toBe(false)
		})
	})

	describe('when both neon and supabase are configured', () => {
		it('throws an error with a clear message', () => {
			const settings = makeSettings({
				databaseProviders: {
					neon: { projectId: 'proj-123', parentBranch: 'main' },
					supabase: { projectRef: 'ref-abc', parentBranch: 'main', withData: true },
				},
			})

			expect(() => createDatabaseProviderFromSettings(settings)).toThrow(
				'Cannot configure both Neon and Supabase database providers simultaneously.',
			)
		})
	})
})
