import type { BranchNameStrategy, BranchGenerationOptions } from '../types/branch-naming.js'
import { getLogger } from '../utils/logger-context.js'

// ============================================
// Shared Utilities
// ============================================

/**
 * Create a URL-safe slug from a title string
 */
export function slugify(title: string, maxLength = 20): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.substring(0, maxLength)
}

// ============================================
// Strategy Classes
// ============================================

/**
 * Simple branch naming strategy
 * Format: feat/issue-{number}__{slug}
 */
export class SimpleBranchNameStrategy implements BranchNameStrategy {
	async generate(issueNumber: string | number, title: string): Promise<string> {
		const slug = slugify(title)
		return `feat/issue-${issueNumber}__${slug}`
	}
}

/**
 * Claude Code-powered branch naming strategy
 * Uses Claude CLI to generate semantic branch names
 */
export class ClaudeBranchNameStrategy implements BranchNameStrategy {
	constructor(private claudeModel = 'haiku') {}

	async generate(issueNumber: string | number, title: string): Promise<string> {
		// Dynamic import to allow mocking in tests
		const { generateBranchName } = await import('../utils/claude.js')
		return generateBranchName(title, issueNumber, this.claudeModel)
	}
}

/**
 * Template-based branch naming strategy
 * Uses a user-defined template with variable substitution
 *
 * Supported variables:
 *   {ticketId}  - Full issue identifier (e.g., "PRINT-1234")
 *   {slug}      - Slugified title (lowercase, hyphens, max 40 chars)
 *
 * Example: "{ticketId}-{slug}" → "PRINT-1234-fix-deps-bug"
 */
export class TemplateBranchNameStrategy implements BranchNameStrategy {
	constructor(private template: string) {}

	async generate(issueNumber: string | number, title: string): Promise<string> {
		const slug = slugify(title, 40)
		const ticketId = String(issueNumber)

		const branchName = this.template
			.replace(/\{ticketId\}/g, ticketId)
			.replace(/\{slug\}/g, slug)

		// Normalize: lowercase, remove trailing hyphens
		return branchName.toLowerCase().replace(/-+$/g, '')
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
		const { issueNumber, title, strategy, branchFormat } = options

		// Priority: explicit strategy > branchFormat template > default strategy
		let nameStrategy: BranchNameStrategy
		if (strategy) {
			nameStrategy = strategy
		} else if (branchFormat) {
			nameStrategy = new TemplateBranchNameStrategy(branchFormat)
		} else {
			nameStrategy = this.defaultStrategy
		}

		getLogger().debug('Generating branch name', {
			issueNumber,
			title,
			strategy: nameStrategy.constructor.name,
			branchFormat,
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
