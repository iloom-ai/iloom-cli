// Branch name generation types - provider-agnostic

/**
 * Strategy interface for generating branch names from issue information
 */
export interface BranchNameStrategy {
	generate(issueNumber: number, title: string): Promise<string>
}

/**
 * Options for branch name generation
 * Supports both simple generation and custom strategy override
 */
export interface BranchGenerationOptions {
	issueNumber: number
	title: string
	strategy?: BranchNameStrategy // Optional override
}
