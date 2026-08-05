# Lupin: example statusline for Claude Code (Windows / PowerShell 5.1+)
# Shows: requested model | Lupin routing truth | folder@branch | context | effort | 5h/7d quotas
#
# Install (opt-in: Lupin NEVER writes settings.json):
#   1. copy this file wherever you like, for example ~\.claude\statusline.ps1
#   2. add to ~\.claude\settings.json:
#        "statusLine": { "type": "command",
#          "command": "powershell -ExecutionPolicy Bypass -File \"C:\\Users\\<you>\\.claude\\statusline.ps1\"" }
#
# The "profile -> model" segment appears ONLY in `lupin run` sessions
# (detected from ANTHROPIC_BASE_URL on 127.0.0.1) and comes from GET /health:
# the truth lives in the harness, never in the model (which repeats the system prompt).

$Esc = [char]27

# PS 5.1 spawned by Claude Code defaults to the OEM codepage: without this the
# unicode glyphs (⇄ →) come out as "?" on screen.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Colorize-Pct {
    param([double]$Pct)
    if ($Pct -ge 90) { return "${Esc}[31m$('{0:0}' -f $Pct)%${Esc}[0m" }
    if ($Pct -ge 70) { return "${Esc}[38;5;208m$('{0:0}' -f $Pct)%${Esc}[0m" }
    if ($Pct -ge 50) { return "${Esc}[33m$('{0:0}' -f $Pct)%${Esc}[0m" }
    return "${Esc}[32m$('{0:0}' -f $Pct)%${Esc}[0m"
}

function Format-Tokens {
    param([long]$Tok)
    if ($Tok -ge 1000000) { return "$([math]::Round($Tok / 1000000.0, 1))M" }
    if ($Tok -ge 1000)    { return "$([math]::Round($Tok / 1000.0, 0))k" }
    return "$Tok"
}

$d = $null
try {
    $raw = [Console]::In.ReadToEnd()
    if (-not [string]::IsNullOrWhiteSpace($raw)) { $d = $raw | ConvertFrom-Json }
} catch {}

$parts = [System.Collections.Generic.List[string]]::new()

# 1. Model requested by Claude Code (through Lupin this is the SLOT name)
try {
    if ($d -and $d.model -and $d.model.display_name) {
        $name = $d.model.display_name -replace '^Claude\s+', ''
        $parts.Add("${Esc}[36m$name${Esc}[0m")
    }
} catch {}

# 2. Lupin routing truth (GET /health, 10s cache)
try {
    $base = $env:ANTHROPIC_BASE_URL
    if ($base -match '^http://127\.0\.0\.1:\d+$') {
        $cacheFile = Join-Path $env:TEMP "lupin_statusline_cache.json"
        $lupin = $null
        if (Test-Path $cacheFile) {
            try {
                $c = Get-Content $cacheFile -Raw | ConvertFrom-Json
                $age = (Get-Date).ToUniversalTime() - [DateTime]::Parse($c.checked_at).ToUniversalTime()
                if ($age.TotalSeconds -lt 10 -and $c.base -eq $base) { $lupin = $c }
            } catch {}
        }
        if ($null -eq $lupin) {
            $lupin = @{ base = $base; checked_at = (Get-Date).ToUniversalTime().ToString("o"); ok = $false; profile = ""; model = ""; free = $false }
            try {
                $h = Invoke-RestMethod "$base/health" -TimeoutSec 1
                # opus first: Claude Code's default model (claude-fable-5) resolves
                # to the opus slot (SPEC-PROVIDERS 4 rule 1), so that is the model
                # really serving a default session. The fallbacks keep the segment
                # honest when a slot is absent because its delegation is broken.
                $slot = @($h.slots.opus, $h.slots.sonnet, $h.slots.haiku) | Where-Object { $_ } | Select-Object -First 1
                $lupin.ok = $true; $lupin.profile = "$($h.activeProfile)"; $lupin.model = "$(if ($slot) { $slot } else { '?' })"
                if ($h.tier -and $h.tier.free) { $lupin.free = $true }
            } catch {}
            try { $lupin | ConvertTo-Json -Compress | Set-Content -Path $cacheFile -Encoding UTF8 } catch {}
        }
        # A free tier is part of the routing truth: without it the line shows half of it.
        if ($lupin.ok) {
            $seg = "${Esc}[38;5;213m⇄ $($lupin.profile) → $($lupin.model)${Esc}[0m"
            if ($lupin.free) { $seg += "${Esc}[90m (free)${Esc}[0m" }
            $parts.Add($seg)
        }
        else           { $parts.Add("${Esc}[31m⇄ Lupin OFFLINE${Esc}[0m") }
    }
} catch {}

# 3. folder@branch
try {
    $cwd = if ($d -and $d.workspace -and $d.workspace.current_dir) { $d.workspace.current_dir } else { "" }
    if ($cwd) {
        $folder = Split-Path $cwd -Leaf
        $branch = git -C $cwd --no-optional-locks rev-parse --abbrev-ref HEAD 2>$null
        $s = "${Esc}[35m$folder${Esc}[0m"
        if ($branch) { $s += "${Esc}[90m@${Esc}[0m${Esc}[34m$branch${Esc}[0m" }
        $parts.Add($s)
    }
} catch {}

# 4. Context: total_input_tokens = input + cache write + cache read
try {
    if ($d -and $d.context_window -and $d.context_window.context_window_size -and $d.context_window.total_input_tokens -gt 0) {
        # before the first API call the tokens are 0: "ctx: 0/1M (0%)" is noise, hide it
        $cw = $d.context_window
        $pct = if ($null -ne $cw.used_percentage) { [double]$cw.used_percentage } else { 100.0 * $cw.total_input_tokens / $cw.context_window_size }
        $parts.Add("ctx: $(Format-Tokens $cw.total_input_tokens)/$(Format-Tokens $cw.context_window_size) ($(Colorize-Pct $pct))")
    }
} catch {}

# 5. Reasoning effort
try {
    if ($d -and $d.effort -and $d.effort.level) { $parts.Add("effort: ${Esc}[33m$($d.effort.level)${Esc}[0m") }
} catch {}

# 6. Claude subscription quotas (absent in sessions through Lupin)
try {
    if ($d -and $d.rate_limits) {
        foreach ($w in @(@('five_hour','5h'), @('seven_day','7d'))) {
            $rl = $d.rate_limits.($w[0])
            if ($rl) {
                $rt = [DateTimeOffset]::FromUnixTimeSeconds($rl.resets_at).LocalDateTime.ToString("HH:mm")
                $parts.Add("$($w[1]): $(Colorize-Pct ([double]$rl.used_percentage)) reset $rt")
            }
        }
    }
} catch {}

[Console]::Write($parts -join " ${Esc}[90m|${Esc}[0m ")
