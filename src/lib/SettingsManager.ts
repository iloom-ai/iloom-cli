import { readFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import deepmerge from 'deepmerge'
import { logger } from '../utils/logger.js'

/**
 * Zod schema for base agent settings (without nested agents)
 */
export const BaseAgentSettingsSchema = z.object({
	model: z
		.enum(['sonnet', 'opus', 'haiku'])
		.optional()
		.describe('Claude model shorthand: sonnet, opus, or haiku'),
	swarmModel: z
		.enum(['sonnet', 'opus', 'haiku'])
		.optional()
		.describe('Model to use for this agent in swarm mode. Overrides the base model when running inside swarm workers.'),
	enabled: z
		.boolean()
		.optional()
		.describe('Whether this agent is enabled. Defaults to true.'),
	providers: z
		.record(
			z.enum(['claude', 'gemini', 'codex']),
			z.string()
		)
		.optional()
		.describe('Map of review providers to model names. Keys: claude, gemini, codex. Values: model name strings (e.g., "sonnet", "gemini-3-pro-preview", "gpt-5.2-codex")'),
	review: z
		.boolean()
		.optional()
		.describe('Whether artifacts from this agent should be reviewed before posting (defaults to false)'),
})

/**
 * Zod schema for agent settings, extends base with sub-agent timeout and nested agents record.
 */
export const AgentSettingsSchema = BaseAgentSettingsSchema.extend({
	agents: z.record(z.string(), BaseAgentSettingsSchema)
		.optional()
		.describe('Nested per-agent settings. Only meaningful under the iloom-swarm-worker agent entry for sub-agent timeout configuration.'),
	subAgentTimeout: z
		.number()
		.min(1, 'Sub-agent timeout must be at least 1 minute')
		.max(120, 'Sub-agent timeout cannot exceed 120 minutes')
		.optional()
		.describe('Timeout in minutes for sub-agent claude -p invocations in swarm mode. Applies to each phase agent (evaluator, analyzer, planner, implementer) when invoked via the Bash tool. Default: 20 minutes. Only meaningful under the iloom-swarm-worker agent entry.'),
})

/**
 * Zod schema for spin agent settings with default model
 * Used for the spin orchestrator configuration
 */
export const SpinAgentSettingsSchema = z.object({
	model: z
		.enum(['sonnet', 'opus', 'haiku'])
		.default('opus')
		.describe('Claude model shorthand for spin orchestrator'),
	swarmModel: z
		.enum(['sonnet', 'opus', 'haiku'])
		.optional()
		.describe('Model for the spin orchestrator when running in swarm mode. Overrides spin.model for swarm workflows.'),
})

/**
 * Zod schema for plan command settings with default model
 * Used for the plan command configuration
 */
export const PlanCommandSettingsSchema = z.object({
	model: z
		.enum(['sonnet', 'opus', 'haiku'])
		.default('opus')
		.describe('Claude model shorthand for plan command'),
	planner: z
		.enum(['claude', 'gemini', 'codex'])
		.default('claude')
		.describe('AI provider for creating the plan'),
	reviewer: z
		.enum(['claude', 'gemini', 'codex', 'none'])
		.default('none')
		.describe('AI provider for reviewing the plan (none to skip review)'),
})

/**
 * Zod schema for summary settings with default model
 * Used for session summary generation configuration
 */
export const SummarySettingsSchema = z.object({
	model: z
		.enum(['sonnet', 'opus', 'haiku'])
		.default('sonnet')
		.describe('Claude model shorthand for session summary generation'),
})

/**
 * Zod schema for workflow permission configuration
 */
export const WorkflowPermissionSchema = z.object({
	permissionMode: z
		.enum(['plan', 'acceptEdits', 'bypassPermissions', 'default'])
		.optional()
		.describe('Permission mode for Claude CLI in this workflow type'),
	noVerify: z
		.boolean()
		.optional()
		.describe('Skip pre-commit hooks (--no-verify) when committing during commit and finish workflows'),
	startIde: z
		.boolean()
		.default(true)
		.describe('Launch IDE (code) when starting this workflow type'),
	startDevServer: z
		.boolean()
		.default(true)
		.describe('Launch development server when starting this workflow type'),
	startAiAgent: z
		.boolean()
		.default(true)
		.describe('Launch Claude Code agent when starting this workflow type'),
	startTerminal: z
		.boolean()
		.default(false)
		.describe('Launch terminal window without dev server when starting this workflow type'),
	generateSummary: z
		.boolean()
		.default(true)
		.describe('Generate and post Claude session summary when finishing this workflow type'),
})

/**
 * Non-defaulting variant for pre-merge validation
 * This prevents Zod from polluting partial settings with default values before merge
 */
export const WorkflowPermissionSchemaNoDefaults = z.object({
	permissionMode: z
		.enum(['plan', 'acceptEdits', 'bypassPermissions', 'default'])
		.optional()
		.describe('Permission mode for Claude CLI in this workflow type'),
	noVerify: z
		.boolean()
		.optional()
		.describe('Skip pre-commit hooks (--no-verify) when committing during commit and finish workflows'),
	startIde: z
		.boolean()
		.optional()
		.describe('Launch IDE (code) when starting this workflow type'),
	startDevServer: z
		.boolean()
		.optional()
		.describe('Launch development server when starting this workflow type'),
	startAiAgent: z
		.boolean()
		.optional()
		.describe('Launch Claude Code agent when starting this workflow type'),
	startTerminal: z
		.boolean()
		.optional()
		.describe('Launch terminal window without dev server when starting this workflow type'),
	generateSummary: z
		.boolean()
		.optional()
		.describe('Generate and post Claude session summary when finishing this workflow type'),
})

/**
 * Zod schema for workflows settings
 */
export const WorkflowsSettingsSchema = z
	.object({
		issue: WorkflowPermissionSchema.optional(),
		pr: WorkflowPermissionSchema.optional(),
		regular: WorkflowPermissionSchema.optional(),
	})
	.optional()

/**
 * Non-defaulting variant for pre-merge validation
 */
export const WorkflowsSettingsSchemaNoDefaults = z
	.object({
		issue: WorkflowPermissionSchemaNoDefaults.optional(),
		pr: WorkflowPermissionSchemaNoDefaults.optional(),
		regular: WorkflowPermissionSchemaNoDefaults.optional(),
	})
	.optional()

/**
 * Zod schema for capabilities settings
 */
export const CapabilitiesSettingsSchema = z
	.object({
		web: z
			.object({
				basePort: z
					.number()
					.min(1, 'Base port must be >= 1')
					.max(65535, 'Base port must be <= 65535')
					.optional()
					.describe('Base port for web workspace port calculations (default: 3000)'),
			})
			.optional()
			.describe('Web dev server settings. To declare a project as a web project, add "web" to the capabilities array in .iloom/package.iloom.json or .iloom/package.iloom.local.json.'),
		database: z
			.object({
				databaseUrlEnvVarName: z
					.string()
					.min(1, 'Database URL variable name cannot be empty')
					.regex(/^[A-Z_][A-Z0-9_]*$/, 'Must be valid env var name (uppercase, underscores)')
					.optional()
					.default('DATABASE_URL')
					.describe('Name of environment variable for database connection URL'),
			})
			.optional(),
	})
	.optional()

/**
 * Non-defaulting variant for pre-merge validation
 */
export const CapabilitiesSettingsSchemaNoDefaults = z
	.object({
		web: z
			.object({
				basePort: z
					.number()
					.min(1, 'Base port must be >= 1')
					.max(65535, 'Base port must be <= 65535')
					.optional()
					.describe('Base port for web workspace port calculations (default: 3000)'),
			})
			.optional()
			.describe('Web dev server settings. To declare a project as a web project, add "web" to the capabilities array in .iloom/package.iloom.json or .iloom/package.iloom.local.json.'),
		database: z
			.object({
				databaseUrlEnvVarName: z
					.string()
					.min(1, 'Database URL variable name cannot be empty')
					.regex(/^[A-Z_][A-Z0-9_]*$/, 'Must be valid env var name (uppercase, underscores)')
					.optional()
					.describe('Name of environment variable for database connection URL'),
			})
			.optional(),
	})
	.optional()

/**
 * Zod schema for Neon database provider settings
 */
export const NeonSettingsSchema = z.object({
	projectId: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9-]+$/, 'Neon project ID must contain only letters, numbers, and hyphens')
		.describe('Neon project ID found in your project URL (e.g., "fantastic-fox-3566354")'),
	parentBranch: z
		.string()
		.min(1)
		.describe('Branch from which new database branches are created'),
})

