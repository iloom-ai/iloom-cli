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
	// Convert HTML details/summary to ADF expand syntax before parsing
	const preprocessed = convertDetailsToExpandSyntax(markdown)
	const adf = parser.markdownToAdf(preprocessed)
	// Sanitize code marks - ensure code-marked text only has code mark
	return sanitizeCodeMarks(adf as AdfNode)
}
