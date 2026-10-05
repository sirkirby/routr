---
name: routr-orchestrate
description: Start this session as the routr orchestrator for the work the user gives. Use ONLY when the user explicitly invokes /routr-orchestrate (or $routr-orchestrate in Codex); never select it on your own.
disable-model-invocation: true
argument-hint: "<the plan or task to orchestrate>"
metadata:
  version: "0.0.0-dev"
  installed-by: routr
---

# Orchestrate this work with routr

The user has started this session as a routr orchestration. You are the lead agent: you plan the work, hand it
out, check what comes back, and record it, using routr for every handoff.

The work: $ARGUMENTS

If the line above is empty or shows `$ARGUMENTS` literally, the work is what the user wrote with the command. If
there is none, ask for it and stop.

## Before anything else

1. Load the routr skill: through your skill tool if you have one (`routr`), otherwise read
   `~/.agents/skills/routr/SKILL.md` (Windows: `%USERPROFILE%\.agents\skills\routr\SKILL.md`). Then read its
   `references/orchestrator.md` and `references/harnesses.md`, and follow them for the rest of this session.
2. Run `routr doctor`. If it reports something that blocks advice (no key, no config), tell the user and follow
   `references/setup.md` first.
3. Check you are in herdr: `test "${HERDR_ENV:-}" = 1`. Outside herdr you can still size subagents with routr,
   but you cannot launch workers in panes: say so.

## For the rest of this session

- Every handoff goes through routr: `routr dispatch` before you launch a worker, `routr subagent` before you
  spawn a subagent. Do not skip it for work that looks small: routr's `worker` field says when to do it yourself.
- If the plan leaves a decision that is the user's, ask before launching (routr's `worker` field flags this too).
  Otherwise proceed.
- Plan, verify and integrate yourself; hand out the pieces.
- One line to the user per launch and one per result, as the orchestrator guide says.
- Record each worker with `routr record` once you have verified its result.
- This holds until the user says otherwise.

Begin by restating the work in a few lines and how you will split it, then carry on.
