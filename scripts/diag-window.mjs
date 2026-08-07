// Diagnostic: enumerate top-level windows of ALL electron processes and dump
// title / visibility / rect so we can see what Flavor Island actually created.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class W2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$pids = @(Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($pids.Count -eq 0) { Write-Output "NO electron process"; exit }
Write-Output ("electron pids: " + ($pids -join ","))
$rows = New-Object System.Collections.ArrayList
$cb = [W2+EnumWindowsProc]{ param($h, $l)
  $pid2 = 0
  [W2]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pids -contains $pid2) {
    $sb = New-Object System.Text.StringBuilder 256
    [W2]::GetWindowText($h, $sb, 256) | Out-Null
    $cls = New-Object System.Text.StringBuilder 128
    [W2]::GetClassName($h, $cls, 128) | Out-Null
    $r = New-Object W2+RECT
    [W2]::GetWindowRect($h, [ref]$r) | Out-Null
    [void]$rows.Add(("pid=" + $pid2 + " hwnd=" + $h + " class='" + $cls.ToString() + "' title='" + $sb.ToString() + "' visible=" + [W2]::IsWindowVisible($h) + " rect=" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom))
  }
  return $true
}
[W2]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$rows
`;
writeFileSync('scripts/_diag.ps1', ps);
try {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\\_diag.ps1'], { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.log('diag failed:', e.stderr?.toString?.() || e.message);
}
