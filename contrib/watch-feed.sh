#!/usr/bin/env bash
# Tail the Telegram feed, coalescing bursts into single events.
#
# Two behaviours matter here:
#
# 1. COALESCING. Raw `tail -F` emits one line per message, so a rapid burst
#    becomes N separate wakeups — and each one cancels the turn the previous
#    started. Buffer until the sender pauses (QUIET seconds), then emit the
#    whole burst at once; Monitor groups stdout within 200ms into one event.
#
# 2. NO SELF-ECHO. The feed also carries assistant-authored entries (media_note),
#    which would otherwise notify us about our own writes — a feedback loop.
#    Only inbound sender traffic (`"untrusted":true`) is emitted.
FEED="${1:-$HOME/.telegram-bridge/incoming.jsonl}"
QUIET="${2:-3}"
touch "$FEED"
tail -n0 -F "$FEED" 2>/dev/null \
  | grep --line-buffered '"untrusted":true' \
  | while IFS= read -r line; do
      buf="$line"
      while IFS= read -r -t "$QUIET" more; do
        [ -n "$more" ] && buf="$buf"$'\n'"$more"
      done
      printf '%s\n' "$buf"
    done
