import { NeonProvider } from '../lib/providers/NeonProvider.js'
import { SupabaseProvider } from '../lib/providers/SupabaseProvider.js'
import type { IloomSettings } from '../lib/SettingsManager.js'
import type { DatabaseProvider } from '../types/index.js'
export { createNeonProviderFromSettings } from './neon-helpers.js'

/**
 * Create the appropriate database provider from iloom settings.
 *
 * - Returns a NeonProvider when databaseProviders.neon is configured
 * - Returns a SupabaseProvider when databaseProviders.supabase is configured
 * - Throws if both neon and supabase are configured simultaneously
 * - Returns an unconfigured NeonProvider (isConfigured() = false) when neither is configured
 */
export function createDatabaseProviderFromSettings(settings: IloomSettings): DatabaseProvider {
	const neonConfig = settings.databaseProviders?.neon
	const supabaseConfig = settings.databaseProviders?.supabase

	if (neonConfig && supabaseConfig) {
		throw new Error(
			'Cannot configure both Neon and Supabase database providers simultaneously. ' +
				'Remove one from databaseProviders in .iloom/settings.json.',
		)
	}

	if (supabaseConfig) {
		return new SupabaseProvider({
			projectRef: supabaseConfig.projectRef,
			parentBranch: supabaseConfig.parentBranch,
			...(supabaseConfig.withData !== undefined && { withData: supabaseConfig.withData }),
		})
	}

	return new NeonProvider({
		projectId: neonConfig?.projectId ?? '',
		parentBranch: neonConfig?.parentBranch ?? '',
	})
}
