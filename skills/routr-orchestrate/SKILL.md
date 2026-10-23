---
name: routr-orchestrate
description: Start this session as the routr orchestrator for the work the user gives. Use ONLY when the user explicitly invokes /routr-orchestrate (or $routr-orchestrate in Codex); never select it on your own.
disable-model-invocation: true
argument-hint: "<the plan or task to orchestrate>"
metadata:
  version: "0.0.0-dev"
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
3. Check whether you are in herdr: `test "${HERDR_ENV:-}" = 1`. Outside herdr, workers run headless (Claude Code,
   Codex, Antigravity and Kiro only): follow the orchestrator guide's "Outside herdr: headless workers" section where it differs from below.

## For the rest of this session

- Every handoff is a routr worker: `routr dispatch` on its brief, then `routr launch --advice <that worker’s saved advice>`.
  Research, exploration and reviews are handoffs too, read-only ones included. Do not skip routr for work that looks small: its `worker` field
  says when to do it yourself.
- Never hand work to your harness's own subagents (Claude Code's Agent tool, Codex's or Cursor's subagents): they all
  run on your subscription, out of the user's sight, with no ledger row. In herdr, never run `routr subagent`: it is for
  workers sizing theirs; outside herdr, hand work out with `routr launch` all the same.
- If the plan leaves a decision that is the user's, ask before launching (routr's `worker` field flags this too).
  Otherwise proceed.
- Every worker starts with `routr launch --worktree <branch>` (`--base <ref>` to start it from another branch or
  commit) and ends with `routr cleanup`, the command in its launch result’s `next`, in herdr or not. Do not make, close
  or remove a worker's worktree or pane with herdr or git yourself: closing its pane leaves its worktree behind.
- Planning is work too: hand out its research and reviews, even when you will wait for the result, and do one
  yourself only when routr's `worker` field says `do it yourself`. Keep for yourself what cannot be handed out:
  turning findings into the plan, the decisions that are the user's, checking each result, and integrating it.
- One line to the user per launch and one per result, as the orchestrator guide says.
- Follow every result’s `next`. After verification, fill launch’s record template and add `--note` and `--report`.
  Never borrow another worker’s advice. Revisions keep the original advice file; if the original task file is gone,
  revise without `--task-file` and say so in `--note`.
- Before you finish, `routr cleanup --cwd <repo>` lists the worktrees still there; remove the ones your session left.
- This holds until the user says otherwise.

Begin by restating the work in a few lines and how you will split it, then carry on.
