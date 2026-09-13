import type { TrackerUrlParseResult, TrackerUrlProvider } from './TrackerUrlParser.js'

/**
 * Options controlling how a parsed tracker URL is validated against the
 * configured iloom settings.
 */
export interface ValidateTrackerUrlOptions {
  /** The tracker provider iloom is configured to use. */
  configuredProvider: TrackerUrlProvider
  /**
   * Optional configured Jira host (e.g. 'myco.atlassian.net' or
   * 'https://myco.atlassian.net'). When set and the parsed URL is a Jira
   * URL, the host must match (case-insensitive, ignoring trailing dot).
   */
  configuredJiraHost?: string
  /**
   * When true, GitHub PR URLs are accepted regardless of the configured
   * tracker (`il start` carve-out, mirroring the bare-numeric PR detection
   * for Linear/Jira-tracked repos). When false (default), provider mismatches
   * always throw.
   */
  allowPrCarveOut?: boolean
}

/**
 * Validate a parsed tracker URL against the configured iloom settings.
 *
 * Throws a user-facing `Error` with a clear message when:
 *   - The URL's provider does not match the configured tracker (and the PR
 *     carve-out doesn't apply).
 *   - The URL is a Jira URL whose host does not match the configured Jira
 *     host (when one is configured).
 *
 * Repository (cross-repo) checks are intentionally NOT handled here: the
 * policy differs between commands (`il start` rejects, `il plan` warns),
 * so callers handle that separately.
 */
export function validateTrackerUrlAgainstSettings(
  parsed: TrackerUrlParseResult,
  opts: ValidateTrackerUrlOptions,
): void {
  const { configuredProvider, configuredJiraHost, allowPrCarveOut } = opts

  const isGitHubPrCarveOut =
    allowPrCarveOut === true &&
    parsed.provider === 'github' &&
    parsed.kind === 'pr'

  if (!isGitHubPrCarveOut && parsed.provider !== configuredProvider) {
    throw new Error(
      `Tracker URL provider "${parsed.provider}" does not match the configured tracker "${configuredProvider}". ` +
        `Re-run with an identifier or URL for ${configuredProvider}, or update your iloom configuration.`,
    )
  }

  if (parsed.provider === 'jira' && configuredJiraHost && parsed.host) {
    const configuredHostname = normalizeJiraHost(configuredJiraHost)
    const parsedHostname = stripTrailingDot(parsed.host.toLowerCase())
    if (parsedHostname !== configuredHostname) {
      throw new Error(
        `Jira host mismatch: URL host "${parsed.host}" does not match the configured Jira host "${configuredHostname}". ` +
          `Update your iloom configuration or use a URL for the configured host.`,
      )
    }
  }
}

/**
 * Normalize a configured Jira host setting into a bare lowercase hostname.
 * Accepts either a bare hostname (`myco.atlassian.net`) or a full URL
 * (`https://myco.atlassian.net`). Trailing dots are stripped so DNS-style
 * fully-qualified names compare equal to the parsed URL's hostname.
 */
function normalizeJiraHost(configured: string): string {
  let hostname: string
  try {
    hostname = new URL(
      configured.startsWith('http') ? configured : `https://${configured}`,
    ).hostname.toLowerCase()
  } catch {
    hostname = configured.toLowerCase()
  }
  return stripTrailingDot(hostname)
}

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host
}
