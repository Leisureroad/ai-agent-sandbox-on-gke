# Subagent-Driven Development

Execute plan by dispatching fresh subagent per task, with two-stage review after each: spec compliance review first, then code quality review.

## The Process
1. **Read plan**, extract tasks, create TodoWrite.
2. For each task:
    - **Dispatch implementer subagent**.
    - If it asks questions, answer and re-dispatch.
    - Implementer implements, tests, commits, self-reviews.
3. **Dispatch spec reviewer subagent**.
    - Confirms code matches plan spec.
    - If issues, implementer fixes and re-reviews.
4. **Dispatch code quality reviewer subagent**.
    - Reviewer approves? If not, implementer fixes.
5. Mark task complete.
6. When all tasks done, dispatch final code reviewer for the entire implementation.

## Advantages
- Fresh context per task (no confusion)
- Subagent can ask questions before AND during work
- Review checkpoints automatic
- Spec compliance prevents over/under-building
- Code quality ensures implementation is well-built
