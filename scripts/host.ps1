# Host GroSplit for the house on this laptop, until it moves to a real host (SPEC.md §13).
# Real bot from .env.production, real ./grosplit.db, port 3100, HTTPS via a Cloudflare quick
# tunnel. Runs hidden in the background and survives closing VS Code (not a reboot or sleep).
#   powershell -ExecutionPolicy Bypass -File scripts/host.ps1          # start, or restart after code changes
#   powershell -ExecutionPolicy Bypass -File scripts/host.ps1 -Stop    # stop
# ponytail: quick tunnel = new URL every start, so this re-points the bot's menu button each time.
# A named tunnel or a real host removes that step.
param([switch]$Stop)

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root '.host.pids'

if (Test-Path $pidFile) {
  # Only ever kill our own node / cloudflared: a stale PID may have been reused by something else.
  Get-Content $pidFile | ForEach-Object {
    $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -in 'node', 'cloudflared') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item $pidFile
}
if ($Stop) { 'GroSplit host stopped.'; exit }

# Refuse an .env.production that holds anything unexpected. Reads KEY NAMES only, never values.
$envFile = Join-Path $root '.env.production'
if (-not (Test-Path $envFile)) { Write-Error '.env.production not found'; exit 1 }
$allowed = 'TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_VISION_API_KEY', 'TELEGRAM_OWNER_ID'
# A line that isn't a clean NAME=value is never echoed (it might be a bare secret).
$unexpected = @()
$n = 0
foreach ($line in Get-Content $envFile) {
  $n++
  if ($line -notmatch '^\s*[^#\s]') { continue }
  $key = ($line -split '=', 2)[0].Trim()
  if ($line -notmatch '=' -or $key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { $unexpected += "line $n is malformed"; continue }
  if ($key -notin $allowed) { $unexpected += $key }
}
if ($unexpected) {
  Write-Error ('.env.production problem: ' + ($unexpected -join ', ') + '. Allowed keys: ' + ($allowed -join ', '))
  exit 1
}

$env:DATABASE_PATH = './grosplit.db'
$env:PORT = '3100'          # 3000 stays free for `npm run dev` with the test bot
Remove-Item Env:DEV -ErrorAction SilentlyContinue
Remove-Item Env:FLY_APP_NAME -ErrorAction SilentlyContinue   # this is the laptop, not Fly

$tunnelLog = Join-Path $root '.host-tunnel.log'
Remove-Item $tunnelLog -ErrorAction SilentlyContinue

$server = Start-Process node -ArgumentList '--env-file=.env.production', 'server.js' `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $root '.host-server.log') -RedirectStandardError (Join-Path $root '.host-server-err.log')
$tunnel = Start-Process cloudflared -ArgumentList 'tunnel', '--url', 'http://localhost:3100' `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $root '.host-tunnel-out.log') -RedirectStandardError $tunnelLog
"$($server.Id)`n$($tunnel.Id)" | Set-Content $pidFile

# Don't claim success if the server never answered (bad env, port taken, crash on boot).
$up = $false
for ($i = 0; $i -lt 15 -and -not $up; $i++) {
  Start-Sleep 1
  try { $null = Invoke-WebRequest -Uri 'http://localhost:3100/' -UseBasicParsing -TimeoutSec 2; $up = $true } catch {}
}
if (-not $up -or $server.HasExited) {  # exited = something else may own :3100
  Write-Host 'Server is not answering on http://localhost:3100/. Last lines of .host-server-err.log:'
  Get-Content (Join-Path $root '.host-server-err.log') -Tail 15 -ErrorAction SilentlyContinue
  foreach ($proc in $server, $tunnel) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  exit 1
}

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep 1
  $m = Select-String -Path $tunnelLog -Pattern 'https://(?!api\.)[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Value }
}
if (-not $url) { Write-Error 'Tunnel did not come up. See .host-tunnel.log'; exit 1 }

# Point the bot's "Open GroSplit" menu button at today's address.
$js = "fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/setChatMenuButton',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({menu_button:{type:'web_app',text:'Open GroSplit',web_app:{url:process.argv[1]}}})}).then(r=>r.json()).then(j=>console.log(j.ok?'menu button ->':'menu button FAILED:',j.ok?process.argv[1]:j.description))"
Push-Location $root
node --env-file=.env.production -e $js $url
Pop-Location
"GroSplit is up: $url  (logs: .host-server.log, .host-tunnel.log)"
