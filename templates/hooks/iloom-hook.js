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
const os = require('os');
const path = require('path');

// Debug logging - writes to /tmp/iloom-hook.log
// Set ILOOM_HOOK_DEBUG=1 to enable logging
const DEBUG = process.env.ILOOM_HOOK_DEBUG === '1';
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
 * Slugify a worktree path to create a metadata filename.
 * Must match MetadataManager.slugifyPath() algorithm.
 *
 * @param {string} worktreePath - Absolute path to worktree
 * @returns {string} Slugified filename with .json extension
 */
function slugifyPath(worktreePath) {
  // 1. Trim trailing slashes
  let slug = worktreePath.replace(/[/\\]+$/, '');
  // 2. Replace path separators with triple underscores
  slug = slug.replace(/[/\\]/g, '___');
  // 3. Replace non-alphanumeric chars (except _ and -) with hyphens
  slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-');
  // 4. Append .json
  return `${slug}.json`;
}

/**
 * Get the full path to the metadata file for a worktree.
 *
 * @param {string} cwd - Working directory (worktree path)
 * @returns {string} Full path to metadata JSON file
 */
function getMetadataFilePath(cwd) {
  const loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms');
  return path.join(loomsDir, slugifyPath(cwd));
}

/**
 * Update the session ID in the metadata file for a worktree.
 * Silently fails if the metadata file doesn't exist or can't be updated.
 *
 * @param {string} cwd - Working directory (worktree path)
 * @param {string} newSessionId - New session ID to set
 */
async function updateSessionId(cwd, newSessionId) {
  try {
    const filePath = getMetadataFilePath(cwd);
    if (!fs.existsSync(filePath)) {
      debug('No metadata file found, skipping session ID update', { cwd, filePath });
      return;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const metadata = JSON.parse(content);
    metadata.sessionId = newSessionId;
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf8');
    debug('Session ID updated in metadata', { cwd, newSessionId });
  } catch (error) {
    debug('Failed to update session ID', { cwd, error: error.message, stack: error.stack });
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

    debug('Received hook event', { hook_event_name, cwd, notification_type, session_id, tool_name: hookData.tool_name, matcher: hookData.matcher });

    // Handle SessionStart with source='clear' - update session ID in metadata
    // This keeps iloom's session tracking synchronized with Claude's session lifecycle
    if (hook_event_name === 'SessionStart') {
      debug('SessionStart event received', { source: hookData.source });
      if (hookData.source === 'clear') {
        debug('Detected /clear, updating session ID to match Claude');
        await updateSessionId(cwd, session_id);
        debug('Updated session ID for /clear', { cwd, newSessionId: session_id });
      } else {
        debug('SessionStart source is not clear, skipping', { source: hookData.source });
      }
      // SessionStart events are not broadcast - exit early
      process.exit(0);
    }

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
| Bug investigation / analysis - ESPECIALLY INVOLVING 3rd PARTY APIs/LIBRARIES | \`@agent-iloom-issue-analyzer\` → present findings → offer to fix |
| Code changes | \`@agent-iloom-issue-implementer\` - TELL THE AGENT NOT TO MAKE/UPDATE ISSUE COMMENTS TO AVOID POLLUTION |
| On 3rd repeated attempt at fixing the same problem  |  \`@agent-iloom-issue-analyze-and-plan\` → if approved, \`@agent-iloom-issue-implementer\` - DO NOT PROVIDE ADDITIONAL GUIDANCE ABOUT ISSUE COMMENTS |
| On 4rd or more repeated attempt at fixing the same problem  |  \`@agent-iloom-issue-analyzer\` → if approved, \`@agent-iloom-issue-planner\` → if approved, \`@agent-iloom-issue-implementer\`  - IN THIS CASE IT'S OK TO CREATE/UPDATE ISSUE COMMENTS |
| New features / complex changes | \`@agent-iloom-issue-analyze-and-plan\` → if approved, \`@agent-iloom-issue-implementer\` - IN THIS CASE IT'S OK TO CREATE/UPDATE ISSUE COMMENTS |
| Deep questions (how/why something works) | \`@agent-iloom-issue-analyzer\` |

Regarding creating/updating comments - if it's a trivial fix or quick answer, DO NOT create or update issue comments to avoid polluting the issue history. Only create/update comments for complex changes or new features as outlined above.`;

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

main().catch((error) => {
  debug('Unhandled error in main', { error: error?.message, stack: error?.stack });
  process.exit(0);
});
