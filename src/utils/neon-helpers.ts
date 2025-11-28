import { NeonProvider } from '../lib/providers/NeonProvider.js'
import type { IloomSettings } from '../lib/SettingsManager.js'

/**
 * Create NeonProvider from settings configuration
 * Returns provider with isConfigured() = false if neon settings missing
 */
export function createNeonProviderFromSettings(settings: IloomSettings): NeonProvider {
	const neonConfig = settings.databaseProviders?.neon

	return new NeonProvider({
		projectId: neonConfig?.projectId ?? '',
		parentBranch: neonConfig?.parentBranch ?? '',
	})
}
