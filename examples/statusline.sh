#!/usr/bin/env bash
# Lupin: example statusline for Claude Code (macOS / Linux, needs jq and curl)
# Shows: requested model | Lupin routing truth | folder@branch | context | effort | 5h/7d quotas
#
# Install (opt-in: Lupin NEVER writes settings.json):
#   1. copy this file, for example to ~/.claude/statusline.sh, and chmod +x it
#   2. add to ~/.claude/settings.json:
#        "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
#
# The "profile->model" segment appears ONLY in `lupin run` sessions
# (ANTHROPIC_BASE_URL on 127.0.0.1) and comes from GET /health: the truth lives
# in the harness, never in the model (which just repeats the system prompt).

set -u
ESC=$'\e'
GRAY="${ESC}[90m"; CYAN="${ESC}[36m"; MAG="${ESC}[35m"; BLUE="${ESC}[34m"
PINK="${ESC}[38;5;213m"; RED="${ESC}[31m"; YEL="${ESC}[33m"; RST="${ESC}[0m"
SEP=" ${GRAY}|${RST} "

json=$(cat)
parts=()

pct_color() { # $1 = integer percentage
  local p=$1
  if   (( p >= 90 )); then printf '%s%d%%%s' "$RED" "$p" "$RST"
  elif (( p >= 70 )); then printf '%s[38;5;208m%d%%%s' "$ESC" "$p" "$RST"
  elif (( p >= 50 )); then printf '%s%d%%%s' "$YEL" "$p" "$RST"
  else printf '%s[32m%d%%%s' "$ESC" "$p" "$RST"; fi
}

fmt_tok() { # $1 = tokens
  awk -v t="$1" 'BEGIN { if (t >= 1000000) printf "%.1fM", t/1000000; else if (t >= 1000) printf "%.0fk", t/1000; else printf "%d", t }'
}

# 1. Model requested by Claude Code (through Lupin this is the SLOT name)
model=$(jq -r '.model.display_name // empty' <<<"$json" | sed 's/^Claude //')
[ -n "$model" ] && parts+=("${CYAN}${model}${RST}")

# 2. Lupin routing truth (GET /health, 10s cache)
base="${ANTHROPIC_BASE_URL:-}"
if [[ "$base" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]; then
  cache="${TMPDIR:-/tmp}/lupin_statusline_cache.json"
  fresh=""
  if [ -f "$cache" ]; then
    now=$(date +%s); mtime=$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)
    [ $(( now - mtime )) -lt 10 ] && [ "$(jq -r '.base // empty' "$cache" 2>/dev/null)" = "$base" ] && fresh=1
  fi
  if [ -z "$fresh" ]; then
    if health=$(curl -sf --max-time 1 "$base/health" 2>/dev/null); then
      # opus first: Claude Code's default model (claude-fable-5) resolves to the
      # opus slot (SPEC-PROVIDERS 4 rule 1), so that is the model really serving
      # a default session. The fallbacks keep the segment honest when a slot is
      # absent because its delegation is broken.
      jq -c --arg base "$base" '{base: $base, ok: true, profile: .activeProfile, model: (.slots.opus // .slots.sonnet // .slots.haiku // "?"), free: (.tier.free // false)}' <<<"$health" >"$cache" 2>/dev/null
    else
      printf '{"base":"%s","ok":false}' "$base" >"$cache"
    fi
  fi
  if [ "$(jq -r '.ok' "$cache" 2>/dev/null)" = "true" ]; then
    seg="${PINK}⇄ $(jq -r '.profile' "$cache")→$(jq -r '.model' "$cache")${RST}"
    # A free tier is part of the routing truth: without it the line shows half of it.
    [ "$(jq -r '.free' "$cache" 2>/dev/null)" = "true" ] && seg+="${GRAY} (free)${RST}"
    parts+=("$seg")
  else
    parts+=("${RED}⇄ Lupin OFFLINE${RST}")
  fi
fi

# 3. folder@branch
cwd=$(jq -r '.workspace.current_dir // empty' <<<"$json")
if [ -n "$cwd" ]; then
  seg="${MAG}$(basename "$cwd")${RST}"
  branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ -n "$branch" ] && seg+="${GRAY}@${RST}${BLUE}${branch}${RST}"
  parts+=("$seg")
fi

# 4. Context (total_input_tokens = input + cache write + cache read)
used=$(jq -r '.context_window.total_input_tokens // empty' <<<"$json")
size=$(jq -r '.context_window.context_window_size // empty' <<<"$json")
if [ -n "$used" ] && [ -n "$size" ] && [ "$used" -gt 0 ]; then  # 0 = session just started: no noise
  pct=$(jq -r '.context_window.used_percentage // empty' <<<"$json")
  [ -z "$pct" ] && pct=$(( used * 100 / size ))
  parts+=("ctx: $(fmt_tok "$used")/$(fmt_tok "$size") ($(pct_color "${pct%.*}"))")
fi

# 5. Reasoning effort
effort=$(jq -r '.effort.level // empty' <<<"$json")
[ -n "$effort" ] && parts+=("effort: ${YEL}${effort}${RST}")

# 6. Claude subscription quotas (absent through Lupin)
for w in five_hour:5h seven_day:7d; do
  key="${w%%:*}"; label="${w##*:}"
  p=$(jq -r ".rate_limits.${key}.used_percentage // empty" <<<"$json")
  if [ -n "$p" ]; then
    rt=$(jq -r ".rate_limits.${key}.resets_at" <<<"$json")
    hhmm=$(date -d "@$rt" +%H:%M 2>/dev/null || date -r "$rt" +%H:%M)
    parts+=("${label}: $(pct_color "${p%.*}") reset $hhmm")
  fi
done

out=""
for p in "${parts[@]}"; do
  [ -n "$out" ] && out+="$SEP"
  out+="$p"
done
printf '%s' "$out"
