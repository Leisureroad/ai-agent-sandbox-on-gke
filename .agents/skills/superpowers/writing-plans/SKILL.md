# Writing Plans

## Overview
Write comprehensive implementation plans assuming the engineer has zero context for our codebase. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** This should be run in a dedicated worktree or sandbox.

## Scope Check
If the spec covers multiple independent subsystems, break into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure
Before defining tasks, map out which files will be created or modified. 
- Design units with clear boundaries and well-defined interfaces.
- Prefer smaller, focused files over large ones that do too much.

## Bite-Sized Task Granularity
**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header
Every plan MUST start with this header:

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]
**Architecture:** [2-3 sentences about approach]
---\n```

## Task Structure
Task N: [Component Name]
Files: exact paths
Steps: [ ] Step 1: Write failing test -> Step 2: Verify RED -> Step 3: Minimal implementation -> Step 4: Verify GREEN -> Step 5: Commit

## No Placeholders
Every step must contain the actual content. No "TBD", "TODO", or "add appropriate validation". Fix issues inline.
