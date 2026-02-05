# iloom Settings

This directory contains configuration files for iloom workflows.

## settings.json

The `settings.json` file allows you to customize iloom's behavior for your project.

### Configuration Options

#### mainBranch (optional)
Specifies the name of your main/primary branch. This is used by iloom to determine where to merge completed work.

**Default**: If not specified, iloom will try to detect it automatically by looking for a "main" branch or using the first worktree found.

**Example**:
```json
{
  "mainBranch": "main"
}
```

#### worktreePrefix (optional)
Configures the directory prefix used when creating worktrees. This allows you to customize where and how worktree directories are named.

**Default**: `<repo-folder-name>-looms/` (e.g., if your repo is in `/Users/dev/my-project`, the default folder for looms is `my-project-looms`, as a sibling of your project folder)

**Allowed characters**: Alphanumeric, hyphens (`-`), underscores (`_`), and forward slashes (`/`)

**Prefix Behavior Examples**:

| Configuration | Worktree Path Result | Explanation |
|---------------|---------------------|-------------|
| `"looms"` | `looms-issue-123` | Auto-append hyphen |
| `"looms-"` | `looms-issue-123` | Preserve explicit separator |
| `"looms/"` | `looms/issue-123` | Explicit folder mode |
| `"temp/iloom"` | `temp/iloom-issue-123` | Auto-append hyphen to last part |
| `"temp/iloom-"` | `temp/iloom-issue-123` | Preserve explicit separator |
| `"temp/looms/"` | `temp/looms/issue-123` | Explicit nested folder mode |
| `""` (empty string) | `issue-123` | No prefix mode |
| `undefined` (not set) | `<repo-name>-looms/issue-123` | Use calculated default |

**Key Rules**:
- Only an explicit trailing `/` creates a subfolder
- Otherwise, the last part is always treated as a prefix with auto-appended `-` (if not already present)
- Backslashes are not allowed (use forward slashes for cross-platform compatibility)
- Spaces and special characters (`*?"<>|:`) are not allowed

**Examples**:
```json
{
  "worktreePrefix": "worktrees"
}
```

```json
{
  "worktreePrefix": "temp/branches/"
}
```

```json
{
  "worktreePrefix": ""
}
```

#### workflows (optional)
Configure per-workflow permission modes for Claude CLI. This allows you to control how Claude interacts with your code in different workflow contexts.

**Available workflow types**:
- `issue` - When working on GitHub issues (using `il start <issue-number>`)
- `pr` - When working on pull requests (using `il start <pr-number>`)
- `regular` - When working on regular branches (using `il start <branch-name>`)

**Available permission modes**:
- `plan` - Claude will create a plan and ask for approval before making changes
- `acceptEdits` - Claude will make changes but wait for you to accept each edit
- `bypassPermissions` - Claude will make changes directly without asking (requires `--dangerously-skip-permissions` flag in Claude CLI)
- `default` - Use Claude CLI's default permission behavior (no flags passed)

**Component launch settings**:
- `startIde` - Launch IDE (VSCode) when starting workflow (default: true)
- `startDevServer` - Launch development server in terminal when starting workflow (default: true)
- `startAiAgent` - Launch Claude Code agent when starting workflow (default: true)
- `startTerminal` - Launch terminal window without dev server when starting workflow (default: false)

**Example**:
```json
{
  "workflows": {
    "issue": {
      "permissionMode": "acceptEdits",
      "startIde": true,
      "startDevServer": true,
      "startAiAgent": true,
      "startTerminal": false
    },
    "pr": {
      "permissionMode": "plan",
      "startIde": true,
      "startDevServer": false,
      "startAiAgent": true,
      "startTerminal": true
    },
    "regular": {
      "permissionMode": "bypassPermissions"
    }
  }
}
```

**Use cases**:
- **`plan` mode for PRs**: When reviewing someone else's PR, you might want Claude to plan changes carefully before executing
- **`acceptEdits` mode for issues**: When implementing new features, you might want Claude to suggest changes but let you review each one
- **`bypassPermissions` mode for regular work**: For your own branches where you trust Claude to work autonomously
- **`default` mode**: When you want standard Claude CLI behavior without any special permissions

