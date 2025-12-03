/**
 * Linear URL utilities
 * Helper functions for constructing Linear URLs
 */

/**
 * Slugify a title for use in Linear URLs
 * Converts to lowercase, replaces non-alphanumeric with hyphens, truncates to reasonable length
 * @param title - Issue title
 * @param maxLength - Maximum slug length (default: 50)
 * @returns Slugified title
 */
export function slugifyTitle(title: string, maxLength: number = 50): string {
  // Convert to lowercase, replace non-alphanumeric chars with hyphens
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens

  // If already short enough, return as-is
  if (slug.length <= maxLength) {
    return slug
  }

  // Split by hyphens and rebuild until we hit the limit
  const parts = slug.split('-')
  let result = ''
  for (const part of parts) {
    const candidate = result ? `${result}-${part}` : part
    if (candidate.length > maxLength) {
      break
    }
    result = candidate
  }

  return result || slug.slice(0, maxLength) // fallback if first part is too long
}

/**
 * Build a Linear issue URL with optional title slug
 * @param identifier - Issue identifier (e.g., "ENG-123")
 * @param title - Optional issue title for slug
 * @returns Linear URL
 */
export function buildLinearIssueUrl(identifier: string, title?: string): string {
  const base = `https://linear.app/issue/${identifier}`
  if (title) {
    const slug = slugifyTitle(title)
    return slug ? `${base}/${slug}` : base
  }
  return base
}
