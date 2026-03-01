/**
 * Utility class for detecting and converting Jira Wiki markup to GitHub-Flavored Markdown.
 * Applied at the MCP layer to prevent malformed content from reaching issue tracker providers.
 *
 * IMPORTANT: Only converts UNAMBIGUOUS Jira Wiki patterns.
 * Patterns that overlap with valid Markdown (e.g., *bold*, _italic_) are
 * intentionally NOT converted to avoid corrupting valid Markdown content.
 *
 * Safe conversions (unambiguous):
 * - h1. through h6. headings at line start -> # through ######
 * - {code}...{code} and {code:lang}...{code} -> fenced code blocks
 * - {quote}...{quote} -> > blockquotes
 * - [text|url] -> [text](url) (only when url looks like http/https)
 *
 * Intentionally NOT converted (ambiguous):
 * - *text* (could be Markdown italic)
 * - _text_ (could be Markdown italic or snake_case)
 */
export class JiraWikiSanitizer {
	/**
	 * Sanitize body text by converting unambiguous Jira Wiki patterns to Markdown.
	 * Preserves content inside backtick-fenced code blocks.
	 * Returns text unchanged if no Wiki patterns detected.
	 */
	static sanitize(text: string): string {
		if (!text) {
			return ''
		}

		// Split text into fenced code block segments vs non-code-block segments.
		// We only apply conversions to non-code-block segments to avoid corrupting code examples.
		const segments = this.splitByCodeBlocks(text)
		const converted = segments.map((segment) => {
			if (segment.isCode) {
				return segment.text
			}
			return this.convertSegment(segment.text)
		})

		return converted.join('')
	}

	/**
	 * Check if text contains unambiguous Jira Wiki patterns.
	 * Only checks for patterns that are safe to convert.
	 */
	static hasJiraWikiPatterns(text: string): boolean {
		if (!text) {
			return false
		}

		// Check for h1. through h6. at line start
		if (/^h[1-6]\.\s+/m.test(text)) {
			return true
		}

		// Check for {code} or {code:lang} blocks
		if (/\{code(?::[^}]*)?\}/i.test(text)) {
			return true
		}

		// Check for {quote} blocks
		if (/\{quote\}/i.test(text)) {
			return true
		}

		// Check for [text|url] links where url starts with http
		if (/\[[^\]|]+\|https?:\/\/[^\]]+\]/.test(text)) {
			return true
		}

		return false
	}

	/**
	 * Split text into segments, separating existing Markdown fenced code blocks
	 * from the rest of the content. This ensures we don't modify content inside
	 * code blocks (e.g., Jira Wiki examples shown in a Markdown code block).
	 */
	private static splitByCodeBlocks(text: string): Array<{ text: string; isCode: boolean }> {
		const segments: Array<{ text: string; isCode: boolean }> = []
		// Match fenced code blocks: ``` optionally followed by language, then content, then ```
		const codeBlockRegex = /^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm
		let lastIndex = 0

		for (const match of text.matchAll(codeBlockRegex)) {
			const matchStart = match.index ?? 0
			// Add the text before this code block
			if (matchStart > lastIndex) {
				segments.push({ text: text.slice(lastIndex, matchStart), isCode: false })
			}
			// Add the code block itself
			segments.push({ text: match[0], isCode: true })
			lastIndex = matchStart + match[0].length
		}

		// Add any remaining text after the last code block
		if (lastIndex < text.length) {
			segments.push({ text: text.slice(lastIndex), isCode: false })
		}

		return segments
	}

	/**
	 * Apply all safe Jira Wiki -> Markdown conversions to a text segment.
	 */
	private static convertSegment(text: string): string {
		let result = text

		// 1. Convert headings: h1. through h6. at line start
		result = result.replace(/^h([1-6])\.\s+(.*?)$/gm, (_match, level: string, content: string) => {
			const hashes = '#'.repeat(parseInt(level, 10))
			return `${hashes} ${content}`
		})

		// 2. Convert {code:lang}...{code} blocks (must come before plain {code} conversion)
		result = result.replace(
			/\{code:([^}]+)\}\s*\n([\s\S]*?)\n?\s*\{code\}/gi,
			(_match, lang: string, content: string) => {
				return '```' + lang.trim() + '\n' + content + '\n```'
			}
		)

		// 3. Convert {code}...{code} blocks (plain, no language)
		result = result.replace(
			/\{code\}\s*\n([\s\S]*?)\n?\s*\{code\}/gi,
			(_match, content: string) => {
				return '```\n' + content + '\n```'
			}
		)

		// 4. Convert {quote}...{quote} blocks to > blockquotes
		result = result.replace(
			/\{quote\}\s*\n([\s\S]*?)\n?\s*\{quote\}/gi,
			(_match, content: string) => {
				// Prefix each line with > for blockquote
				const lines = content.split('\n')
				return lines.map((line) => `> ${line}`).join('\n')
			}
		)

		// 5. Convert [text|url] links where url starts with http(s)
		result = result.replace(
			/\[([^\]|]+)\|(https?:\/\/[^\]]+)\]/g,
			(_match, linkText: string, url: string) => {
				return `[${linkText}](${url})`
			}
		)

		return result
	}
}