#### agents (optional)
Configure model preferences for different agent types. This allows you to use more powerful or faster models depending on the task, and optionally use alternative AI providers for specific agents.

**Available models by provider** (as of February 2026):

| Provider | Models | Notes |
|----------|--------|-------|
| `claude` | `sonnet`, `opus`, `haiku` | Default provider. Use the `model` field. |
| `gemini` | `gemini-3-pro-preview` | Requires Gemini MCP server configured. Use the `providers` field. |
| `codex` | `gpt-5.2-codex` | Requires Codex MCP server configured. Use the `providers` field. |

**Claude models**:
- `opus` - Most capable model for complex tasks (default for workflow agents)
- `sonnet` - Balanced performance and speed
- `haiku` - Fastest model for simple tasks

**Available agent types**:
- `iloom-issue-analyze-and-plan` - Combined analysis and planning for SIMPLE tasks
- `iloom-issue-analyzer` - Analyzes and researches GitHub issues to identify root causes
- `iloom-issue-complexity-evaluator` - Quickly assesses issue complexity (uses haiku by default)
- `iloom-issue-enhancer` - Enhances bug/enhancement reports from Product Manager perspective
- `iloom-issue-implementer` - Implements GitHub issues exactly as specified
- `iloom-issue-planner` - Creates detailed implementation plans for issues
- `iloom-code-reviewer` - Reviews uncommitted code changes
- `iloom-artifact-reviewer` - Reviews workflow artifacts (enhancements, analyses, plans) before posting

**Agent Configuration Options**:
- `model` - Claude model to use (sonnet, opus, haiku)
- `review` - Enable artifact review before posting (true/false) - only for workflow agents
- `providers` - Multi-provider configuration for reviewer agents (see below)

**Budget-friendly configuration**:

To reduce costs, you can configure agents to use faster, more economical models. Use this command to have Claude suggest budget-optimized settings:

```bash
iloom config "make my settings more budget friendly"
```

Or manually configure specific agents:

**Basic Example**:
```json
{
  "agents": {
    "iloom-issue-enhancer": { "model": "sonnet" },
    "iloom-issue-analyzer": { "model": "sonnet" },
    "iloom-issue-analyze-and-plan": { "model": "sonnet" },
    "iloom-issue-planner": { "model": "sonnet" },
    "iloom-issue-implementer": { "model": "sonnet" }
  }
}
```

**Multi-provider example** (code review with multiple providers):
```json
{
  "agents": {
    "iloom-issue-analyzer": { "model": "opus" },
    "iloom-issue-planner": { "model": "sonnet" },
    "iloom-code-reviewer": {
      "providers": {
        "claude": "opus",
        "gemini": "gemini-3-pro-preview"
      }
    }
  }
}
```

This configures the code reviewer to use both Claude and Gemini for reviews. Multiple providers can be configured to get reviews from different AI models.

**Artifact Review Configuration**:

The artifact reviewer can validate workflow outputs before they are posted to issues. To enable artifact review:

1. Configure the artifact reviewer with providers
2. Enable `review: true` on workflow agents whose output you want reviewed

```json
{
  "agents": {
    "iloom-artifact-reviewer": {
      "enabled": true,
      "providers": {
        "claude": "sonnet",
        "gemini": "gemini-3-pro-preview"
      }
    },
    "iloom-issue-planner": {
      "review": true
    },
    "iloom-issue-analyzer": {
      "review": true
    }
  }
}
```

**Provider options for reviewers**:
- `claude` - Use Claude for review (sonnet, opus, haiku)
- `gemini` - Use Gemini via MCP (requires Gemini MCP server configured)
- `codex` - Use Codex via MCP (requires Codex MCP server configured)

**Workflow agents that support the `review` flag**:
- `iloom-issue-enhancer`
- `iloom-issue-analyzer`
- `iloom-issue-planner`
- `iloom-issue-analyze-and-plan`
- `iloom-issue-implementer`
- `iloom-issue-complexity-evaluator`

