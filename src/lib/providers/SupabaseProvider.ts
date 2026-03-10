import type { DatabaseDeletionResult, DatabaseProvider } from '../../types/index.js'
import { getLogger } from '../../utils/logger-context.js'

export interface SupabaseConfig {
	projectRef: string
	parentBranch: string
	withData?: boolean
}

/**
 * Supabase database provider implementation
 * Provides database branching via the Supabase CLI
 *
 * NOTE: This is a placeholder. Full implementation tracked separately.
 */
export class SupabaseProvider implements DatabaseProvider {
	readonly displayName = 'Supabase CLI'
	readonly installHint = 'brew install supabase/tap/supabase'

	constructor(config: SupabaseConfig) {
		getLogger().debug('SupabaseProvider initialized with config:', {
			projectRef: config.projectRef,
			parentBranch: config.parentBranch,
			hasProjectRef: !!config.projectRef,
			hasParentBranch: !!config.parentBranch,
		})
	}

	isConfigured(): boolean {
		// Returns false until the full implementation is available
		return false
	}

	sanitizeBranchName(branchName: string): string {
		return branchName.replace(/[^a-zA-Z0-9-]/g, '-')
	}

	async isCliAvailable(): Promise<boolean> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async isAuthenticated(_cwd?: string): Promise<boolean> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async listBranches(_cwd?: string): Promise<string[]> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async branchExists(_name: string, _cwd?: string): Promise<boolean> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async getConnectionString(_branch: string, _cwd?: string): Promise<string> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async createBranch(_name: string, _fromBranch?: string, _cwd?: string): Promise<string> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async deleteBranch(_name: string, _isPreview?: boolean, _cwd?: string): Promise<DatabaseDeletionResult> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async findPreviewBranch(_branchName: string, _cwd?: string): Promise<string | null> {
		throw new Error('SupabaseProvider: not yet implemented')
	}

	async getBranchNameFromEndpoint(_endpointId: string, _cwd?: string): Promise<string | null> {
		throw new Error('SupabaseProvider: not yet implemented')
	}
}
