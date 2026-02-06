import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PromptTemplateManager, TemplateVariables, buildReviewTemplateVariables } from './PromptTemplateManager.js'
import { readFile } from 'fs/promises'

vi.mock('fs/promises')
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

describe('PromptTemplateManager', () => {
	let manager: PromptTemplateManager

	beforeEach(() => {
		manager = new PromptTemplateManager('templates/prompts')
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('loadTemplate', () => {
		it('should load issue template successfully', async () => {
			const templateContent = 'Issue template with ISSUE_NUMBER'
			vi.mocked(readFile).mockResolvedValueOnce(templateContent)

			const result = await manager.loadTemplate('issue')

			expect(result).toBe(templateContent)
			expect(readFile).toHaveBeenCalledWith('templates/prompts/issue-prompt.txt', 'utf-8')
		})

		it('should load pr template successfully', async () => {
			const templateContent = 'PR template with PR_NUMBER'
			vi.mocked(readFile).mockResolvedValueOnce(templateContent)

			const result = await manager.loadTemplate('pr')

			expect(result).toBe(templateContent)
			expect(readFile).toHaveBeenCalledWith('templates/prompts/pr-prompt.txt', 'utf-8')
		})

		it('should load regular template successfully', async () => {
			const templateContent = 'Regular template'
			vi.mocked(readFile).mockResolvedValueOnce(templateContent)

			const result = await manager.loadTemplate('regular')

			expect(result).toBe(templateContent)
			expect(readFile).toHaveBeenCalledWith('templates/prompts/regular-prompt.txt', 'utf-8')
		})

		it('should throw error when template file is not found', async () => {
			vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT: no such file'))

			await expect(manager.loadTemplate('issue')).rejects.toThrow(
				'Template not found: templates/prompts/issue-prompt.txt'
			)
		})

		it('should use custom template directory when provided', async () => {
			const customManager = new PromptTemplateManager('custom/templates')
			const templateContent = 'Custom template'
			vi.mocked(readFile).mockResolvedValueOnce(templateContent)

			await customManager.loadTemplate('issue')

			expect(readFile).toHaveBeenCalledWith('custom/templates/issue-prompt.txt', 'utf-8')
		})
	})

	describe('substituteVariables', () => {
		it('should substitute ISSUE_NUMBER variable', () => {
			const template = 'Work on issue {{ISSUE_NUMBER}}'
			const variables: TemplateVariables = { ISSUE_NUMBER: 123 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Work on issue 123')
		})

		it('should NOT substitute variable names that appear as substrings', () => {
			const template = 'IMPORTANT: Use port {{PORT}}'
			const variables: TemplateVariables = { PORT: 3000 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('IMPORTANT: Use port 3000')
		})

		it('should substitute PR_NUMBER variable', () => {
			const template = 'Review PR {{PR_NUMBER}}'
			const variables: TemplateVariables = { PR_NUMBER: 456 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Review PR 456')
		})

		it('should substitute ISSUE_TITLE variable', () => {
			const template = 'Title: {{ISSUE_TITLE}}'
			const variables: TemplateVariables = { ISSUE_TITLE: 'Add authentication' }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Title: Add authentication')
		})

		it('should substitute PR_TITLE variable', () => {
			const template = 'PR: {{PR_TITLE}}'
			const variables: TemplateVariables = { PR_TITLE: 'Fix bug in login' }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('PR: Fix bug in login')
		})

		it('should substitute WORKSPACE_PATH variable', () => {
			const template = 'Working in {{WORKSPACE_PATH}}'
			const variables: TemplateVariables = { WORKSPACE_PATH: '/path/to/workspace' }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Working in /path/to/workspace')
		})

		it('should substitute PORT variable', () => {
			const template = 'Dev server on {{PORT}}'
			const variables: TemplateVariables = { PORT: 3123 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Dev server on 3123')
		})

		it('should substitute multiple variables', () => {
			const template = 'Issue {{ISSUE_NUMBER}}: {{ISSUE_TITLE}} at {{WORKSPACE_PATH}}'
			const variables: TemplateVariables = {
				ISSUE_NUMBER: 123,
				ISSUE_TITLE: 'Add feature',
				WORKSPACE_PATH: '/workspace',
			}

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Issue 123: Add feature at /workspace')
		})

		it('should substitute all occurrences of a variable', () => {
			const template = '{{ISSUE_NUMBER}} is important. Work on {{ISSUE_NUMBER}} now.'
			const variables: TemplateVariables = { ISSUE_NUMBER: 123 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('123 is important. Work on 123 now.')
		})

		it('should handle empty variables object', () => {
			const template = 'Work on {{ISSUE_NUMBER}}'
			const variables: TemplateVariables = {}

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Work on ')
		})

		it('should only substitute defined variables', () => {
			const template = 'Issue {{ISSUE_NUMBER}} and PR {{PR_NUMBER}}'
			const variables: TemplateVariables = { ISSUE_NUMBER: 123 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Issue 123 and PR ')
		})

		it('should handle undefined variable values by outputting empty string', () => {
			const template = 'Issue {{ISSUE_NUMBER}}'
			const variables: TemplateVariables = { ISSUE_NUMBER: undefined }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Issue ')
		})

		it('should include conditional section when ONE_SHOT_MODE is true', () => {
			const template = 'Start{{#if ONE_SHOT_MODE}} one-shot content {{/if}}End'
			const variables: TemplateVariables = { ONE_SHOT_MODE: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Start one-shot content End')
		})

		it('should exclude conditional section when ONE_SHOT_MODE is false', () => {
			const template = 'Start{{#if ONE_SHOT_MODE}} one-shot content {{/if}}End'
			const variables: TemplateVariables = { ONE_SHOT_MODE: false }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('StartEnd')
		})

		it('should exclude conditional section when ONE_SHOT_MODE is undefined', () => {
			const template = 'Start{{#if ONE_SHOT_MODE}} one-shot content {{/if}}End'
			const variables: TemplateVariables = {}

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('StartEnd')
		})

		it('should handle multi-line conditional sections', () => {
			const template = `Header
{{#if ONE_SHOT_MODE}}
Line 1
Line 2
Line 3
{{/if}}
Footer`
			const variables: TemplateVariables = { ONE_SHOT_MODE: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe(`Header
Line 1
Line 2
Line 3
Footer`)
		})

		it('should process conditionals and variable substitution together', () => {
			const template = '{{#if ONE_SHOT_MODE}}Issue {{ISSUE_NUMBER}}{{/if}}'
			const variables: TemplateVariables = { ONE_SHOT_MODE: true, ISSUE_NUMBER: 123 }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Issue 123')
		})

		it('should handle multiple conditional sections in same template', () => {
			const template = '{{#if ONE_SHOT_MODE}}First{{/if}} Middle {{#if ONE_SHOT_MODE}}Second{{/if}}'
			const variables: TemplateVariables = { ONE_SHOT_MODE: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('First Middle Second')
		})

		it('should include conditional section when INTERACTIVE_MODE is true', () => {
			const template = 'Start{{#if INTERACTIVE_MODE}} interactive content {{/if}}End'
			const variables: TemplateVariables = { INTERACTIVE_MODE: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Start interactive content End')
		})

		it('should exclude conditional section when INTERACTIVE_MODE is false', () => {
			const template = 'Start{{#if INTERACTIVE_MODE}} interactive content {{/if}}End'
			const variables: TemplateVariables = { INTERACTIVE_MODE: false }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('StartEnd')
		})

		it('should exclude conditional section when INTERACTIVE_MODE is undefined', () => {
			const template = 'Start{{#if INTERACTIVE_MODE}} interactive content {{/if}}End'
			const variables: TemplateVariables = {}

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('StartEnd')
		})

		it('should handle multi-line INTERACTIVE_MODE conditional sections', () => {
			const template = `Header
{{#if INTERACTIVE_MODE}}
2.5. Extract and validate assumptions (batched validation):
   - Read the agent's output
   - Use AskUserQuestion tool
{{/if}}
Footer`
			const variables: TemplateVariables = { INTERACTIVE_MODE: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toContain('Extract and validate assumptions')
			expect(result).toContain('AskUserQuestion tool')
		})

		it('should include content when HAS_PACKAGE_JSON is true', () => {
			const template = '{{#if HAS_PACKAGE_JSON}}Node.js project detected{{/if}}'
			const variables: TemplateVariables = { HAS_PACKAGE_JSON: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Node.js project detected')
		})

		it('should exclude content when HAS_PACKAGE_JSON is false', () => {
			const template = '{{#if HAS_PACKAGE_JSON}}Node.js project detected{{/if}}'
			const variables: TemplateVariables = { HAS_PACKAGE_JSON: false }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('')
		})

		it('should include content when NO_PACKAGE_JSON is true', () => {
			const template = '{{#if NO_PACKAGE_JSON}}Non-Node.js project detected{{/if}}'
			const variables: TemplateVariables = { NO_PACKAGE_JSON: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Non-Node.js project detected')
		})

		it('should exclude content when NO_PACKAGE_JSON is false', () => {
			const template = '{{#if NO_PACKAGE_JSON}}Non-Node.js project detected{{/if}}'
			const variables: TemplateVariables = { NO_PACKAGE_JSON: false }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('')
		})

		it('should handle mutually exclusive HAS_PACKAGE_JSON and NO_PACKAGE_JSON', () => {
			const template = '{{#if HAS_PACKAGE_JSON}}Node{{/if}}{{#if NO_PACKAGE_JSON}}Other{{/if}}'
			const variablesWithPackageJson: TemplateVariables = { HAS_PACKAGE_JSON: true, NO_PACKAGE_JSON: false }
			const variablesWithoutPackageJson: TemplateVariables = { HAS_PACKAGE_JSON: false, NO_PACKAGE_JSON: true }

			const resultWithPackage = manager.substituteVariables(template, variablesWithPackageJson)
			const resultWithoutPackage = manager.substituteVariables(template, variablesWithoutPackageJson)

			expect(resultWithPackage).toBe('Node')
			expect(resultWithoutPackage).toBe('Other')
		})

		it('should output raw block content literally without parsing Handlebars syntax', () => {
			// Raw blocks output their content literally - {{VARIABLE}} is NOT substituted
			const template = '{{{{raw}}}}{{VARIABLE}}{{{{/raw}}}}'
			const variables: TemplateVariables = {}

			const result = manager.substituteVariables(template, variables)

			// Raw block outputs {{VARIABLE}} literally, not the substituted value
			expect(result).toBe('{{VARIABLE}}')
		})

		it('should handle JSON content with single braces without raw blocks', () => {
			// Single braces in JSON are safe - Handlebars only parses {{ double braces }}
			const template = '```json\n{"definitions": {"foo": {"type": "object"}}}\n```\nValue: {{SETTINGS_SCHEMA}}'
			const jsonValue = '{"test": true}'
			const variables: TemplateVariables = { SETTINGS_SCHEMA: jsonValue }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('```json\n{"definitions": {"foo": {"type": "object"}}}\n```\nValue: {"test": true}')
		})

		it('should handle complex JSON schema embedded directly in template', () => {
			// This simulates what happens after export-schema.ts embeds the schema
			const complexJson = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "definitions": {
    "IloomSettings": {
      "type": "object",
      "properties": {
        "mainBranch": { "type": "string" }
      }
    }
  }
}`
			const template = `\`\`\`json\n${complexJson}\n\`\`\`\nHello {{NAME}}`
			const variables: TemplateVariables = {}

			const result = manager.substituteVariables(template, { ...variables, NAME: 'World' } as TemplateVariables & { NAME: string })

			expect(result).toBe(`\`\`\`json\n${complexJson}\n\`\`\`\nHello World`)
		})

		it('should handle README content with code blocks containing curly braces', () => {
			// Code blocks with curly braces are safe since Handlebars only parses {{ }}
			const readmeWithCodeBlocks = `# My Project

\`\`\`typescript
const obj = { key: "value" }
\`\`\`
`
			const template = `${readmeWithCodeBlocks}\nVersion: {{VERSION}}`
			const result = manager.substituteVariables(template, { VERSION: '1.0.0' } as TemplateVariables & { VERSION: string })

			expect(result).toBe(`${readmeWithCodeBlocks}\nVersion: 1.0.0`)
		})

		it('should include conditional section when AUTO_COMMIT_PUSH is true', () => {
			const template = 'Start{{#if AUTO_COMMIT_PUSH}} auto-commit enabled {{/if}}End'
			const variables: TemplateVariables = { AUTO_COMMIT_PUSH: true }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('Start auto-commit enabled End')
		})

		it('should exclude conditional section when AUTO_COMMIT_PUSH is false', () => {
			const template = 'Start{{#if AUTO_COMMIT_PUSH}} auto-commit enabled {{/if}}End'
			const variables: TemplateVariables = { AUTO_COMMIT_PUSH: false }

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('StartEnd')
		})

		it('should exclude conditional section when AUTO_COMMIT_PUSH is undefined', () => {
			const template = 'Start{{#if AUTO_COMMIT_PUSH}} auto-commit enabled {{/if}}End'
			const variables: TemplateVariables = {}

			const result = manager.substituteVariables(template, variables)

			expect(result).toBe('StartEnd')
		})

		it('should handle nested DRAFT_PR_MODE and AUTO_COMMIT_PUSH conditionals', () => {
			const template = `{{#if DRAFT_PR_MODE}}Draft PR{{#if AUTO_COMMIT_PUSH}} with auto-commit{{/if}}{{/if}}`

			// Both true
			const resultBothTrue = manager.substituteVariables(template, { DRAFT_PR_MODE: true, AUTO_COMMIT_PUSH: true })
			expect(resultBothTrue).toBe('Draft PR with auto-commit')

			// DRAFT_PR_MODE true, AUTO_COMMIT_PUSH false
			const resultDraftOnly = manager.substituteVariables(template, { DRAFT_PR_MODE: true, AUTO_COMMIT_PUSH: false })
			expect(resultDraftOnly).toBe('Draft PR')

			// DRAFT_PR_MODE false (nested content not evaluated)
			const resultNoDraft = manager.substituteVariables(template, { DRAFT_PR_MODE: false, AUTO_COMMIT_PUSH: true })
			expect(resultNoDraft).toBe('')
		})
	})

	describe('getPrompt', () => {
		it('should load and substitute variables for issue template', async () => {
			const template = 'Work on issue {{ISSUE_NUMBER}}: {{ISSUE_TITLE}}'
			vi.mocked(readFile).mockResolvedValueOnce(template)

			const variables: TemplateVariables = {
				ISSUE_NUMBER: 123,
				ISSUE_TITLE: 'Add authentication',
			}

			const result = await manager.getPrompt('issue', variables)

			expect(result).toBe('Work on issue 123: Add authentication')
			expect(readFile).toHaveBeenCalledWith('templates/prompts/issue-prompt.txt', 'utf-8')
		})

		it('should load and substitute variables for pr template', async () => {
			const template = 'Review PR {{PR_NUMBER}}'
			vi.mocked(readFile).mockResolvedValueOnce(template)

			const variables: TemplateVariables = { PR_NUMBER: 456 }

			const result = await manager.getPrompt('pr', variables)

			expect(result).toBe('Review PR 456')
			expect(readFile).toHaveBeenCalledWith('templates/prompts/pr-prompt.txt', 'utf-8')
		})

		it('should load regular template without substitution', async () => {
			const template = 'Regular workflow instructions'
			vi.mocked(readFile).mockResolvedValueOnce(template)

			const result = await manager.getPrompt('regular', {})

			expect(result).toBe('Regular workflow instructions')
			expect(readFile).toHaveBeenCalledWith('templates/prompts/regular-prompt.txt', 'utf-8')
		})

		it('should handle template loading errors', async () => {
			vi.mocked(readFile).mockRejectedValueOnce(new Error('File not found'))

			await expect(manager.getPrompt('issue', {})).rejects.toThrow(
				'Template not found: templates/prompts/issue-prompt.txt'
			)
		})

		it('should handle complex variable substitution', async () => {
			const template =
				'Issue {{ISSUE_NUMBER}} at {{WORKSPACE_PATH}}\nTitle: {{ISSUE_TITLE}}\nPort: {{PORT}}'
			vi.mocked(readFile).mockResolvedValueOnce(template)

			const variables: TemplateVariables = {
				ISSUE_NUMBER: 789,
				ISSUE_TITLE: 'Complex feature',
				WORKSPACE_PATH: '/complex/path',
				PORT: 3789,
			}

			const result = await manager.getPrompt('issue', variables)

			expect(result).toBe(
				'Issue 789 at /complex/path\nTitle: Complex feature\nPort: 3789'
			)
		})

		it('should process conditional sections and variables together', async () => {
			const template = 'Issue {{ISSUE_NUMBER}}{{#if ONE_SHOT_MODE}} (one-shot mode){{/if}}'
			vi.mocked(readFile).mockResolvedValueOnce(template)

			const variables: TemplateVariables = {
				ISSUE_NUMBER: 123,
				ONE_SHOT_MODE: true,
			}

			const result = await manager.getPrompt('issue', variables)

			expect(result).toBe('Issue 123 (one-shot mode)')
		})

		it('should exclude conditional sections when ONE_SHOT_MODE is false', async () => {
			const template = 'Issue {{ISSUE_NUMBER}}{{#if ONE_SHOT_MODE}} (one-shot mode){{/if}}'
			vi.mocked(readFile).mockResolvedValueOnce(template)

			const variables: TemplateVariables = {
				ISSUE_NUMBER: 123,
				ONE_SHOT_MODE: false,
			}

			const result = await manager.getPrompt('issue', variables)

			expect(result).toBe('Issue 123')
		})
	})
})

describe('buildReviewTemplateVariables', () => {
	describe('code reviewer', () => {
		it('should default REVIEW_ENABLED to true when no iloom-code-reviewer settings', () => {
			const result = buildReviewTemplateVariables({})

			expect(result.REVIEW_ENABLED).toBe(true)
		})

		it('should set REVIEW_ENABLED to false when iloom-code-reviewer is disabled', () => {
			const result = buildReviewTemplateVariables({
				'iloom-code-reviewer': { enabled: false },
			})

			expect(result.REVIEW_ENABLED).toBe(false)
		})

		it('should not set provider flags when review is disabled', () => {
			const result = buildReviewTemplateVariables({
				'iloom-code-reviewer': { enabled: false },
			})

			expect(result.HAS_REVIEW_CLAUDE).toBeUndefined()
			expect(result.HAS_REVIEW_GEMINI).toBeUndefined()
			expect(result.HAS_REVIEW_CODEX).toBeUndefined()
			expect(result.REVIEW_CLAUDE_MODEL).toBeUndefined()
		})

		it('should default to Claude with sonnet model when no providers specified', () => {
			const result = buildReviewTemplateVariables({})

			expect(result.HAS_REVIEW_CLAUDE).toBe(true)
			expect(result.REVIEW_CLAUDE_MODEL).toBe('sonnet')
			expect(result.HAS_REVIEW_GEMINI).toBe(false)
			expect(result.HAS_REVIEW_CODEX).toBe(false)
		})

		it('should set provider flags based on configured providers', () => {
			const result = buildReviewTemplateVariables({
				'iloom-code-reviewer': {
					providers: {
						claude: 'opus',
						gemini: 'gemini-3-pro',
					},
				},
			})

			expect(result.HAS_REVIEW_CLAUDE).toBe(true)
			expect(result.REVIEW_CLAUDE_MODEL).toBe('opus')
			expect(result.HAS_REVIEW_GEMINI).toBe(true)
			expect(result.REVIEW_GEMINI_MODEL).toBe('gemini-3-pro')
			expect(result.HAS_REVIEW_CODEX).toBe(false)
			expect(result.REVIEW_CODEX_MODEL).toBeUndefined()
		})

		it('should not default to Claude when other providers are specified without claude', () => {
			const result = buildReviewTemplateVariables({
				'iloom-code-reviewer': {
					providers: {
						gemini: 'gemini-3-flash',
					},
				},
			})

			expect(result.HAS_REVIEW_CLAUDE).toBe(false)
			expect(result.REVIEW_CLAUDE_MODEL).toBeUndefined()
			expect(result.HAS_REVIEW_GEMINI).toBe(true)
			expect(result.REVIEW_GEMINI_MODEL).toBe('gemini-3-flash')
		})

		it('should set codex provider flags when configured', () => {
			const result = buildReviewTemplateVariables({
				'iloom-code-reviewer': {
					providers: {
						codex: 'gpt-5.1-codex',
					},
				},
			})

			expect(result.HAS_REVIEW_CODEX).toBe(true)
			expect(result.REVIEW_CODEX_MODEL).toBe('gpt-5.1-codex')
			expect(result.HAS_REVIEW_CLAUDE).toBe(false)
		})
	})

	describe('artifact reviewer', () => {
		it('should default ARTIFACT_REVIEW_ENABLED to true when no iloom-artifact-reviewer settings', () => {
			const result = buildReviewTemplateVariables({})

			expect(result.ARTIFACT_REVIEW_ENABLED).toBe(true)
		})

		it('should set ARTIFACT_REVIEW_ENABLED to false when disabled', () => {
			const result = buildReviewTemplateVariables({
				'iloom-artifact-reviewer': { enabled: false },
			})

			expect(result.ARTIFACT_REVIEW_ENABLED).toBe(false)
		})

		it('should not set artifact provider flags when disabled', () => {
			const result = buildReviewTemplateVariables({
				'iloom-artifact-reviewer': { enabled: false },
			})

			expect(result.HAS_ARTIFACT_REVIEW_CLAUDE).toBeUndefined()
			expect(result.HAS_ARTIFACT_REVIEW_GEMINI).toBeUndefined()
			expect(result.HAS_ARTIFACT_REVIEW_CODEX).toBeUndefined()
		})

		it('should default to Claude with sonnet model when no providers specified', () => {
			const result = buildReviewTemplateVariables({
				'iloom-artifact-reviewer': { enabled: true },
			})

			expect(result.HAS_ARTIFACT_REVIEW_CLAUDE).toBe(true)
			expect(result.ARTIFACT_REVIEW_CLAUDE_MODEL).toBe('sonnet')
			expect(result.HAS_ARTIFACT_REVIEW_GEMINI).toBe(false)
			expect(result.HAS_ARTIFACT_REVIEW_CODEX).toBe(false)
		})

		it('should set artifact provider flags based on configured providers', () => {
			const result = buildReviewTemplateVariables({
				'iloom-artifact-reviewer': {
					enabled: true,
					providers: {
						claude: 'sonnet',
						gemini: 'gemini-3-pro',
					},
				},
			})

			expect(result.HAS_ARTIFACT_REVIEW_CLAUDE).toBe(true)
			expect(result.ARTIFACT_REVIEW_CLAUDE_MODEL).toBe('sonnet')
			expect(result.HAS_ARTIFACT_REVIEW_GEMINI).toBe(true)
			expect(result.ARTIFACT_REVIEW_GEMINI_MODEL).toBe('gemini-3-pro')
			expect(result.HAS_ARTIFACT_REVIEW_CODEX).toBe(false)
		})

		it('should not default to Claude when other providers are specified without claude', () => {
			const result = buildReviewTemplateVariables({
				'iloom-artifact-reviewer': {
					providers: {
						codex: 'gpt-5.1-codex',
					},
				},
			})

			expect(result.HAS_ARTIFACT_REVIEW_CLAUDE).toBe(false)
			expect(result.ARTIFACT_REVIEW_CLAUDE_MODEL).toBeUndefined()
			expect(result.HAS_ARTIFACT_REVIEW_CODEX).toBe(true)
			expect(result.ARTIFACT_REVIEW_CODEX_MODEL).toBe('gpt-5.1-codex')
		})
	})

	describe('per-agent review flags', () => {
		it('should set per-agent review flags when review is true', () => {
			const result = buildReviewTemplateVariables({
				'iloom-issue-enhancer': { review: true },
				'iloom-issue-analyzer': { review: true },
				'iloom-issue-planner': { review: true },
				'iloom-issue-analyze-and-plan': { review: true },
				'iloom-issue-implementer': { review: true },
				'iloom-issue-complexity-evaluator': { review: true },
			})

			expect(result.ENHANCER_REVIEW_ENABLED).toBe(true)
			expect(result.ANALYZER_REVIEW_ENABLED).toBe(true)
			expect(result.PLANNER_REVIEW_ENABLED).toBe(true)
			expect(result.ANALYZE_AND_PLAN_REVIEW_ENABLED).toBe(true)
			expect(result.IMPLEMENTER_REVIEW_ENABLED).toBe(true)
			expect(result.COMPLEXITY_REVIEW_ENABLED).toBe(true)
		})

		it('should default per-agent review flags to false when not configured', () => {
			const result = buildReviewTemplateVariables({})

			expect(result.ENHANCER_REVIEW_ENABLED).toBe(false)
			expect(result.ANALYZER_REVIEW_ENABLED).toBe(false)
			expect(result.PLANNER_REVIEW_ENABLED).toBe(false)
			expect(result.ANALYZE_AND_PLAN_REVIEW_ENABLED).toBe(false)
			expect(result.IMPLEMENTER_REVIEW_ENABLED).toBe(false)
			expect(result.COMPLEXITY_REVIEW_ENABLED).toBe(false)
		})

		it('should set individual per-agent flags independently', () => {
			const result = buildReviewTemplateVariables({
				'iloom-issue-enhancer': { review: true },
				'iloom-issue-planner': { review: true },
				'iloom-issue-analyzer': { review: false },
			})

			expect(result.ENHANCER_REVIEW_ENABLED).toBe(true)
			expect(result.PLANNER_REVIEW_ENABLED).toBe(true)
			expect(result.ANALYZER_REVIEW_ENABLED).toBe(false)
			expect(result.IMPLEMENTER_REVIEW_ENABLED).toBe(false)
		})
	})

	describe('null and undefined agents', () => {
		it('should handle null agents parameter', () => {
			const result = buildReviewTemplateVariables(null)

			expect(result.REVIEW_ENABLED).toBe(true)
			expect(result.ARTIFACT_REVIEW_ENABLED).toBe(true)
			expect(result.HAS_REVIEW_CLAUDE).toBe(true)
			expect(result.REVIEW_CLAUDE_MODEL).toBe('sonnet')
			expect(result.ENHANCER_REVIEW_ENABLED).toBe(false)
			expect(result.ANALYZER_REVIEW_ENABLED).toBe(false)
			expect(result.PLANNER_REVIEW_ENABLED).toBe(false)
		})

		it('should handle undefined agents parameter', () => {
			const result = buildReviewTemplateVariables(undefined)

			expect(result.REVIEW_ENABLED).toBe(true)
			expect(result.ARTIFACT_REVIEW_ENABLED).toBe(true)
			expect(result.HAS_REVIEW_CLAUDE).toBe(true)
			expect(result.REVIEW_CLAUDE_MODEL).toBe('sonnet')
			expect(result.ENHANCER_REVIEW_ENABLED).toBe(false)
		})

		it('should handle calling with no arguments', () => {
			const result = buildReviewTemplateVariables()

			expect(result.REVIEW_ENABLED).toBe(true)
			expect(result.ARTIFACT_REVIEW_ENABLED).toBe(true)
			expect(result.HAS_REVIEW_CLAUDE).toBe(true)
		})
	})
})
