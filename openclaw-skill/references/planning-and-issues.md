# Planning and Issue Management

## il plan

Launch an interactive AI planning session to decompose features into child issues.

**When to use:** Whenever the user has an idea for an improvement, new feature, or wants to break down work into implementable tasks. This is the primary ideation tool — always prefer `il plan` over manually creating issues.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[prompt]` | positional | — | Planning topic or issue identifier (e.g., `#123`, `ENG-456`) |
| `--model <name>` | string | `opus` | Claude model: `opus`, `sonnet`, `haiku` |
| `--yolo` | boolean | `false` | Autonomous mode (bypass all permission prompts) |
| `--planner <provider>` | enum | `claude` | AI planner: `claude`, `gemini`, `codex` |
| `--reviewer <provider>` | enum | `none` | AI reviewer: `claude`, `gemini`, `codex`, `none` |
| `-p, --print` | boolean | `false` | Headless mode for CI/CD (implies `--yolo`) |
| `--output-format <format>` | enum | — | Output format: `json`, `stream-json`, `text` (requires `--print`) |
| `--verbose` | boolean | — | Verbose output (requires `--print`) |
| `--json` | boolean | `false` | Final result as JSON (requires `--print`) |
| `--json-stream` | boolean | `false` | Stream JSONL output (requires `--print`) |

### Modes

**Fresh Planning Mode** — prompt describes the work to plan:
```bash
# Autonomous planning with prompt (required for --yolo)
bash pty:true background:true command:"il plan --yolo --print --json-stream 'Add authentication to the API'"

# Headless planning with JSON output
bash pty:true command:"il plan --yolo --print --output-format json 'Add authentication to the API'"
```

> **Note:** `--yolo` mode requires either a **prompt argument** (description string) or an **issue identifier**. Without one, the command fails immediately.

**Issue Decomposition Mode** — issue identifier provided:
```bash
# Decompose existing issue #123 into child tasks
bash pty:true background:true command:"il plan '#123' --yolo"

# Linear issue decomposition
bash pty:true background:true command:"il plan 'ENG-456' --yolo"
```

See `{baseDir}/references/non-interactive-patterns.md` for execution mode guidance and session lifecycle.

### JSON Output (with `--print`)

```json
{
  "success": true,
  "output": "[Claude planning response]"
}
```

### Capabilities

The planner has access to:
- Issue management (create issues, child issues, dependencies, comments)
- Code exploration (Read, Glob, Grep)
- Web search and fetch
- Git commands (read-only: status, log, branch, remote, diff, show)

---

## il add-issue

Create a new issue with AI-enhanced description.

**Aliases:** `a`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `<description>` | positional | — | Issue title/description (required, >30 chars, >3 words unless `--body` used) |
| `--body <text>` | string | — | Issue body text (bypasses length/word validation) |
| `--json` | boolean | `false` | Output result as JSON (non-interactive) |

### Examples

```bash
# Create issue with AI enhancement (non-interactive)
bash pty:true command:"il add-issue 'Add dark mode toggle to settings page' --json"

# Create issue with explicit body
bash pty:true command:"il add-issue 'Fix login timeout' --body 'Users report 504 errors after 30 seconds' --json"
```

### Behavior

1. Validates description format
2. Runs description through AI enhancement agent (always)
3. Creates the issue on the configured tracker
4. Returns structured result in `--json` mode

See `{baseDir}/references/non-interactive-patterns.md` for prompt bypasses.

### JSON Output

```json
{
  "url": "https://github.com/owner/repo/issues/123",
  "id": 123,
  "title": "Add dark mode toggle to settings page",
  "created_at": "2026-02-17T12:00:00.000Z"
}
```

---

## il enhance

Apply AI enhancement to an existing issue's description.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `<workItem>` | positional | — | Work item identifier (required) |
| `--no-browser` | boolean | `false` | Skip browser opening prompt |
| `--author <username>` | string | — | GitHub username to tag in questions |
| `--json` | boolean | `false` | Output result as JSON (non-interactive) |

### Examples

```bash
# Enhance issue #42 (non-interactive)
bash pty:true command:"il enhance 42 --no-browser --json"

# Enhance with author tagging
bash pty:true command:"il enhance 42 --author johndoe --no-browser --json"
```

See `{baseDir}/references/non-interactive-patterns.md` for prompt bypasses.

### JSON Output

```json
{
  "url": "https://github.com/owner/repo/issues/42#issuecomment-789",
  "id": 789,
  "title": "Issue Title",
  "created_at": "2026-02-17T12:00:00.000Z",
  "enhanced": true
}
```

The `enhanced` field is `false` if the issue already had a thorough description.

---

## il issues

List open issues and PRs from the configured tracker.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | boolean | `false` | Output as JSON array |
| `--limit <n>` | number | `100` | Max number of results |
| `--sprint <name>` | string | — | Filter by sprint (Jira only) |
| `--mine` | boolean | `false` | Show only my issues (Jira only) |

### Examples

```bash
# List all open issues as JSON
bash pty:true command:"il issues --json"

# List with limit
bash pty:true command:"il issues --json --limit 20"

# Jira: filter by sprint
bash pty:true command:"il issues --json --sprint 'Sprint 5'"
```

### Behavior

- Always returns JSON array (no interactive output)
- Results cached for 2 minutes
- Includes both issues and PRs (PRs from GitHub regardless of issue tracker)
- Sorted by `updatedAt` descending

### JSON Output

```json
[
  {
    "id": "123",
    "title": "Fix login timeout",
    "updatedAt": "2026-02-17T12:00:00.000Z",
    "url": "https://github.com/owner/repo/issues/123",
    "state": "open",
    "type": "issue"
  },
  {
    "id": "99",
    "title": "Add dark mode",
    "updatedAt": "2026-02-16T10:00:00.000Z",
    "url": "https://github.com/owner/repo/pull/99",
    "state": "open",
    "type": "pr"
  }
]
```
