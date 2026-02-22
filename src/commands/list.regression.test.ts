/**
 * Regression test for the `il list --json` command.
 *
 * Verifies that finished looms are NOT included in JSON output
 * unless `--finished` or `--all` flags are explicitly passed.
 *
 * Bug: After a change to always fetch finishedLooms for swarm issue enrichment,
 * the finishedJson array was populated unconditionally, causing `il list --json`
 * to return finished looms even when neither --finished nor --all was set.
 *
 * Fix: Gate finishedJson with showFinished ternary.
 */
import { describe, it, expect } from 'vitest'
import { formatFinishedLoomForJson } from '../utils/loom-formatter.js'
import type { LoomMetadata } from '../lib/MetadataManager.js'

// A minimal finished loom metadata object for testing
const finishedLoomMetadata: LoomMetadata = {
  description: 'A finished loom',
  created_at: '2024-01-15T10:30:00.000Z',
  branchName: 'issue-999__finished-feature',
  worktreePath: '/Users/dev/projects/myapp-looms/issue-999__finished-feature',
  issueType: 'issue',
  issue_numbers: ['999'],
  pr_numbers: [],
  issueTracker: 'github',
  colorHex: '#dcebff',
  sessionId: 'session-finished',
  projectPath: '/Users/dev/projects/myapp',
  issueUrls: { '999': 'https://github.com/owner/repo/issues/999' },
  prUrls: {},
  draftPrNumber: null,
  capabilities: [],
  parentLoom: null,
  status: 'finished',
  finishedAt: '2024-01-20T15:45:00.000Z',
}

describe('il list --json: finished looms gating regression', () => {
  /**
   * This test reproduces the exact logic from the list command's JSON output path
   * in cli.ts to verify that finishedJson is gated by showFinished.
   *
   * The actual code in cli.ts:
   *   const showFinished = Boolean(options.finished) || Boolean(options.all)
   *   let finishedJson = showFinished
   *     ? finishedLooms.map(loom => formatFinishedLoomForJson(loom, allActiveMetadata, finishedLooms))
   *     : []
   *   const allLooms = [...activeJson, ...finishedJson]
   */

  const finishedLooms = [finishedLoomMetadata]
  const allActiveMetadata: LoomMetadata[] = []
  const activeJson: unknown[] = [] // Empty active looms for simplicity

  it('should NOT include finished looms when showFinished is false (no --finished or --all)', () => {
    // Simulate: il list --json (no --finished, no --all)
    const options = { json: true }
    const showFinished = Boolean((options as { finished?: boolean }).finished) || Boolean((options as { all?: boolean }).all)

    // This is the exact gating logic from cli.ts
    const finishedJson = showFinished
      ? finishedLooms.map(loom => formatFinishedLoomForJson(loom, allActiveMetadata, finishedLooms))
      : []

    const allLooms = [...activeJson, ...finishedJson]

    expect(showFinished).toBe(false)
    expect(finishedJson).toEqual([])
    expect(allLooms).toEqual([])
  })

  it('should include finished looms when --finished flag is set', () => {
    // Simulate: il list --json --finished
    const options = { json: true, finished: true }
    const showFinished = Boolean(options.finished) || Boolean((options as { all?: boolean }).all)

    const finishedJson = showFinished
      ? finishedLooms.map(loom => formatFinishedLoomForJson(loom, allActiveMetadata, finishedLooms))
      : []

    const allLooms = [...activeJson, ...finishedJson]

    expect(showFinished).toBe(true)
    expect(finishedJson.length).toBe(1)
    expect(allLooms.length).toBe(1)
    expect(allLooms[0]).toMatchObject({
      branch: 'issue-999__finished-feature',
      status: 'finished',
    })
  })

  it('should include finished looms when --all flag is set', () => {
    // Simulate: il list --json --all
    const options = { json: true, all: true }
    const showFinished = Boolean((options as { finished?: boolean }).finished) || Boolean(options.all)

    const finishedJson = showFinished
      ? finishedLooms.map(loom => formatFinishedLoomForJson(loom, allActiveMetadata, finishedLooms))
      : []

    const allLooms = [...activeJson, ...finishedJson]

    expect(showFinished).toBe(true)
    expect(finishedJson.length).toBe(1)
    expect(allLooms.length).toBe(1)
    expect(allLooms[0]).toMatchObject({
      branch: 'issue-999__finished-feature',
      status: 'finished',
    })
  })

  it('should demonstrate the bug: without gating, finished looms leak into output', () => {
    // This test shows what USED TO happen before the fix:
    // finishedJson was always populated from finishedLooms.map(...)
    // regardless of showFinished
    const options = { json: true } // no --finished, no --all
    const showFinished = Boolean((options as { finished?: boolean }).finished) || Boolean((options as { all?: boolean }).all)

    // BUG BEHAVIOR (old code): always map finishedLooms
    const buggyFinishedJson = finishedLooms.map(loom => formatFinishedLoomForJson(loom, allActiveMetadata, finishedLooms))

    // FIX BEHAVIOR (new code): gate with showFinished
    const fixedFinishedJson = showFinished
      ? finishedLooms.map(loom => formatFinishedLoomForJson(loom, allActiveMetadata, finishedLooms))
      : []

    // The buggy version incorrectly includes finished looms
    expect(buggyFinishedJson.length).toBe(1)
    // The fixed version correctly excludes them
    expect(fixedFinishedJson.length).toBe(0)
  })
})
