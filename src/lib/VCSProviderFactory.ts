import type { IloomSettings } from './SettingsManager.js'
import type { VersionControlProvider } from './VersionControlProvider.js'

/**
 * VCSProviderFactory
 *
 * Creates the appropriate VCS provider for PR operations based on settings.
 *
 * Returns null for GitHub — GitHub uses the legacy PRManager path.
 * Returns a VersionControlProvider for other providers (e.g., BitBucket from PR #609).
 *
 * This factory is the routing hub for the unified `pr` and `draft-pr` modes:
 *   - null  → GitHub legacy path (PRManager.createOrOpenPR)
 *   - non-null → VCS provider path (VersionControlProvider.createPR)
 */
export class VCSProviderFactory {
	/**
	 * Create a VCS provider for the given settings.
	 *
	 * Returns null for GitHub (legacy PRManager path).
	 * Returns a VersionControlProvider for other configured providers.
	 *
	 * @param settings - Loaded iloom settings
	 * @returns A VersionControlProvider instance, or null for the GitHub/legacy path
	 */
	static create(_settings: IloomSettings): VersionControlProvider | null {
		// GitHub uses the legacy PRManager path — return null
		// Additional providers (e.g., BitBucket) will be added here when PR #609 lands
		return null
	}
}
