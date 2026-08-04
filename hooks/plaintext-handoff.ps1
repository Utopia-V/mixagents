param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("stage", "hook")]
    [string]$Mode,

    [ValidateRange(1, 3600)]
    [int]$TtlSeconds = 300,

    [string]$StateDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$agentType = "v4_flash_worker"
$stateRoot = if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
    Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Codex\plaintext-subagent-handoff"
} else {
    [System.IO.Path]::GetFullPath($StateDirectory)
}
$pendingPath = Join-Path $stateRoot "$agentType.pending.json"

function Write-Json([object]$Value) {
    [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 8))
}

if ($Mode -eq "stage") {
    $assignment = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($assignment)) {
        [Console]::Error.WriteLine("Refusing to stage an empty Flash assignment.")
        exit 2
    }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    if (Test-Path -LiteralPath $pendingPath) {
        $existing = Get-Content -Raw -LiteralPath $pendingPath | ConvertFrom-Json
        if ($existing.schema -ne 1 -or $existing.agent_type -ne $agentType -or [string]::IsNullOrWhiteSpace([string]$existing.expires_at)) {
            [Console]::Error.WriteLine("The existing Flash handoff has an invalid schema, agent type, or expiry. Refusing to replace it.")
            exit 9
        }
        if ([DateTimeOffset]::Parse([string]$existing.expires_at) -gt [DateTimeOffset]::UtcNow) {
            [Console]::Error.WriteLine("A v4_flash_worker handoff is already pending. Let it be consumed or expire before staging another.")
            exit 3
        }
        Remove-Item -LiteralPath $pendingPath -Force
    }

    $now = [DateTimeOffset]::UtcNow
    $handoff = [ordered]@{
        schema = 1
        handoff_id = [Guid]::NewGuid().ToString()
        agent_type = $agentType
        created_at = $now.ToString("O")
        expires_at = $now.AddSeconds($TtlSeconds).ToString("O")
        assignment = $assignment
    }
    $temporaryPath = Join-Path $stateRoot (".{0}.tmp" -f [Guid]::NewGuid().ToString("N"))

    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            ($handoff | ConvertTo-Json -Compress -Depth 8),
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $pendingPath -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }

    Write-Json ([ordered]@{
        staged = $true
        handoff_id = $handoff.handoff_id
        agent_type = $agentType
        expires_at = $handoff.expires_at
        pending_path = $pendingPath
    })
    exit 0
}

$rawHookInput = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($rawHookInput)) {
    [Console]::Error.WriteLine("SubagentStart hook input was empty.")
    exit 4
}

$hookInput = $rawHookInput | ConvertFrom-Json
if ($hookInput.hook_event_name -ne "SubagentStart" -or $hookInput.agent_type -ne $agentType) {
    exit 0
}
if (-not (Test-Path -LiteralPath $pendingPath)) {
    exit 0
}

$agentID = if ([string]::IsNullOrWhiteSpace([string]$hookInput.agent_id)) {
    [Guid]::NewGuid().ToString("N")
} else {
    ([string]$hookInput.agent_id -replace "[^A-Za-z0-9_-]", "_")
}
$claimedPath = Join-Path $stateRoot "$agentType.claimed.$agentID.json"
Move-Item -LiteralPath $pendingPath -Destination $claimedPath -ErrorAction Stop

try {
    $handoff = Get-Content -Raw -LiteralPath $claimedPath | ConvertFrom-Json
    if ($handoff.schema -ne 1 -or $handoff.agent_type -ne $agentType) {
        [Console]::Error.WriteLine("The pending Flash handoff has an invalid schema or agent type.")
        exit 5
    }
    if ([DateTimeOffset]::Parse([string]$handoff.expires_at) -le [DateTimeOffset]::UtcNow) {
        [Console]::Error.WriteLine("The pending Flash handoff expired before the child started.")
        exit 6
    }
    if ([string]::IsNullOrWhiteSpace([string]$handoff.assignment)) {
        [Console]::Error.WriteLine("The pending Flash handoff contains no assignment.")
        exit 7
    }

    $additionalContext = @"
You are the spawned v4_flash_worker child, not the root agent. The parent supplied the complete task below through a one-time plaintext handoff because provider-internal collaboration ciphertext is not a reliable cross-provider task carrier. Treat this as the task contract. Do not continue the parent's unrelated work and do not report the assignment missing merely because the encrypted collaboration payload is unreadable.

BEGIN PARENT ASSIGNMENT
$($handoff.assignment)
END PARENT ASSIGNMENT
"@

    Remove-Item -LiteralPath $claimedPath -Force
    Write-Json ([ordered]@{
        hookSpecificOutput = [ordered]@{
            hookEventName = "SubagentStart"
            additionalContext = $additionalContext
        }
    })
} finally {
    if (Test-Path -LiteralPath $claimedPath) {
        Remove-Item -LiteralPath $claimedPath -Force
    }
}