#### capabilities.web.basePort (optional)
Configure the base port number for web workspace port calculations. Each workspace gets a unique port calculated as `basePort + identifier`.

**Default**: `3000`

**Valid Range**: `1` to `65535` (ports 1-1023 are typically reserved by the system, but the validation allows them)

**Port Calculation**:
- **Issue workspaces**: `basePort + issueNumber`
  - Example: basePort `8080` + issue `#42` = port `8122`
- **PR workspaces**: `basePort + prNumber`
  - Example: basePort `8080` + PR `#100` = port `8180`
- **Branch workspaces**: `basePort + deterministic_hash(branchName) % 999 + 1`
  - Example: basePort `8080` + hash offset (1-999) = port `8081-9079`

**Example**:
```json
{
  "capabilities": {
    "web": {
      "basePort": 8080
    }
  }
}
```

**Port Limit Errors**:
If the calculated port exceeds `65535`, workspace creation will fail with an error.
- Example: `basePort: 60000` + `issue: 10000` = `70000` (EXCEEDS LIMIT)
- Solution: Use a lower base port or work with lower-numbered issues/PRs

**Use cases**:
- **Avoid port conflicts**: If port `3000` is already in use by another application
- **Project conventions**: Match your project's standard development port (e.g., `8080`, `5000`)
- **Multiple projects**: Use different base ports for different projects to avoid conflicts

### Complete Example

Here's a complete example showing all available options:

```json
{
  "mainBranch": "main",
  "worktreePrefix": "temp/branches",
  "workflows": {
    "issue": {
      "permissionMode": "acceptEdits"
    },
    "pr": {
      "permissionMode": "plan"
    },
    "regular": {
      "permissionMode": "bypassPermissions"
    }
  },
  "agents": {
    "iloom-issue-implementer": {
      "model": "opus"
    },
    "iloom-issue-complexity-evaluator": {
      "model": "haiku"
    }
  },
  "capabilities": {
    "web": {
      "basePort": 8080
    },
    "database": {
      "databaseUrlEnvVarName": "DATABASE_URL"
    }
  }
}
```

### Minimal Example

All fields are optional. You can start with an empty configuration and add settings as needed:

```json
{}
```

Or just configure the settings you need:

```json
{
  "mainBranch": "develop"
}
```

### Validation

The settings file is validated when loaded. Common validation errors:

- **Invalid permission mode**: Must be one of `plan`, `acceptEdits`, `bypassPermissions`, or `default`
- **Invalid model**: Must be one of `sonnet`, `opus`, or `haiku`
- **Empty mainBranch**: If provided, mainBranch cannot be an empty string
- **Invalid worktreePrefix**: Only alphanumeric characters, hyphens (`-`), underscores (`_`), and forward slashes (`/`) are allowed. Backslashes and spaces are rejected.
- **Invalid basePort**: Must be a number between `1` and `65535`
- **Invalid JSON**: The file must be valid JSON syntax

### Notes

- All settings are optional - iloom will use sensible defaults if settings are not provided
- Settings are loaded from `<project-root>/.iloom/settings.json`
- If the file doesn't exist, iloom will use default behavior without error
- Changes to settings take effect the next time you run an iloom command

## Global Settings

iloom also supports global user-level settings that apply to all projects.

### Location

Global settings are stored at: `~/.config/iloom-ai/settings.json`

### Precedence

Global settings have the lowest precedence in the merge hierarchy:
1. CLI arguments (highest)
2. `.iloom/settings.local.json`
3. `.iloom/settings.json`
4. `~/.config/iloom-ai/settings.json` (lowest)

### Recommended Use Cases

Use global settings for:
- Default agent model preferences (e.g., prefer opus for analysis agents)
- Default workflow permission modes
- Personal preferences that should apply to all your projects

Keep in project settings:
- `mainBranch` - varies per project
- `databaseProviders` - project-specific credentials
- `issueManagement.github.remote` - project-specific
- `protectedBranches` - varies per project
