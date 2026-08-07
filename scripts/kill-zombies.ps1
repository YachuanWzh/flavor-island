$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*flavor-island*' }
if (-not $procs) {
  Write-Output 'no flavor-island electron processes found'
} else {
  foreach ($p in $procs) {
    Write-Output ("killing PID " + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
