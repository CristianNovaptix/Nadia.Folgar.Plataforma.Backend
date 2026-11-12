$ErrorActionPreference = 'Stop'

$port = 3000
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Test-IsBackendNodeProcess {
  param([Parameter(Mandatory = $true)] $Process)

  if ($Process.Name -ne 'node.exe') {
    return $false
  }

  return $Process.CommandLine -like "*$backendRoot*" -or
    $Process.CommandLine -like '*dist/main*' -or
    $Process.CommandLine -like '*dist\main*'
}

function Stop-BackendProcess {
  param([Parameter(Mandatory = $true)] [int] $ProcessId)

  Write-Host "Cerrando backend anterior (PID $ProcessId)..."
  taskkill /PID $ProcessId /T /F | Out-Null

  try {
    Wait-Process -Id $ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  } catch {
    # If the process is already gone, Wait-Process can race and throw.
  }
}

function Get-ListeningPortConnections {
  netstat -ano |
    Select-String "LISTENING" |
    Where-Object { $_.Line -match "[:.]$port\s" } |
    ForEach-Object {
      $parts = ($_.Line -split '\s+') | Where-Object { $_ }
      [pscustomobject]@{
        ProcessId = [int]$parts[-1]
        Line = $_.Line
      }
    }
}

# Solo procesos de este repo: "dist/main" a secas tambien coincide con backends de otros proyectos.
# El que quedo escuchando como "node dist/main.js" lo cierra el chequeo por puerto de mas abajo.
$backendProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*$backendRoot*" }

foreach ($process in $backendProcesses) {
  Stop-BackendProcess $process.ProcessId
}

$connections = Get-ListeningPortConnections

foreach ($connection in $connections) {
  $processId = $connection.ProcessId

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    continue
  }

  if (Test-IsBackendNodeProcess $process) {
    Stop-BackendProcess $processId
    continue
  }

  throw "El puerto $port esta ocupado por PID $processId ($($process.Name)): $($process.CommandLine)"
}

$deadline = (Get-Date).AddSeconds(15)
do {
  $remainingConnections = @(Get-ListeningPortConnections)
  if ($remainingConnections.Count -eq 0) {
    exit 0
  }

  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

$remainingDescriptions = $remainingConnections | ForEach-Object {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ProcessId)" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    "PID $($_.ProcessId)"
  } else {
    "PID $($_.ProcessId) ($($process.Name)): $($process.CommandLine)"
  }
}

throw "El puerto $port sigue ocupado despues de intentar cerrarlo: $($remainingDescriptions -join '; ')"
