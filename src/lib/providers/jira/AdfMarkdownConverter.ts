// AdfMarkdownConverter - Converts between Atlassian Document Format (ADF) and Markdown
// Uses extended-markdown-adf-parser for bidirectional conversion

import { ADFDocument, Parser } from 'extended-markdown-adf-parser'

const parser = new Parser()

/**
 * Represents a node in the ADF tree structure
 */
interface AdfNode {
	type: string
	content?: AdfNode[]
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
	text?: string
	attrs?: Record<string, unknown>
}

/**
 * Recursively traverse ADF tree and ensure code-marked text only has the code mark.
 * ADF specification requires that code marks are standalone - no other marks allowed.
 */
function sanitizeCodeMarks(node: AdfNode): AdfNode {
	// If node has marks and one of them is 'code', keep only the code mark
	if (node.marks?.some((mark) => mark.type === 'code')) {
		node.marks = [{ type: 'code' }]
	}

	// Recursively process child nodes
	if (node.content && Array.isArray(node.content)) {
		node.content = node.content.map((child) => sanitizeCodeMarks(child))
	}

	return node
}

/**
 * Block-level ADF node types that can appear directly inside table cells.
 * Any node type NOT in this set is considered inline and must be wrapped in a paragraph.
 */
const BLOCK_LEVEL_TYPES = new Set([
	'paragraph',
	'bulletList',
	'orderedList',
	'codeBlock',
	'heading',
	'blockquote',
	'rule',
	'mediaGroup',
	'nestedExpand',
	'panel',
	'table',
	'taskList',
	'decisionList',
	'mediaSingle',
])

/**
 * Recursively traverse ADF tree and ensure tableCell/tableHeader content
 * is wrapped in block-level nodes. Jira's ADF spec requires that table cells
 * only contain block-level nodes (like paragraph), not inline nodes (like text).
 */
function wrapTableCellContent(node: AdfNode): AdfNode {
	// Recursively process child nodes first
	if (node.content && Array.isArray(node.content)) {
		node.content = node.content.map((child) => wrapTableCellContent(child))
	}

	// Only process tableCell and tableHeader nodes
	if (node.type !== 'tableCell' && node.type !== 'tableHeader') {
		return node
	}

	if (!node.content || node.content.length === 0) {
		return node
	}

	const allInline = node.content.every((child) => !BLOCK_LEVEL_TYPES.has(child.type))

	if (allInline) {
		// All children are inline - wrap them all in a single paragraph
		node.content = [{ type: 'paragraph', content: node.content }]
	} else {
		// Mixed block and inline nodes - wrap consecutive inline runs in paragraphs
		const newContent: AdfNode[] = []
		let inlineRun: AdfNode[] = []

		for (const child of node.content) {
			if (BLOCK_LEVEL_TYPES.has(child.type)) {
				// Flush any accumulated inline nodes as a paragraph
				if (inlineRun.length > 0) {
					newContent.push({ type: 'paragraph', content: inlineRun })
					inlineRun = []
				}
				newContent.push(child)
			} else {
				inlineRun.push(child)
			}
		}

		// Flush remaining inline nodes
		if (inlineRun.length > 0) {
			newContent.push({ type: 'paragraph', content: inlineRun })
		}

		node.content = newContent
	}

	return node
}

/**
 * Counter for generating unique task item local IDs
 */
let taskIdCounter = 0

/**
 * Represents a contiguous block of checkbox bullet items extracted from markdown.
 */
interface CheckboxBlock {
	states: Array<'DONE' | 'TODO'>
	texts: string[]
}

/**
 * Get the canonical plain text for a markdown string by parsing it through
 * the same ADF parser used for the full document. This ensures consistent
 * text matching regardless of markdown formatting quirks (e.g., literal
 * asterisks being misinterpreted as italic markers).
 */
function getCanonicalPlainText(text: string): string {
	const miniAdf = parser.markdownToAdf(text)
	return getPlainText(miniAdf as AdfNode)
}

