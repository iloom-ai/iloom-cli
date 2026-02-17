// VCSProviderFactory - creates appropriate VersionControlProvider based on settings
// Follows pattern from IssueTrackerFactory

import type { VersionControlProvider } from './VersionControlProvider.js'
import { BitBucketVCSProvider } from './providers/bitbucket/index.js'
import type { IloomSettings } from './SettingsManager.js'
import { getLogger } from '../utils/logger-context.js'

export type VCSProviderType = 'github' | 'bitbucket'

/**
 * Factory for creating VersionControlProvider instances based on settings
 * 
 * Note: GitHub VCS operations still use PRManager with gh CLI for now.
 * This factory is primarily for BitBucket and future VCS providers.
 */
export class VCSProviderFactory {
	/**
	 * Create a VersionControlProvider instance based on settings configuration
	 * 
	 * @param settings - iloom settings containing versionControl.provider
	 * @returns VersionControlProvider instance configured for the specified provider
	 * @throws Error if provider type is not supported or required config is missing
	 */
	static create(settings: IloomSettings): VersionControlProvider | null {
		const provider = settings.versionControl?.provider

		// If no versionControl config, return null (use legacy PRManager for GitHub)
		if (!provider) {
			getLogger().debug('VCSProviderFactory: No versionControl.provider configured, using legacy PRManager')
			return null
		}

		getLogger().debug(`VCSProviderFactory: Creating VCS provider for "${provider}"`)

		switch (provider) {
			case 'github':
				// GitHub still uses PRManager with gh CLI
				getLogger().debug('VCSProviderFactory: GitHub uses legacy PRManager, returning null')
				return null
				
			case 'bitbucket': {
				getLogger().debug(`VCSProviderFactory: Creating BitBucketVCSProvider from settings`)
				return BitBucketVCSProvider.fromSettings(settings)
			}
			
			default:
				throw new Error(`Unsupported VCS provider: ${provider}`)
		}
	}

	/**
	 * Check if a VCS provider is configured
	 * 
	 * @param settings - iloom settings
	 * @returns true if versionControl provider is configured
	 */
	static isConfigured(settings: IloomSettings): boolean {
		return settings.versionControl?.provider !== undefined && settings.versionControl?.provider !== 'github'
	}

	/**
	 * Get the configured provider name from settings
	 * 
	 * @param settings - iloom settings
	 * @returns Provider type string or undefined if not configured
	 */
	static getProviderName(settings: IloomSettings): VCSProviderType | undefined {
		return settings.versionControl?.provider as VCSProviderType | undefined
	}
}
