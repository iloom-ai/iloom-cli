# templates/

> **Maintenance:** Keep this file in sync with the directory contents. If you add, remove, or change the responsibility of a template, update the relevant section below.

This directory contains the template system that generates prompts and agent definitions for Claude Code sessions. Templates are rendered by `PromptTemplateManager` using Handlebars and copied to `dist/templates/` at build time.

## Prompt Ownership Table

Each prompt template belongs to exactly one execution context. Editing the wrong template is a common mistake — check this table first:

| Template | Execution Context | Used By | Purpose |
|----------|------------------|---------|---------|
| `prompts/issue-prompt.txt` | Regular + Swarm child | `il spin` (single issue) | Main workflow: phase agents execute analysis → planning → implementation → review |
| `prompts/swarm-orchestrator-prompt.txt` | Swarm orchestrator only | `il spin` (epic) | 5-phase orchestration: parse children, spawn workers, monitor, merge, finalize |
| `prompts/plan-prompt.txt` | Plan mode only | `il plan` | Architect agent: decompose work into issues, no implementation |
| `prompts/pr-prompt.txt` | Regular (PR workflow) | `il spin` (PR) | PR-specific instructions for reviewing and implementing PR feedback |
| `prompts/regular-prompt.txt` | Regular (branch workflow) | `il spin` (branch) | Ad-hoc branch work without an issue |
| `prompts/init-prompt.txt` | Setup | `il init` | First-run project configuration |
| `prompts/session-summary-prompt.txt` | Regular (finish) | `il finish` | Generate session recap on loom completion |
| `prompts/epic-report-prompt.txt` | Swarm (post-completion) | Orchestrator | Epic completion report after all children finish |

## Handlebars Conventions

- **Variables**: `{{VARIABLE_NAME}}` — uppercase with underscores, defined in `TemplateVariables` interface
- **Conditionals**: `{{#if FLAG_NAME}}...{{/if}}` and `{{#unless FLAG_NAME}}...{{/unless}}`
- **Raw blocks**: `{{{{raw}}}}{{VARIABLE}}{{{{/raw}}}}` — for JSON content that contains literal braces
- **Variable source**: `PromptTemplateManager.renderTemplate()` accepts a `TemplateVariables` object with 100+ fields. Check the interface definition before adding new variables.

## Swarm Mode in issue-prompt.txt

`issue-prompt.txt` serves double duty — it's used for both regular single-issue work and swarm child workers. The `SWARM_MODE` flag controls the differences:

- **`SWARM_MODE=false` (regular)**: Full interactive workflow, optional user checkpoints, recap writes to loom's recap file
- **`SWARM_MODE=true` (swarm child)**: Fully autonomous, no user interaction, MUST pass `worktreePath` on all recap calls, single comment output at end, reports success/failure back to orchestrator

## Agent Workflow Todo Lists

The todo list in `prompts/issue-prompt.txt` is critical for ensuring agents follow the implementation plan correctly.

**Why the Todo List Matters:**
- Agents use the todo list as both a progress tracker and an execution checklist
- Each numbered item represents a workflow step that must be completed
- Agents check off items as they complete each step, providing visibility into progress
- The todo list serves as the source of truth for what steps need to be executed

**When Adding New Workflow Steps:**
- New workflow steps MUST be added to the todo list to ensure they are executed
- Position the item appropriately based on when it should run in the workflow
- Use Handlebars conditionals (e.g., `{{#if FLAG_NAME}}`) when steps are conditional
- Ensure numbering remains sequential within each conditional branch

**Example — Adding a Conditional Step:**
```handlebars
{{#if SOME_MODE}}
{{#if SOME_FLAG}}
17. Execute conditional step (STEP X.X)
18. Next step...
{{else}}
17. Next step...
{{/if}}
{{else}}
17. Next step...
{{/if}}
```

Without the todo list entry, agents may skip steps even if they are fully documented elsewhere in the prompt.
