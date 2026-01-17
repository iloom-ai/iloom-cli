#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-undef */
/**
 * iloom-hook.js - Claude Code hook script for iloom-vscode integration
 *
 * This script is called by Claude Code on various events and broadcasts
 * relevant session state changes to all iloom-vscode extension instances
 * via Unix sockets.
 *
 * Events we handle:
 * - Stop → waiting_for_input (Claude finished turn)
 * - PermissionRequest → waiting_for_approval (needs permission)
 * - PreToolUse → working (tool about to execute)
 * - PostToolUse → working (tool finished, clears approval)
 * - SessionEnd → ended (clear notifications)
 * - Notification(idle_prompt) → idle_reminder (60s reminder)
 * - Notification(elicitation_dialog) → tool_input_needed (MCP tool question)
 *
 * Events we skip (exit without broadcasting):
 * - SessionStart - user just launched, they know
 * - SubagentStop - subagent done but main agent may continue
 * - Notification(permission_prompt) - redundant with PermissionRequest
 * - Notification(auth_success) - user just logged in
 * - Any other notification types
 *
 * This is purely a notification mechanism - it does NOT participate in
 * permission approval/denial. Claude Code handles permission prompts in
 * the terminal as normal.
 *
 * Debug logging: Set ILOOM_HOOK_DEBUG=1 to enable logging to /tmp/iloom-hook.log
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Reaction polling configuration
const REACTION_POLL_INTERVAL_MS = 5000; // 5 seconds between polls
const REACTION_POLL_TIMEOUT_MS = 300000; // 5 minutes max wait

// Debug logging - writes to /tmp/iloom-hook.log
// Set ILOOM_HOOK_DEBUG=0 to disable (enabled by default for now)
const DEBUG = process.env.ILOOM_HOOK_DEBUG !== '0';
const LOG_FILE = '/tmp/iloom-hook.log';

function debug(message, data = {}) {
  if (!DEBUG) return;

  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  const logLine = `[${timestamp}] ${message}${dataStr}\n`;

  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch {
    // Ignore logging errors
  }
}

/**
 * Convert workspace path to recap filename
 * Same algorithm as MetadataManager.slugifyPath()
 */
function slugifyPath(loomPath) {
  let slug = loomPath.replace(/[/\\]+$/, '');
  slug = slug.replace(/[/\\]/g, '___');
  slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${slug}.json`;
}

/**
 * Get the recap file path for a workspace
 */
function getRecapFilePath(cwd) {
  const recapsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps');
  return path.join(recapsDir, slugifyPath(cwd));
}

/**
 * Read recap file and get the most recent comment artifact
 * Returns null if no comment artifacts found
 */
function getMostRecentCommentFromRecap(cwd) {
  try {
    const recapPath = getRecapFilePath(cwd);
    if (!fs.existsSync(recapPath)) {
      debug('Recap file not found', { recapPath });
      return null;
    }

    const content = fs.readFileSync(recapPath, 'utf8');
    const recap = JSON.parse(content);

    if (!recap.artifacts || recap.artifacts.length === 0) {
      debug('No artifacts in recap file');
      return null;
    }

    // Filter to comment artifacts and sort by timestamp descending
    const comments = recap.artifacts
      .filter(a => a.type === 'comment')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (comments.length === 0) {
      debug('No comment artifacts found');
      return null;
    }

    const mostRecent = comments[0];
    debug('Found most recent comment', { url: mostRecent.primaryUrl });
    return mostRecent;
  } catch (error) {
    debug('Error reading recap file', { error: error.message });
    return null;
  }
}

/**
 * Extract numeric comment ID from GitHub comment URL
 * URL format: https://github.com/owner/repo/issues/123#issuecomment-456789
 */
function extractCommentIdFromUrl(url) {
  const match = url.match(/#issuecomment-(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Extract owner/repo from GitHub comment URL
 * URL format: https://github.com/owner/repo/issues/123#issuecomment-456789
 */
function extractRepoFromUrl(url) {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1] : null;
}

/**
 * Check if a comment has a thumbs-up reaction
 * Uses gh api to fetch reactions for the comment
 * @returns {boolean} true if thumbs-up found, false otherwise
 */
function hasThumbsUpReaction(commentId, repo) {
  try {
    const apiPath = `repos/${repo}/issues/comments/${commentId}/reactions`;
    const result = execSync(`gh api ${apiPath}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const reactions = JSON.parse(result);

    // Check if any reaction is a thumbs-up (+1)
    const hasThumbsUp = reactions.some(r => r.content === '+1');
    debug('Reaction check result', { commentId, hasThumbsUp, reactionCount: reactions.length });
    return hasThumbsUp;
  } catch (error) {
    debug('Error checking reactions', { error: error.message });
    return false;
  }
}