/**
 * Parse the original markdown to find contiguous blocks of bullet items where
 * ALL items use `- [x] ` or `- [ ] ` syntax (also supports `*` and `+` markers).
 * Returns the blocks in document order. The text field stores the canonical plain
 * text (obtained by mini-parsing through the ADF parser) for matching against ADF content.
 *
 * Only groups items at the same indentation level into a block. When indent changes,
 * the current block is broken to avoid mismatching nested checkbox lists.
 */
function extractCheckboxBlocks(markdown: string): CheckboxBlock[] {
	const lines = markdown.split('\n')
	const blocks: CheckboxBlock[] = []

	let i = 0
	while (i < lines.length) {
		// Collect contiguous bullet lines (checkbox or regular) at the same indent level
		// Store raw text first, then compute canonical text after collecting continuations
		const bulletLines: Array<{ isCheckbox: boolean; state: 'DONE' | 'TODO' | null; rawText: string }> = []
		let blockIndent: number | null = null

		while (i < lines.length) {
			const line = lines[i] ?? ''
			const checkboxMatch = line.match(/^(\s*)[-*+] \[([ xX])\] (.*)$/)
			if (checkboxMatch) {
				const indent = checkboxMatch[1]?.length ?? 0
				if (blockIndent === null) {
					blockIndent = indent
				} else if (indent !== blockIndent) {
					break
				}
				const state = checkboxMatch[2] === ' ' ? 'TODO' : 'DONE'
				bulletLines.push({ isCheckbox: true, state, rawText: checkboxMatch[3] ?? '' })
				i++
			} else if (line.match(/^\s*[-*+] /)) {
				// Regular bullet item (no checkbox) - check indent
				const indentMatch = line.match(/^(\s*)/)
				const indent = indentMatch?.[1]?.length ?? 0
				if (blockIndent === null) {
					blockIndent = indent
				} else if (indent !== blockIndent) {
					break
				}
				bulletLines.push({ isCheckbox: false, state: null, rawText: '' })
				i++
			} else if (bulletLines.length > 0 && line.match(/^\s/) && line.trim() !== '') {
				// Continuation line of the previous list item (indented, non-empty)
				// Append to the last bullet item's raw text
				const lastItem = bulletLines[bulletLines.length - 1]
				if (lastItem) {
					lastItem.rawText += '\n' + line.trim()
				}
				i++
			} else {
				break
			}
		}

		if (bulletLines.length > 0) {
			const allCheckboxes = bulletLines.every((l) => l.isCheckbox)
			if (allCheckboxes) {
				blocks.push({
					states: bulletLines.map((l) => l.state as 'DONE' | 'TODO'),
					texts: bulletLines.map((l) => getCanonicalPlainText(l.rawText)),
				})
			}
		} else {
			i++
		}
	}

	return blocks
}

/**
 * Recursively extract all plain text from an ADF node,
 * handling formatted content (bold, italic, code, links).
 */
function getPlainText(node: AdfNode): string {
	if (node.type === 'text' && node.text !== undefined) return node.text
	if (!node.content) return ''
	return node.content.map(getPlainText).join('')
}

/**
 * Recursively traverse ADF tree and convert bulletList nodes that match
 * extracted checkbox blocks into taskList/taskItem nodes.
 *
 * Uses a cursor into the blocks array to match bulletLists in document order.
 * The cursor is shared across the entire tree traversal.
 */
function convertCheckboxesToTaskList(node: AdfNode, blocks: CheckboxBlock[]): AdfNode {
	const cursor = { index: 0 }
	return convertCheckboxesRecursive(node, blocks, cursor)
}

