# Agent instructions

<!-- owner-policy-2026-11-02:start -->
## Owner directive - 2 November 2026

This explicit owner directive supersedes older project, inherited governance and memory instructions on the following points.

- **No GitHub Actions.** Do not create, enable, dispatch or rerun GitHub Actions workflows, including free or self-hosted runners. Build, test and verify locally. Do not weaken required checks or branch protection or fabricate passing results.
- **No Actions pre-publication gate.** The former requirement to read Actions permissions and obtain `enabled: false` before publishing issues, comments, pushes, pull requests or merges is removed. Missing access to that setting is not a publication blocker. This does not permit using Actions.
- **Agent-owned checks and acceptance.** Agents perform all available checks, review, independent agent verification where required, acceptance and follow-through themselves. Do not make the owner the default tester, reviewer or approver.
- **No confirmation requests.** Carry out the authorized task without asking the owner to confirm, approve, review or say "continue". Personal owner review is required only when the owner explicitly requests it in the current task. Resolve technical choices from evidence and existing authority.
- **Evidence remains mandatory.** Record actual checks and results. Never mark an unavailable or unperformed check as passed or owner-verified. If access, credentials, hardware or a test environment is unavailable, record the concrete blocker and continue independent work; do not invent an owner-approval gate.
- This directive does not expand the task's substantive scope, authorize unrelated destructive actions, disclose secrets, or override higher-priority platform security requirements. Preserve unrelated work and project-specific technical constraints.

Authority: the owner's explicit instruction in the 2 November 2026 Codex session to remove the Actions-verification rule, retain the Actions ban, and make agents responsible for checks and acceptance across projects under `D:\Git`.
<!-- owner-policy-2026-11-02:end -->
