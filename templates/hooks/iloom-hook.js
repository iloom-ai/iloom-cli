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
 * - SubagentStop - subagent done but main agent may continue (recap handled via PostToolUse)
 * - Notification(permission_prompt) - redundant with PermissionRequest
 * - Notification(auth_success) - user just logged in
 * - Any other notification types
 *
 * Special handling:
 * - PostToolUse for Task tool - outputs recap reminder to parent agent via additionalContext
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

// Debug logging - writes to /tmp/iloom-hook.log
// Set ILOOM_HOOK_DEBUG=0 to disable (enabled by default for now)
const DEBUG = process.env.ILOOM_HOOK_DEBUG !== '0';
const LOG_FILE = '/tmp/iloom-hook.log';
const RECAP_LOG_FILE = '/tmp/iloom-recap-hook.log';


function debug(message, data = {}, logFile = LOG_FILE) {
  if (!DEBUG) return;

  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  const logLine = `[${timestamp}] ${message}${dataStr}\n`;

  try {
    fs.appendFileSync(logFile, logLine);
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
 * Handle PostToolUse for Task tools - output recap reminder to parent agent
 * This fires after a Task (subagent) completes, with output going to the parent.
 * @param {object} hookData - Hook input data
 * @returns {object|null} Response with additionalContext or null to skip
 */
function handleTaskPostToolUse(hookData) {
  debug('=== handleTaskPostToolUse ENTER ===', {
   tool_name: hookData.tool_name,
   tool_input: hookData.tool_input,
   tool_result: hookData.tool_result
  }, RECAP_LOG_FILE);

  // Only handle Task tool
  if (hookData.tool_name !== 'Task') {
    debug('SKIP: not a Task tool', { tool_name: hookData.tool_name }, RECAP_LOG_FILE);
    return null;
  }

  // Get subagent_type from tool_input (the input to the Task tool)
  const subagentType = hookData.tool_input?.subagent_type;
  debug('Task tool detected', { subagentType }, RECAP_LOG_FILE);

  // Only handle iloom agents
  if (!subagentType || !subagentType.includes('iloom')) {
    debug('SKIP: not an iloom agent', { subagentType, hasIloom: subagentType?.includes('iloom') }, RECAP_LOG_FILE);
    return null;
  }

  debug('MATCH: iloom agent detected', { subagentType }, RECAP_LOG_FILE);

  // Check environment variable for phase reminders setting
  // ILOOM_RECAP_PHASE_REMINDERS is injected by iloom when launching Claude
  // Default is 'true' if not set (matches settings schema default)
  const phaseRemindersEnv = process.env.ILOOM_RECAP_PHASE_REMINDERS;
  if (phaseRemindersEnv === 'false') {
    debug('SKIP: Phase reminders disabled via ILOOM_RECAP_PHASE_REMINDERS=false', {}, RECAP_LOG_FILE);
    return null;
  }

  debug('RETURNING REMINDER: phaseReminders enabled', { phaseRemindersEnv }, RECAP_LOG_FILE);

  // Return PostToolUse response with additionalContext - this goes to the parent agent
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `**Recap check:** Did this phase produce anything the USER would want to know?

**First:** Use \`get_recap\` to see what's already captured - avoid duplicates.
**Add if new:** architectural choice, non-obvious discovery, risk, assumption
**SKIP if:** already in recap, phase skipped, complexity classification, "tests pass", anything about YOUR process

The recap is for the USER, not a log of your workflow.`
    }
  };
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

    // Handle PostToolUse for Task tools - output recap reminder to parent agent
    // This fires after a Task (subagent) completes, with additionalContext going to the parent
    if (hook_event_name === 'PostToolUse' && hookData.tool_name === 'Task') {
      debug('=== main() PostToolUse Task detected ===', { session_id, cwd, tool_name: hookData.tool_name }, RECAP_LOG_FILE);
      const response = handleTaskPostToolUse(hookData);
      if (response) {
        debug('OUTPUT RESPONSE to stdout', { hookEventName: response.hookSpecificOutput?.hookEventName }, RECAP_LOG_FILE);
        // Output JSON with hookSpecificOutput.additionalContext - goes to parent agent
        console.log(JSON.stringify(response));
        debug('RESPONSE OUTPUT COMPLETE', {}, RECAP_LOG_FILE);
      } else {
        debug('NO RESPONSE returned from handleTaskPostToolUse', {}, RECAP_LOG_FILE);
      }
      // Continue to allow other processing (e.g., broadcasting) to occur
    }

    const status = mapEventToStatus(hook_event_name, notification_type);
    debug('Mapped event to status', { status });

    // Skip events we don't care about
    if (status === null) {
      debug('Event not relevant, skipping');
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

main().catch(() => process.exit(0));