/**
 * Zod schema for database provider settings
 */
export const DatabaseProvidersSettingsSchema = z
	.object({
		neon: NeonSettingsSchema.optional().describe(
			'Neon database configuration. Requires Neon CLI installed and authenticated for database branching.',
		),
	})
	.optional()

/**
 * Zod schema for iloom settings
 */
export const IloomSettingsSchema = z.object({
	mainBranch: z
		.string()
		.min(1, "Settings 'mainBranch' cannot be empty")
		.optional()
		.describe('Name of the main/primary branch for the repository'),
	sourceEnvOnStart: z
		.boolean()
		.default(false)
		.describe(
			'Source all dotenv-flow files (.env, .env.local, .env.development, .env.development.local) when launching terminal processes (Claude, dev server, terminal). ' +
				'Files are sourced in precedence order so later files override earlier ones. ' +
				'NOTE TO AI AGENTS: Before making changes to settings files, YOU MUST OFFER to check .env file compatibility. ' +
				'WARNING: Unquoted values in .env files may break sourcing in bash/zsh shells. ' +
				'Before enabling, verify ALL your .env.* files do not contain unquoted special characters ' +
				'(e.g., database URLs with ?, &, or other shell metacharacters). ' +
				'Shell compatibility issues may cause processes to fail or behave unexpectedly.',
		),
	worktreePrefix: z
		.string()
		.optional()
		.refine(
			(val) => {
				if (val === undefined) return true // undefined = use default calculation
				if (val === '') return true // empty string = no prefix mode

				// Allowlist: only alphanumeric, hyphens, underscores, and forward slashes
				const allowedChars = /^[a-zA-Z0-9\-_/]+$/
				if (!allowedChars.test(val)) return false

				// Reject if only special characters (no alphanumeric content)
				if (/^[-_/]+$/.test(val)) return false

				// Check each segment (split by /) contains at least one alphanumeric character
				const segments = val.split('/')
				for (const segment of segments) {
					if (segment && /^[-_]+$/.test(segment)) {
						// Segment exists but contains only hyphens/underscores
						return false
					}
				}

				return true
			},
			{
				message:
					"worktreePrefix contains invalid characters. Only alphanumeric characters, hyphens (-), underscores (_), and forward slashes (/) are allowed. Use forward slashes for nested directories.",
			},
		)
		.describe(
			'Prefix for worktree directories. Empty string disables prefix. Defaults to <repo-name>-looms if not set.',
		),
	protectedBranches: z
		.array(z.string().min(1, 'Protected branch name cannot be empty'))
		.optional()
		.describe('List of branches that cannot be deleted (defaults to [mainBranch, "main", "master", "develop"])'),
	copyGitIgnoredPatterns: z
		.array(z.string().min(1, 'Pattern cannot be empty'))
		.optional()
		.describe('Glob patterns for gitignored files to copy to looms (e.g., ["*.db", "data/*.sqlite"]). Great for local dbs and large test data files that are too big to commit to git. Note: .env (dotenv-flow) files, iloom\'s and claude\'s local settings are automatically copied and do not need to be specified here.'),
	workflows: WorkflowsSettingsSchema.describe('Per-workflow-type permission configurations'),
	agents: z
		.record(z.string(), AgentSettingsSchema)
		.optional()
		.nullable()
		.describe(
			'Per-agent configuration overrides. Available agents: ' +
				'iloom-issue-analyzer (analyzes issues), ' +
				'iloom-issue-planner (creates implementation plans), ' +
				'iloom-issue-analyze-and-plan (combined analysis and planning), ' +
				'iloom-issue-complexity-evaluator (evaluates complexity), ' +
				'iloom-issue-enhancer (enhances issue descriptions), ' +
				'iloom-issue-implementer (implements code changes), ' +
				'iloom-code-reviewer (reviews code changes against requirements), ' +
				'iloom-artifact-reviewer (reviews artifacts before posting), ' +
				'iloom-swarm-worker (swarm worker agent, dynamically generated). ' +
				'Use swarmModel on any agent to override its model in swarm mode.',
		),
	spin: SpinAgentSettingsSchema.optional().describe(
		'Spin orchestrator configuration. Model defaults to opus when not configured.',
	),
	plan: PlanCommandSettingsSchema.optional().describe(
		'Plan command configuration. Model defaults to opus, planner to claude, reviewer to none when not configured.',
	),
	summary: SummarySettingsSchema.optional().describe(
		'Session summary generation configuration. Model defaults to sonnet when not configured.',
	),
	capabilities: CapabilitiesSettingsSchema.describe('Project capability configurations'),
	databaseProviders: DatabaseProvidersSettingsSchema.describe('Database provider configurations'),
	issueManagement: z
		.object({
			// SYNC: If this default changes, update displayDefaultsBox() in src/utils/first-run-setup.ts
			provider: z.enum(['github', 'linear', 'jira']).optional().default('github').describe('Issue tracker provider (github, linear, jira)'),
			github: z
				.object({
					remote: z
						.string()
						.min(1, 'Remote name cannot be empty')
						.describe('Git remote name to use for GitHub operations'),
				})
				.optional(),
			linear: z
				.object({
					teamId: z
						.string()
						.min(1, 'Team ID cannot be empty')
						.describe('Linear team identifier (e.g., "ENG", "PLAT")'),
					branchFormat: z
						.string()
						.optional()
						.describe('Branch naming template for Linear issues'),
					apiToken: z
						.string()
						.optional()
						.describe('Linear API token (lin_api_...). SECURITY: Store in settings.local.json only, never commit to source control.'),
				})
				.optional(),
			jira: z
				.object({
					host: z
						.string()
						.min(1, 'Jira host cannot be empty')
						.describe('Jira instance URL (e.g., "https://yourcompany.atlassian.net")'),
					username: z
						.string()
						.min(1, 'Jira username/email cannot be empty')
						.describe('Jira username or email address'),
					apiToken: z
						.string()
						.optional()
						.describe('Jira API token. SECURITY: Store in settings.local.json only, never commit to source control. Generate at: https://id.atlassian.com/manage-profile/security/api-tokens'),
					projectKey: z
						.string()
						.min(1, 'Project key cannot be empty')
						.describe('Jira project key (e.g., "PROJ", "ENG")'),
					boardId: z
						.string()
						.optional()
						.describe('Jira board ID for sprint/workflow operations (optional)'),
					transitionMappings: z
						.record(z.string(), z.string())
						.optional()
						.describe('Map iloom states to Jira transition names (e.g., {"In Review": "Start Review"})'),
					defaultIssueType: z
						.string()
						.min(1)
						.optional()
						.default('Task')
						.describe('Default Jira issue type name for creating issues (e.g., "Task", "Story", "Bug")'),
					defaultSubtaskType: z
						.string()
						.min(1)
						.optional()
						.default('Subtask')
						.describe('Default Jira issue type name for creating subtasks/child issues (e.g., "Subtask", "Sub-task")'),
					doneStatuses: z
						.array(z.string())
						.optional()
						.default(['Done'])
						.describe('Status names to exclude from issue lists (e.g., ["Done", "Closed", "Verify"])'),
				})
				.optional(),
		})
		.optional()
		.describe('Issue management configuration'),
	mergeBehavior: z
		.object({
			// SYNC: If this default changes, update displayDefaultsBox() in src/utils/first-run-setup.ts
			mode: z.enum(['local', 'github-pr', 'github-draft-pr']).default('local'),
			remote: z.string().optional(),
			autoCommitPush: z
				.boolean()
				.optional()
				.describe(
					'Auto-commit and push after code review in draft PR mode. Defaults to true when mode is github-draft-pr.'
				),
			openBrowserOnFinish: z
				.boolean()
				.default(true)
				.describe(
					'Open the PR in the default browser after finishing in github-pr or github-draft-pr mode. Use --no-browser flag to override.'
				),
		})
		.optional()
		.describe('Merge behavior configuration: local (merge locally), github-pr (create PR), or github-draft-pr (create draft PR at start, mark ready on finish)'),
	ide: z
		.object({
			// SYNC: If this default changes, update displayDefaultsBox() in src/utils/first-run-setup.ts
			type: z
				.enum(['vscode', 'cursor', 'webstorm', 'sublime', 'intellij', 'windsurf', 'antigravity'])
				.default('vscode')
				.describe(
					'IDE to launch when starting a loom. Options: vscode (Visual Studio Code), cursor (Cursor AI editor), ' +
						'webstorm (JetBrains WebStorm), sublime (Sublime Text), intellij (JetBrains IntelliJ IDEA), ' +
						'windsurf (Windsurf editor), antigravity (Antigravity IDE).'
				),
		})
		.optional()
		.describe(
			'IDE configuration for workspace launches. Controls which editor opens when you start a loom. ' +
				'Supports VSCode, Cursor, WebStorm, Sublime Text, IntelliJ, Windsurf, and Antigravity. ' +
				'Note: Color synchronization (title bar colors) only works with VSCode-compatible editors (vscode, cursor, windsurf, antigravity).'
		),
	colors: z
		.object({
			terminal: z
				.boolean()
				.default(true)
				.describe('Apply terminal background colors based on branch name (macOS only)'),
			vscode: z
				.boolean()
				.default(false)
				.describe(
					'Apply VSCode/Cursor title bar colors based on branch name. ' +
						'Note: This modifies .vscode/settings.json which may be in source control. ' +
						'Default is false for safety; enable via init or explicitly if .vscode is gitignored.'
				),
		})
		.optional()
		.describe('Color synchronization settings for workspace identification'),
	attribution: z
		.enum(['off', 'upstreamOnly', 'on'])
		.default('upstreamOnly')
		.describe(
			'Controls when iloom attribution appears in session summaries. ' +
				'"off" - never show attribution. ' +
				'"upstreamOnly" - only show for contributions to external repositories (e.g., open source). ' +
				'"on" - always show attribution.'
		),
	git: z
		.object({
			commitTimeout: z
				.number()
				.min(1000, 'Commit timeout must be at least 1000ms')
				.max(600000, 'Commit timeout cannot exceed 600000ms (10 minutes)')
				.default(60000)
				.describe('Timeout in milliseconds for git commit operations. Increase for long-running pre-commit hooks.'),
		})
		.default({ }) // ensures the object always exists and uses default for the inner properties
		.describe('Git operation settings'),
})

