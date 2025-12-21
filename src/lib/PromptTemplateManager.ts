import { readFile } from 'fs/promises'
import { accessSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { logger } from '../utils/logger.js'

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
	RECAP_JSON?: string  // JSON recap context for session summary
	// Draft PR mode variables - mutually exclusive with standard issue mode
	DRAFT_PR_NUMBER?: number  // PR number for draft PR workflow
	DRAFT_PR_MODE?: boolean   // True when using github-draft-pr merge mode
	STANDARD_ISSUE_MODE?: boolean  // True when using standard issue commenting (not draft PR)
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
	async loadTemplate(templateName: 'issue' | 'pr' | 'regular' | 'init' | 'session-summary'): Promise<string> {
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
	 * Substitute variables in a template string
	 */
	substituteVariables(template: string, variables: TemplateVariables): string {
		let result = template

		// Process conditional sections first
		result = this.processConditionalSections(result, variables)

		// Replace each variable if it exists
		if (variables.ISSUE_NUMBER !== undefined) {
			result = result.replace(/ISSUE_NUMBER/g, String(variables.ISSUE_NUMBER))
		}

		if (variables.PR_NUMBER !== undefined) {
			result = result.replace(/PR_NUMBER/g, String(variables.PR_NUMBER))
		}

		if (variables.ISSUE_TITLE !== undefined) {
			result = result.replace(/ISSUE_TITLE/g, variables.ISSUE_TITLE)
		}

		if (variables.PR_TITLE !== undefined) {
			result = result.replace(/PR_TITLE/g, variables.PR_TITLE)
		}

		if (variables.WORKSPACE_PATH !== undefined) {
			result = result.replace(/WORKSPACE_PATH/g, variables.WORKSPACE_PATH)
		}

		if (variables.PORT !== undefined) {
			result = result.replace(/PORT/g, String(variables.PORT))
		}

		if (variables.SETTINGS_SCHEMA !== undefined) {
			result = result.replace(/SETTINGS_SCHEMA/g, variables.SETTINGS_SCHEMA)
		}

		if (variables.SETTINGS_GLOBAL_JSON !== undefined) {
			result = result.replace(/SETTINGS_GLOBAL_JSON/g, variables.SETTINGS_GLOBAL_JSON)
		}

		if (variables.SETTINGS_JSON !== undefined) {
			result = result.replace(/SETTINGS_JSON/g, variables.SETTINGS_JSON)
		}

		if (variables.SETTINGS_LOCAL_JSON !== undefined) {
			result = result.replace(/SETTINGS_LOCAL_JSON/g, variables.SETTINGS_LOCAL_JSON)
		}

		if (variables.SHELL_TYPE !== undefined) {
			result = result.replace(/SHELL_TYPE/g, variables.SHELL_TYPE)
		}

		if (variables.SHELL_CONFIG_PATH !== undefined) {
			result = result.replace(/SHELL_CONFIG_PATH/g, variables.SHELL_CONFIG_PATH)
		}

		if (variables.SHELL_CONFIG_CONTENT !== undefined) {
			result = result.replace(/SHELL_CONFIG_CONTENT/g, variables.SHELL_CONFIG_CONTENT)
		}

		if (variables.REMOTES_INFO !== undefined) {
			result = result.replace(/REMOTES_INFO/g, variables.REMOTES_INFO)
		}

		if (variables.MULTIPLE_REMOTES !== undefined) {
			result = result.replace(/MULTIPLE_REMOTES/g, variables.MULTIPLE_REMOTES)
		}

		if (variables.SINGLE_REMOTE !== undefined) {
			result = result.replace(/SINGLE_REMOTE/g, variables.SINGLE_REMOTE)
		}

		if (variables.SINGLE_REMOTE_NAME !== undefined) {
			result = result.replace(/SINGLE_REMOTE_NAME/g, variables.SINGLE_REMOTE_NAME)
		}

		if (variables.SINGLE_REMOTE_URL !== undefined) {
			result = result.replace(/SINGLE_REMOTE_URL/g, variables.SINGLE_REMOTE_URL)
		}

		if (variables.NO_REMOTES !== undefined) {
			result = result.replace(/NO_REMOTES/g, variables.NO_REMOTES)
		}

		if (variables.README_CONTENT !== undefined) {
			result = result.replace(/README_CONTENT/g, variables.README_CONTENT)
		}

		if (variables.SETTINGS_SCHEMA_CONTENT !== undefined) {
			result = result.replace(/SETTINGS_SCHEMA_CONTENT/g, variables.SETTINGS_SCHEMA_CONTENT)
		}

		if (variables.VSCODE_SETTINGS_GITIGNORED !== undefined) {
			result = result.replace(/VSCODE_SETTINGS_GITIGNORED/g, variables.VSCODE_SETTINGS_GITIGNORED)
		}

		// Session summary template variables
		if (variables.SESSION_CONTEXT !== undefined) {
			result = result.replace(/SESSION_CONTEXT/g, variables.SESSION_CONTEXT)
		}

		if (variables.BRANCH_NAME !== undefined) {
			result = result.replace(/BRANCH_NAME/g, variables.BRANCH_NAME)
		}

		if (variables.LOOM_TYPE !== undefined) {
			result = result.replace(/LOOM_TYPE/g, variables.LOOM_TYPE)
		}

		if (variables.COMPACT_SUMMARIES !== undefined) {
			result = result.replace(/COMPACT_SUMMARIES/g, variables.COMPACT_SUMMARIES)
		}

		if (variables.RECAP_JSON !== undefined) {
			result = result.replace(/RECAP_JSON/g, variables.RECAP_JSON)
		}

		// Draft PR mode variable substitution
		if (variables.DRAFT_PR_NUMBER !== undefined) {
			result = result.replace(/DRAFT_PR_NUMBER/g, String(variables.DRAFT_PR_NUMBER))
		}

		return result
	}

	/**
	 * Process conditional sections in template
	 * Format: {{#IF ONE_SHOT_MODE}}content{{/IF ONE_SHOT_MODE}}
	 *
	 * Note: /s flag allows . to match newlines
	 */
	private processConditionalSections(template: string, variables: TemplateVariables): string {
		let result = template

		// Process ONE_SHOT_MODE conditionals
		const oneShotRegex = /\{\{#IF ONE_SHOT_MODE\}\}(.*?)\{\{\/IF ONE_SHOT_MODE\}\}/gs

		if (variables.ONE_SHOT_MODE === true) {
			// Include the content, remove the conditional markers
			result = result.replace(oneShotRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(oneShotRegex, '')
		}

		// Process SETTINGS_JSON conditionals
		const settingsJsonRegex = /\{\{#IF SETTINGS_JSON\}\}(.*?)\{\{\/IF SETTINGS_JSON\}\}/gs

		if (variables.SETTINGS_JSON !== undefined && variables.SETTINGS_JSON !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(settingsJsonRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(settingsJsonRegex, '')
		}

		// Process SETTINGS_GLOBAL_JSON conditionals
		const settingsGlobalJsonRegex = /\{\{#IF SETTINGS_GLOBAL_JSON\}\}(.*?)\{\{\/IF SETTINGS_GLOBAL_JSON\}\}/gs

		if (variables.SETTINGS_GLOBAL_JSON !== undefined && variables.SETTINGS_GLOBAL_JSON !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(settingsGlobalJsonRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(settingsGlobalJsonRegex, '')
		}

		// Process SETTINGS_LOCAL_JSON conditionals
		const settingsLocalJsonRegex = /\{\{#IF SETTINGS_LOCAL_JSON\}\}(.*?)\{\{\/IF SETTINGS_LOCAL_JSON\}\}/gs

		if (variables.SETTINGS_LOCAL_JSON !== undefined && variables.SETTINGS_LOCAL_JSON !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(settingsLocalJsonRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(settingsLocalJsonRegex, '')
		}

		// Process MULTIPLE_REMOTES conditionals
		const multipleRemotesRegex = /\{\{#IF MULTIPLE_REMOTES\}\}(.*?)\{\{\/IF MULTIPLE_REMOTES\}\}/gs

		if (variables.MULTIPLE_REMOTES !== undefined && variables.MULTIPLE_REMOTES !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(multipleRemotesRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(multipleRemotesRegex, '')
		}

		// Process SINGLE_REMOTE conditionals
		const singleRemoteRegex = /\{\{#IF SINGLE_REMOTE\}\}(.*?)\{\{\/IF SINGLE_REMOTE\}\}/gs

		if (variables.SINGLE_REMOTE !== undefined && variables.SINGLE_REMOTE !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(singleRemoteRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(singleRemoteRegex, '')
		}

		// Process NO_REMOTES conditionals
		const noRemotesRegex = /\{\{#IF NO_REMOTES\}\}(.*?)\{\{\/IF NO_REMOTES\}\}/gs

		if (variables.NO_REMOTES !== undefined && variables.NO_REMOTES !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(noRemotesRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(noRemotesRegex, '')
		}

		// Process FIRST_TIME_USER conditionals
		const firstTimeUserRegex = /\{\{#IF FIRST_TIME_USER\}\}(.*?)\{\{\/IF FIRST_TIME_USER\}\}/gs

		if (variables.FIRST_TIME_USER === true) {
			// Include the content, remove the conditional markers
			result = result.replace(firstTimeUserRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(firstTimeUserRegex, '')
		}

		// Process INTERACTIVE_MODE conditionals
		const interactiveModeRegex = /\{\{#IF INTERACTIVE_MODE\}\}(.*?)\{\{\/IF INTERACTIVE_MODE\}\}/gs

		if (variables.INTERACTIVE_MODE === true) {
			// Include the content, remove the conditional markers
			result = result.replace(interactiveModeRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(interactiveModeRegex, '')
		}

		// Process COMPACT_SUMMARIES conditionals
		const compactSummariesRegex = /\{\{#IF COMPACT_SUMMARIES\}\}(.*?)\{\{\/IF COMPACT_SUMMARIES\}\}/gs

		if (variables.COMPACT_SUMMARIES !== undefined && variables.COMPACT_SUMMARIES !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(compactSummariesRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(compactSummariesRegex, '')
		}

		// Process RECAP_JSON conditionals
		const recapJsonRegex = /\{\{#IF RECAP_JSON\}\}(.*?)\{\{\/IF RECAP_JSON\}\}/gs

		if (variables.RECAP_JSON !== undefined && variables.RECAP_JSON !== '') {
			// Include the content, remove the conditional markers
			result = result.replace(recapJsonRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(recapJsonRegex, '')
		}

		// Process DRAFT_PR_MODE conditionals
		const draftPrModeRegex = /\{\{#IF DRAFT_PR_MODE\}\}(.*?)\{\{\/IF DRAFT_PR_MODE\}\}/gs

		if (variables.DRAFT_PR_MODE === true) {
			// Include the content, remove the conditional markers
			result = result.replace(draftPrModeRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(draftPrModeRegex, '')
		}

		// Process STANDARD_ISSUE_MODE conditionals
		const standardIssueModeRegex = /\{\{#IF STANDARD_ISSUE_MODE\}\}(.*?)\{\{\/IF STANDARD_ISSUE_MODE\}\}/gs

		if (variables.STANDARD_ISSUE_MODE === true) {
			// Include the content, remove the conditional markers
			result = result.replace(standardIssueModeRegex, '$1')
		} else {
			// Remove the entire conditional block
			result = result.replace(standardIssueModeRegex, '')
		}

		return result
	}

	/**
	 * Get a fully processed prompt for a workflow type
	 */
	async getPrompt(
		type: 'issue' | 'pr' | 'regular' | 'init' | 'session-summary',
		variables: TemplateVariables
	): Promise<string> {
		const template = await this.loadTemplate(type)
		return this.substituteVariables(template, variables)
	}
}
