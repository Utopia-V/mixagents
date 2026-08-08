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
$lockPath = Join-Path $stateRoot ".$agentType.lock"
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$strictUtf8WithoutBom = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $utf8WithoutBom
[Console]::OutputEncoding = $utf8WithoutBom

function Stop-Handoff([string]$Message, [int]$Code) {
    [Console]::Error.WriteLine($Message)
    exit $Code
}

function Stop-TransportFailure([string]$Action, [System.Exception]$Exception) {
    Stop-Handoff "Plaintext handoff transport failure while ${Action}: $($Exception.Message)" 12
}

function Write-Json([object]$Value) {
    [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function Get-JsonProperty([object]$Value, [string]$Name) {
    if ($null -eq $Value) {
        return $null
    }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    $property.Value
}

function Test-OffsetTimestamp([object]$Value, [ref]$Parsed) {
    if ($Value -isnot [string] -or $Value -notmatch '(?:Z|[+-][0-9]{2}:[0-9]{2})$') {
        return $false
    }
    $timestamp = [DateTimeOffset]::MinValue
    $valid = [DateTimeOffset]::TryParse(
        $Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,
        [ref]$timestamp
    )
    if ($valid) {
        $Parsed.Value = $timestamp
    }
    $valid
}

function Test-HandoffEnvelope([object]$Value) {
    if ($null -eq $Value -or $Value -is [System.Array]) {
        return [pscustomobject]@{ Valid = $false; Error = "the handoff envelope must be a JSON object" }
    }

    $schema = Get-JsonProperty $Value "schema"
    if (($schema -isnot [int] -and $schema -isnot [long]) -or $schema -ne 1) {
        return [pscustomobject]@{ Valid = $false; Error = "the handoff envelope has an invalid schema" }
    }
    $envelopeAgentType = Get-JsonProperty $Value "agent_type"
    if ($envelopeAgentType -isnot [string] -or $envelopeAgentType -ne $agentType) {
        return [pscustomobject]@{ Valid = $false; Error = "the handoff envelope has an invalid agent type" }
    }
    $handoffID = Get-JsonProperty $Value "handoff_id"
    $parsedGuid = [Guid]::Empty
    if ($handoffID -isnot [string] -or -not [Guid]::TryParseExact($handoffID, "D", [ref]$parsedGuid)) {
        return [pscustomobject]@{ Valid = $false; Error = "the handoff envelope has an invalid handoff id" }
    }
    $assignment = Get-JsonProperty $Value "assignment"
    if ($assignment -isnot [string] -or [string]::IsNullOrWhiteSpace($assignment)) {
        return [pscustomobject]@{ Valid = $false; Error = "the handoff envelope assignment must not be blank" }
    }

    $createdAt = [DateTimeOffset]::MinValue
    if (-not (Test-OffsetTimestamp (Get-JsonProperty $Value "created_at") ([ref]$createdAt))) {
        return [pscustomobject]@{ Valid = $false; Error = "created_at must be a valid timestamp with a UTC offset" }
    }
    $expiresAt = [DateTimeOffset]::MinValue
    if (-not (Test-OffsetTimestamp (Get-JsonProperty $Value "expires_at") ([ref]$expiresAt))) {
        return [pscustomobject]@{ Valid = $false; Error = "expires_at must be a valid timestamp with a UTC offset" }
    }

    [pscustomobject]@{
        Valid = $true
        Error = $null
        Value = $Value
        ExpiresAt = $expiresAt
    }
}

function Read-HandoffEnvelope([string]$Path) {
    try {
        $raw = [System.IO.File]::ReadAllText($Path, $strictUtf8WithoutBom)
        $value = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return [pscustomobject]@{ Valid = $false; Error = "the handoff state is not valid UTF-8 JSON" }
    }
    Test-HandoffEnvelope $value
}

function Get-StateFiles([string]$Pattern) {
    try {
        if (-not [System.IO.Directory]::Exists($stateRoot)) {
            return @()
        }
        @([System.IO.Directory]::GetFiles($stateRoot, $Pattern, [System.IO.SearchOption]::TopDirectoryOnly))
    } catch {
        Stop-TransportFailure "enumerating handoff state" $_.Exception
    }
}

function Move-ToQuarantine([string]$ClaimedPath, [string]$AgentID = "unknown") {
    $safeAgentID = if ([string]::IsNullOrWhiteSpace($AgentID)) {
        "unknown"
    } else {
        ($AgentID -replace "[^A-Za-z0-9_-]", "_")
    }
    $failedPath = Join-Path $stateRoot ("{0}.failed.{1}.{2}.json" -f $agentType, $safeAgentID, [Guid]::NewGuid().ToString("N"))
    try {
        [System.IO.File]::Move($ClaimedPath, $failedPath)
    } catch [System.IO.FileNotFoundException] {
        return $null
    } catch {
        Stop-TransportFailure "quarantining an invalid claim" $_.Exception
    }
    $failedPath
}

function Remove-ExpiredClaims {
    $now = [DateTimeOffset]::UtcNow
    foreach ($backupPath in @(Get-StateFiles ".$agentType.expired.*.bak")) {
        $validation = Read-HandoffEnvelope $backupPath
        if (-not $validation.Valid -or $validation.ExpiresAt -gt $now) {
            $null = Move-ToQuarantine $backupPath "replacement-backup"
            continue
        }
        try {
            [System.IO.File]::Delete($backupPath)
        } catch {
            Stop-TransportFailure "cleaning an expired replacement backup" $_.Exception
        }
    }
    foreach ($claimedPath in @(Get-StateFiles "$agentType.claimed.*.json")) {
        $validation = Read-HandoffEnvelope $claimedPath
        if (-not $validation.Valid) {
            $null = Move-ToQuarantine $claimedPath
            continue
        }
        if ($validation.ExpiresAt -gt $now) {
            continue
        }
        try {
            [System.IO.File]::Delete($claimedPath)
        } catch {
            Stop-TransportFailure "cleaning an expired claim" $_.Exception
        }
    }
}

function Invoke-WithStateLock([scriptblock]$Action) {
    try {
        $null = [System.IO.Directory]::CreateDirectory($stateRoot)
    } catch {
        Stop-TransportFailure "creating the state directory" $_.Exception
    }

    $lockStream = $null
    try {
        $lockStream = [System.IO.FileStream]::new(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch [System.IO.IOException] {
        $nativeCode = $_.Exception.HResult -band 0xFFFF
        if ($nativeCode -in @(32, 33)) {
            Stop-Handoff "A plaintext handoff state transition is already in progress." 13
        }
        Stop-TransportFailure "acquiring the state lock" $_.Exception
    } catch {
        Stop-TransportFailure "acquiring the state lock" $_.Exception
    }

    try {
        & $Action
    } finally {
        if ($null -ne $lockStream) {
            $lockStream.Dispose()
        }
    }
}

function Publish-Handoff([object]$Handoff, [bool]$ReplaceExpired) {
    $temporaryPath = Join-Path $stateRoot (".{0}.staging.{1}.tmp" -f $agentType, [Guid]::NewGuid().ToString("N"))
    $backupPath = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $writer = [System.IO.StreamWriter]::new($stream, $utf8WithoutBom, 4096, $true)
        try {
            $writer.Write(($Handoff | ConvertTo-Json -Compress -Depth 8))
            $writer.Flush()
            $stream.Flush($true)
        } finally {
            $writer.Dispose()
            $stream.Dispose()
        }

        if ($ReplaceExpired) {
            $backupPath = Join-Path $stateRoot (".{0}.expired.{1}.bak" -f $agentType, [Guid]::NewGuid().ToString("N"))
            [System.IO.File]::Replace($temporaryPath, $pendingPath, $backupPath, $true)
            [System.IO.File]::Delete($backupPath)
            $backupPath = $null
        } else {
            [System.IO.File]::Move($temporaryPath, $pendingPath)
        }
    } catch [System.IO.IOException] {
        if (-not $ReplaceExpired -and [System.IO.File]::Exists($pendingPath)) {
            Stop-Handoff "A v4_flash_worker handoff is already pending. Consume or remove it before staging another." 3
        }
        Stop-TransportFailure "publishing a pending handoff" $_.Exception
    } catch {
        Stop-TransportFailure "publishing a pending handoff" $_.Exception
    } finally {
        if ([System.IO.File]::Exists($temporaryPath)) {
            try {
                [System.IO.File]::Delete($temporaryPath)
            } catch {
                Stop-TransportFailure "cleaning a staged handoff temporary file" $_.Exception
            }
        }
    }
}

function Stage-Locked([string]$Assignment) {
    Remove-ExpiredClaims
    if (@(Get-StateFiles "$agentType.claimed.*.json").Count -gt 0 -or @(Get-StateFiles "$agentType.failed.*.json").Count -gt 0) {
        Stop-Handoff "A v4_flash_worker handoff is already claimed or quarantined. Resolve it before staging another." 3
    }

    $now = [DateTimeOffset]::UtcNow
    $replaceExpired = $false
    if ([System.IO.File]::Exists($pendingPath)) {
        $validation = Read-HandoffEnvelope $pendingPath
        if (-not $validation.Valid) {
            Stop-Handoff "The existing Flash handoff is malformed. Refusing to replace it." 9
        }
        if ($validation.ExpiresAt -gt $now) {
            Stop-Handoff "A v4_flash_worker handoff is already pending. Let it be consumed or expire before staging another." 3
        }
        $replaceExpired = $true
    }

    $handoff = [ordered]@{
        schema = 1
        handoff_id = [Guid]::NewGuid().ToString("D")
        agent_type = $agentType
        created_at = $now.ToString("O")
        expires_at = $now.AddSeconds($TtlSeconds).ToString("O")
        assignment = $Assignment
    }
    Publish-Handoff $handoff $replaceExpired
    $handoff
}

function Run-TargetHookLocked([object]$HookInput) {
    Remove-ExpiredClaims
    if (@(Get-StateFiles "$agentType.claimed.*.json").Count -gt 0 -or @(Get-StateFiles "$agentType.failed.*.json").Count -gt 0) {
        Stop-Handoff "A plaintext handoff is already claimed or quarantined for a v4_flash_worker." 11
    }
    if (-not [System.IO.File]::Exists($pendingPath)) {
        Stop-Handoff "No plaintext handoff was available for the v4_flash_worker start." 10
    }

    $rawAgentID = [string](Get-JsonProperty $HookInput "agent_id")
    $agentID = if ([string]::IsNullOrWhiteSpace($rawAgentID)) {
        [Guid]::NewGuid().ToString("N")
    } else {
        ($rawAgentID -replace "[^A-Za-z0-9_-]", "_")
    }
    $claimedPath = Join-Path $stateRoot ("{0}.claimed.{1}.{2}.json" -f $agentType, $agentID, [Guid]::NewGuid().ToString("N"))
    try {
        [System.IO.File]::Move($pendingPath, $claimedPath)
    } catch [System.IO.FileNotFoundException] {
        Stop-Handoff "The plaintext handoff disappeared before it could be claimed." 10
    } catch {
        Stop-TransportFailure "claiming the pending handoff" $_.Exception
    }

    $validation = Read-HandoffEnvelope $claimedPath
    if (-not $validation.Valid) {
        $null = Move-ToQuarantine $claimedPath $agentID
        Stop-Handoff "The pending Flash handoff is malformed or has an invalid schema." 5
    }
    if ($validation.ExpiresAt -le [DateTimeOffset]::UtcNow) {
        try {
            [System.IO.File]::Delete($claimedPath)
        } catch {
            Stop-TransportFailure "removing an expired pending handoff" $_.Exception
        }
        Stop-Handoff "The pending Flash handoff expired before the child started." 6
    }

    $assignment = [string](Get-JsonProperty $validation.Value "assignment")
    $additionalContext = @"
You are the spawned v4_flash_worker child, not the root agent. The parent supplied the complete task below through a one-time plaintext handoff because provider-internal collaboration ciphertext is not a reliable cross-provider task carrier. Treat this as the task contract. Do not continue the parent's unrelated work and do not report the assignment missing merely because the encrypted collaboration payload is unreadable.

BEGIN PARENT ASSIGNMENT
$assignment
END PARENT ASSIGNMENT
"@

    try {
        Write-Json ([ordered]@{
            hookSpecificOutput = [ordered]@{
                hookEventName = "SubagentStart"
                additionalContext = $additionalContext
            }
        })
    } catch {
        Stop-TransportFailure "delivering the claimed handoff" $_.Exception
    }

    try {
        [System.IO.File]::Delete($claimedPath)
    } catch {
        Stop-TransportFailure "consuming the claimed handoff" $_.Exception
    }
}

try {
    if ($Mode -eq "stage") {
        $assignment = [Console]::In.ReadToEnd()
        if ($assignment.Length -gt 0 -and $assignment[0] -eq [char]0xFEFF) {
            $assignment = $assignment.Substring(1)
        }
        if ([string]::IsNullOrWhiteSpace($assignment)) {
            Stop-Handoff "Refusing to stage an empty Flash assignment." 2
        }
        $handoff = Invoke-WithStateLock { Stage-Locked $assignment }
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
    if ($rawHookInput.Length -gt 0 -and $rawHookInput[0] -eq [char]0xFEFF) {
        $rawHookInput = $rawHookInput.Substring(1)
    }
    if ([string]::IsNullOrWhiteSpace($rawHookInput)) {
        Stop-Handoff "SubagentStart hook input was empty." 4
    }
    try {
        $hookInput = $rawHookInput | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Stop-Handoff "SubagentStart hook input was invalid JSON." 4
    }
    if ($null -eq $hookInput -or $hookInput -is [System.Array]) {
        Stop-Handoff "SubagentStart hook input must be a JSON object." 4
    }
    if ((Get-JsonProperty $hookInput "hook_event_name") -ne "SubagentStart" -or (Get-JsonProperty $hookInput "agent_type") -ne $agentType) {
        exit 0
    }

    Invoke-WithStateLock { Run-TargetHookLocked $hookInput }
    exit 0
} catch {
    Stop-TransportFailure "processing the handoff" $_.Exception
}
