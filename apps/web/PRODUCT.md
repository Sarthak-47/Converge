# Product

<!-- impeccable:product-schema 1 -->

<!-- Written from the repository (README, docs/Converge_System_Design.docx, docs/WORKLOG.md) on 2026-11-20.
     The owner delegated the open choices ("whatever you think is best"); facts below are inferred from the
     built product unless marked otherwise. -->

## Platform

web (the same app also runs inside the Electron desktop shell, `apps/desktop`)

## Users

Small software teams (inferred) who edit, test and ship code together with their own coding agents. Each
member brings an Anthropic key; agents type into the same files as people. Owners invite editors and viewers.

## Product Purpose

Converge is a real-time, multi-user development environment: a browser IDE and a desktop app with live local
sync, collaborative editing, version history, agents that work in the same files as people, sandboxed test
runs behind named approvals, and pull requests opened from sessions. Success is a team and its agents
converging on one working change without overwriting each other.

## Positioning

People and agents are equal, visible participants in one live document: every edit, cursor, lane and turn is
attributed, revertible on its own, and stored durably. Not a chat bolted onto an editor.

## Operating Context

Long working sessions in a browser tab or the desktop app beside a local Git checkout. Workflows: workspaces,
file tree and editor, chat, sessions (plans, lanes, takeover and handoff), approvals for sandboxed commands,
workspace memory (notes pinned to code), history and restore, Git import, push and pull requests.

## Capabilities and Constraints

- Roles: owner, editor, viewer; viewers read but cannot edit.
- Agents run on the prompting member's own key; a per-turn and a daily spending cap apply.
- Everything must work in light and dark (system preference).
- End-to-end tests address the UI by class names, roles and accessible names; those are part of the contract.

## Evidence on Hand

No customers, testimonials, or metrics exist for marketing use; none may be invented. Measured latency and
recovery figures live in `docs/BASELINE.md` and are engineering evidence, not claims.

## Product Principles

1. Attribution over anonymity: who (person or agent) did what is always visible.
2. Nothing is lost: edits survive outages, restores and races; the UI says what state things are in.
3. Humans approve consequential actions by name.
4. Calm under load: the tool disappears into the task.

## Accessibility & Inclusion

WCAG 2.1 AA contrast in both themes; full keyboard use; no information carried by colour alone (inferred
standard; no product-specific requirement recorded).
