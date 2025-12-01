import type { BranchNameStrategy, BranchGenerationOptions } from '../types/branch-naming.js'
import { logger } from '../utils/logger.js'

// ============================================
// Strategy Classes
// ============================================

/**
 * Simple branch naming strategy
 * Format: feat/issue-{number}-{slug}
 */
export class SimpleBranchNameStrategy implements BranchNameStrategy {
	async generate(issueNumber: number, title: string): Promise<string> {
		// Create a simple slug from the title
		const slug = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.substring(0, 20) // Keep it short for the simple strategy

		return `feat/issue-${issueNumber}-${slug}`
	}
}

/**
 * Claude AI-powered branch naming strategy
 * Uses Claude CLI to generate semantic branch names
 */
export class ClaudeBranchNameStrategy implements BranchNameStrategy {
	constructor(private claudeModel = 'haiku') {}

	async generate(issueNumber: number, title: string): Promise<string> {
		// Dynamic import to allow mocking in tests
		const { generateBranchName } = await import('../utils/claude.js')
		return generateBranchName(title, issueNumber, this.claudeModel)
	}
}

// ============================================
// Service Interface and Implementation
// ============================================

/**
 * Service interface for branch name generation
 * Provides strategy management and generation capabilities
 */
export interface BranchNamingService {
	generateBranchName(options: BranchGenerationOptions): Promise<string>
	setDefaultStrategy(strategy: BranchNameStrategy): void
	getDefaultStrategy(): BranchNameStrategy
}

/**
 * Default implementation of BranchNamingService
 * Supports multiple naming strategies with configurable defaults
 */
export class DefaultBranchNamingService implements BranchNamingService {
	private defaultStrategy: BranchNameStrategy

	constructor(options?: {
		strategy?: BranchNameStrategy
		useClaude?: boolean
		claudeModel?: string
	}) {
		// Set up default strategy based on options
		if (options?.strategy) {
			this.defaultStrategy = options.strategy
		} else if (options?.useClaude !== false) {
			this.defaultStrategy = new ClaudeBranchNameStrategy(options?.claudeModel)
		} else {
			this.defaultStrategy = new SimpleBranchNameStrategy()
		}
	}

	async generateBranchName(options: BranchGenerationOptions): Promise<string> {
		const { issueNumber, title, strategy } = options

		// Use provided strategy or fall back to default
		const nameStrategy = strategy ?? this.defaultStrategy

		logger.debug('Generating branch name', {
			issueNumber,
			title,
			strategy: nameStrategy.constructor.name,
		})

		return nameStrategy.generate(issueNumber, title)
	}

	setDefaultStrategy(strategy: BranchNameStrategy): void {
		this.defaultStrategy = strategy
	}

	getDefaultStrategy(): BranchNameStrategy {
		return this.defaultStrategy
	}
}
