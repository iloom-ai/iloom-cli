import { describe, it, expect } from 'vitest'
import { validateTrackerUrlAgainstSettings } from './tracker-url-validation.js'
import type { TrackerUrlParseResult } from './TrackerUrlParser.js'

const ghIssue: TrackerUrlParseResult = {
  provider: 'github',
  kind: 'issue',
  identifier: '123',
  repo: 'owner/repo',
  host: 'github.com',
}

const ghPr: TrackerUrlParseResult = {
  provider: 'github',
  kind: 'pr',
  identifier: '42',
  repo: 'owner/repo',
  host: 'github.com',
}

const linearIssue: TrackerUrlParseResult = {
  provider: 'linear',
  kind: 'issue',
  identifier: 'WEB-1',
  host: 'linear.app',
}

const jiraIssueMyco: TrackerUrlParseResult = {
  provider: 'jira',
  kind: 'issue',
  identifier: 'PROJ-99',
  host: 'myco.atlassian.net',
}

const jiraIssueOther: TrackerUrlParseResult = {
  provider: 'jira',
  kind: 'issue',
  identifier: 'ENG-123',
  host: 'other-org.atlassian.net',
}

describe('validateTrackerUrlAgainstSettings', () => {
  describe('provider mismatch', () => {
    it('throws when URL provider does not match configured provider', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(linearIssue, {
          configuredProvider: 'github',
        })
      ).toThrow(/does not match the configured tracker/i)
    })

    it('does not throw when URL provider matches configured provider', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(ghIssue, {
          configuredProvider: 'github',
        })
      ).not.toThrow()
    })
  })

  describe('PR carve-out', () => {
    it('allows GitHub PR URL when allowPrCarveOut=true and configured tracker is Linear', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(ghPr, {
          configuredProvider: 'linear',
          allowPrCarveOut: true,
        })
      ).not.toThrow()
    })

    it('still rejects GitHub issue URL with allowPrCarveOut=true and configured tracker is Linear', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(ghIssue, {
          configuredProvider: 'linear',
          allowPrCarveOut: true,
        })
      ).toThrow(/does not match the configured tracker/i)
    })

    it('rejects GitHub PR URL when allowPrCarveOut=false and configured tracker is Linear', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(ghPr, {
          configuredProvider: 'linear',
          allowPrCarveOut: false,
        })
      ).toThrow(/does not match the configured tracker/i)
    })

    it('rejects GitHub PR URL when allowPrCarveOut is unset (defaults to false)', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(ghPr, {
          configuredProvider: 'linear',
        })
      ).toThrow(/does not match the configured tracker/i)
    })
  })

  describe('Jira host validation', () => {
    it('throws when configured Jira host differs from URL host', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(jiraIssueOther, {
          configuredProvider: 'jira',
          configuredJiraHost: 'myco.atlassian.net',
        })
      ).toThrow(/Jira host mismatch/i)
    })

    it('does not throw when configured Jira host matches URL host', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(jiraIssueMyco, {
          configuredProvider: 'jira',
          configuredJiraHost: 'myco.atlassian.net',
        })
      ).not.toThrow()
    })

    it('compares Jira host case-insensitively', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(jiraIssueMyco, {
          configuredProvider: 'jira',
          configuredJiraHost: 'MYCO.atlassian.NET',
        })
      ).not.toThrow()
    })

    it('accepts configured Jira host given as full URL', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(jiraIssueMyco, {
          configuredProvider: 'jira',
          configuredJiraHost: 'https://myco.atlassian.net',
        })
      ).not.toThrow()
    })

    it('treats trailing dot in URL host as equivalent to configured host', () => {
      const withTrailingDot: TrackerUrlParseResult = {
        ...jiraIssueMyco,
        host: 'myco.atlassian.net.',
      }
      expect(() =>
        validateTrackerUrlAgainstSettings(withTrailingDot, {
          configuredProvider: 'jira',
          configuredJiraHost: 'myco.atlassian.net',
        })
      ).not.toThrow()
    })

    it('skips Jira host check when no configuredJiraHost provided', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(jiraIssueOther, {
          configuredProvider: 'jira',
        })
      ).not.toThrow()
    })

    it('does not run Jira host check for non-Jira URLs', () => {
      expect(() =>
        validateTrackerUrlAgainstSettings(ghIssue, {
          configuredProvider: 'github',
          configuredJiraHost: 'myco.atlassian.net',
        })
      ).not.toThrow()
    })
  })
})
