# Agent setup guide: changelog

Agents compare the `memory-setup <version>` line of the instructions they installed with the version at the top
of [the guide](../agent-setup.md), and propose updates when this file lists a newer one. Bump the version only for
changes an installed agent should act on.

## 0.1.0 — 2026-10-17

First version, adapted from Notion's agent setup guide (v0.0.4): discovery, one approved import of the host's
native memory, persistent instructions with a version marker, optional daily routine and standing rules, with
`AGENTS.md` as the operating guide. Adds enforcement levels (blocked by the host, native memory off, instructions
only) and, for Claude Code, a permission rule and a `PreToolUse` hook that refuse writes to its own memory.
