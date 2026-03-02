# Configuration

## Settings System

iloom uses a layered settings system with three files:

| File | Location | Scope | Git |
|------|----------|-------|-----|
| Global settings | `~/.config/iloom-ai/settings.json` | All projects | N/A |
| Project settings | `.iloom/settings.json` | This project | Committed |
| Local settings | `.iloom/settings.local.json` | This machine | Gitignored |

Local overrides project, project overrides global.

For the complete settings schema and all configuration options, see `{baseDir}/references/initialization.md`.

### Runtime Setting Overrides

Use `--set` to override any setting for a single command:

```bash
bash pty:true command:"il start 42 --set mergeBehavior.mode=github-pr --set capabilities.web.basePort=4000"
```

The `--set` flag accepts dot notation and can be repeated.

---

## Environment Variables

### iloom Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ILOOM_DEBUG` | Enable debug logging | `false` |
| `ILOOM_SHELL` | Override shell detection | Auto-detect |
| `ILOOM_SETTINGS_PATH` | Override settings file location | `~/.config/iloom-ai/settings.json` |
| `ILOOM_NO_COLOR` | Disable colored output | `false` |
| `ILOOM_DEV_SERVER_TIMEOUT` | Dev server startup timeout (ms) | `180000` |
| `ILOOM_UPDATE_CACHE_TIMEOUT_MINS` | Update check cache TTL (minutes) | `60` |

### Issue Tracker Variables

| Variable | Description | Required For |
|----------|-------------|-------------|
| `LINEAR_API_TOKEN` | Linear API authentication | Linear integration |
| `JIRA_HOST` | Jira instance URL | Jira integration |
| `JIRA_USERNAME` | Jira username | Jira integration |
| `JIRA_API_TOKEN` | Jira API token | Jira integration |
| `JIRA_PROJECT_KEY` | Jira project key | Jira integration |

### Standard Variables

| Variable | Description |
|----------|-------------|
| `CI` | When `true`, disables interactive prompts |
| `CLAUDE_API_KEY` | Claude API key (if not using Claude CLI auth) |

---

## Global CLI Flags

Available on all commands:

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Display command help |
| `--version`, `-v` | Display iloom version |
| `--debug` | Enable debug output |
| `--no-color` | Disable colored output |
| `--set <key=value>` | Override any setting (repeatable) |

---

## il projects

List all configured iloom projects.

```bash
bash pty:true command:"il projects --json"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | boolean | `false` | Output as JSON array |

### JSON Output

```json
[
  {
    "configuredAt": "2026-01-15T10:00:00.000Z",
    "projectPath": "/path/to/project",
    "projectName": "my-project",
    "activeLooms": 3,
    "capabilities": ["web", "cli"]
  }
]
```

---

## il update

Update iloom CLI to the latest version.

```bash
bash pty:true command:"il update"
bash pty:true command:"il update --dry-run"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dry-run` | boolean | `false` | Check for updates without installing |

Only works for globally installed iloom (`npm install -g`).

---

## il feedback

Submit bug reports or feature requests to the iloom repository.

```bash
bash pty:true command:"il feedback 'The rebase command fails on merge commits' --body 'Steps to reproduce...' --json"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `<description>` | positional | — | Feedback description (>30 chars, >3 words) |
| `--body <text>` | string | — | Detailed body text |
| `--json` | boolean | `false` | Output as JSON |

---

## il contribute

Fork, clone, and set up the iloom repository for contribution.

```bash
bash pty:true command:"il contribute"
```

No flags. Interactive setup process.