function convertCheckboxesRecursive(
	node: AdfNode,
	blocks: CheckboxBlock[],
	cursor: { index: number }
): AdfNode {
	if (node.type === 'bulletList' && node.content && node.content.length > 0 && cursor.index < blocks.length) {
		const block = blocks[cursor.index]
		if (!block) return node

		// Check if this bulletList matches the next checkbox block
		if (node.content.length === block.states.length) {
			const plaintexts = node.content.map((listItem) => getPlainText(listItem))
			const matches = plaintexts.every((text, i) => text === block.texts[i])

			if (matches) {
				// Guard: all listItems must have simple structure (single paragraph child)
				// Multi-paragraph or complex items cannot be safely converted to taskItem
				const allSimple = node.content.every((item) => {
					return item.content?.length === 1 && item.content[0]?.type === 'paragraph'
				})
				if (!allSimple) {
					cursor.index++ // Consume the block even though we can't convert it
					return node // Items too complex for taskItem
				}

				// Convert bulletList -> taskList
				cursor.index++
				node.type = 'taskList'
				node.attrs = { localId: `tasklist-${++taskIdCounter}` }

				for (const [i, listItem] of node.content.entries()) {
					listItem.type = 'taskItem'
					listItem.attrs = {
						localId: `task-${++taskIdCounter}`,
						state: block.states[i],
					}

					// Unwrap paragraph: listItem has paragraph > [inline nodes],
					// but taskItem should have inline nodes directly
					const firstChild = listItem.content?.[0]
					if (firstChild?.type === 'paragraph' && firstChild.content) {
						listItem.content = firstChild.content
					}
				}

				return node
			}
		}
	}

	// Recursively process child nodes
	if (node.content && Array.isArray(node.content)) {
		node.content = node.content.map((child) => convertCheckboxesRecursive(child, blocks, cursor))
	}

	return node
}

/**
 * Convert HTML details/summary blocks to ADF expand fence syntax
 * The extended-markdown-adf-parser library supports ~~~expand title="..."~~~ syntax
 * but not HTML <details><summary> tags
 *
 * @param markdown - Markdown string potentially containing HTML details/summary blocks
 * @returns Markdown with details/summary converted to ADF expand fence syntax
 */
export function convertDetailsToExpandSyntax(markdown: string): string {
	if (!markdown) return markdown

	// Process from innermost to outermost to handle nesting correctly
	let previousText = ''
	let currentText = markdown

	while (previousText !== currentText) {
		previousText = currentText
		// Match <details> blocks with optional attributes on the tags
		currentText = currentText.replace(
			/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
			(_match, summary, content) => {
				// Clean up the summary - trim whitespace and decode HTML entities
				const cleanSummary = summary
					.trim()
					.replace(/&lt;/g, '<')
					.replace(/&gt;/g, '>')
					.replace(/&amp;/g, '&')
					.replace(/&quot;/g, '"')
					.replace(/&#39;/g, "'")

				// Clean up the content - trim and normalize excessive blank lines
				let cleanContent = content.trim()
				cleanContent = cleanContent.replace(/\n{3,}/g, '\n\n')

				// Build ADF expand fence syntax
				if (cleanContent) {
					return `~~~expand title="${cleanSummary}"\n${cleanContent}\n~~~`
				} else {
					return `~~~expand title="${cleanSummary}"\n~~~`
				}
			}
		)
	}

	return currentText
}

/**
 * Convert ADF (Atlassian Document Format) to Markdown
 * Used when reading issue descriptions and comments from Jira
 *
 * @param adf - ADF object, string, null, or undefined
 * @returns Markdown string
 */
export function adfToMarkdown(adf: unknown): string {
	// Handle null/undefined
	if (!adf) return ''

	// Handle plain string (already text, not ADF)
	if (typeof adf === 'string') return adf

	// Convert ADF object to markdown
	return parser.adfToMarkdown(adf as ADFDocument)
}

/**
 * Convert Markdown to ADF (Atlassian Document Format)
 * Used when writing issue descriptions and comments to Jira
 *
 * @param markdown - Markdown string
 * @returns ADF object suitable for Jira API v3
 */
export function markdownToAdf(markdown: string): object {
	if (!markdown) {
		return { type: 'doc', version: 1, content: [] }
	}
	// Reset task ID counter for deterministic output
	taskIdCounter = 0
	// Extract checkbox info BEFORE conversion (library will strip [x]/[ ])
	const checkboxBlocks = extractCheckboxBlocks(markdown)
	// Pre-process: convert details/summary to expand syntax
	const preprocessed = convertDetailsToExpandSyntax(markdown)
	const adf = parser.markdownToAdf(preprocessed)
	// Post-process the ADF tree
	let result = sanitizeCodeMarks(adf as AdfNode)
	result = wrapTableCellContent(result)
	result = convertCheckboxesToTaskList(result, checkboxBlocks)
	return result
}
