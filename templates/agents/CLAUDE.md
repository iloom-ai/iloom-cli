# templates/agents/

> **Maintenance:** Keep this file in sync with the directory contents. If you add, remove, or change an agent's role, update the relevant section below.

This directory contains phase agent definitions as Markdown files with YAML frontmatter. They are loaded by `AgentManager`, rendered to `.claude/agents/` in worktrees, and invoked as skills during workflows.

## Phase Agent Lifecycle

Agents execute in a fixed sequence during issue workflows. Each phase has a single responsibility:

```
complexity-evaluator → analyzer (or analyze-and-plan for SIMPLE) → planner → implementer → code-reviewer
```

- **SIMPLE tasks** (< 5 files, < 200 LOC): Use `analyze-and-plan` which combines analysis + planning into one step, then `implementer`
- **COMPLEX tasks**: Full pipeline: `analyzer` → `planner` → `implementer`
- **Code review**: `code-reviewer` runs after implementation (swarm mode only; in regular mode, review is optional)
- **Wave verification**: `wave-verifier` is an epic-level agent that verifies a wave of completed children

## Agent Files

| Agent | Phase | Model | Used In | Responsibility |
|-------|-------|-------|---------|---------------|
| `iloom-issue-complexity-evaluator.md` | Triage | haiku | Regular + Swarm | Classify task as SIMPLE or COMPLEX |
| `iloom-issue-analyzer.md` | Analysis | opus | Regular + Swarm | Deep research for COMPLEX tasks |
| `iloom-issue-analyze-and-plan.md` | Analysis + Planning | opus | Regular + Swarm | Combined phase for SIMPLE tasks |
| `iloom-issue-planner.md` | Planning | opus | Regular + Swarm | Detailed implementation plan (COMPLEX only) |
| `iloom-issue-implementer.md` | Implementation | opus | Regular + Swarm | Execute the plan, run typecheck/lint/tests |
| `iloom-code-reviewer.md` | Review | opus | Swarm | Autonomous code review, no human gates |
| `iloom-issue-enhancer.md` | Enhancement | — | Regular | Enhance issue descriptions with context |
| `iloom-wave-verifier.md` | Verification | — | Swarm (epic) | Verify a wave of completed children |
| `iloom-framework-detector.md` | Setup | — | Regular | Detect project frameworks/capabilities |
| `iloom-artifact-reviewer.md` | Review | — | Regular | Review generated artifacts |

## YAML Frontmatter Format

```yaml
---
name: iloom-issue-implementer
description: One-line description of this agent's role
model: opus          # Default model (can be overridden by settings)
color: green         # Optional: terminal color for status display
tools:               # Optional: restrict available tools
  - Read
  - Edit
  - Bash
---

Agent prompt content in Markdown...
```

## Model Override Rules

Agent models resolve in this order (highest priority first):
1. **CLI flag**: `--set agents.iloom-issue-implementer.model=sonnet`
2. **Settings**: `settings.agents["iloom-issue-implementer"].model`
3. **Swarm model defaults**: `SwarmSetupService` applies swarm-specific defaults (e.g., haiku for complexity evaluator)
4. **Frontmatter**: The `model` field in the YAML above

Do NOT hardcode model choices in agent templates to work around performance issues — use the settings system instead.

## Swarm Agent Rendering

In swarm mode, `SwarmSetupService.renderSwarmAgents()` copies these templates to the epic worktree as:
- `.claude/agents/iloom-swarm-<phase>.md` (agent definitions)
- `.claude/skills/iloom-swarm-<phase>/SKILL.md` (skill wrappers that invoke agents)

The swarm worker agent (`iloom-swarm-worker.md`) is rendered separately and invokes these skills in sequence.