/**
 * Non-defaulting variant for pre-merge validation
 * This prevents Zod from polluting partial settings with default values before merge
 */
export const IloomSettingsSchemaNoDefaults = z.object({
	mainBranch: z
		.string()
		.min(1, "Settings 'mainBranch' cannot be empty")
		.optional()
		.describe('Name of the main/primary branch for the repository'),
	sourceEnvOnStart: z
		.boolean()
		.optional()
		.describe(
			'Source all dotenv-flow files (.env, .env.local, .env.development, .env.development.local) when launching terminal processes (Claude, dev server, terminal). ' +
				'Files are sourced in precedence order so later files override earlier ones. ' +
				'NOTE TO AI AGENTS: Before making changes to settings files, YOU MUST OFFER to check .env compatibility. ' +
				'WARNING: Unquoted values in .env files may break sourcing in bash/zsh shells. ' +
				'Before enabling, verify ALL your .env.* files do not contain unquoted special characters ' +
				'(e.g., database URLs with ?, &, or other shell metacharacters). ' +
				'Shell compatibility issues may cause processes to fail or behave unexpectedly.',
		),
	worktreePrefix: z
		.string()
		.optional()
		.refine(
			(val) => {
				if (val === undefined) return true // undefined = use default calculation
				if (val === '') return true // empty string = no prefix mode

				// Allowlist: only alphanumeric, hyphens, underscores, and forward slashes
				const allowedChars = /^[a-zA-Z0-9\-_/]+$/
				if (!allowedChars.test(val)) return false

				// Reject if only special characters (no alphanumeric content)
				if (/^[-_/]+$/.test(val)) return false

				// Check each segment (split by /) contains at least one alphanumeric character
				const segments = val.split('/')
				for (const segment of segments) {
					if (segment && /^[-_]+$/.test(segment)) {
						// Segment exists but contains only hyphens/underscores
						return false
					}
				}

				return true
			},
			{
				message:
					"worktreePrefix contains invalid characters. Only alphanumeric characters, hyphens (-), underscores (_), and forward slashes (/) are allowed. Use forward slashes for nested directories.",
			},
		)
		.describe(
			'Prefix for worktree directories. Empty string disables prefix. Defaults to <repo-name>-looms if not set.',
		),
	protectedBranches: z
		.array(z.string().min(1, 'Protected branch name cannot be empty'))
		.optional()
		.describe('List of branches that cannot be deleted (defaults to [mainBranch, "main", "master", "develop"])'),
	copyGitIgnoredPatterns: z
		.array(z.string().min(1, 'Pattern cannot be empty'))
		.optional()
		.describe('Glob patterns for gitignored files to copy to looms (e.g., ["*.db", "data/*.sqlite"]). Great for local dbs and large test data files that are too big to commit to git. Note: .env (dotenv-flow) files, iloom\'s and claude\'s local settings are automatically copied and do not need to be specified here.'),
	workflows: WorkflowsSettingsSchemaNoDefaults.describe('Per-workflow-type permission configurations'),
	agents: z
		.record(z.string(), AgentSettingsSchema)
		.optional()
		.nullable()
		.describe(
			'Per-agent configuration overrides. Available agents: ' +
				'iloom-issue-analyzer (analyzes issues), ' +
				'iloom-issue-planner (creates implementation plans), ' +
				'iloom-issue-analyze-and-plan (combined analysis and planning), ' +
				'iloom-issue-complexity-evaluator (evaluates complexity), ' +
				'iloom-issue-enhancer (enhances issue descriptions), ' +
				'iloom-issue-implementer (implements code changes), ' +
				'iloom-code-reviewer (reviews code changes against requirements), ' +
				'iloom-artifact-reviewer (reviews artifacts before posting), ' +
				'iloom-swarm-worker (swarm worker agent, dynamically generated). ' +
				'Use swarmModel on any agent to override its model in swarm mode.',
		),
	spin: z
		.object({
			model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
			swarmModel: z.enum(['sonnet', 'opus', 'haiku']).optional(),
		})
		.optional()
		.describe('Spin orchestrator configuration'),
	plan: z
		.object({
			model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
			planner: z.enum(['claude', 'gemini', 'codex']).optional(),
			reviewer: z.enum(['claude', 'gemini', 'codex', 'none']).optional(),
		})
		.optional()
		.describe('Plan command configuration'),
	summary: z
		.object({
			model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
		})
		.optional()
		.describe('Session summary generation configuration'),
	capabilities: CapabilitiesSettingsSchemaNoDefaults.describe('Project capability configurations'),
	databaseProviders: DatabaseProvidersSettingsSchema.describe('Database provider configurations'),
	issueManagement: z
		.object({
			provider: z.enum(['github', 'linear', 'jira']).optional().describe('Issue tracker provider (github, linear, jira)'),
			github: z
				.object({
					remote: z
						.string()
						.min(1, 'Remote name cannot be empty')
						.describe('Git remote name to use for GitHub operations'),
				})
				.optional(),
			linear: z
				.object({
					teamId: z
						.string()
						.min(1, 'Team ID cannot be empty')
						.describe('Linear team identifier (e.g., "ENG", "PLAT")'),
					branchFormat: z
						.string()
						.optional()
						.describe('Branch naming template for Linear issues'),
					apiToken: z
						.string()
						.optional()
						.describe('Linear API token (lin_api_...). SECURITY: Store in settings.local.json only, never commit to source control.'),
				})
				.optional(),
			jira: z
				.object({
					host: z
						.string()
						.min(1, 'Jira host cannot be empty')
						.describe('Jira instance URL (e.g., "https://yourcompany.atlassian.net")'),
					username: z
						.string()
						.min(1, 'Jira username/email cannot be empty')
						.describe('Jira username or email address'),
					apiToken: z
						.string()
						.optional()
						.describe('Jira API token. SECURITY: Store in settings.local.json only, never commit to source control. Generate at: https://id.atlassian.com/manage-profile/security/api-tokens'),
					projectKey: z
						.string()
						.min(1, 'Project key cannot be empty')
						.describe('Jira project key (e.g., "PROJ", "ENG")'),
					boardId: z
						.string()
						.optional()
						.describe('Jira board ID for sprint/workflow operations (optional)'),
					transitionMappings: z
						.record(z.string(), z.string())
						.optional()
						.describe('Map iloom states to Jira transition names (e.g., {"In Review": "Start Review"})'),
					defaultIssueType: z
						.string()
						.min(1)
						.optional()
						.describe('Default Jira issue type name for creating issues (e.g., "Task", "Story", "Bug")'),
					defaultSubtaskType: z
						.string()
						.min(1)
						.optional()
						.describe('Default Jira issue type name for creating subtasks/child issues (e.g., "Subtask", "Sub-task")'),
					doneStatuses: z
						.array(z.string())
						.optional()
						.default(['Done'])
						.describe('Status names to exclude from issue lists (e.g., ["Done", "Closed", "Verify"])'),
				})
				.optional(),
		})
		.optional()
		.describe('Issue management configuration'),
	mergeBehavior: z
		.object({
			mode: z.enum(['local', 'github-pr', 'github-draft-pr']).optional(),
			remote: z.string().optional(),
			autoCommitPush: z
				.boolean()
				.optional()
				.describe(
					'Auto-commit and push after code review in draft PR mode. Defaults to true when mode is github-draft-pr.'
				),
			openBrowserOnFinish: z
				.boolean()
				.optional()
				.describe(
					'Open the PR in the default browser after finishing in github-pr or github-draft-pr mode. Use --no-browser flag to override.'
				),
		})
		.optional()
		.describe('Merge behavior configuration: local (merge locally), github-pr (create PR), or github-draft-pr (create draft PR at start, mark ready on finish)'),
	ide: z
		.object({
			type: z
				.enum(['vscode', 'cursor', 'webstorm', 'sublime', 'intellij', 'windsurf', 'antigravity'])
				.optional()
				.describe(
					'IDE to launch when starting a loom. Options: vscode (Visual Studio Code), cursor (Cursor AI editor), ' +
						'webstorm (JetBrains WebStorm), sublime (Sublime Text), intellij (JetBrains IntelliJ IDEA), ' +
						'windsurf (Windsurf editor), antigravity (Antigravity IDE).'
				),
		})
		.optional()
		.describe(
			'IDE configuration for workspace launches. Controls which editor opens when you start a loom. ' +
				'Supports VSCode, Cursor, WebStorm, Sublime Text, IntelliJ, Windsurf, and Antigravity. ' +
				'Note: Color synchronization (title bar colors) only works with VSCode-compatible editors (vscode, cursor, windsurf, antigravity).'
		),
	colors: z
		.object({
			terminal: z
				.boolean()
				.optional()
				.describe('Apply terminal background colors based on branch name (macOS only)'),
			vscode: z
				.boolean()
				.optional()
				.describe(
					'Apply VSCode/Cursor title bar colors based on branch name. ' +
						'Note: This modifies .vscode/settings.json which may be in source control.'
				),
		})
		.optional()
		.describe('Color synchronization settings for workspace identification'),
	attribution: z
		.enum(['off', 'upstreamOnly', 'on'])
		.optional()
		.describe(
			'Controls when iloom attribution appears in session summaries. ' +
				'"off" - never show attribution. ' +
				'"upstreamOnly" - only show for contributions to external repositories (e.g., open source). ' +
				'"on" - always show attribution.'
		),
	git: z
		.object({
			commitTimeout: z
				.number()
				.min(1000, 'Commit timeout must be at least 1000ms')
				.max(600000, 'Commit timeout cannot exceed 600000ms (10 minutes)')
				.optional()
				.describe('Timeout in milliseconds for git commit operations. Increase for long-running pre-commit hooks.'),
		})
		.optional()
		.describe('Git operation settings'),
})

