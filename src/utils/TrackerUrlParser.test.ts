import { describe, it, expect } from 'vitest'
import {
  parseTrackerUrl,
  TrackerUrlError,
  type TrackerUrlParseResult,
} from './TrackerUrlParser.js'

describe('parseTrackerUrl', () => {
  describe('GitHub URLs', () => {
    it.each<[string, TrackerUrlParseResult]>([
      [
        'https://github.com/owner/repo/issues/123',
        {
          provider: 'github',
          kind: 'issue',
          identifier: '123',
          repo: 'owner/repo',
          host: 'github.com',
        },
      ],
      [
        'https://github.com/owner/repo/pull/456',
        {
          provider: 'github',
          kind: 'pr',
          identifier: '456',
          repo: 'owner/repo',
          host: 'github.com',
        },
      ],
      [
        'http://github.com/owner/repo/issues/1',
        {
          provider: 'github',
          kind: 'issue',
          identifier: '1',
          repo: 'owner/repo',
          host: 'github.com',
        },
      ],
    ])('parses %s', (input, expected) => {
      expect(parseTrackerUrl(input)).toEqual(expected)
    })

    it('strips trailing slash', () => {
      expect(parseTrackerUrl('https://github.com/owner/repo/issues/123/')).toEqual({
        provider: 'github',
        kind: 'issue',
        identifier: '123',
        repo: 'owner/repo',
        host: 'github.com',
      })
    })

    it('strips query string', () => {
      const result = parseTrackerUrl(
        'https://github.com/owner/repo/issues/123?ref=foo'
      )
      expect(result?.identifier).toBe('123')
      expect(result?.repo).toBe('owner/repo')
    })

    it('strips URL fragment', () => {
      const result = parseTrackerUrl(
        'https://github.com/owner/repo/issues/123#issuecomment-789'
      )
      expect(result?.identifier).toBe('123')
    })

    it('matches keyword case-insensitively', () => {
      const result = parseTrackerUrl('https://github.com/owner/repo/Issues/123')
      expect(result?.kind).toBe('issue')
      expect(result?.identifier).toBe('123')
    })

    it('matches host case-insensitively', () => {
      const result = parseTrackerUrl('https://GitHub.com/owner/repo/issues/123')
      expect(result?.provider).toBe('github')
      expect(result?.identifier).toBe('123')
    })

    it('strips wrapping <...> markdown autolink', () => {
      const result = parseTrackerUrl(
        '<https://github.com/owner/repo/issues/123>'
      )
      expect(result?.identifier).toBe('123')
    })

    it('strips trailing punctuation', () => {
      expect(
        parseTrackerUrl('https://github.com/owner/repo/issues/123,')?.identifier
      ).toBe('123')
      expect(
        parseTrackerUrl('https://github.com/owner/repo/issues/123.')?.identifier
      ).toBe('123')
      expect(
        parseTrackerUrl('https://github.com/owner/repo/issues/123;')?.identifier
      ).toBe('123')
      expect(
        parseTrackerUrl('https://github.com/owner/repo/issues/123)')?.identifier
      ).toBe('123')
    })

    it('strips user-info credentials from URL', () => {
      const result = parseTrackerUrl(
        'https://user:token@github.com/owner/repo/issues/123'
      )
      expect(result).toEqual({
        provider: 'github',
        kind: 'issue',
        identifier: '123',
        repo: 'owner/repo',
        host: 'github.com',
      })
    })

    it('handles www.github.com host', () => {
      const result = parseTrackerUrl(
        'https://www.github.com/owner/repo/issues/123'
      )
      expect(result?.provider).toBe('github')
      expect(result?.identifier).toBe('123')
    })

    it('throws TrackerUrlError when number is missing', () => {
      expect(() =>
        parseTrackerUrl('https://github.com/owner/repo/issues/')
      ).toThrow(TrackerUrlError)
    })

    it('throws TrackerUrlError when path number is non-numeric', () => {
      expect(() =>
        parseTrackerUrl('https://github.com/owner/repo/issues/abc')
      ).toThrow(TrackerUrlError)
    })

    it('throws TrackerUrlError on unrecognized GitHub path (e.g. discussions)', () => {
      expect(() =>
        parseTrackerUrl('https://github.com/owner/repo/discussions/123')
      ).toThrow(TrackerUrlError)
    })

    it('throws TrackerUrlError on truncated GitHub URL (no /issues|/pull)', () => {
      expect(() => parseTrackerUrl('https://github.com/owner/repo')).toThrow(
        TrackerUrlError
      )
    })
  })

  describe('Linear URLs', () => {
    it('parses basic Linear issue URL', () => {
      expect(parseTrackerUrl('https://linear.app/team/issue/WEB-2423')).toEqual({
        provider: 'linear',
        kind: 'issue',
        identifier: 'WEB-2423',
        host: 'linear.app',
      })
    })

    it('strips trailing slug', () => {
      const result = parseTrackerUrl(
        'https://linear.app/team/issue/WEB-2423/some-title-slug'
      )
      expect(result?.identifier).toBe('WEB-2423')
    })

    it('uppercases lowercase identifier', () => {
      const result = parseTrackerUrl(
        'https://linear.app/team/issue/web-2423'
      )
      expect(result?.identifier).toBe('WEB-2423')
    })

    it('matches keyword case-insensitively', () => {
      const result = parseTrackerUrl(
        'https://linear.app/team/Issue/WEB-2423'
      )
      expect(result?.identifier).toBe('WEB-2423')
    })

    it('does NOT extract project key from slug (slug may contain dashes that look like keys)', () => {
      const result = parseTrackerUrl(
        'https://linear.app/team/issue/WEB-2423/fix-PROJ-99-bug'
      )
      expect(result?.identifier).toBe('WEB-2423')
    })

    it('strips query string and fragment', () => {
      const result = parseTrackerUrl(
        'https://linear.app/team/issue/WEB-2423?foo=bar#comment-1'
      )
      expect(result?.identifier).toBe('WEB-2423')
    })

    it('throws TrackerUrlError when identifier segment is missing', () => {
      expect(() =>
        parseTrackerUrl('https://linear.app/team/issue/')
      ).toThrow(TrackerUrlError)
    })

    it('throws TrackerUrlError when identifier segment is invalid', () => {
      expect(() =>
        parseTrackerUrl('https://linear.app/team/issue/INVALID/foo')
      ).toThrow(TrackerUrlError)
    })

    it('throws TrackerUrlError when path has no /issue/ segment', () => {
      expect(() =>
        parseTrackerUrl('https://linear.app/team/projects/foo')
      ).toThrow(TrackerUrlError)
    })

    it('accepts 1-character team keys', () => {
      expect(
        parseTrackerUrl('https://linear.app/team/issue/A-1/foo')
      ).toEqual({
        provider: 'linear',
        kind: 'issue',
        identifier: 'A-1',
        host: 'linear.app',
      })
    })

    it('throws TrackerUrlError when number segment is missing', () => {
      expect(() =>
        parseTrackerUrl('https://linear.app/team/issue/WEB-/foo')
      ).toThrow(TrackerUrlError)
    })
  })

  describe('Jira URLs', () => {
    it('parses Atlassian Cloud URL', () => {
      expect(
        parseTrackerUrl('https://myco.atlassian.net/browse/PROJ-99')
      ).toEqual({
        provider: 'jira',
        kind: 'issue',
        identifier: 'PROJ-99',
        host: 'myco.atlassian.net',
      })
    })

    it('parses self-hosted Jira URL', () => {
      expect(
        parseTrackerUrl('https://jira.example.com/browse/PROJ-99')
      ).toEqual({
        provider: 'jira',
        kind: 'issue',
        identifier: 'PROJ-99',
        host: 'jira.example.com',
      })
    })

    it('preserves host casing for downstream comparison', () => {
      const result = parseTrackerUrl(
        'https://MyCo.Atlassian.net/browse/PROJ-99'
      )
      // URL constructor lowercases the hostname automatically.
      expect(result?.host).toBe('myco.atlassian.net')
    })

    it('uppercases lowercase identifier', () => {
      const result = parseTrackerUrl(
        'https://myco.atlassian.net/browse/proj-99'
      )
      expect(result?.identifier).toBe('PROJ-99')
    })

    it('strips query string', () => {
      const result = parseTrackerUrl(
        'https://myco.atlassian.net/browse/PROJ-99?focusedCommentId=12345'
      )
      expect(result?.identifier).toBe('PROJ-99')
    })

    it('strips trailing slash', () => {
      const result = parseTrackerUrl(
        'https://myco.atlassian.net/browse/PROJ-99/'
      )
      expect(result?.identifier).toBe('PROJ-99')
    })

    it('throws TrackerUrlError when identifier is malformed', () => {
      expect(() =>
        parseTrackerUrl('https://myco.atlassian.net/browse/INVALID')
      ).toThrow(TrackerUrlError)
    })

    it('throws TrackerUrlError on Atlassian Cloud host with non-/browse path', () => {
      expect(() =>
        parseTrackerUrl('https://myco.atlassian.net/projects/PROJ')
      ).toThrow(TrackerUrlError)
    })
  })

  describe('non-URL / pass-through inputs', () => {
    it.each(['123', '#456', 'WEB-2423', 'feat/branch', '   ', ''])(
      'returns null for plain identifier %j',
      (input) => {
        expect(parseTrackerUrl(input)).toBeNull()
      }
    )

    it('returns null for unknown tracker host (gitlab.com)', () => {
      expect(
        parseTrackerUrl('https://gitlab.com/owner/repo/-/issues/1')
      ).toBeNull()
    })

    it('returns null for non-tracker URL on unknown host', () => {
      expect(parseTrackerUrl('https://example.com/something/123')).toBeNull()
    })

    it('returns null for malformed URL with http(s) prefix', () => {
      expect(parseTrackerUrl('https://')).toBeNull()
      expect(parseTrackerUrl('https:// invalid url')).toBeNull()
    })

    it('returns null for non-string input', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parseTrackerUrl(undefined as any)).toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parseTrackerUrl(null as any)).toBeNull()
    })
  })

  describe('TrackerUrlError', () => {
    it('is an instance of Error', () => {
      const err = new TrackerUrlError('test')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(TrackerUrlError)
      expect(err.name).toBe('TrackerUrlError')
    })

    it('captures host when provided', () => {
      const err = new TrackerUrlError('test', 'github.com')
      expect(err.host).toBe('github.com')
    })

    it('captured host is set on thrown error from parser', () => {
      try {
        parseTrackerUrl('https://github.com/owner/repo/discussions/123')
        expect.fail('expected to throw')
      } catch (err) {
        expect(err).toBeInstanceOf(TrackerUrlError)
        expect((err as TrackerUrlError).host).toBe('github.com')
      }
    })
  })
})
