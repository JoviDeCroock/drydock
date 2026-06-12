#!/bin/bash
# Headless runner for the drydock-ops customer feedback loop.
#
# Runs the /drydock-ops skill via `claude -p` from any machine with claude,
# wrangler (logged in), and gh (authed) available. Suitable for cron/launchd:
#   52 8 * * * /path/to/repo/.claude/skills/drydock-ops/run.sh
# Output lands in ~/.drydock-ops (reports, history, logs) — see SKILL.md.
set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# launchd/cron jobs default to 256 open files, which kills the claude CLI on startup.
ulimit -n 4096

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OPS_HOME="$HOME/.drydock-ops"
mkdir -p "$OPS_HOME/reports" "$OPS_HOME/logs" "$OPS_HOME/backup"

cd "$REPO_ROOT"
{
  echo "=== ops-loop run $(date '+%F %T') ==="
  claude -p "Today is $(date +%F). Run the /drydock-ops skill end to end." \
    --allowedTools "Skill,Bash(npx wrangler d1 execute:*),Bash(gh issue list:*),Bash(gh issue view:*),Bash(gh issue create:*),Bash(gh pr list:*),Bash(gh pr view:*),Read,Write,Edit,Glob,Grep"
  echo "=== done $(date '+%F %T') ==="
} >> "$OPS_HOME/logs/run-$(date +%F).log" 2>&1
