import { describe, it, expect } from 'vitest'
import { MarkdownAgentParser } from './MarkdownAgentParser.js'

describe('MarkdownAgentParser', () => {
	describe('parse - basic functionality', () => {
		it('should parse simple frontmatter and content', () => {
			const markdown = `---
name: test-agent
description: A test agent
model: sonnet
---

This is the content.`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data).toEqual({
				name: 'test-agent',
				description: 'A test agent',
				model: 'sonnet',
			})
			expect(result.content).toBe('\nThis is the content.')
		})

		it('should handle frontmatter with all agent fields', () => {
			const markdown = `---
name: full-agent
description: Full description
tools: Read, Write, Edit
model: opus
color: blue
---

Agent prompt here.`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data).toEqual({
				name: 'full-agent',
				description: 'Full description',
				tools: 'Read, Write, Edit',
				model: 'opus',
				color: 'blue',
			})
			expect(result.content).toBe('\nAgent prompt here.')
		})

		it('should preserve newlines in content', () => {
			const markdown = `---
name: multiline-agent
description: Test
model: sonnet
---

Line 1
Line 2
Line 3`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.content).toBe('\nLine 1\nLine 2\nLine 3')
		})

		it('should handle empty content after frontmatter', () => {
			const markdown = `---
name: empty-agent
description: Test
model: sonnet
---
`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data).toEqual({
				name: 'empty-agent',
				description: 'Test',
				model: 'sonnet',
			})
			expect(result.content).toBe('')
		})
	})

	describe('parse - multiline YAML values', () => {
		it('should parse multiline string with | indicator', () => {
			const markdown = `---
name: multiline-agent
description: |
  This is a multiline
  description with multiple lines
  preserved.
model: sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.name).toBe('multiline-agent')
			expect(result.data.description).toContain('This is a multiline')
			expect(result.data.description).toContain('description with multiple lines')
			expect(result.data.description).toContain('preserved.')
		})

		it('should handle multiline description with embedded XML', () => {
			const markdown = `---
name: xml-agent
description: |
  Description with <example>XML tags</example>
  and newlines preserved.
model: sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.description).toContain('<example>XML tags</example>')
			expect(result.data.description).toContain('newlines preserved')
		})

		it('should handle complex multiline description similar to real agent files', () => {
			const markdown = `---
name: complex-agent
description: |
  Use this agent when you need to analyze issues. Examples:
  <example>
  Context: User wants analysis
  user: "Analyze issue #42"
  assistant: "I'll analyze that"
  </example>
tools: Read, Write
model: sonnet
---

Prompt content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.description).toContain('Use this agent')
			expect(result.data.description).toContain('<example>')
			expect(result.data.description).toContain('user: "Analyze issue #42"')
			expect(result.data.description).toContain('</example>')
		})
	})

	describe('parse - content preservation', () => {
		it('should preserve markdown formatting in content', () => {
			const markdown = `---
name: format-agent
description: Test
model: sonnet
---

# Heading

\`\`\`typescript
const code = "block";
\`\`\`

<example>XML tag</example>`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.content).toContain('# Heading')
			expect(result.content).toContain('```typescript')
			expect(result.content).toContain('const code = "block";')
			expect(result.content).toContain('<example>XML tag</example>')
		})

		it('should preserve special characters in content', () => {
			const markdown = `---
name: special-agent
description: Test
model: sonnet
---

Special chars: !@#$%^&*()
Quotes: "double" and 'single'
Backslash: \\test\\path`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.content).toContain('!@#$%^&*()')
			expect(result.content).toContain('"double" and \'single\'')
			expect(result.content).toContain('\\test\\path')
		})
	})

	describe('parse - special tool values', () => {
		it('should handle tools with special characters', () => {
			const markdown = `---
name: special-tools
description: Test
tools: mcp__context7__get-library-docs, Bash(gh api:*), Read
model: sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.tools).toBe('mcp__context7__get-library-docs, Bash(gh api:*), Read')
		})

		it('should handle very long tools list', () => {
			const longTools =
				'Bash, Glob, Grep, Read, Edit, Write, NotebookEdit, WebFetch, TodoWrite, WebSearch, BashOutput, KillShell, SlashCommand'

			const markdown = `---
name: many-tools
description: Test
tools: ${longTools}
model: sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.tools).toBe(longTools)
		})
	})

	describe('parse - error cases', () => {
		it('should throw error for missing opening delimiter', () => {
			const markdown = `name: bad-agent
description: Missing delimiters
model: sonnet
---

Content`

			expect(() => MarkdownAgentParser.parse(markdown)).toThrow(
				'Missing opening frontmatter delimiter',
			)
		})

		it('should throw error for missing closing delimiter', () => {
			const markdown = `---
name: bad-agent
description: No closing delimiter
model: sonnet

Content without closing ---`

			expect(() => MarkdownAgentParser.parse(markdown)).toThrow(
				'Missing closing frontmatter delimiter',
			)
		})

		it('should handle empty frontmatter', () => {
			const markdown = `---
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data).toEqual({})
			expect(result.content).toBe('\nContent')
		})
	})

	describe('parse - edge cases', () => {
		it('should handle frontmatter with extra whitespace', () => {
			const markdown = `---
name:   spaced-agent
description:   Test with spaces
model:   sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.name).toBe('spaced-agent')
			expect(result.data.description).toBe('Test with spaces')
			expect(result.data.model).toBe('sonnet')
		})

		it('should handle values with colons', () => {
			const markdown = `---
name: colon-agent
description: Test with colon: in value
model: sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.description).toBe('Test with colon: in value')
		})

		it('should handle values with special characters', () => {
			const markdown = `---
name: special-agent
description: Test with @#$%^&*() chars
model: sonnet
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.description).toBe('Test with @#$%^&*() chars')
		})

		it('should handle hyphenated and underscored keys', () => {
			const markdown = `---
some-key: hyphenated
another_key: underscored
mixed-key_here: both
---

Content`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data['some-key']).toBe('hyphenated')
			expect(result.data['another_key']).toBe('underscored')
			expect(result.data['mixed-key_here']).toBe('both')
		})
	})

	describe('parse - real-world examples', () => {
		it('should parse structure similar to actual iloom agent files', () => {
			const markdown = `---
name: iloom-issue-analyzer
description: Use this agent when you need to analyze and research GitHub issues, bugs, or enhancement requests. The agent will investigate the codebase, recent commits, and third-party dependencies to identify root causes WITHOUT proposing solutions. Ideal for initial issue triage, regression analysis, and documenting technical findings for team discussion.\\n\\nExamples:\\n<example>\\nContext: User wants to analyze a newly reported bug in issue #42\\nuser: "Please analyze issue #42 - users are reporting that the login button doesn't work on mobile"\\nassistant: "I'll use the github-issue-analyzer agent to investigate this issue and document my findings."\\n<commentary>\\nSince this is a request to analyze a GitHub issue, use the Task tool to launch the github-issue-analyzer agent to research the problem.\\n</commentary>\\n</example>
tools: Bash, Glob, Grep, Read, Edit, Write, NotebookEdit, WebFetch, TodoWrite, WebSearch, BashOutput, KillShell, SlashCommand, ListMcpResourcesTool, ReadMcpResourceTool, mcp__context7__resolve-library-id, mcp__context7__get-library-docs, mcp__figma-dev-mode-mcp-server__get_code, mcp__figma-dev-mode-mcp-server__get_variable_defs, mcp__figma-dev-mode-mcp-server__get_code_connect_map, mcp__figma-dev-mode-mcp-server__get_screenshot, mcp__figma-dev-mode-mcp-server__get_metadata, mcp__figma-dev-mode-mcp-server__add_code_connect_map, mcp__figma-dev-mode-mcp-server__create_design_system_rules, Bash(gh api:*), Bash(gh pr view:*), Bash(gh issue view:*),Bash(gh issue comment:*),Bash(git show:*),mcp__issue_management__update_comment, mcp__issue_management__create_comment
color: pink
model: sonnet
---

You are Claude, an elite GitHub issue analyst specializing in deep technical investigation and root cause analysis.`

			const result = MarkdownAgentParser.parse(markdown)

			expect(result.data.name).toBe('iloom-issue-analyzer')
			expect(result.data.description).toContain('Use this agent when you need to analyze')
			expect(result.data.description).toContain('<example>')
			expect(result.data.tools).toContain('Bash, Glob, Grep, Read')
			expect(result.data.tools).toContain('mcp__context7__resolve-library-id')
			expect(result.data.tools).toContain('Bash(gh api:*)')
			expect(result.data.color).toBe('pink')
			expect(result.data.model).toBe('sonnet')
			expect(result.content).toContain(
				'You are Claude, an elite GitHub issue analyst specializing in deep technical investigation',
			)
		})
	})
})