/**
 * Poll for thumbs-up reaction on a comment
 * Returns true if thumbs-up detected within timeout, false otherwise
 */
async function pollForThumbsUp(commentId, repo) {
  const startTime = Date.now();

  debug('Starting reaction polling', { commentId, repo, timeoutMs: REACTION_POLL_TIMEOUT_MS });

  while (Date.now() - startTime < REACTION_POLL_TIMEOUT_MS) {
    if (hasThumbsUpReaction(commentId, repo)) {
      debug('Thumbs-up detected!', { commentId, elapsedMs: Date.now() - startTime });
      return true;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, REACTION_POLL_INTERVAL_MS));
  }

  debug('Polling timed out without thumbs-up', { commentId, elapsedMs: Date.now() - startTime });
  return false;
}

/**
 * Read JSON from stdin until EOF
 * @returns {Promise<object>} Parsed JSON data from Claude Code
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse stdin JSON: ${error.message}`));
      }
    });

    process.stdin.on('error', reject);
  });
}

/**
 * Find all iloom sockets in /tmp
 *
 * @returns {string[]} Array of socket paths
 */
function findAllIloomSockets() {
  try {
    const tmpDir = '/tmp';
    const files = fs.readdirSync(tmpDir);
    const sockets = files
      .filter(file => file.startsWith('iloom-') && file.endsWith('.sock'))
      .map(file => path.join(tmpDir, file))
      .filter(socketPath => {
        // Verify it's actually a socket
        try {
          const stat = fs.statSync(socketPath);
          return stat.isSocket();
        } catch {
          return false;
        }
      });

    return sockets;
  } catch (error) {
    debug('Error finding iloom sockets', { error: error.message });
    return [];
  }
}

/**
 * Map hook event name to session status
 *
 * @param {string} eventName - The hook_event_name from Claude Code
 * @param {string|undefined} notificationType - notification_type for Notification events
 * @returns {string|null} Status string for iloom-vscode, or null if event should be skipped
 */
function mapEventToStatus(eventName, notificationType) {
  switch (eventName) {
    case 'Stop':
      return 'waiting_for_input';

    case 'PermissionRequest':
      return 'waiting_for_approval';

    case 'PreToolUse':
    case 'PostToolUse':
      return 'working';

    case 'SessionEnd':
      return 'ended';

    case 'Notification':
      if (notificationType === 'idle_prompt') {
        return 'idle_reminder';
      }
      if (notificationType === 'elicitation_dialog') {
        return 'tool_input_needed';
      }
      // Other notification types - not relevant, skip
      return null;

    case 'UserPromptSubmit':
      return 'user_prompt_submit';  // Special marker for additionalContext output

    default:
      // Other events (SessionStart, SubagentStop, etc.) - not relevant, skip
      return null;
  }
}

/**
 * Send status to a single socket (fire and forget)
 *
 * @param {string} socketPath - Path to Unix socket
 * @param {string} status - Session status
 * @param {object} hookData - Full hook data from Claude Code
 * @returns {Promise<void>}
 */
async function sendStatus(socketPath, status, hookData) {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      const message = JSON.stringify({
        type: 'session_status',
        status,
        session_id: hookData.session_id,
        hook_event_name: hookData.hook_event_name,
        cwd: hookData.cwd,
        tool_name: hookData.tool_name,
        tool_input: hookData.tool_input,
        notification_type: hookData.notification_type,
        timestamp: new Date().toISOString()
      });

      client.write(message + '\n');
      // Fire and forget - close connection immediately after sending
      client.end();
      resolve();
    });

    // Handle connection errors silently
    client.on('error', () => {
      resolve();
    });
  });
}

/**
 * Broadcast status to all iloom sockets (fire and forget)
 * Each VSCode instance can filter messages by cwd if needed
 *
 * @param {string[]} socketPaths - Array of socket paths to broadcast to
 * @param {string} status - Session status
 * @param {object} hookData - Full hook data from Claude Code
 */
async function broadcastStatus(socketPaths, status, hookData) {
  debug('Broadcasting to all sockets', { count: socketPaths.length, socketPaths });

  const promises = socketPaths.map(socketPath => {
    return sendStatus(socketPath, status, hookData).catch(error => {
      debug('Broadcast failed for socket', { socketPath, error: error.message });
      return null;
    });
  });

  // Wait for all broadcasts to complete (or fail)
  await Promise.allSettled(promises);
  debug('Broadcast completed');
}

/**
 * Main entry point
 */