/**
 * TypeScript type for Neon settings derived from Zod schema
 */
export type NeonSettings = z.infer<typeof NeonSettingsSchema>

/**
 * TypeScript type for database providers settings derived from Zod schema
 */
export type DatabaseProvidersSettings = z.infer<typeof DatabaseProvidersSettingsSchema>

/**
 * TypeScript type for agent settings derived from Zod schema
 */
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/**
 * TypeScript type for spin agent settings derived from Zod schema
 */
export type SpinAgentSettings = z.infer<typeof SpinAgentSettingsSchema>

/**
 * TypeScript type for plan command settings derived from Zod schema
 */
export type PlanCommandSettings = z.infer<typeof PlanCommandSettingsSchema>

/**
 * TypeScript type for summary settings derived from Zod schema
 */
export type SummarySettings = z.infer<typeof SummarySettingsSchema>

/**
 * TypeScript type for workflow permission configuration derived from Zod schema
 */
export type WorkflowPermission = z.infer<typeof WorkflowPermissionSchema>

/**
 * TypeScript type for workflows settings derived from Zod schema
 */
export type WorkflowsSettings = z.infer<typeof WorkflowsSettingsSchema>

/**
 * TypeScript type for capabilities settings derived from Zod schema
 */
export type CapabilitiesSettings = z.infer<typeof CapabilitiesSettingsSchema>

