import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentManager, type AgentConfigs } from './AgentManager.js'
import { readFile } from 'fs/promises'
import fg from 'fast-glob'

vi.mock('fs/promises')
vi.mock('fast-glob')
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

describe('AgentManager', () => {
	let manager: AgentManager

	beforeEach(() => {
		manager = new AgentManager('templates/agents')
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('loadAgents', () => {
		it('should load all three agent markdown files successfully', async () => {
			// Mock fast-glob to return the agent filenames
			vi.mocked(fg).mockResolvedValueOnce([
				'iloom-issue-analyzer.md',
				'iloom-issue-planner.md',
				'iloom-issue-implementer.md',
			])

			// Mock readFile to return valid markdown for each agent
			const mockAnalyzerMd = `---
name: iloom-issue-analyzer
description: Analyzer agent
tools: Read, Grep
model: sonnet
color: pink
---

You are an analyzer`

			const mockPlannerMd = `---
name: iloom-issue-planner
description: Planner agent
tools: Read, Write
model: sonnet
color: blue
---

You are a planner`

			const mockImplementerMd = `---
name: iloom-issue-implementer
description: Implementer agent
tools: Edit, Bash
model: sonnet
color: green
---

You are an implementer`

			vi.mocked(readFile)
				.mockResolvedValueOnce(mockAnalyzerMd)
				.mockResolvedValueOnce(mockPlannerMd)
				.mockResolvedValueOnce(mockImplementerMd)

			const result = await manager.loadAgents()

			expect(Object.keys(result)).toHaveLength(3)
			expect(result['iloom-issue-analyzer']).toEqual({
				description: 'Analyzer agent',
				prompt: 'You are an analyzer',
				tools: ['Read', 'Grep'],
				model: 'sonnet',
				color: 'pink',
			})
			expect(result['iloom-issue-planner']).toEqual({
				description: 'Planner agent',
				prompt: 'You are a planner',
				tools: ['Read', 'Write'],
				model: 'sonnet',
				color: 'blue',
			})
			expect(result['iloom-issue-implementer']).toEqual({
				description: 'Implementer agent',
				prompt: 'You are an implementer',
				tools: ['Edit', 'Bash'],
				model: 'sonnet',
				color: 'green',
			})
		})

		it('should handle missing agent files gracefully', async () => {
			vi.mocked(fg).mockResolvedValueOnce([
				'iloom-issue-analyzer.md',
			])
			vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT: no such file'))

			await expect(manager.loadAgents()).rejects.toThrow(
				'Failed to load agent from iloom-issue-analyzer.md',
			)
		})

		it('should handle malformed markdown in agent files', async () => {
			vi.mocked(fg).mockResolvedValueOnce([
				'bad-agent.md',
			])
			// Markdown without proper frontmatter delimiters
			vi.mocked(readFile).mockResolvedValueOnce('Just some text without frontmatter')

			await expect(manager.loadAgents()).rejects.toThrow(
				'Failed to load agent from bad-agent.md',
			)
		})
	})

	describe('formatForCli', () => {
		it('should format agents as object for --agents flag', () => {
			const agents: AgentConfigs = {
				'test-agent': {
					description: 'Test',
					prompt: 'Test prompt',
					tools: ['Read'],
					model: 'sonnet',
					color: 'blue',
				},
			}

			const result = manager.formatForCli(agents)

			expect(result).toEqual(agents)
			expect(typeof result).toBe('object')
		})

		it('should include color field in output', () => {
			const agents: AgentConfigs = {
				'test-agent': {
					description: 'Test',
					prompt: 'Test prompt',
					tools: ['Read'],
					model: 'sonnet',
					color: 'pink',
				},
			}

			const result = manager.formatForCli(agents)

			expect(result['test-agent']).toHaveProperty('color', 'pink')
		})

		it('should preserve tools array structure', () => {
			const agents: AgentConfigs = {
				'test-agent': {
					description: 'Test',
					prompt: 'Test prompt',
					tools: ['Read', 'Write', 'Edit'],
					model: 'sonnet',
				},
			}

			const result = manager.formatForCli(agents)

			expect(Array.isArray(result['test-agent'].tools)).toBe(true)
			expect(result['test-agent'].tools).toHaveLength(3)
		})
	})

	describe('loadAgents - Markdown Support', () => {
		it('should successfully load agent from .md file with valid frontmatter', async () => {
			// Mock readdir to return .md file
			vi.mocked(fg).mockResolvedValueOnce([
				'test-agent.md',
			])

			// Mock readFile to return markdown with frontmatter
			const markdownContent = `---
name: test-agent
description: Test agent description
tools: Bash, Read, Write, Grep
model: sonnet
color: blue
---

You are a test agent.
This is the prompt content.`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(Object.keys(result)).toHaveLength(1)
			expect(result['test-agent']).toEqual({
				description: 'Test agent description',
				prompt: 'You are a test agent.\nThis is the prompt content.',
				tools: ['Bash', 'Read', 'Write', 'Grep'],
				model: 'sonnet',
				color: 'blue',
			})
		})

		it('should extract all required fields from frontmatter', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: full-agent
description: Full description
tools: Read, Write
model: opus
color: green
---

Agent prompt here.`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['full-agent']).toMatchObject({
				description: 'Full description',
				prompt: 'Agent prompt here.',
				tools: ['Read', 'Write'],
				model: 'opus',
				color: 'green',
			})
		})

		it('should handle multiline description field with embedded XML', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['complex-agent.md'])

			const markdownContent = `---
name: complex-agent
description: |
  Multi-line description with <example>XML tags</example>
  and newlines preserved.
tools: Read
model: sonnet
---

Prompt content`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['complex-agent'].description).toContain('<example>XML tags</example>')
			expect(result['complex-agent'].description).toContain('newlines preserved')
		})

		it('should parse name field from frontmatter', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['filename.md'])

			const markdownContent = `---
name: frontmatter-name
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			// Agent name should come from frontmatter, not filename
			expect(result['frontmatter-name']).toBeDefined()
			expect(result['filename']).toBeUndefined()
		})

		it('should convert comma-separated tools string to array', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: tools-agent
description: Test
tools: Bash, Read, Write
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['tools-agent'].tools).toEqual(['Bash', 'Read', 'Write'])
			expect(Array.isArray(result['tools-agent'].tools)).toBe(true)
		})

		it('should handle tools with special characters and patterns', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: special-tools-agent
description: Test
tools: mcp__context7__get-library-docs, Bash(gh api:*), Bash(gh pr view:*)
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['special-tools-agent'].tools).toEqual([
				'mcp__context7__get-library-docs',
				'Bash(gh api:*)',
				'Bash(gh pr view:*)',
			])
		})

		it('should trim whitespace from each tool name', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: whitespace-agent
description: Test
tools: Bash,  Read,   Write  ,Grep
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['whitespace-agent'].tools).toEqual(['Bash', 'Read', 'Write', 'Grep'])
		})

		it('should extract markdown body as prompt field', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: prompt-agent
description: Test
tools: Read
model: sonnet
---

This is the actual prompt.
It has multiple lines.
With various formatting.`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['prompt-agent'].prompt).toBe(
				'This is the actual prompt.\nIt has multiple lines.\nWith various formatting.'
			)
		})

		it('should preserve formatting in prompt', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: format-agent
description: Test
tools: Read
model: sonnet
---

# Heading

\`\`\`typescript
const code = "block";
\`\`\`

<example>XML tag</example>`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['format-agent'].prompt).toContain('# Heading')
			expect(result['format-agent'].prompt).toContain('```typescript')
			expect(result['format-agent'].prompt).toContain('<example>XML tag</example>')
		})

		it('should throw error for missing frontmatter delimiters', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['bad-agent.md'])

			const markdownContent = `name: bad-agent
description: Missing delimiters
tools: Read
model: sonnet

Just content without frontmatter`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			await expect(manager.loadAgents()).rejects.toThrow('Failed to load agent')
		})

		it('should throw error for missing required field: name', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
description: Missing name
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			await expect(manager.loadAgents()).rejects.toThrow('Missing required field: name')
		})

		it('should throw error for missing required field: description', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: no-desc-agent
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			await expect(manager.loadAgents()).rejects.toThrow('Missing required field: description')
		})

		it('should allow agents without tools field (tools inherits from parent)', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: no-tools-agent
description: Test
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const agents = await manager.loadAgents()
			expect(agents['no-tools-agent']).toBeDefined()
			expect(agents['no-tools-agent'].tools).toBeUndefined()
		})

		it('should throw error for missing required field: model', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: no-model-agent
description: Test
tools: Read
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			await expect(manager.loadAgents()).rejects.toThrow('Missing required field: model')
		})

		it('should handle optional color field', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

			const markdownContent = `---
name: no-color-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

			const result = await manager.loadAgents()

			expect(result['no-color-agent'].color).toBeUndefined()
		})
	})

	describe('validateAgentConfig - model validation', () => {
		it('should accept valid model aliases', async () => {
			const validModels = ['sonnet', 'opus', 'haiku']

			for (const model of validModels) {
				vi.clearAllMocks()
				vi.mocked(fg).mockResolvedValueOnce(['agent.md'])

				const markdownContent = `---
name: ${model}-agent
description: Test
tools: Read
model: ${model}
---

Prompt`

				vi.mocked(readFile).mockResolvedValueOnce(markdownContent)

				const result = await manager.loadAgents()

				expect(result[`${model}-agent`].model).toBe(model)
			}
		})
	})

	describe('loadAgents with settings overrides', () => {
		it('should merge settings model overrides into agent configs', async () => {
			vi.mocked(fg).mockResolvedValueOnce([
				'iloom-issue-analyzer.md',
				'iloom-issue-planner.md',
			])

			const mockAnalyzerMd = `---
name: iloom-issue-analyzer
description: Analyzer agent
tools: Read
model: sonnet
---

Analyzer prompt`

			const mockPlannerMd = `---
name: iloom-issue-planner
description: Planner agent
tools: Write
model: sonnet
---

Planner prompt`

			vi.mocked(readFile)
				.mockResolvedValueOnce(mockAnalyzerMd)
				.mockResolvedValueOnce(mockPlannerMd)

			const settings = {
				agents: {
					'iloom-issue-analyzer': {
						model: 'haiku',
					},
				},
			}

			const result = await manager.loadAgents(settings)

			// Analyzer should have overridden model
			expect(result['iloom-issue-analyzer'].model).toBe('haiku')
			// Planner should keep original model
			expect(result['iloom-issue-planner'].model).toBe('sonnet')
		})

		it('should preserve template model when agent not in settings', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: opus
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {},
			}

			const result = await manager.loadAgents(settings)

			expect(result['test-agent'].model).toBe('opus')
		})

		it('should use settings model when agent is overridden', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'test-agent': {
						model: 'haiku',
					},
				},
			}

			const result = await manager.loadAgents(settings)

			expect(result['test-agent'].model).toBe('haiku')
		})

		it('should handle settings with extra agents not in templates', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'test-agent': {
						model: 'opus',
					},
					'non-existent-agent': {
						model: 'haiku',
					},
				},
			}

			const result = await manager.loadAgents(settings)

			// Should apply override for existing agent
			expect(result['test-agent'].model).toBe('opus')
			// Should not create non-existent agent
			expect(result['non-existent-agent']).toBeUndefined()
		})

		it('should handle settings with missing model field (use template default)', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'test-agent': {},
				},
			}

			const result = await manager.loadAgents(settings)

			// Should keep original model when settings doesn't have model field
			expect(result['test-agent'].model).toBe('sonnet')
		})

		it('should maintain backward compatibility when settings is undefined', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const result = await manager.loadAgents(undefined)

			expect(result['test-agent'].model).toBe('sonnet')
		})

		it('should override multiple agents correctly', async () => {
			vi.mocked(fg).mockResolvedValueOnce([
				'agent1.md',
				'agent2.md',
				'agent3.md',
			])

			const mock1 = `---
name: agent1
description: Test
tools: Read
model: sonnet
---

Prompt`

			const mock2 = `---
name: agent2
description: Test
tools: Write
model: opus
---

Prompt`

			const mock3 = `---
name: agent3
description: Test
tools: Edit
model: haiku
---

Prompt`

			vi.mocked(readFile)
				.mockResolvedValueOnce(mock1)
				.mockResolvedValueOnce(mock2)
				.mockResolvedValueOnce(mock3)

			const settings = {
				agents: {
					'agent1': {
						model: 'haiku',
					},
					'agent3': {
						model: 'sonnet',
					},
				},
			}

			const result = await manager.loadAgents(settings)

			expect(result['agent1'].model).toBe('haiku')
			expect(result['agent2'].model).toBe('opus') // Not overridden
			expect(result['agent3'].model).toBe('sonnet')
		})
	})

	describe('model precedence with settings', () => {
		it('should prioritize settings model over template model', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
color: blue
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'test-agent': {
						model: 'haiku',
					},
				},
			}

			const result = await manager.loadAgents(settings)

			expect(result['test-agent']).toEqual({
				description: 'Test',
				prompt: 'Prompt',
				tools: ['Read'],
				model: 'haiku', // Settings value, not template value
				color: 'blue',
			})
		})

		it('should preserve all other agent config fields when overriding model', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test agent description
tools: Read, Write, Edit
model: sonnet
color: pink
---

Complex prompt with multiple lines
and various content.`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'test-agent': {
						model: 'opus',
					},
				},
			}

			const result = await manager.loadAgents(settings)

			// All fields except model should remain unchanged
			expect(result['test-agent'].description).toBe('Test agent description')
			expect(result['test-agent'].prompt).toBe('Complex prompt with multiple lines\nand various content.')
			expect(result['test-agent'].tools).toEqual(['Read', 'Write', 'Edit'])
			expect(result['test-agent'].color).toBe('pink')
			// Only model should be changed
			expect(result['test-agent'].model).toBe('opus')
		})
	})

	describe('loadAgents with pattern filtering', () => {
		it('should filter agents using glob patterns', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['iloom-framework-detector.md'])

			const mockDetectorMd = `---
name: iloom-framework-detector
description: Framework detector
tools: Read, Grep
model: sonnet
---

Detect framework`

			vi.mocked(readFile).mockResolvedValueOnce(mockDetectorMd)

			const result = await manager.loadAgents(undefined, undefined, ['iloom-framework-detector.md'])

			expect(Object.keys(result)).toHaveLength(1)
			expect(result['iloom-framework-detector']).toBeDefined()

			// Verify fast-glob was called with correct pattern
			expect(fg).toHaveBeenCalledWith(['iloom-framework-detector.md'], {
				cwd: 'templates/agents',
				onlyFiles: true,
			})
		})

		it('should support negation patterns to exclude specific agents', async () => {
			vi.mocked(fg).mockResolvedValueOnce([
				'iloom-issue-analyzer.md',
				'iloom-issue-planner.md',
			])

			const mockAnalyzerMd = `---
name: iloom-issue-analyzer
description: Analyzer
tools: Read
model: sonnet
---

Analyzer`

			const mockPlannerMd = `---
name: iloom-issue-planner
description: Planner
tools: Write
model: sonnet
---

Planner`

			vi.mocked(readFile)
				.mockResolvedValueOnce(mockAnalyzerMd)
				.mockResolvedValueOnce(mockPlannerMd)

			const result = await manager.loadAgents(undefined, undefined, ['*.md', '!iloom-framework-detector.md'])

			expect(Object.keys(result)).toHaveLength(2)
			expect(result['iloom-issue-analyzer']).toBeDefined()
			expect(result['iloom-issue-planner']).toBeDefined()
			expect(result['iloom-framework-detector']).toBeUndefined()

			// Verify fast-glob was called with negation pattern
			expect(fg).toHaveBeenCalledWith(['*.md', '!iloom-framework-detector.md'], {
				cwd: 'templates/agents',
				onlyFiles: true,
			})
		})

		it('should use default pattern *.md when no patterns provided', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			await manager.loadAgents()

			// Verify default pattern was used
			expect(fg).toHaveBeenCalledWith(['*.md'], {
				cwd: 'templates/agents',
				onlyFiles: true,
			})
		})

		it('should return empty object when no agents match pattern', async () => {
			vi.mocked(fg).mockResolvedValueOnce([])

			const result = await manager.loadAgents(undefined, undefined, ['nonexistent-agent.md'])

			expect(result).toEqual({})
		})
	})

	describe('loadAgents with artifact reviewer settings', () => {
		it('should set ARTIFACT_REVIEW_ENABLED to true when artifact reviewer is enabled', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt with {{ARTIFACT_REVIEW_ENABLED}}`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'iloom-artifact-reviewer': {
						enabled: true,
					},
				},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			expect(templateVariables.ARTIFACT_REVIEW_ENABLED).toBe(true)
		})

		it('should set ARTIFACT_REVIEW_ENABLED to false when artifact reviewer is disabled', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'iloom-artifact-reviewer': {
						enabled: false,
					},
				},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			expect(templateVariables.ARTIFACT_REVIEW_ENABLED).toBe(false)
		})

		it('should extract per-agent review flags to template variables', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'iloom-issue-enhancer': { review: true },
					'iloom-issue-planner': { review: true },
					'iloom-issue-analyzer': { review: false },
				},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			expect(templateVariables.ENHANCER_REVIEW_ENABLED).toBe(true)
			expect(templateVariables.PLANNER_REVIEW_ENABLED).toBe(true)
			expect(templateVariables.ANALYZER_REVIEW_ENABLED).toBe(false)
		})

		it('should set HAS_ARTIFACT_REVIEW_* flags based on providers', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'iloom-artifact-reviewer': {
						enabled: true,
						providers: {
							claude: 'sonnet',
							gemini: 'gemini-3-pro',
						},
					},
				},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			expect(templateVariables.HAS_ARTIFACT_REVIEW_CLAUDE).toBe(true)
			expect(templateVariables.HAS_ARTIFACT_REVIEW_GEMINI).toBe(true)
			expect(templateVariables.HAS_ARTIFACT_REVIEW_CODEX).toBe(false)
			expect(templateVariables.ARTIFACT_REVIEW_CLAUDE_MODEL).toBe('sonnet')
			expect(templateVariables.ARTIFACT_REVIEW_GEMINI_MODEL).toBe('gemini-3-pro')
		})

		it('should default to Claude when no providers specified for artifact reviewer', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {
					'iloom-artifact-reviewer': {
						enabled: true,
					},
				},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			expect(templateVariables.HAS_ARTIFACT_REVIEW_CLAUDE).toBe(true)
			expect(templateVariables.ARTIFACT_REVIEW_CLAUDE_MODEL).toBe('sonnet')
		})

		it('should default per-agent review flags to false when not configured', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			expect(templateVariables.ENHANCER_REVIEW_ENABLED).toBe(false)
			expect(templateVariables.ANALYZER_REVIEW_ENABLED).toBe(false)
			expect(templateVariables.PLANNER_REVIEW_ENABLED).toBe(false)
			expect(templateVariables.ANALYZE_AND_PLAN_REVIEW_ENABLED).toBe(false)
			expect(templateVariables.IMPLEMENTER_REVIEW_ENABLED).toBe(false)
			expect(templateVariables.COMPLEXITY_REVIEW_ENABLED).toBe(false)
		})

		it('should default ARTIFACT_REVIEW_ENABLED to true when no artifact reviewer settings', async () => {
			vi.mocked(fg).mockResolvedValueOnce(['test-agent.md'])

			const mockMd = `---
name: test-agent
description: Test
tools: Read
model: sonnet
---

Prompt`

			vi.mocked(readFile).mockResolvedValueOnce(mockMd)

			const settings = {
				agents: {},
			}

			const templateVariables = {} as Record<string, unknown>
			await manager.loadAgents(settings as never, templateVariables)

			// Default to true when enabled is not explicitly false
			expect(templateVariables.ARTIFACT_REVIEW_ENABLED).toBe(true)
		})
	})
})