async function main() {
  debug('Hook invoked', { ILOOM: process.env.ILOOM, ILOOM_HOOK_DEBUG: process.env.ILOOM_HOOK_DEBUG });

  // Only run when launched via iloom (ILOOM=1)
  // This prevents the hook from doing anything when Claude is run directly
  if (process.env.ILOOM !== '1') {
    debug('ILOOM not set, exiting silently');
    process.exit(0);
  }

  try {
    const hookData = await readStdin();
    const { hook_event_name, cwd, notification_type, session_id } = hookData;

    debug('Received hook event', { hook_event_name, cwd, notification_type, session_id, tool_name: hookData.tool_name });

    const status = mapEventToStatus(hook_event_name, notification_type);
    debug('Mapped event to status', { status });

    // Skip events we don't care about
    if (status === null) {
      debug('Event not relevant, skipping');
      process.exit(0);
    }

    // Special handling for UserPromptSubmit - output JSON additionalContext instead of broadcasting
    if (status === 'user_prompt_submit') {
      const reminder = `**REMINDER**: You MUST USE subagents to preserve your context window for ongoing conversation.

| Request Type | Action |
|--------------|--------|
| Trivial (quick answer, single-line fix) | Handle directly |
| Bug investigation / analysis | \`@agent-iloom-issue-analyzer\` → present findings → offer to fix |
| Code changes | \`@agent-iloom-issue-implementer\` - TELL THE AGENT NOT TO MAKE/UPDATE ISSUE COMMENTS TO AVOID POLLUTION |
| On 3rd repeated attempt at fixing the same problem  |  \`@agent-iloom-issue-analyze-and-plan\` → if approved, \`@agent-iloom-issue-implementer\` - DO NOT PROVIDE ADDITIONAL GUIDANCE ABOUT ISSUE COMMENTS |
| On 4rd or more repeated attempt at fixing the same problem  |  \`@agent-iloom-issue-analyzer\` → if approved, \`@agent-iloom-issue-planner\` → if approved, \`@agent-iloom-issue-implementer\`  - DO NOT PROVIDE ADDITIONAL GUIDANCE ABOUT ISSUE COMMENTS |
| New features / complex changes | \`@agent-iloom-issue-analyze-and-plan\` → if approved, \`@agent-iloom-issue-implementer\` |
| Deep questions (how/why something works) | \`@agent-iloom-issue-analyzer\` |`;

      const output = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: reminder
        }
      };
      console.log(JSON.stringify(output));
      debug('UserPromptSubmit: output additionalContext reminder');
      process.exit(0);
    }

    // Special handling for PermissionRequest on AskUserQuestion - poll for thumbs-up
    if (status === 'waiting_for_approval' && hookData.tool_name === 'AskUserQuestion') {
      debug('AskUserQuestion detected, attempting reaction polling');

      const comment = getMostRecentCommentFromRecap(cwd);
      if (comment && comment.primaryUrl) {
        // Check if this is a GitHub URL (not Linear)
        if (comment.primaryUrl.includes('github.com')) {
          const commentId = extractCommentIdFromUrl(comment.primaryUrl);
          const repo = extractRepoFromUrl(comment.primaryUrl);

          if (commentId && repo) {
            // Poll for thumbs-up in parallel with terminal prompt
            // If detected, return permissionDecision to auto-approve
            const hasApproval = await pollForThumbsUp(commentId, repo);

            if (hasApproval) {
              const output = {
                hookSpecificOutput: {
                  permissionDecision: 'allow'
                }
              };
              console.log(JSON.stringify(output));
              debug('Returning thumbs-up approval');
              process.exit(0);
            }
          } else {
            debug('Could not extract comment ID or repo from URL', { url: comment.primaryUrl });
          }
        } else {
          debug('Non-GitHub URL, skipping reaction polling', { url: comment.primaryUrl });
        }
      } else {
        debug('No recent comment found in recap');
      }

      // If no thumbs-up detected, fall through to normal broadcast
      // Terminal prompt will handle approval
    }

    // Find all iloom sockets for broadcasting
    const allSockets = findAllIloomSockets();
    debug('Found iloom sockets', { count: allSockets.length, sockets: allSockets });

    // If no sockets exist, exit silently (no VSCode extensions running)
    if (allSockets.length === 0) {
      debug('No iloom sockets found, exiting');
      process.exit(0);
    }

    // Broadcast status to all sockets (fire and forget)
    // All events including PermissionRequest are just notifications
    await broadcastStatus(allSockets, status, hookData);

    debug('Hook completed successfully');
  } catch (error) {
    debug('Hook error', { error: error.message, stack: error.stack });
    // Silent failure - don't interrupt Claude
  }
}

main().catch(() => process.exit(0));
