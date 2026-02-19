import { describe, test, expect } from 'vitest'
import { convertDetailsToExpandSyntax, markdownToAdf } from './AdfMarkdownConverter.js'

// Type definition for ADF nodes used in tests
interface AdfNode {
	type: string
	content?: AdfNode[]
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
	text?: string
	attrs?: Record<string, unknown>
}

// Helper function to find text nodes with code marks in ADF tree
function findTextNodesWithCodeMark(node: AdfNode): AdfNode[] {
	const results: AdfNode[] = []

	if (node.type === 'text' && node.marks?.some((mark) => mark.type === 'code')) {
		results.push(node)
	}

	if (node.content && Array.isArray(node.content)) {
		for (const child of node.content) {
			results.push(...findTextNodesWithCodeMark(child))
		}
	}

	return results
}

describe('AdfMarkdownConverter', () => {
	describe('convertDetailsToExpandSyntax', () => {
		test('converts basic details/summary block', () => {
			const input = `<details>
<summary>Header</summary>
CONTENT
</details>`

			const expected = `~~~expand title="Header"
CONTENT
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles multiple details blocks', () => {
			const input = `First block:
<details>
<summary>First Header</summary>
First content
</details>

Some text in between

<details>
<summary>Second Header</summary>
Second content
</details>`

			const expected = `First block:
~~~expand title="First Header"
First content
~~~

Some text in between

~~~expand title="Second Header"
Second content
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles extra whitespace before and after content', () => {
			const input = `<details>
<summary>Header</summary>


Content with extra newlines


</details>`

			const expected = `~~~expand title="Header"
Content with extra newlines
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles empty content', () => {
			const input = `<details>
<summary>Header</summary>
</details>`

			const expected = `~~~expand title="Header"
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles content with code blocks', () => {
			const input = `<details>
<summary>Error Details</summary>

\`\`\`typescript
const error = new Error('test')
console.log(error)
\`\`\`

</details>`

			const expected = `~~~expand title="Error Details"
\`\`\`typescript
const error = new Error('test')
console.log(error)
\`\`\`
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles nested details blocks (2-level)', () => {
			const input = `<details>
<summary>Outer Header</summary>

This is some outer content

<details>
<summary>Inner Header</summary>
This is some inner content
</details>

</details>`

			const expected = `~~~expand title="Outer Header"
This is some outer content

~~~expand title="Inner Header"
This is some inner content
~~~
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles nested details blocks (3-level)', () => {
			const input = `<details>
<summary>Level 1</summary>

Content at level 1

<details>
<summary>Level 2</summary>

Content at level 2

<details>
<summary>Level 3</summary>
Content at level 3
</details>

</details>

</details>`

			const expected = `~~~expand title="Level 1"
Content at level 1

~~~expand title="Level 2"
Content at level 2

~~~expand title="Level 3"
Content at level 3
~~~
~~~
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles mixed nested and non-nested blocks', () => {
			const input = `<details>
<summary>First Block</summary>
Simple content
</details>

Some text in between

<details>
<summary>Nested Block</summary>

Outer content

<details>
<summary>Inner Block</summary>
Inner content
</details>

</details>`

			const expected = `~~~expand title="First Block"
Simple content
~~~

Some text in between

~~~expand title="Nested Block"
Outer content

~~~expand title="Inner Block"
Inner content
~~~
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles details tag with attributes', () => {
			const input = `<details open>
<summary>Expanded by Default</summary>
Content here
</details>`

			const expected = `~~~expand title="Expanded by Default"
Content here
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles summary tag with attributes', () => {
			const input = `<details>
<summary class="custom-class" id="test-id">Header</summary>
Content here
</details>`

			const expected = `~~~expand title="Header"
Content here
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles HTML entities in summary', () => {
			const input = `<details>
<summary>&lt;Component&gt; Details</summary>
Content here
</details>`

			const expected = `~~~expand title="<Component> Details"
Content here
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles case-insensitive HTML tags', () => {
			const input = `<DETAILS>
<SUMMARY>Header</SUMMARY>
Content
</DETAILS>`

			const expected = `~~~expand title="Header"
Content
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('returns original text if no details blocks', () => {
			const input = `Just some regular text
with multiple lines
and no details blocks`

			expect(convertDetailsToExpandSyntax(input)).toBe(input)
		})

		test('returns empty string for empty input', () => {
			expect(convertDetailsToExpandSyntax('')).toBe('')
		})

		test('returns null for null input', () => {
			expect(convertDetailsToExpandSyntax(null as unknown as string)).toBe(null)
		})

		test('returns undefined for undefined input', () => {
			expect(convertDetailsToExpandSyntax(undefined as unknown as string)).toBe(undefined)
		})

		test('handles malformed HTML gracefully - missing closing tag', () => {
			const input = '<details><summary>Header</summary>Content' // Missing closing tag

			// Should not throw, just return original text
			expect(() => convertDetailsToExpandSyntax(input)).not.toThrow()
			expect(convertDetailsToExpandSyntax(input)).toBe(input)
		})

		test('handles malformed HTML gracefully - missing summary tag', () => {
			const input = '<details>Content without summary</details>'

			// Should not throw, just return original text
			expect(() => convertDetailsToExpandSyntax(input)).not.toThrow()
			expect(convertDetailsToExpandSyntax(input)).toBe(input)
		})

		test('handles unicode characters', () => {
			const input = `<details>
<summary>Unicode Test 🚀</summary>
Content with émojis 🎉 and àccénts
</details>`

			const expected = `~~~expand title="Unicode Test 🚀"
Content with émojis 🎉 and àccénts
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('real-world workflow example', () => {
			const input = `## Implementation Progress

<details>
<summary>📋 Complete Context & Details (click to expand)</summary>

### Phase 1: Setup
- [x] Create files
- [x] Write tests

### Phase 2: Testing
- [ ] Run tests

</details>

Last updated: 2025-01-16`

			const expected = `## Implementation Progress

~~~expand title="📋 Complete Context & Details (click to expand)"
### Phase 1: Setup
- [x] Create files
- [x] Write tests

### Phase 2: Testing
- [ ] Run tests
~~~

Last updated: 2025-01-16`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('normalizes excessive blank lines in content', () => {
			const input = `<details>
<summary>Header</summary>

Content line 1



Content line 2




Content line 3

</details>`

			const expected = `~~~expand title="Header"
Content line 1

Content line 2

Content line 3
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles special characters in content', () => {
			const input = `<details>
<summary>Special Chars</summary>
!@#$%^&*()_+-=[]{}|;':",./<>?
</details>`

			const expected = `~~~expand title="Special Chars"
!@#$%^&*()_+-=[]{}|;':",./<>?
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles content with HTML tags that should be preserved', () => {
			const input = `<details>
<summary>HTML Content</summary>
Some text with <strong>bold</strong> and <em>italic</em>
</details>`

			const expected = `~~~expand title="HTML Content"
Some text with <strong>bold</strong> and <em>italic</em>
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})

		test('handles extremely long content', () => {
			const longContent = 'Line\n'.repeat(1000)
			const input = `<details>
<summary>Long Content</summary>
${longContent}
</details>`

			const result = convertDetailsToExpandSyntax(input)
			expect(result).toContain('~~~expand title="Long Content"')
			expect(result).toContain('~~~')
			expect(result.length).toBeGreaterThan(longContent.length)
		})

		test('handles all HTML entity types', () => {
			const input = `<details>
<summary>&lt;div&gt; &amp; &quot;quotes&quot; &#39;apostrophe&#39;</summary>
Content
</details>`

			const expected = `~~~expand title="<div> & "quotes" 'apostrophe'"
Content
~~~`

			expect(convertDetailsToExpandSyntax(input)).toBe(expected)
		})
	})

	describe('markdownToAdf', () => {
		test('returns empty doc for empty input', () => {
			expect(markdownToAdf('')).toEqual({ type: 'doc', version: 1, content: [] })
		})

		test('returns empty doc for null input', () => {
			expect(markdownToAdf(null as unknown as string)).toEqual({ type: 'doc', version: 1, content: [] })
		})

		test('returns empty doc for undefined input', () => {
			expect(markdownToAdf(undefined as unknown as string)).toEqual({ type: 'doc', version: 1, content: [] })
		})

		test('converts plain text to ADF', () => {
			const result = markdownToAdf('Hello world')
			expect(result).toHaveProperty('type', 'doc')
			expect(result).toHaveProperty('version', 1)
			expect(result).toHaveProperty('content')
		})

		test('converts details/summary to ADF expand node', () => {
			const input = `<details>
<summary>Click to expand</summary>
Hidden content
</details>`

			const result = markdownToAdf(input)
			expect(result).toHaveProperty('type', 'doc')
			expect(result).toHaveProperty('content')

			// The ADF should contain an expand node (since the preprocessing converts to expand syntax)
			const content = (result as { content: unknown[] }).content
			expect(content.length).toBeGreaterThan(0)

			// Find the expand node in the content
			const hasExpandNode = content.some((node: unknown) => {
				return (node as { type: string }).type === 'expand'
			})
			expect(hasExpandNode).toBe(true)
		})

		test('converts nested details/summary correctly', () => {
			const input = `<details>
<summary>Outer</summary>
Outer content
<details>
<summary>Inner</summary>
Inner content
</details>
</details>`

			const result = markdownToAdf(input)
			expect(result).toHaveProperty('type', 'doc')

			// Should have expand nodes
			const content = (result as { content: unknown[] }).content
			const expandNodes = content.filter((node: unknown) => (node as { type: string }).type === 'expand')
			expect(expandNodes.length).toBeGreaterThanOrEqual(1)
		})

		test('preserves regular markdown content alongside details blocks', () => {
			const input = `# Heading

Some regular text

<details>
<summary>Expandable</summary>
Hidden content
</details>

More text`

			const result = markdownToAdf(input)
			expect(result).toHaveProperty('type', 'doc')

			const content = (result as { content: unknown[] }).content
			// Should have multiple content nodes (heading, paragraphs, expand)
			expect(content.length).toBeGreaterThan(1)
		})

		test('handles markdown with emoji in summary', () => {
			const input = `<details>
<summary>📋 Complete Context</summary>
Content here
</details>`

			const result = markdownToAdf(input)
			expect(result).toHaveProperty('type', 'doc')

			// Should have an expand node with the title including emoji
			const content = (result as { content: unknown[] }).content
			const expandNode = content.find((node: unknown) => (node as { type: string }).type === 'expand')
			expect(expandNode).toBeDefined()
			expect((expandNode as { attrs: { title: string } }).attrs.title).toBe('📋 Complete Context')
		})

		// Tests for code mark sanitization - ADF spec requires code marks to be standalone
		describe('code mark sanitization', () => {
			test('code mark only remains unchanged', () => {
				const input = 'Some `code` here'
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
				expect(codeNodes[0].text).toBe('code')
			})

			test('code with bold mark - removes bold, keeps only code', () => {
				const input = '**bold `code`**'
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
				expect(codeNodes[0].text).toBe('code')
			})

			test('code with italic mark - removes italic, keeps only code', () => {
				const input = '*italic `code`*'
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
				expect(codeNodes[0].text).toBe('code')
			})

			test('code with multiple marks (bold + italic) - removes all, keeps only code', () => {
				const input = '***bold italic `code`***'
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
				expect(codeNodes[0].text).toBe('code')
			})

			test('code inside link - removes link mark, keeps only code', () => {
				const input = '[`code link`](https://example.com)'
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
				expect(codeNodes[0].text).toBe('code link')
			})

			test('nested content with code marks is recursively sanitized', () => {
				// Blockquote with bold code inside
				const input = `> **bold \`code\`** in blockquote`
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
			})

			test('no code marks - text remains unchanged', () => {
				const input = '**bold** and *italic* text'
				const result = markdownToAdf(input) as AdfNode

				// Should have bold and italic marks, but no code
				const codeNodes = findTextNodesWithCodeMark(result)
				expect(codeNodes.length).toBe(0)

				// The bold and italic text should still have their marks
				const content = result.content || []
				expect(content.length).toBeGreaterThan(0)
			})

			test('multiple text nodes - only code-marked nodes are affected', () => {
				const input = '**bold** and `code` and *italic*'
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				// Only one code node
				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])

				// Other marks should be preserved
				const content = result.content || []
				const paragraph = content[0]
				const textNodes = (paragraph?.content || []) as AdfNode[]

				// Find the bold text node
				const boldNode = textNodes.find(
					(node) => node.type === 'text' && node.marks?.some((m) => m.type === 'strong')
				)
				expect(boldNode).toBeDefined()

				// Find the italic text node
				const italicNode = textNodes.find(
					(node) => node.type === 'text' && node.marks?.some((m) => m.type === 'em')
				)
				expect(italicNode).toBeDefined()
			})

			test('handles text with no marks array', () => {
				const input = 'Plain text with no formatting'
				const result = markdownToAdf(input) as AdfNode

				// Should not throw and should have content
				expect(result.type).toBe('doc')
				expect(result.content?.length).toBeGreaterThan(0)
			})

			test('handles deeply nested structure with code marks', () => {
				// List with nested content containing code
				const input = `- Item with **\`code\`** inside`
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				expect(codeNodes.length).toBe(1)
				expect(codeNodes[0].marks).toEqual([{ type: 'code' }])
			})

			test('mixed content - code inside various formatting preserved correctly', () => {
				const input = `Text with **bold \`code1\`** and *italic \`code2\`* and plain \`code3\``
				const result = markdownToAdf(input) as AdfNode
				const codeNodes = findTextNodesWithCodeMark(result)

				// All three code nodes should only have code marks
				expect(codeNodes.length).toBe(3)
				for (const node of codeNodes) {
					expect(node.marks).toEqual([{ type: 'code' }])
				}
			})
		})
	})
})
