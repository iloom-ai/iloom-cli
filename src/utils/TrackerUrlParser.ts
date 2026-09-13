import { logger } from './logger.js'

/**
 * Provider type extracted from a tracker URL.
 */
export type TrackerUrlProvider = 'github' | 'linear' | 'jira'

/**
 * Whether the URL points to an issue or a pull request.
 */
export type TrackerUrlKind = 'issue' | 'pr'

/**
 * Result of parsing a tracker URL.
 *
 * The `identifier` is emitted in canonical case for the provider:
 *   - GitHub: numeric string (e.g. '123')
 *   - Linear: uppercase TEAM-NUM (e.g. 'WEB-2423')
 *   - Jira: uppercase KEY-NUM (e.g. 'PROJ-99')
 *
 * Callers that perform identifier comparisons against stored data should
 * still pass the identifier through `IssueTracker.normalizeIdentifier()`
 * to handle legacy data that may already be on disk in a different case.
 */
export interface TrackerUrlParseResult {
  provider: TrackerUrlProvider
  kind: TrackerUrlKind
  identifier: string
  /** owner/repo for GitHub URLs only */
  repo?: string
  /** URL host (e.g. 'myco.atlassian.net'); useful for Jira host validation */
  host?: string
}

/**
 * Thrown when an input clearly intends to be a tracker URL (matches a known
 * host or shape) but cannot be parsed into a valid identifier. Callers that
 * cannot recognize a URL pattern at all should return `null` instead so the
 * caller can fall back to the bare-identifier code path.
 */
export class TrackerUrlError extends Error {
  public readonly host?: string

  constructor(message: string, host?: string) {
    super(message)
    this.name = 'TrackerUrlError'
    if (host !== undefined) {
      this.host = host
    }
  }
}

const HTTP_PREFIX_RE = /^https?:\/\//i
// Linear allows 1-character team keys (e.g. `A-123`); Jira project keys are
// also typically >=2 chars but the API permits short keys, so use `*` to allow
// 1+ alphanumeric after the leading letter.
const PROJECT_KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/

/**
 * Parse a tracker URL into a normalized result.
 *
 * @param input Raw user-provided string. May contain wrapping `<...>`,
 *              trailing punctuation, or auth credentials.
 * @returns Parsed tracker info, or `null` if the input is not a recognized
 *          tracker URL (callers can then try bare-identifier matching).
 * @throws TrackerUrlError if the input clearly intends to be a tracker URL
 *         (matches a known host) but is malformed.
 */
export function parseTrackerUrl(input: string): TrackerUrlParseResult | null {
  if (typeof input !== 'string') {
    return null
  }

  const cleaned = stripWrapping(input)
  if (cleaned.length === 0) {
    return null
  }

  if (!HTTP_PREFIX_RE.test(cleaned)) {
    return null
  }

  let url: URL
  try {
    url = new URL(cleaned)
  } catch {
    // Looked like a URL (has http(s):// prefix) but URL constructor rejected
    // it. This is "clearly intended to be a URL but malformed" — but we don't
    // know the host so we can't tell whether it's a tracker URL. Return null
    // so the caller falls through to bare-identifier matching.
    return null
  }

  if (url.username || url.password) {
    // Strip credentials defensively — never log the raw URL.
    logger.debug('parseTrackerUrl: URL had credentials, stripped')
    url.username = ''
    url.password = ''
  }

  const host = url.hostname.toLowerCase()

  if (host === 'github.com' || host === 'www.github.com') {
    return parseGitHub(url)
  }

  if (host === 'linear.app' || host === 'www.linear.app') {
    return parseLinear(url)
  }

  // Jira: detect by path shape `/browse/KEY-NUM`. Both Atlassian Cloud and
  // self-hosted Jira use the `/browse/...` URL shape.
  if (/^\/browse\/[^/]+\/?$/.test(url.pathname)) {
    return parseJira(url)
  }

  // Atlassian Cloud host with a non-`/browse/` path → still clearly a Jira
  // URL but malformed for our purposes.
  if (host.endsWith('.atlassian.net')) {
    throw new TrackerUrlError(
      `Unrecognized Jira URL shape: ${url.pathname}. Expected /browse/<KEY-NUM>.`,
      url.hostname
    )
  }

  // Unknown host → not a recognized tracker URL. Return null so the caller
  // can fall back to bare-identifier matching.
  return null
}

