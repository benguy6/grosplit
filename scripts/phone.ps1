# Screenshot the mirrored phone (uxplay "AirPlay Video Stream" window) -> .shots/phone.png
# Works even when other windows cover it. Windows only.
#   powershell -ExecutionPolicy Bypass -File scripts/phone.ps1 [outFile]
param([string]$Out = (Join-Path $PSScriptRoot '..\.shots\phone.png'))

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PhoneShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int L, T, R, B; }
}
'@

[PhoneShot]::SetProcessDPIAware() | Out-Null
$win = Get-Process | Where-Object MainWindowTitle -eq 'AirPlay Video Stream' | Select-Object -First 1
if (-not $win) { Write-Error 'Phone mirror not running (no "AirPlay Video Stream" window).'; exit 1 }

$r = New-Object PhoneShot+RECT
[PhoneShot]::GetWindowRect($win.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT: needed for GPU-rendered video windows.
[PhoneShot]::PrintWindow($win.MainWindowHandle, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)

New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save($Out)
$Out
