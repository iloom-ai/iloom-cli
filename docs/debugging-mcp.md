# Debugging iloom MCP Servers

When you see "issue_management · ✘ failed" in Claude Code, it means the MCP server isn't starting properly. Here's how to debug it:

## 1. Check MCP Server Logs

The MCP server logs errors to stderr. To see them:

```bash
# Navigate to your project with iloom configured
cd /path/to/your/project

# Start a loom (this generates the MCP config)
il start YOUR-ISSUE-123

# The MCP server is launched by Claude Code
# Check Claude Code's output panel for errors
```

## 2. Test MCP Server Manually

You can test the MCP server directly:

```bash
# Set required environment variables for Jira
export ISSUE_PROVIDER=jira
export JIRA_HOST="https://yourcompany.atlassian.net"
export JIRA_USERNAME="your.email@company.com"
export JIRA_API_TOKEN="your-api-token"
export JIRA_PROJECT_KEY="PROJ"

# Optional: transition mappings
export JIRA_TRANSITION_MAPPINGS='{"In Review":"Start Review"}'

# Run the MCP server
node dist/mcp/issue-management-server.js
```

The server should start and output:
```
Starting Issue Management MCP Server...
Environment validated
Issue management provider: jira
```

## 3. Common Issues

### Missing Environment Variables

**Error:** `Missing required environment variables for Jira provider: ...`

**Solution:** Ensure all required Jira settings are in your `.iloom/settings.local.json`:

```json
{
  "issueManagement": {
    "jira": {
      "apiToken": "your-api-token-here"
    }
  }
}
```

And in `.iloom/settings.json`:
```json
{
  "issueManagement": {
    "provider": "jira",
    "jira": {
      "host": "https://yourcompany.atlassian.net",
      "username": "your.email@company.com",
      "projectKey": "PROJ"
    }
  }
}
```

### Invalid Provider

**Error:** `Invalid ISSUE_PROVIDER: ... Must be 'github', 'linear', or 'jira'`

**Solution:** Check that `issueManagement.provider` in your settings is set to one of the supported values.

### API Authentication Failure

**Error:** `Jira API error (401): ...`

**Solution:** 
1. Verify your Jira API token is correct
2. Generate a new token at: https://id.atlassian.com/manage-profile/security/api-tokens
3. Ensure the token has proper permissions

**Error:** `Jira API error (403): ...`

**Solution:** Your user account may not have permission to access the Jira project. Contact your Jira administrator.

## 4. Check MCP Configuration

iloom generates MCP configuration that Claude Code uses. You can inspect it:

```bash
# Check what MCP config iloom would generate
il start --help  # This won't actually start, but shows the config

# Or manually test config generation:
node --input-type=module -e "
import { generateIssueManagementMcpConfig } from './dist/utils/mcp.js';
import { SettingsManager } from './dist/lib/SettingsManager.js';

const settingsManager = new SettingsManager();
const settings = await settingsManager.loadSettings();
const config = await generateIssueManagementMcpConfig(
  'issue',
  null,
  'jira',
  settings
);
console.log(JSON.stringify(config, null, 2));
"
```

## 5. Verbose Logging

To see more detailed logs, set the DEBUG environment variable before starting Claude Code:

```bash
# On macOS/Linux
export DEBUG=iloom:*

# On Windows (PowerShell)
$env:DEBUG="iloom:*"

# Then start Claude Code
```

## 6. Test Jira Connection

Test that iloom can connect to Jira:

```bash
# This will attempt to fetch an issue
il start PROJ-123

# If successful, you should see:
# ✓ Issue found: PROJ-123
```

## 7. Claude Code MCP Settings

Check that Claude Code is configured to use iloom's MCP servers. The config should be in `~/.claude/settings.json` or your project's `.claude/settings.local.json`.

Look for:
```json
{
  "mcpServers": {
    "issue_management": {
      "transport": "stdio",
      "command": "node",
      "args": ["/path/to/iloom/dist/mcp/issue-management-server.js"],
      "env": {
        "ISSUE_PROVIDER": "jira",
        "JIRA_HOST": "...",
        // ...other Jira env vars
      }
    }
  }
}
```

## 8. Still Having Issues?

If the MCP server still isn't working:

1. **Check iloom version:** Run `il --version` and ensure you have the latest version
2. **Reinstall dependencies:** `cd /path/to/iloom && pnpm install && pnpm build`
3. **Check Node version:** MCP servers require Node.js 18 or later
4. **File an issue:** Include the full error output and your (redacted) settings