/**
 * TypeScript type for IDE settings derived from Zod schema
 */
export type IdeSettings = z.infer<typeof IloomSettingsSchema>['ide']

/**
 * TypeScript type for iloom settings derived from Zod schema
 */
export type IloomSettings = z.infer<typeof IloomSettingsSchema>

/**
 * TypeScript input type for iloom settings (before Zod defaults are applied)
 * Used for validation where partial/input objects need to be accepted
 */
export type IloomSettingsInput = z.input<typeof IloomSettingsSchema>

function redactSensitiveFields(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj
	if (typeof obj !== 'object') return obj
	if (Array.isArray(obj)) return obj.map(redactSensitiveFields)
	const sensitiveKeys = ['apitoken', 'token', 'secret', 'password']
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const lowerKey = key.toLowerCase()
		if (sensitiveKeys.some(s => lowerKey.includes(s)) && typeof value === 'string') {
			result[key] = '[REDACTED]'
		} else if (typeof value === 'object' && value !== null) {
			result[key] = redactSensitiveFields(value)
		} else {
			result[key] = value
		}
	}
	return result
}

/**
 * Manages project-level settings from .iloom/settings.json
 */
export class SettingsManager {
	/**
	 * Load settings from global, project, and local sources with proper precedence
	 * Merge hierarchy (lowest to highest priority):
	 * 1. Global settings (~/.config/iloom-ai/settings.json)
	 * 2. Project settings (<PROJECT_ROOT>/.iloom/settings.json)
	 * 3. Local settings (<PROJECT_ROOT>/.iloom/settings.local.json)
	 * 4. CLI overrides (--set flags)
	 * Returns empty object if all files don't exist (not an error)
	 */
	async loadSettings(
		projectRoot?: string,
		cliOverrides?: Partial<IloomSettings>,
	): Promise<IloomSettings> {
		const root = this.getProjectRoot(projectRoot)

		// Load global settings (lowest priority)
		const globalSettings = await this.loadGlobalSettingsFile()
		const globalSettingsPath = this.getGlobalSettingsPath()
		logger.debug(`🌍 Global settings from ${globalSettingsPath}:`, JSON.stringify(redactSensitiveFields(globalSettings), null, 2))

		// Load base settings from settings.json
		const baseSettings = await this.loadSettingsFile(root, 'settings.json')
		const baseSettingsPath = path.join(root, '.iloom', 'settings.json')
		logger.debug(`📄 Base settings from ${baseSettingsPath}:`, JSON.stringify(redactSensitiveFields(baseSettings), null, 2))

		// Load local overrides from settings.local.json
		const localSettings = await this.loadSettingsFile(root, 'settings.local.json')
		const localSettingsPath = path.join(root, '.iloom', 'settings.local.json')
		logger.debug(`📄 Local settings from ${localSettingsPath}:`, JSON.stringify(redactSensitiveFields(localSettings), null, 2))

		// Deep merge with priority: cliOverrides > localSettings > baseSettings > globalSettings
		let merged = this.mergeSettings(this.mergeSettings(globalSettings, baseSettings), localSettings)
		logger.debug('🔄 After merging global + base + local settings:', JSON.stringify(redactSensitiveFields(merged), null, 2))

		if (cliOverrides && Object.keys(cliOverrides).length > 0) {
			logger.debug('⚙️ CLI overrides to apply:', JSON.stringify(redactSensitiveFields(cliOverrides), null, 2))
			merged = this.mergeSettings(merged, cliOverrides)
			logger.debug('🔄 After applying CLI overrides:', JSON.stringify(redactSensitiveFields(merged), null, 2))
		}

		// Validate merged result
		try {
			const finalSettings = IloomSettingsSchema.parse(merged)

			// Debug: Log final merged configuration
			this.logFinalConfiguration(finalSettings)

			return finalSettings
		} catch (error) {
			// Show all Zod validation errors
			if (error instanceof z.ZodError) {
				const errorMsg = this.formatAllZodErrors(error, '<merged settings>')
				// Enhance error message if CLI overrides were applied
				if (cliOverrides && Object.keys(cliOverrides).length > 0) {
					throw new Error(`${errorMsg.message}\n\nNote: CLI overrides were applied. Check your --set arguments.`)
				}
				throw errorMsg
			}
			throw error
		}
	}