function parseGitHub(url: URL): TrackerUrlParseResult {
  // Path: /<owner>/<repo>/(issues|pull)/<n>(/...)? — keyword case-insensitive.
  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/i
  )
  if (!match) {
    throw new TrackerUrlError(
      `Unrecognized GitHub URL shape: ${url.pathname}. Expected /<owner>/<repo>/issues/<n> or /<owner>/<repo>/pull/<n>.`,
      url.hostname
    )
  }
  const [, owner, repo, keyword, number] = match
  if (!owner || !repo || !keyword || !number) {
    // Should be unreachable given the regex above, but the type narrowing
    // satisfies @typescript-eslint/no-non-null-assertion.
    throw new TrackerUrlError(
      `Malformed GitHub URL: ${url.pathname}.`,
      url.hostname
    )
  }
  return {
    provider: 'github',
    kind: keyword.toLowerCase() === 'pull' ? 'pr' : 'issue',
    identifier: number,
    repo: `${owner}/${repo}`,
    host: url.hostname,
  }
}

function parseLinear(url: URL): TrackerUrlParseResult {
  // Path: /<workspace>/issue/<TEAM-NUM>(/<slug>)?
  // CRITICAL: extract identifier from the path segment immediately after
  // /issue/, NOT by regex-scanning the whole URL — slug segments may contain
  // dashes that look like project keys (e.g. /issue/WEB-2423/fix-PROJ-99-bug).
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  const issueIdx = segments.findIndex((s) => s.toLowerCase() === 'issue')
  if (issueIdx === -1) {
    throw new TrackerUrlError(
      `Unrecognized Linear URL shape: ${url.pathname}. Expected /<workspace>/issue/<TEAM-NUM>.`,
      url.hostname
    )
  }
  const idSegment = segments[issueIdx + 1]
  if (!idSegment) {
    throw new TrackerUrlError(
      `Malformed Linear URL: missing issue identifier in ${url.pathname}.`,
      url.hostname
    )
  }
  const idMatch = idSegment.match(PROJECT_KEY_RE)
  if (!idMatch?.[1] || !idMatch[2]) {
    throw new TrackerUrlError(
      `Malformed Linear URL: '${idSegment}' is not a valid Linear identifier (expected TEAM-NUM).`,
      url.hostname
    )
  }
  const team = idMatch[1].toUpperCase()
  const num = idMatch[2]
  return {
    provider: 'linear',
    kind: 'issue',
    identifier: `${team}-${num}`,
    host: url.hostname,
  }
}

function parseJira(url: URL): TrackerUrlParseResult {
  const match = url.pathname.match(/^\/browse\/([^/]+)\/?$/)
  if (!match?.[1]) {
    throw new TrackerUrlError(
      `Malformed Jira URL: ${url.pathname}.`,
      url.hostname
    )
  }
  const idSegment = match[1]
  const idMatch = idSegment.match(PROJECT_KEY_RE)
  if (!idMatch?.[1] || !idMatch[2]) {
    throw new TrackerUrlError(
      `Malformed Jira URL: '${idSegment}' is not a valid Jira identifier (expected KEY-NUM).`,
      url.hostname
    )
  }
  const key = idMatch[1].toUpperCase()
  const num = idMatch[2]
  return {
    provider: 'jira',
    kind: 'issue',
    identifier: `${key}-${num}`,
    host: url.hostname,
  }
}

/**
 * Strip surrounding whitespace, optional `<...>` wrappers (e.g. when pasted
 * from Markdown autolinks), and trailing punctuation that often gets pasted
 * along with URLs from prose.
 */
function stripWrapping(input: string): string {
  let s = input.trim()
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim()
  }
  // Strip trailing punctuation that commonly follows URLs in prose.
  s = s.replace(/[,;.!?)\]]+$/, '')
  return s
}
