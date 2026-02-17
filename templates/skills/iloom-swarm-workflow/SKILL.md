# iloom Swarm Workflow

Executes the full iloom autonomous workflow for a single issue in swarm mode. This skill is invoked by a child agent spawned by the swarm orchestrator.

## Usage

```
/iloom-swarm-workflow <issue-number> <worktree-path>
```

## Arguments

- `<issue-number>`: The issue number to work on (e.g., `42`, `#42`)
- `<worktree-path>`: Absolute path to the pre-created worktree for this issue

## Prerequisites

- The worktree must already exist at `<worktree-path>` with dependencies installed
- `iloom-metadata.json` must be present in the worktree (created by the orchestrator)
- The recap MCP server must be running (provides `set_loom_state`, `set_complexity`, etc.)
- The issue management MCP server must be running

## Workflow

**IMPORTANT: This is a fully autonomous workflow. Do NOT pause for user input, call AskUserQuestion, or wait for human checkpoints at any point.**

### Step 0: Initialize

1. `cd` to the specified `<worktree-path>`
2. Read `iloom-metadata.json` from the worktree root to get full context:
   ```bash
   cat <worktree-path>/iloom-metadata.json
   ```
   Extract: issue numbers, parent loom info, worktree path, branch name, project path
3. Call `recap.set_loom_state` with state `in_progress`
4. Read the issue using `mcp__issue_management__get_issue` with `{ number: "<issue-number>", includeComments: true }`

### Step 1: Upfront Scan (Enhancement Check)

Perform a quick assessment of the issue body:
- If the issue body is already thorough (>250 words, well-structured, clear requirements): **skip enhancement**
- If the issue body is minimal or lacks structure: **run enhancement**

If enhancement is needed:
- Invoke `@agent-iloom-issue-enhancer` with the issue number
- Pass the issue context (do NOT rely on baked-in template variables)
- Wait for the enhancer to complete
- Re-read the issue to get the enhanced description

### Step 2: Complexity Evaluation

Invoke `@agent-iloom-issue-complexity-evaluator` with the issue number.

The evaluator will:
- Assess the issue and classify it as TRIVIAL, SIMPLE, or COMPLEX
- Call `recap.set_complexity` with the result
- Return the classification

Store the classification result for routing in the next step.

### Step 3: Analysis and Planning

Route based on complexity classification:

**If TRIVIAL or SIMPLE:**
- Invoke `@agent-iloom-issue-analyze-and-plan` with the issue number
- This agent performs combined lightweight analysis and planning in one step
- Wait for completion and capture the plan output

**If COMPLEX:**
- Invoke `@agent-iloom-issue-analyzer` with the issue number
- Wait for analysis to complete
- Then invoke `@agent-iloom-issue-planner` with the issue number
- Wait for planning to complete and capture the plan output

### Step 4: Implementation

Invoke `@agent-iloom-issue-implementer` with:
- The issue number
- The plan (from Step 3)
- The working directory (`<worktree-path>`)

The implementer will:
- Read the issue and plan
- Implement the changes
- Run validation (tests, typecheck, lint)
- Return implementation summary

### Step 5: Code Review

1. Call `recap.set_loom_state` with state `code_review`
2. Invoke `@agent-iloom-code-reviewer`
   - The reviewer will analyze uncommitted changes in the worktree
   - Returns review results with findings categorized by severity

### Step 6: Handle Review Results

If the code review found **critical** or **high** severity issues:
1. Invoke `@agent-iloom-issue-implementer` again with:
   - The list of issues to fix (critical and high only -- skip low and medium)
   - The working directory
   - Context: "Fix the following code review findings"
2. Wait for fixes to complete
3. Optionally re-run code review to verify fixes

If no critical/high issues: proceed to Step 7.

### Step 7: Finalize

**On success:**
1. Stage and commit all changes:
   ```bash
   cd <worktree-path>
   git add -A
   git commit -m "fixes #<issue-number>"
   ```
2. Call `recap.set_loom_state` with state `done`
3. Report completion to the orchestrator with:
   - Issue number
   - Status: `success`
   - Brief summary of what was implemented
   - Number of files changed

**On failure (at any step):**
1. Call `recap.set_loom_state` with state `failed`
2. Report failure to the orchestrator with:
   - Issue number
   - Status: `failed`
   - Which step failed
   - Error details / reason for failure
3. Do NOT commit partial work

## Error Handling

At each step, if an agent fails or returns an error:
1. Assess if the error is recoverable (e.g., a test failure that can be fixed)
2. If recoverable: attempt to fix and retry the step (max 1 retry per step)
3. If not recoverable: proceed to failure finalization (Step 7 failure path)

**Never silently swallow errors.** Every failure must be reported back to the orchestrator with enough detail to understand what went wrong.

## State Transitions

The workflow calls `recap.set_loom_state` at these points:

| Point | State | Trigger |
|-------|-------|---------|
| Step 0 (Initialize) | `in_progress` | Workflow begins |
| Step 5 (Code Review) | `code_review` | Before running review |
| Step 7 (Success) | `done` | All steps complete, committed |
| Step 7 (Failure) | `failed` | Any unrecoverable error |

## Output Format

When the workflow completes, return a structured result to the caller:

```
## Swarm Workflow Result

**Issue:** #<issue-number>
**Status:** success | failed
**Summary:** <1-2 sentence description of what was done or what failed>
**Files Changed:** <count>
**Complexity:** <TRIVIAL | SIMPLE | COMPLEX>
**Steps Completed:** <list of completed steps>
```