	/**
	 * Log the final merged configuration for debugging
	 */
	private logFinalConfiguration(settings: IloomSettings): void {
		logger.debug('📋 Final merged configuration:', JSON.stringify(redactSensitiveFields(settings), null, 2))
	}

	/**
	 * Load and parse a single settings file
	 * Returns empty object if file doesn't exist (not an error)
	 * Uses non-defaulting schema to prevent polluting partial settings with defaults before merge
	 */
	private async loadSettingsFile(
		projectRoot: string,
		filename: string,
	): Promise<z.infer<typeof IloomSettingsSchemaNoDefaults>> {
		const settingsPath = path.join(projectRoot, '.iloom', filename)

		try {
			const content = await readFile(settingsPath, 'utf-8')
			let parsed: unknown

			try {
				parsed = JSON.parse(content)
			} catch (error) {
				throw new Error(
					`Failed to parse settings file at ${settingsPath}: ${error instanceof Error ? error.message : 'Invalid JSON'}`,
				)
			}

			// Basic type checking - ensure it's an object, but don't validate schema completeness
			// Individual files may be incomplete (e.g., Linear config split between files)
			// Final validation will happen on the merged result in loadSettings()
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error(
					`Settings validation failed at ${filename}:\n  - root: Expected object, received ${typeof parsed}`
				)
			}
			return parsed as z.infer<typeof IloomSettingsSchemaNoDefaults>
		} catch (error) {
			// File not found is not an error - return empty settings
			if ((error as { code?: string }).code === 'ENOENT') {
				logger.debug(`No settings file found at ${settingsPath}, using defaults`)
				return {}
			}

			// Re-throw parsing errors
			throw error
		}
	}

	/**
	 * Deep merge two settings objects with priority to override
	 * Uses deepmerge library with array replacement strategy
	 */
	private mergeSettings(
		base: Partial<IloomSettings> | z.infer<typeof IloomSettingsSchemaNoDefaults>,
		override: Partial<IloomSettings> | z.infer<typeof IloomSettingsSchemaNoDefaults>,
	): IloomSettings {
		// Use deepmerge with array replacement (not concatenation)
		// Type assertion is safe because the merged result will be validated with IloomSettingsSchema
		// which applies all the defaults after merging
		return deepmerge(base as Record<string, unknown>, override as Record<string, unknown>, {
			// Replace arrays instead of concatenating them
			arrayMerge: (_destinationArray, sourceArray) => sourceArray,
		}) as IloomSettings
	}

	/**
	 * Format all Zod validation errors into a single error message
	 */
	private formatAllZodErrors(error: z.ZodError, settingsPath: string): Error {
		const errorMessages = error.issues.map(issue => {
			const path = issue.path.length > 0 ? issue.path.join('.') : 'root'
			return `  - ${path}: ${issue.message}`
		})

		return new Error(
			`Settings validation failed at ${settingsPath}:\n${errorMessages.join('\n')}`,
		)
	}

	/**
	 * Validate settings structure and model names using Zod schema
	 * This method is kept for testing purposes but uses Zod internally
	 * @internal - Only used in tests via bracket notation
	 */
	// @ts-expect-error - Used in tests via bracket notation, TypeScript can't detect this usage
	private validateSettings(settings: IloomSettingsInput): void {
		try {
			IloomSettingsSchema.parse(settings)
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw this.formatAllZodErrors(error, '<validation>')
			}
			throw error
		}
	}

	/**
	 * Get project root (defaults to process.cwd())
	 */
	private getProjectRoot(projectRoot?: string): string {
		return projectRoot ?? process.cwd()
	}

	/**
	 * Get global config directory path (~/.config/iloom-ai)
	 */
	private getGlobalConfigDir(): string {
		return path.join(os.homedir(), '.config', 'iloom-ai')
	}

	/**
	 * Get global settings file path (~/.config/iloom-ai/settings.json)
	 */
	private getGlobalSettingsPath(): string {
		return path.join(this.getGlobalConfigDir(), 'settings.json')
	}

	/**
	 * Load and parse global settings file
	 * Returns empty object if file doesn't exist (not an error)
	 * Warns but returns empty object on validation/parse errors (graceful degradation)
	 */
	private async loadGlobalSettingsFile(): Promise<z.infer<typeof IloomSettingsSchemaNoDefaults>> {
		const settingsPath = this.getGlobalSettingsPath()

		try {
			const content = await readFile(settingsPath, 'utf-8')
			let parsed: unknown

			try {
				parsed = JSON.parse(content)
			} catch (error) {
				logger.warn(
					`Failed to parse global settings file at ${settingsPath}: ${error instanceof Error ? error.message : 'Invalid JSON'}. Ignoring global settings.`,
				)
				return {}
			}

			// Validate with non-defaulting schema
			try {
				const validated = IloomSettingsSchemaNoDefaults.strict().parse(parsed)
				return validated
			} catch (error) {
				if (error instanceof z.ZodError) {
					const errorMsg = this.formatAllZodErrors(error, 'global settings')
					logger.warn(`${errorMsg.message}. Ignoring global settings.`)
				} else {
					logger.warn(`Validation error in global settings: ${error instanceof Error ? error.message : 'Unknown error'}. Ignoring global settings.`)
				}
				return {}
			}
		} catch (error) {
			// File not found is not an error - return empty settings
			if ((error as { code?: string }).code === 'ENOENT') {
				logger.debug(`No global settings file found at ${settingsPath}`)
				return {}
			}

			// Other file system errors - warn and continue
			logger.warn(`Error reading global settings file at ${settingsPath}: ${error instanceof Error ? error.message : 'Unknown error'}. Ignoring global settings.`)
			return {}
		}
	}

	/**
	 * Get effective protected branches list with mainBranch always included
	 *
	 * This method provides a single source of truth for protected branches logic:
	 * 1. Use configured protectedBranches if provided
	 * 2. Otherwise use defaults: [mainBranch, 'main', 'master', 'develop']
	 * 3. ALWAYS ensure mainBranch is included even if user configured custom list
	 *
	 * @param projectRoot - Optional project root directory (defaults to process.cwd())
	 * @returns Array of protected branch names with mainBranch guaranteed to be included
	 */
	async getProtectedBranches(projectRoot?: string): Promise<string[]> {
		const settings = await this.loadSettings(projectRoot)
		// SYNC: If this default changes, update displayDefaultsBox() in src/utils/first-run-setup.ts
		const mainBranch = settings.mainBranch ?? 'main'

		// Build protected branches list:
		// 1. Use configured protectedBranches if provided
		// 2. Otherwise use defaults: [mainBranch, 'main', 'master', 'develop']
		// 3. ALWAYS ensure mainBranch is included even if user configured custom list
		let protectedBranches: string[]
		if (settings.protectedBranches) {
			// Use configured list but ensure mainBranch is always included
			protectedBranches = settings.protectedBranches.includes(mainBranch)
				? settings.protectedBranches
				: [mainBranch, ...settings.protectedBranches]
		} else {
			// Use defaults with current mainBranch
			protectedBranches = [mainBranch, 'main', 'master', 'develop']
		}

		return protectedBranches
	}

	/**
	 * Get the spin orchestrator model with default applied
	 * Default is defined in SpinAgentSettingsSchema
	 *
	 * @param settings - Pre-loaded settings object
	 * @returns Model shorthand ('opus', 'sonnet', or 'haiku')
	 */
	getSpinModel(settings?: IloomSettings, mode?: 'swarm'): 'sonnet' | 'opus' | 'haiku' {
		if (mode === 'swarm' && settings?.spin?.swarmModel) {
			return settings.spin.swarmModel
		}
		return settings?.spin?.model ?? SpinAgentSettingsSchema.parse({}).model
	}

	/**
	 * Get the plan command model with default applied
	 * Default is defined in PlanCommandSettingsSchema
	 *
	 * @param settings - Pre-loaded settings object
	 * @returns Model shorthand ('opus', 'sonnet', or 'haiku')
	 */
	getPlanModel(settings?: IloomSettings): 'sonnet' | 'opus' | 'haiku' {
		return settings?.plan?.model ?? PlanCommandSettingsSchema.parse({}).model
	}

	/**
	 * Get the plan command planner with default applied
	 * Default is 'claude'
	 *
	 * @param settings - Pre-loaded settings object
	 * @returns Planner provider ('claude', 'gemini', or 'codex')
	 */
	getPlanPlanner(settings?: IloomSettings): 'claude' | 'gemini' | 'codex' {
		return settings?.plan?.planner ?? 'claude'
	}

	/**
	 * Get the plan command reviewer with default applied
	 * Default is 'none' (no review step)
	 *
	 * @param settings - Pre-loaded settings object
	 * @returns Reviewer provider ('claude', 'gemini', 'codex', or 'none')
	 */
	getPlanReviewer(settings?: IloomSettings): 'claude' | 'gemini' | 'codex' | 'none' {
		return settings?.plan?.reviewer ?? 'none'
	}

	/**
	 * Get the session summary model with default applied
	 * Default is defined in SummarySettingsSchema
	 *
	 * @param settings - Pre-loaded settings object
	 * @returns Model shorthand ('opus', 'sonnet', or 'haiku')
	 */
	getSummaryModel(settings?: IloomSettings): 'sonnet' | 'opus' | 'haiku' {
		return settings?.summary?.model ?? SummarySettingsSchema.parse({}).model
	}
}
