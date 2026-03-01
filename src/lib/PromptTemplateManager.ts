import { readFile } from 'fs/promises'
import { accessSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Handlebars from 'handlebars'
import { logger } from '../utils/logger.js'
import type { AgentSettings } from './SettingsManager.js'

// Register raw helper to handle content with curly braces (e.g., JSON)
// Usage: {{{{raw}}}}{{VARIABLE}}{{{{/raw}}}}
// This outputs the variable content as-is without Handlebars parsing its curly braces
Handlebars.registerHelper('raw', function (this: unknown, options: Handlebars.HelperOptions) {
	return options.fn(this)
})

export interface TemplateVariables {
	ISSUE_NUMBER?: string | number
	PR_NUMBER?: number
	ISSUE_TITLE?: string
	PR_TITLE?: string
	WORKSPACE_PATH?: string
	PORT?: number
	ONE_SHOT_MODE?: boolean
	INTERACTIVE_MODE?: boolean
	SETTINGS_SCHEMA?: string
	SETTINGS_GLOBAL_JSON?: string
	SETTINGS_JSON?: string
	SETTINGS_LOCAL_JSON?: string
	SHELL_TYPE?: string
	SHELL_CONFIG_PATH?: string
	SHELL_CONFIG_CONTENT?: string
	REMOTES_INFO?: string
	MULTIPLE_REMOTES?: string
	SINGLE_REMOTE?: string
	SINGLE_REMOTE_NAME?: string
	SINGLE_REMOTE_URL?: string
	NO_REMOTES?: string
	README_CONTENT?: string
	SETTINGS_SCHEMA_CONTENT?: string
	FIRST_TIME_USER?: boolean
	VSCODE_SETTINGS_GITIGNORED?: string
	// Session summary template variables
	SESSION_CONTEXT?: string  // Session ID for Claude to reference its conversation
	BRANCH_NAME?: string      // Branch being finished
	LOOM_TYPE?: string        // 'issue' or 'pr'
	COMPACT_SUMMARIES?: string  // Extracted compact summaries from session transcript
	RECAP_DATA?: string  // Formatted recap data (goal, complexity, entries, artifacts)
	// Draft PR mode variables - mutually exclusive with standard issue mode
	DRAFT_PR_NUMBER?: number  // PR number for draft PR workflow
	DRAFT_PR_URL?: string     // Full URL of the draft PR (e.g., https://github.com/owner/repo/pull/123)
	DRAFT_PR_MODE?: boolean   // True when using github-draft-pr merge mode
	AUTO_COMMIT_PUSH?: boolean  // True when auto-commit/push is enabled for draft PR mode
	STANDARD_ISSUE_MODE?: boolean  // True when using standard issue commenting (not draft PR)
	STANDARD_BRANCH_MODE?: boolean // True when using standard branch mode (not draft PR)
	// Direct prompt mode - agent enhances raw text without issue context or MCP tools
	DIRECT_PROMPT_MODE?: boolean
	// VS Code environment detection
	IS_VSCODE_MODE?: boolean  // True when ILOOM_VSCODE=1 environment variable is set
	// Multi-language support variables - mutually exclusive
	HAS_PACKAGE_JSON?: boolean  // True when project has package.json
	NO_PACKAGE_JSON?: boolean   // True when project does not have package.json (non-Node.js projects)
	// Review agent configuration variables (code reviewer)
	REVIEW_ENABLED?: boolean               // True if review is enabled (defaults to true)
	REVIEW_CLAUDE_MODEL?: string           // Claude model if configured (defaults to 'sonnet')
	REVIEW_GEMINI_MODEL?: string           // Gemini model if configured
	REVIEW_CODEX_MODEL?: string            // Codex model if configured
	HAS_REVIEW_CLAUDE?: boolean            // True if claude provider configured (defaults to true)
	HAS_REVIEW_GEMINI?: boolean            // True if gemini provider configured
	HAS_REVIEW_CODEX?: boolean             // True if codex provider configured
	// Artifact reviewer configuration variables
	ARTIFACT_REVIEW_ENABLED?: boolean               // True if artifact review is enabled (defaults to true)
	ARTIFACT_REVIEW_CLAUDE_MODEL?: string           // Claude model if configured (defaults to 'sonnet')
	ARTIFACT_REVIEW_GEMINI_MODEL?: string           // Gemini model if configured
	ARTIFACT_REVIEW_CODEX_MODEL?: string            // Codex model if configured
	HAS_ARTIFACT_REVIEW_CLAUDE?: boolean            // True if claude provider configured (defaults to true)
	HAS_ARTIFACT_REVIEW_GEMINI?: boolean            // True if gemini provider configured
	HAS_ARTIFACT_REVIEW_CODEX?: boolean             // True if codex provider configured
	// Per-agent review flags (whether artifacts should be reviewed before posting)
	ENHANCER_REVIEW_ENABLED?: boolean               // True if enhancer artifacts should be reviewed
	ANALYZER_REVIEW_ENABLED?: boolean               // True if analyzer artifacts should be reviewed
	PLANNER_REVIEW_ENABLED?: boolean                // True if planner artifacts should be reviewed
	ANALYZE_AND_PLAN_REVIEW_ENABLED?: boolean       // True if analyze-and-plan artifacts should be reviewed
	IMPLEMENTER_REVIEW_ENABLED?: boolean            // True if implementer artifacts should be reviewed
	COMPLEXITY_REVIEW_ENABLED?: boolean             // True if complexity evaluator artifacts should be reviewed
	COMPLEXITY_OVERRIDE?: 'trivial' | 'simple' | 'complex'  // Complexity override from CLI flag or loom metadata
	// Planning mode variables - mutually exclusive
	EXISTING_ISSUE_MODE?: boolean   // True when decomposing an existing issue (il plan 42)
	FRESH_PLANNING_MODE?: boolean   // True when starting fresh planning session (il plan "feature idea")
	// Issue context for decomposition mode
	PARENT_ISSUE_NUMBER?: string | undefined    // Issue number being decomposed
	PARENT_ISSUE_TITLE?: string | undefined     // Title of issue being decomposed
	PARENT_ISSUE_BODY?: string | undefined      // Body of issue being decomposed
	// Existing children and dependencies context for decomposition mode
	PARENT_ISSUE_CHILDREN?: string | undefined  // Formatted list of existing child issues (if any)
	PARENT_ISSUE_DEPENDENCIES?: string | undefined  // Formatted list of existing dependencies (if any)
	// Multi-AI provider support for plan command
	PLANNER?: 'claude' | 'gemini' | 'codex'
	REVIEWER?: 'claude' | 'gemini' | 'codex' | 'none'
	USE_CLAUDE_PLANNER?: boolean
	USE_GEMINI_PLANNER?: boolean
	USE_CODEX_PLANNER?: boolean
	USE_CLAUDE_REVIEWER?: boolean
	USE_GEMINI_REVIEWER?: boolean
	USE_CODEX_REVIEWER?: boolean
	HAS_REVIEWER?: boolean
	// Git remote configuration
	GIT_REMOTE?: string  // Remote name for push (defaults to 'origin')
	// Swarm orchestrator variables
	EPIC_ISSUE_NUMBER?: string | number
	EPIC_WORKTREE_PATH?: string
	EPIC_METADATA_PATH?: string  // Path to the epic's metadata JSON file
	CHILD_ISSUES?: string  // JSON stringified array of child issues with worktree paths
	DEPENDENCY_MAP?: string  // JSON stringified dependency map
	SWARM_MODE?: boolean  // True when rendering agents in swarm mode
	AUTO_SWARM_MODE?: boolean  // True when plan command launched with --auto-swarm flag
	SWARM_AGENT_METADATA?: string  // JSON string mapping agent names to { model, tools } for claude -p commands
	SWARM_SUB_AGENT_TIMEOUT_MS?: number  // Timeout in milliseconds for sub-agent claude -p Bash tool calls (default: 600000 = 10 minutes)
	NO_CLEANUP?: boolean  // True when child loom cleanup should be skipped (e.g., manual cleanup later)
	POST_SWARM_REVIEW?: boolean  // True when post-swarm code review is enabled (defaults to true)
	ISSUE_PREFIX?: string  // "#" for GitHub, "" for Linear/Jira — used in commit message templates
}

/**
 * Build review-related template variables from settings.
 * Used by both the ignite command (for prompt templates) and AgentManager (for agent prompts).
 */
export function buildReviewTemplateVariables(agents?: Record<string, AgentSettings> | null): Partial<TemplateVariables> {
	const variables: Partial<TemplateVariables> = {}

	// Code reviewer configuration
	const reviewerSettings = agents?.['iloom-code-reviewer']
	const reviewEnabled = reviewerSettings?.enabled !== false // Default to true
	variables.REVIEW_ENABLED = reviewEnabled

	if (reviewEnabled) {
		const providers = reviewerSettings?.providers ?? {}
		const hasAnyProvider = Object.keys(providers).length > 0

		const claudeModel = providers.claude ?? (hasAnyProvider ? undefined : 'sonnet')
		if (claudeModel) {
			variables.REVIEW_CLAUDE_MODEL = claudeModel
		}
		if (providers.gemini) {
			variables.REVIEW_GEMINI_MODEL = providers.gemini
		}
		if (providers.codex) {
			variables.REVIEW_CODEX_MODEL = providers.codex
		}
		variables.HAS_REVIEW_CLAUDE = !!claudeModel
		variables.HAS_REVIEW_GEMINI = !!providers.gemini
		variables.HAS_REVIEW_CODEX = !!providers.codex
	}

	// Artifact reviewer configuration
	const artifactReviewerSettings = agents?.['iloom-artifact-reviewer']
	const artifactReviewEnabled = artifactReviewerSettings?.enabled !== false // Default to true
	variables.ARTIFACT_REVIEW_ENABLED = artifactReviewEnabled

	if (artifactReviewEnabled) {
		const artifactProviders = artifactReviewerSettings?.providers ?? {}
		const hasAnyArtifactProvider = Object.keys(artifactProviders).length > 0

		const artifactClaudeModel = artifactProviders.claude ?? (hasAnyArtifactProvider ? undefined : 'sonnet')
		if (artifactClaudeModel) {
			variables.ARTIFACT_REVIEW_CLAUDE_MODEL = artifactClaudeModel
		}
		if (artifactProviders.gemini) {
			variables.ARTIFACT_REVIEW_GEMINI_MODEL = artifactProviders.gemini
		}
		if (artifactProviders.codex) {
			variables.ARTIFACT_REVIEW_CODEX_MODEL = artifactProviders.codex
		}
		variables.HAS_ARTIFACT_REVIEW_CLAUDE = !!artifactClaudeModel
		variables.HAS_ARTIFACT_REVIEW_GEMINI = !!artifactProviders.gemini
		variables.HAS_ARTIFACT_REVIEW_CODEX = !!artifactProviders.codex
	}

	// Per-agent review flags (defaults to false for each)
	variables.ENHANCER_REVIEW_ENABLED = agents?.['iloom-issue-enhancer']?.review === true
	variables.ANALYZER_REVIEW_ENABLED = agents?.['iloom-issue-analyzer']?.review === true
	variables.PLANNER_REVIEW_ENABLED = agents?.['iloom-issue-planner']?.review === true
	variables.ANALYZE_AND_PLAN_REVIEW_ENABLED = agents?.['iloom-issue-analyze-and-plan']?.review === true
	variables.IMPLEMENTER_REVIEW_ENABLED = agents?.['iloom-issue-implementer']?.review === true
	variables.COMPLEXITY_REVIEW_ENABLED = agents?.['iloom-issue-complexity-evaluator']?.review === true

	return variables
}

export class PromptTemplateManager {
	private templateDir: string

	constructor(templateDir?: string) {
		if (templateDir) {
			this.templateDir = templateDir
		} else {
			// Find templates relative to the package installation
			// When running from dist/, templates are copied to dist/prompts/
			const currentFileUrl = import.meta.url
			const currentFilePath = fileURLToPath(currentFileUrl)
			const distDir = path.dirname(currentFilePath) // dist directory (may be chunked file location)

			// Walk up to find the dist directory (in case of chunked files)
			let templateDir = path.join(distDir, 'prompts')
			let currentDir = distDir

			// Try to find the prompts directory by walking up
			while (currentDir !== path.dirname(currentDir)) {
				const candidatePath = path.join(currentDir, 'prompts')
				try {
					// Check if this directory exists (sync check for constructor)
					accessSync(candidatePath)
					templateDir = candidatePath
					break
				} catch {
					currentDir = path.dirname(currentDir)
				}
			}

			this.templateDir = templateDir
			logger.debug('PromptTemplateManager initialized', {
				currentFilePath,
				distDir,
				templateDir: this.templateDir
			})
		}
	}

	/**
	 * Load a template file by name
	 */
	async loadTemplate(templateName: 'issue' | 'pr' | 'regular' | 'init' | 'session-summary' | 'plan' | 'swarm-orchestrator'): Promise<string> {
		const templatePath = path.join(this.templateDir, `${templateName}-prompt.txt`)

		logger.debug('Loading template', {
			templateName,
			templateDir: this.templateDir,
			templatePath
		})

		try {
			return await readFile(templatePath, 'utf-8')
		} catch (error) {
			logger.error('Failed to load template', { templateName, templatePath, error })
			throw new Error(`Template not found: ${templatePath}`)
		}
	}

	/**
	 * Substitute variables in a template string using Handlebars
	 */
	substituteVariables(template: string, variables: TemplateVariables): string {
		const compiled = Handlebars.compile(template, { noEscape: true })
		return compiled(variables)
	}

	/**
	 * Get a fully processed prompt for a workflow type
	 */
	async getPrompt(
		type: 'issue' | 'pr' | 'regular' | 'init' | 'session-summary' | 'plan' | 'swarm-orchestrator',
		variables: TemplateVariables
	): Promise<string> {
		const template = await this.loadTemplate(type)
		return this.substituteVariables(template, variables)
	}
}
