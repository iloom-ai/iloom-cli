# iloom

<div align="center">

[![npm](https://img.shields.io/npm/v/%40iloom%2Fcli?label=npm)](https://www.npmjs.com/package/@iloom/cli)
[![License: BSL-1.1](https://img.shields.io/badge/license-BSL--1.1-lightgrey)](https://raw.githubusercontent.com/iloom-ai/iloom-cli/main/LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/built%20for-claude%20code-8A6FFF)](https://claude.ai/)
[![CI](https://github.com/iloom-ai/iloom-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/iloom-ai/iloom-cli/actions/workflows/ci.yml)

</div>

<div align="center">
  <img width="327" height="328" alt="iloom-ai-logo" src="https://raw.githubusercontent.com/iloom-ai/iloom-cli/main/assets/iloom-logo.png" />
  <div>Scale understanding, not just output.</div>

</div>

#### Links to key sections
[How It Works](#how-it-works) • [Installation](#installation) • [Commands](#commands) • [Feedback](#providing-feedback) • [Limitations](#platform--integration-support) • [Configuration](#configuration)


## Built For Modern Tools...

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![Neon](https://img.shields.io/badge/Neon-00E699?style=for-the-badge)](https://neon.tech/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-8A6FFF?style=for-the-badge)](https://claude.ai/)

*These companies and projects do not endorse iloom.*

## ...To Solve A Very Modern Problem

The promise of AI-assisted development is profound: write more code, ship features faster, handle complexity at scale. But there's a hidden cost that many tools ignore.

**AI agents write code quickly. They struggle to stay in sync with their humans.**

When you juggle multiple issues, the hard part is not branches or ports. It is keeping you and your AI aligned on the goal.

Friction piles up:
- You open new chats for each problem and rebuild context in your head.
- Mental overhead grows. Stress rises. Momentum drops.
- Hidden assumptions creep in. The AI picks Axios when your team standardizes on fetch. It reaches for the wrong auth pattern.
- Hit a context limit and the model forgets what matters.

The outcome is familiar: more time briefing the AI than building, more time fixing than shipping. Work can look finished while somehow shrouded in mystery.

**The bottleneck isn't output velocity. It's maintaining shared understanding between human and AI at scale.**

*iloom treats context as a first-class concern. It's not a tool for managing branches - it's a control plane for maintaining alignment between you and your AI assistant as you work across multiple issues simultaneously.*

## How iloom Solves This

iloom uses your existing Claude subscription, takes what context you already have, and works with you to build a shared mental model of the task at hand.

```bash
> npm install -g @iloom/cli

# iloom doesn't need your GitHub access token - it uses the GitHub CLI instead.
> gh auth login 

# Spins up an isolated dev environment.
# Pulls in issue 25 from GitHub, even if it's just an issue title.
# Fills in the blanks with you.
> iloom start 25 

# or 

# Creates an issue, builds that same shared mental model from scratch.
> iloom start "user auth broken" 

# or

# Grabs context from this PR and its original issue, then iterates on it alongside you 
> iloom start 34 

# then

# Knows which loom you're in, validates, merges your code back to your primary branch.
# If you hit compilation/lint/test failures or merge conflicts along the way,
# Claude will help resolve them automatically.
> iloom finish 
```

**The iloom difference**: Surface hidden assumptions up front, then persist all the analysis and reasoning in GitHub issue comments - visible and editable - rather than burning tokens in the context window where they're invisible and set in stone.

### One Command, Parallel Work, Predictable Flow

Each loom follows the same workflow - structured, visible, repeatable.

`iloom start` doesn't just create a git worktree. It spins up a loom. Here's what happens:

- Fetches the full GitHub issue (or PR) including all comments and requirements - or not, if they don't exist.
- Creates an isolated environment (Git worktree, database branch, web server on a deterministic unique port)
- Enhances the GitHub issue with a better description, and structured analysis & planning. Asking questions and stating assumptions along the way, all in GitHub comments.
- Launches Claude with this context preloaded from the issue, guides you through a structured workflow. You can stop at any time, pick up where you left off.
- Each loom is color-coded, from terminal windows to VS Code, so you visually know which context you're in.

**When you switch to this loom, both you and Claude know exactly what you're working on and why.**

### Merge with Confidence

```bash
> iloom finish
# ✅ Runs tests, types, lint - Claude helps fix any failures automatically
# ✅ Generates commit message from the issue context
# ✅ Handles merge conflicts with AI assistance
# ✅ Merges to main, installs dependencies
# ✅ Cleans up everything - worktree, database branch, and the web server you were using to test your work
```
(as you can see, using iloom does not spare you from copious emoji)

This isn't just convenience automation. You know you're merging the correct code, correctly - the commit message is auto-generated from the issue context, and any build/test/merge failures get fixed automatically with Claude's help. It helps keep resources in check too, local and remote, by safely shutting down servers and cleaning up Neon DB branches.

## What This Means for How You Work

### You Stop Babysitting Your AI, Start Collaborating With It

Traditional approach:
1. Start a feature, brief Claude on context.
2. Review code, fix misunderstandings. Argue with Claude.
3. Get pulled into a bug - stash or WIP commit, switch branches, start a new Claude chat.
4. Lose context on both tasks, repeat the same explanations.

iloom approach:
1. `il start 45` - begin the feature. Note: `il` is an alias for `iloom`.
2. Review iloom's structured analysis in GitHub, clarify assumptions.
3. `il start 99` - urgent bug; Claude already knows the issue context from the GitHub issue.
4. Switch between looms freely - color coding and context persistence keep everything clear.
5. `il finish` - work validated, merged, cleaned up.
6. Return to your feature loom - context, reasoning, and AI alignment all intact.

**The difference**: Your AI becomes a persistent collaborator rather than a tool you're constantly playing catch-up with.

**Plus, your AI's reasoning is now visible to everyone, including future you:**
The AI analysis gets posted as GitHub comments, so anyone on your team can see the context and planning without having to ask you for background.

### You Scale Understanding, Not Just Output

Without iloom, adding AI to your workflow increases code production but also increases cognitive load. You're managing what the AI knows, correcting misaligned suggestions, and second-guessing its understanding. Not to mention managing its context window.

With iloom, the cognitive load stays constant as you scale. Each loom holds a complete shared understanding between you and your AI. Five issues in flight feel (almost) as calm and clear as one.

**This is how you achieve sustainable velocity with AI assistance.**

### You Reduce Rework and Chaos

When you and your AI are in lockstep:
- Features get built right the first time because you spot when the AI is going off course, way before it writes a line of code.
- Reviews focus on the quality of the AI's thinking, not just its code.
- Fewer surprises caused by AI agents inventing requirements or inconsistently implementing existing patterns
- If the AI takes a wrong turn - you don't spend hours arguing with Claude and playing context window Tetris. You just start the process again with better issue descriptions, different assumptions and better context for your AI assistant.

### The Power of Predictable Flow

Every loom follows the same rhythm - Start → Enhance → Analyze → Plan → Implement → Human review → Finish.  
The steps never change. The tools stay aligned.  
Predictability becomes muscle memory - you focus on ideas, not process.

## How It Works

iloom orchestrates specialized AI agents that analyze issues, evaluate complexity, create implementation plans, and document everything directly in GitHub comments. Each agent has a specific role and writes structured output that becomes permanent project and team knowledge.

### Creating Context

```bash
> il start 25
```

iloom executes a multi-phase context-establishment workflow:

1. **Fetch complete requirements** - GitHub issue body + all comments
2. **Create isolated loom** - Git worktree at `~/project-looms/issue-25-auth-bugs/` (branch names are generated)
3. **Run AI workflow agents** - Enhance, analyze, plan, and document directly in GitHub comments:
   - **Enhancement Agent**: Expands brief issues into detailed requirements (if needed)
   - **Complexity Evaluator**: Assesses scope and determines workflow approach
     - **Simple workflow**: Combined analysis and planning in one step
     - **Complex workflow**: Separate analysis phase, then detailed planning phase
4. **Establish environment** - Unique web server port (e.g., 3025), isolated database branch, `.env` file with correct DATABASE_URL environment variable
5. **Launch tools** - VS Code with color theme, dev server, Claude with preloaded context from GitHub comments

**Result**: A continer where both you and your AI share understanding, with all context stored as structured GitHub comments. Open the issue in your browser to see:
- Enhancement analysis (if the issue was brief)
- Complexity evaluation with metrics
- Root cause analysis and technical findings
- Implementation plan
- All context is editable, reviewable, and persists across machines

### Maintaining Context

Each loom is isolated:

- **Git worktree** - Separate filesystem, different branch checked out, no switching overhead
- **Database branch** - Schema changes don't affect other contexts (optional, requires Neon - other provider support coming soon)
- **Unique port** - Multiple dev servers run simultaneously (base port + issue number)
- **Environment variables** - Each loom has correct database URL
- **Visual identity** - Color-coded VS Code window (40 distinct pastel colors)
- **GitHub issue comments** - Multi-phase context (enhancement, analysis, planning) persists and is editable by team members

**When you switch looms, the context switches with you.**

### Context That Scales With Your Team

Traditional AI workflows store context locally in chat history or Markdown files. iloom stores context where it belongs - in the GitHub issue itself.

**Benefits:**

- **Transparency**: All AI analysis and planning is visible to your entire team
- **Collaboration**: Team members can review, comment on, and refine AI-generated context
- **Persistence**: Context survives repository clones, machine switches, and team member changes
- **Version Control**: GitHub tracks all context changes with timestamps and authors
- **Searchability**: GitHub's search finds AI insights across all your issues
- **Integration**: Context appears in notifications, project boards, and automation workflows
- **No Sync Issues**: Everyone sees the same context - no local file drift

When Claude analyzes your issue and creates a comment with "### Root Cause Analysis", that insight becomes permanent project knowledge. When you switch machines, clone the repo elsewhere, or bring in a new team member - the context is already there.

**This is context as infrastructure, not files.**

### Understanding the Multi-Agent Workflow

When you run `il start 25`, iloom orchestrates specialized AI agents that work through a structured analysis and planning process:

**Phase 1: Enhancement (optional)** - `iloom-issue-enhancer`
- Checks if issue needs more detail (word count, structure, clarity)
- Expands brief descriptions into comprehensive requirements
- Posts enhancement as a GitHub comment
- **Used for:** All issues that need enhancement

**Phase 2: Complexity Evaluation** - `iloom-issue-complexity-evaluator`
- Analyzes scope, file changes, breaking changes, risks
- Classifies as Simple or Complex
- Posts evaluation as a GitHub comment with metrics
- **Used for:** All issues

#### For complex issues

**Phase 3: Dedicated Analysis** - `iloom-issue-analyzer`
- Investigates root causes and technical constraints
- Documents findings and implementation considerations
- Posts analysis as a GitHub comment
- **Used for:** Complex issues only

**Phase 4: Dedicated Planning** - `iloom-issue-planner`
- Creates detailed implementation roadmap
- Breaks work into phases with validation points
- Posts plan as a GitHub comment
- **Used for:** Complex issues only

#### For simple issues

**Phase 3+4: Combined Analysis & Planning** - `iloom-issue-analyze-and-plan`
- Combines analysis and planning in a single step to shorten time and reduce review checkpoints
- Posts combined analysis and plan as a GitHub comment
- **Used for:** Simple issues only

#### For all issues

**Phase 5: Implementation** - `iloom-issue-implementer`
- Executes the implementation plan created in previous phases
- Updates progress in a GitHub comment
- Documents decisions and completion status
- **Used for:** All issues

**Phase 6: Review (optional)** - `iloom-issue-reviewer`
- Reviews completed implementation against issue requirements
- Posts review findings as a GitHub comment
- **Used for:** All issues (when review is requested)

All agent output is written to GitHub issue comments using markdown, making the AI's reasoning process transparent and collaborative. You can review, edit, or refine any comment before proceeding to the next phase.

### A Note on Token Usage and Model Selection

iloom optimizes for **building shared understanding** and **long-term efficiency** over short-term token economy. The multi-phase workflow deliberately front-loads analysis and planning to reduce expensive implementation rework.

You can [configure](#configuration) the models used by the agents:

- **Default**: All agents run on the latest Sonnet model to balance capability and cost
- **Haiku for Implementation**: The `iloom-issue-implementer` agent is a good candidate for the latest Haiku model for token-conscious users, as it follows detailed plans created by analysis/planning agents
- **Maximum Power**: Override to Opus for complex architectural work (more expensive)

**Available agents** (all configurable):
- `iloom-issue-enhancer` - Structures issue descriptions from user perspective
- `iloom-issue-complexity-evaluator` - Assesses scope and determines workflow approach
- `iloom-issue-analyzer` - Investigates root causes (complex issues only)
- `iloom-issue-planner` - Creates implementation roadmap (complex issues only)
- `iloom-issue-analyze-and-plan` - Combined analysis and planning (simple issues only)
- `iloom-issue-implementer` - Executes implementation plans (good candidate for Haiku)
- `iloom-issue-reviewer` - Reviews completed implementations

**Hard-coded model usage** (not configurable):
- **Branch naming** - Uses the latest Haiku model to generate descriptive branch names from issue titles
- **Commit message generation** - Uses the latest Haiku model to create commit messages

Both operations use Haiku for fast, cost-effective AI assistance.

**Fun Fact**: iloom originally used Opus (over the latest Sonnet model) for analysis and planning phases. As agent prompts improved, we switched entirely to Sonnet with equivalent results at lower cost.

**Recommendation**: A Claude Max subscription is recommended. The theory is that token investment in structured/shared context pays dividends through reduced debugging, rework, and cognitive overhead.

## Commands

### Loom Management

```bash
iloom start <issue-number | pr-number | issue-description | branch-name>
# Create loom with complete context
# Orchestrates AI agents that analyze the issue and post structured comments
# Phases: Enhancement → Analysis → Planning → Implementation with review checkpoints at every step
# Aliases: create, up
# Options:
#   --one-shot <mode>  - Automation level for Claude CLI
#                        default: Standard behavior with prompts
#                        noReview: Skip phase approval prompts
#                        bypassPermissions: Full automation, skip all permission prompts. Be careful!

iloom finish
# AI assisted validation, commit, merge steps, as well as loom cleanup (run this from the loom directory)
# Alias: dn

iloom rebase
# Rebase current branch on main with Claude-assisted conflict resolution (run this from a loom directory)
# Options:
#   -f, --force    - Skip confirmation prompts
#   -n, --dry-run  - Preview actions without executing

iloom cleanup [identifier...]
# Remove a loom without merging (safely, by default)

iloom list
# Show active looms with their ports and paths

iloom spin
# Launch Claude with auto-detected loom context
# Options:
#   --one-shot=<mode>  - Same automation modes as 'start'

iloom open [identifier]
# Open loom in browser (web projects) or run configured CLI tool
```

### Issue Management

```bash
iloom add-issue <description>
# Create and AI-enhance GitHub issue (doesn't spin up a loom)
# Alias: a
# Example: il add-issue "Add dark mode toggle to settings"

iloom enhance <issue-number>
# Apply AI enhancement agent to existing GitHub issue
# Expands requirements, asks clarifying questions and adds implementation context
```

## Providing Feedback

Found a bug, have a feature request, or want to contribute ideas to improve iloom CLI? Submit feedback directly from your terminal.

```bash
iloom feedback <description>
# Submit feedback/bug report to iloom-cli repository
# Alias: f
# Example: il feedback "Add support for Linear issue tracking"
# Example: il feedback "The worktree cleanup seems to leave temp files behind"
```

**What happens when you run `iloom feedback`:**

1. **Issue Creation**: Creates a new issue in the [iloom-cli repository](https://github.com/iloom-ai/iloom-cli)
2. **Browser Opening**: Opens the created issue in your browser for you to review and add additional context
3. **AI Enhancement**: Within a couple of minutes, your feedback gets enhanced by iloom to provide clear context and actionable details

**Open the browser to provide additional context. Please:**
- Be specific about what you expected vs. what happened
- Include your environment details if reporting a bug (OS, Node version, etc.)
- Mention the command or workflow that had issues
- Suggest improvements or alternative approaches if you have ideas

Your feedback helps make iloom better for everyone! Issues created through `iloom feedback` are prioritized and reviewed regularly.

### Maintenance

```bash
iloom init
# Setup guide for shell autocomplete, settings file initialization (will do much more soon)
# Run this once per project

iloom update
# Update iloom-cli to the latest version
```

## Configuration

iloom uses a flexible configuration system with clear priority ordering.

### Configuration Priority

Settings are loaded in this order (highest to lowest priority):

1. **CLI arguments** - Command-line flags (e.g., `--one-shot bypassPermissions`)
2. **`.iloom/settings.local.json`** - Local machine settings (gitignored, not committed)
3. **`.iloom/settings.json`** - Project-wide settings (committed to repository)
4. **Built-in defaults** - Hardcoded fallback values

This allows teams to share project defaults via `settings.json` while individual developers maintain personal overrides in `settings.local.json`.

**Example Use Cases:**
- Developer needs different `basePort` due to port conflicts
- Local database connection strings that differ from team defaults
- Personal preferences for `permissionMode` or component launch flags

**Note:** The `.iloom/settings.local.json` file is automatically created and gitignored when you run `il init`.

### Key Configuration:

```jsonc
{
  "mainBranch": "main",
  "capabilities": {
    "web": { "basePort": 3000 },
    "database": { "databaseUrlEnvVarName": "DATABASE_URL" }
  },
  "workflows": {
    "issue": {
      "permissionMode": "default",
      "startIde": true,
      "startDevServer": true,
      "startAiAgent": true,
      "startTerminal": false
    }
  },
  "agents": {
    "iloom-issue-enhancer": {"model":"opus"},
    "iloom-issue-analyzer": {"model":"opus"},
    "iloom-issue-analyze-and-plan":  {"model":"opus"},
    "iloom-issue-implementer":  {"model":"haiku"}
  }
}
```

**Note on agent configuration:** All agents use the latest Sonnet model by default, except complexity evaluator which uses Haiku. You could also try a some different configurations:
- **Opus for analysis/enhancement** - Maximum reasoning capability for understanding requirements and planning
- **Haiku for implementation** - Cost-effective execution of detailed plans (recommended for token-conscious users)

** Common configuration options:**
- `mainBranch` - Primary branch for merging (default: "main")
- `capabilities.web.basePort` - Base port for dev servers (default: 3000)
- `capabilities.database.databaseUrlEnvVarName` - Name of environment variable for database connection URL (default: "DATABASE_URL")
- `workflows` - Per-workflow Claude CLI permission modes and tool launching
- `agents` - Claude model selection (sonnet/opus/haiku) per agent type

All options can be specified in either `settings.json` (project-wide) or `settings.local.json` (local overrides, gitignored).

Port calculation: `assignedPort = basePort + issueNumber`
Example: Issue #25 with basePort 3000 = port 3025

For complete configuration reference, see [.iloom/README.md](./.iloom/README.md)

## Requirements

**Essential:**
- Claude CLI - AI assistance with issue context preloaded
- Node.js 16+
- Git 2.5+ (for worktree support)
- GitHub CLI (`gh`) - authenticated with your repository

**Recommended**
- A Claude Max subscription - iloom uses your own subscription

**Optional (auto-detected):**
- **Neon CLI** - Isolated database branches per loom
- **VS Code** - Color-coded editor windows for visual context
- **iTerm2** (macOS only) - Enhanced terminal experience with dual tabs in a single window (when configured to open both Claude and start a dev server)

Optional features activate automatically when detected.

## Platform & Integration Support

This is an early stage product - platform/tech stack support is limited for now.

**Current Platform Support:**
- ✅ **macOS** - Fully tested and supported
- ⚠️ **Linux/Windows** - Not yet tested, may work with modifications

**Issue Tracking Integration:**
- ✅ **GitHub Issues** - Full support with AI enhancement, analysis, and planning
- 🚧 **Linear** - Native integration coming soon. A two way sync between Linear and your github repo works great currently.

**Project Type Support:**
- ✅ **Node.js web projects** - First-class support via package.json scripts (`dev`, `test`, `build`)
- ✅ **Node.js CLI tools** - Full support with isolated executables (see below)
- 🔧 **Other tech stacks** - Can work now via package.json scripts, native support coming later (open to help!)

We (Claude and I) are actively working on expanding platform and integration support. Contributions welcome!

## Installation

```bash
# Install globally
> npm install -g @iloom/cli

# Authenticate with GitHub
> gh auth login
# do `gh auth login --scopes project` to automatically move issues to in progress

# Initialize in your project
> cd your-project
> il init

# Start working
> il start 25 # existing issue
> il start "Enable log in/sign up with Google account" # new issue
```

## Pull Request Support

iloom works identically with GitHub pull requests:

```bash
> il start 125  # PR number instead of issue number
```

Automatically detects PR, fetches the branch, and creates loom with PR context. Everything else works the same.

## Architecture

**Technologies:**
- TypeScript CLI built with Commander.js
- Git worktrees for loom isolation
- GitHub CLI integration for issues/PRs
- Integration with node-based web servers via standard package.json scripts
- Database branching (Neon) - optional
- Claude CLI integration for AI assistance to resolve compilation/test/lint/merge errors

**Project structure:**
```
src/
├── commands/          # CLI commands (start, finish, cleanup, list, add-issue, enhance, spin, init, open)
├── lib/              # Core business logic (WorkspaceManager, GitWorktreeManager, etc.)
├── utils/            # Utility functions (git, github, env, database, shell)
└── types/            # TypeScript definitions
```

For development guidelines and testing strategy, see [CLAUDE.md](./CLAUDE.md).

### Node.js Web Project Support

iloom provides first-class support for Node.js web applications (next/express/vite, etc) through standardized package.json scripts:

**Required scripts** (auto-detected):
- `dev` - Start development server (launched automatically with unique port)
- `test` - Run test suite (executed during `il finish` validation)

**Optional scripts**:
- `lint` - Code quality checks (run during `il finish` if present)
- `typecheck` - TypeScript validation (run during `il finish` if present)

**How it integrates:**

```bash
> il start 25
# ✅ Runs `pnpm install` in worktree
# ✅ Launches `pnpm dev` on port 3025 (3000 + issue number)
# ✅ Sets up database branch with correct DATABASE_URL

> il finish
# ✅ Runs `pnpm test` (fails if tests fail)
# ✅ Runs `pnpm typecheck` if configured
# ✅ Runs `pnpm lint` if configured
# ✅ AI assists with any failures automatically
```

### Node.js CLI Tool Support

iloom was built using iloom itself. CLI tools get the same isolation benefits as web projects, plus **isolated executable access per loom**.

**How it works:**

When you create a loom for a CLI project, iloom creates workspace-specific binaries so you can test each issue's version independently:

```bash
> il start 52  # Working on CLI feature in issue 52
> cli-tool-52 --version  # Test issue 52's version

> il start 137  # Switch to different CLI issue
> cli-tool-137 --help    # Test issue 137's version

# Original binary still works from main branch
> cli-tool --version     # Unaffected by iloom CLIs
```

**Binary naming**: `<original-name>-<issue/pr-number>`
- Binary named in package.json's "bin" object: `cli-tool`
- Issue 52: `cli-tool-52`
- Issue 137: `cli-tool-137`
- PR 200: `cli-tool-200`

**Cleanup**: When you run `il finish`, the workspace-specific binary is automatically removed along with the worktree and any database branches.

This enables parallel development and testing of CLI features without conflicts or manual PATH manipulation.



**Other tech stacks**: Projects using different languages/frameworks can work with iloom by providing compatible package.json scripts that wrap their native tooling. Native support for additional tech stacks is planned (but probably not for a while).

## Roadmap

**Currently in Development** - Actively developing this CLI tool, with the intent to support more workflow flexibility and different tech stacks, task management tools and DB providers.

### Understanding Git Worktrees

A Git worktree is a separate working directory for the same repository. Instead of switching branches in one directory, you have multiple directories with different branches checked out simultaneously.

Traditional approach:
```bash
> git checkout feature-a    # Switch branch
# Edit files
> git stash                 # Save work
> git checkout feature-b    # Switch branch again
# Edit different files
> git stash pop             # Restore work
> git checkout feature-a    # Switch back
```

Git worktree approach:
```bash
# All exist simultaneously:
~/project-looms/issue-25/  # feature-a checked out
~/project-looms/issue-30/  # feature-b checked out
~/project/                      # main branch

# No branch switching, no stashing, less confusion
```

This is the foundation that enables loom isolation and persistent context. Other awesome tools use worktrees too.

### When to Choose Other Git Worktree Solutions

iloom isn't the only tool that makes git worktrees more accessible. Several excellent alternatives exist, each with different trade-offs:

**Editor-Integrated Solutions:**
- [VS Code Git Worktrees](https://marketplace.visualstudio.com/items?itemName=GitWorktrees.git-worktrees) - Enhanced Git worktree support in VS Code
- [git-worktree.nvim](https://github.com/ThePrimeagen/git-worktree.nvim) - Neovim plugin for rapid worktree management

**Apps**
- [Crystal](https://github.com/stravu/crystal) - Run multiple Codex and Claude Code AI sessions in parallel git worktrees
- [Conductor](https://conductor.build/) - Run a team of coding agents on your Mac

**CLI Helpers:**
- [git-worktree-wrapper](https://github.com/lu0/git-worktree-wrapper) - Manage Git worktrees with `git checkout` and `git branch` commands.

**What They Do Well:**
- Reduce friction of git worktree CLI commands
- Integrate tightly with your editor workflow
- Minimal learning curve if you know git
- Lightweight - just worktree management, nothing more
- Conductor and Crystal help you with Agentic coding too

**Where iloom Differs:**

Most tools focus on **making git worktrees easier to use**, some add-in Agentic coding too. iloom focuses on **making multi-issue AI-assisted development sustainable**.

**Beyond Worktrees:**
- **Database isolation**: Neon branch integration for schema/data separation
- **AI context persistence**: Structured analysis stored in GitHub comments, not local chat history
- **Cognitive overhead reduction**: Color coding, port assignment, environment setup handled automatically
- **Human-AI alignment**: Multi-phase workflow surfaces assumptions before code is written
- **Validation automation**: AI-assisted error fixing during merge process

**The Trade-off:**

Other tools increase code output with minimal process change. iloom increases **sustainable velocity** with a prescriptive workflow. You trade flexibility for:
- Persistent shared understanding between you and your AI
- Reduced time debugging AI misunderstandings
- Less context switching mental overhead
- Complete environment isolation (not just git)

**Choose other solutions if:**
- You primarily work solo without AI assistance
- You want minimal workflow changes
- You just need easier git worktree commands
- You don't see yourself working on multiple tasks at once

**Choose iloom if:**
- You're scaling AI-assisted development across multiple issues
- Cognitive overhead is limiting your velocity more than coding speed
- You work on projects with database schemas that change per feature
- You want AI analysis and planning visible to your whole team

## Contributing

This project follows Test-Driven Development. All code must:
- Be written test-first with comprehensive unit tests
- Achieve >70% code coverage
- Include regression tests against bash script behavior
- Use mock factories for all external dependencies

## License

**Business Source License 1.1** - Free to use for any purpose, including commercial use within your organization.

**You can:**
- ✅ Use freely in your organization and commercial projects
- ✅ Modify and distribute internally
- ✅ Build paid applications with it

**You cannot:**
- ❌ Resell iloom itself as a product or service
- ❌ Incorporate into products/services you sell to others
- ❌ Offer as a hosted service or SaaS

**Converts to Apache 2.0 on 2029-01-01** - Becomes fully open source automatically.

For commercial licensing inquiries, contact Adam Creeger.

See [LICENSE](https://raw.githubusercontent.com/iloom-ai/iloom-cli/main/LICENSE) for complete terms.
