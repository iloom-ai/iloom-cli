# Getting Started with iloom

This guide walks you through setting up iloom and completing your first workflow. Whether you use GitHub or Linear for issue tracking, you will have a working environment within minutes.

## VS Code User?

Install the [iloom VS Code Extension](https://marketplace.visualstudio.com/items?itemName=iloom-ai.iloom-vscode) for an integrated experience:

- **Explorer Panel** - View and manage all active looms from the sidebar
- **Recap Panel** - Track workflow progress, decisions, and artifacts
- **Quick Switch** - Jump between looms without leaving the editor
- **Command Palette** - Access all loom operations via `Cmd+Shift+P`

The extension works alongside the CLI - use whichever is more convenient for each task.

---

## Prerequisites

### System Requirements

- **macOS** (Windows support coming soon)

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 16+ | Runtime for iloom CLI |
| Git | 2.5+ | Worktree support for isolated environments |
| Claude Code CLI | Latest | AI-powered analysis and planning |

**Claude Subscription:** iloom uses your existing Claude subscription (Claude Max recommended) through the Claude Code CLI. Install it from [claude.ai](https://claude.com/product/claude-code).

### Recommended Tools

| Tool | Purpose |
|------|---------|
| [iTerm2](https://iterm2.com) | Enhanced terminal for macOS with better split panes and session management |

### For GitHub Users (Default)

Install and authenticate the GitHub CLI:

```bash
# Install GitHub CLI (macOS)
brew install gh

# Authenticate
gh auth login
```

### For Linear Users

You will need a Linear API token. Get one from Linear Settings > API > Personal API keys. You will configure this during project initialization.

Note: Even though you're using Linear you will need the GH CLI if you use a PR-based workflow.

### Installation

```bash
npm install -g @iloom/cli
```

Verify the installation:

```bash
il --version
```

---

## Project Initialization

The first time you run `il start` in a project, iloom automatically runs the configuration wizard. Just start working:

```bash
cd your-project
il start 123  # First run triggers il init automatically
```

The wizard guides you through:
- Issue tracker selection (GitHub or Linear)
- Database provider setup (Neon, if applicable)
- IDE preference (VS Code, Cursor, Windsurf, etc.)
- Workflow mode (local, PR, or draft PR)

You can also run `il init` manually if you want to configure before starting work.

### Natural Language Configuration

You can also configure iloom using plain English instructions - no need to memorize exact setting names.

**Examples:**

```bash
# Configure your preferred IDE
il config "I want to use Cursor as my editor"

# Switch to draft PR mode for team workflows
il config "I want to use draft PRs"

# Set up Linear integration
il config "I want to use Linear for issue tracking"

# Configure GitHub PR mode
il config "I want PRs to be created when I finish work"

# Set up local-only development (no PRs)
il config "I want to merge directly to main without creating PRs"

# Configure Neon database integration
il config "set up Neon database with project ID abc-123"

# Multiple settings at once
il config "set my IDE to windsurf and configure linear"
```

Note: `il init` is just an alias for `il config`.

See [Provider-Specific Setup](#provider-specific-setup) for detailed GitHub and Linear configuration.

---

## Workflow Modes

iloom supports three modes for handling finished work:

| Mode | When PR is Created | Best For |
|------|-------------------|----------|
| `local` | Never | Solo development, rapid iteration |
| `github-pr` | On `il finish` | Team environments |
| `github-draft-pr` | On `il start` | Open source, early visibility |

- **Local** (default): Merge directly to main without creating a PR
- **GitHub PR**: Create a PR when you run `il finish`
- **GitHub Draft PR**: Create a draft PR on `il start`, mark it ready on `il finish`

Configure with:

```bash
il config "I want to use draft PRs"
il config "I want PRs created when I finish"
il config "I want to merge directly without PRs"
```

---

## The Core Workflow: Start, Work, Finish

### Step 1: Start a Loom

```bash
# GitHub issue
il start 25

# Linear issue
il start ILM-42

# Create a new issue and start work
il start "Add dark mode toggle to settings"
```

When you run `il start`, iloom:

1. **Fetches** the issue details from GitHub or Linear
2. **Enhances** brief descriptions into detailed requirements
3. **Evaluates** complexity to choose the right workflow
4. **Analyzes** the codebase and problem space
5. **Plans** the implementation with file-level specificity
6. **Creates** an isolated environment (Git worktree, database branch, unique port)
7. **Launches** your IDE with the workspace ready

All AI reasoning is posted as issue comments, creating a permanent record for you and your team.

### Step 2: Work in Your Loom

Your loom is a fully isolated environment:

```
~/your-project-looms/feat-issue-25-dark-mode/
```

- **Unique port:** Web projects run on port `3000 + issue number` (e.g., 3025)
- **Database branch:** Schema changes are isolated from other looms if you've configured Neon DB
- **Environment files:** Each loom has its own set of `.env` files (including .local and environment specific ones)

Launch Claude with full context:

```bash
il spin
```

Commit your work:

```bash
il commit
```

View your active looms:

```bash
il list
```

### Step 3: Finish and Merge

Run from inside your loom, or specify the issue number or branch name:

```bash
il finish           # From inside the loom
il finish 25        # From anywhere, by issue number
il finish feat-25   # From anywhere, by branch name
```

This command:

1. Rebases on main (Claude helps resolve conflicts if needed)
2. Runs validation (typecheck, lint, tests)
3. If failures occur, launches Claude to help fix them
4. Commits any uncommitted changes
5. Merges or creates PR (based on your workflow mode)
6. Cleans up the worktree and database branch

---

## Planning vs Starting: When to Use Each

iloom offers two ways to begin work: `il plan` for strategic decomposition and `il start` for immediate implementation.

### Use `il plan` when:

- You have a complex feature that needs decomposition into multiple issues
- You want to create an epic with child issues
- You need to think through architecture before implementation
- You want Claude to help identify dependencies between tasks
- You have an existing issue that needs to be broken down

### Use `il start "<description>"` when:

- You have a single, focused task to implement
- The work fits in one PR
- You want to immediately create a loom and start coding
- You already know exactly what needs to be done

### Planning Modes

**Fresh Planning** - Start from scratch with a topic:

```bash
il plan "Implement user authentication with OAuth providers"
```

**Decomposition Mode** - Break down an existing issue:

```bash
il plan 42      # Decompose GitHub issue #42
il plan ENG-123 # Decompose Linear issue ENG-123
```

In decomposition mode, the Architect fetches the existing issue's context, any child issues already created, and existing dependencies - so you can resume planning where you left off.

### Multi-AI Provider Configuration

Configure different AI providers for planning and review phases:

```bash
# Use Gemini for planning with Claude review
il plan --planner gemini --reviewer claude "Add OAuth support"

# Use Claude for planning with no review (default)
il plan --planner claude --reviewer none "Add logging"
```

Or set defaults using `il config`:

```bash
il config "change the planning agent to gemini and the reviewer to claude"
```

or directly in `.iloom/settings.json` or `.iloom/settings.local.json`:

```json
{
  "plan": {
    "planner": "gemini",
    "reviewer": "claude"
  }
}
```

### Code Review with Gemini MCP (Recommended)

For code review during implementation, iloom can use Gemini via the Gemini MCP server. This is **recommended** due to observed high quality review results.

**Step 1: Install and Configure Gemini MCP**

Add the Gemini MCP server to your Claude Code configuration (`~/.claude.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "@anthropic/gemini-mcp-server"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

Get your Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

**Step 2: Configure the Code Review Agent**

Add the `iloom-code-reviewer` agent configuration to `.iloom/settings.json`:

```json
{
  "agents": {
    "iloom-code-reviewer": {
      "providers": {
        "gemini": "gemini-3-pro-preview"
      }
    }
  }
}
```

This configures iloom to use Gemini for reviewing code changes against issue requirements during the implementation workflow.

### Autonomous Mode

For hands-off planning, use `--yolo` to skip permission prompts:

```bash
il plan --yolo "Add GitLab integration"
il plan --yolo 42  # Autonomous decomposition
```

**Warning:** Autonomous mode uses `--dangerously-bypass-permissions`, which can perform irreversible damage. Use this mode at your own risk and, of course, review the results carefully.

### Example Workflow

```bash
# For complex features - plan first, then start individual issues
il plan "Implement user authentication with OAuth providers"
# Architect creates Epic #100 with child issues #101, #102, #103

il start 101  # Start work on first child issue
# ... implement and finish ...
il start 102  # Continue with next child issue

# For simple tasks - start directly
il start "Fix typo in login error message"
```

**Key Difference:** `il plan` creates issues but does NOT create a loom workspace. Use `il start <issue-number>` after planning to begin implementation on each child issue.

---

## Keeping Your Branch Current with il rebase

For long-running features, main may advance while you work. Use `il rebase` to stay current:

```bash
il rebase
```

This command:

1. Fetches the latest main branch
2. Automatically handles uncommitted changes (creates a temporary WIP commit)
3. Attempts to rebase your branch onto the main branch.
4. If conflicts occur, launches Claude to help resolve them
5. Restores your uncommitted changes after success

**When to use:**

- Main has new commits you need now (before finishing)
- Proactively on long-running branches

Note: `il finish` automatically rebases, so you only need `il rebase` when you want main's changes before you're ready to finish.

---

## Child Looms

Sometimes you need to branch off from a branch. Child looms let you create workspaces within workspaces.

### When to Use Child Looms

- Breaking down a large feature into smaller PRs
- Handling an urgent bug while deep in feature work
- Experimenting without affecting your main feature branch

### Creating a Child Loom

When you run `il start` from inside an existing loom, iloom prompts you to create a child loom:

```bash
# Inside ~/your-project-looms/feat-issue-25-auth/
il start 42
# iloom asks: Create as child loom?
```

Force the behavior with flags:

```bash
il start 42 --child-loom      # Always create as child
il start 42 --no-child-loom   # Always create independent
```

#### Rebasing in Child Looms

When you run `il rebase` from wthin a Child Loom, it rebases the branch onto the parent branch, NOT onto main.

### Inheritance

Child looms inherit from their parent, not from main:

- Git branch starts from parent's current state
- Database branch is copied from parent's branch
- Child looms are stored in a separate directory

### Directory Structure

```
~/
├── your-project/                     # Main project repo
├── your-project-looms/               # Regular looms directory
│   └── feat-issue-25-auth/           # Parent Loom
└── feat-issue-25-auth-looms/         # Child looms directory (sibling)
    ├── fix-issue-42-bug/             # Child Loom
    └── feat-issue-43-subtask/        # Another Child Loom
```

---

## Provider-Specific Setup

### GitHub Setup

GitHub is the default provider. After authenticating with `gh auth login`, iloom works automatically.

**For multi-remote repositories** (e.g., fork + upstream), specify which remote to use for issues:

```bash
il config "use upstream remote for issues"
```

**Key features with GitHub:**
- Issue and PR support
- All workflow modes available (local, github-pr, github-draft-pr)
- Issue references: `#123`, PR references: `#456`

### Linear Setup

Linear requires an API token. You can provide it via environment variable or local settings.

Set your API token via environment variable:

```bash
export LINEAR_API_TOKEN="lin_api_..."
```

Then configure iloom to use Linear:

```bash
il config "I want to use Linear for issue tracking with team ENG"
```

Get your API token from Linear Settings > API > Personal API keys.

**Key differences from GitHub:**

| Feature | GitHub | Linear |
|---------|--------|--------|
| Issue references | `#123` | `ENG-123`, `ILM-42` |
| Workflow modes | All three | All three (PRs go through GitHub) |

When using Linear with PR workflow modes, PRs are created on GitHub while issues are tracked in Linear. You'll need both `LINEAR_API_TOKEN` and `gh auth login` configured.

---

## Next Steps

- [Complete Command Reference](./iloom-commands.md) - All commands, options, and examples
- [Multi-Language Projects](./multi-language-projects.md) - Python, Rust, Ruby, Go, and more
