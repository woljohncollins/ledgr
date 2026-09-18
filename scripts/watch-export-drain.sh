#!/bin/bash
# Poll the OneDrive export drain: /health + the latest export-drain workflow run.
# Usage: ./scripts/watch-export-drain.sh [interval_seconds]
# ponytail: plain poll loop, no daemon/service; kill with Ctrl+C when the drain finishes.
set -euo pipefail
INTERVAL="${1:-60}"

while true; do
  ts=$(date "+%Y-%m-%d %H:%M:%S")
  # take the most recent run that wasn't cancelled (a stray duplicate dispatch
  # can otherwise sort to the top and mask the real one still running)
  run=$(gh run list --workflow=export-drain.yml --limit 5 --json status,conclusion,databaseId,createdAt 2>/dev/null \
    | jq '[.[] | select(.conclusion != "cancelled")] | [.[0]]')
  health=$(curl -s --max-time 10 https://ledgr-teal.vercel.app/health)

  status=$(echo "$run" | jq -r '.[0].status')
  conclusion=$(echo "$run" | jq -r '.[0].conclusion')
  runId=$(echo "$run" | jq -r '.[0].databaseId')
  lastExportAt=$(echo "$health" | jq -r '.checks.lastExportAt')
  lastExportRunAt=$(echo "$health" | jq -r '.checks.lastExportRunAt')
  remaining=$(echo "$health" | jq -r '.checks.lastExportRemaining // "?"')
  errCount=$(echo "$health" | jq -r '.checks.errors.last24h')
  lastErr=$(echo "$health" | jq -r '.checks.errors.recent[0].message // "none"')

  echo "[$ts] run #$runId: $status/$conclusion | remaining=$remaining | lastExportRunAt=$lastExportRunAt lastExportAt=$lastExportAt | errors24h=$errCount | latest: $lastErr"

  if [ "$status" = "completed" ]; then
    echo "[$ts] drain workflow finished ($conclusion) — stopping watch."
    break
  fi

  sleep "$INTERVAL"
done
