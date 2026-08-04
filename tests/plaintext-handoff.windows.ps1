$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "hooks\plaintext-handoff.ps1"
$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("codex-plaintext-handoff-test-{0}" -f [Guid]::NewGuid().ToString("N"))))
$expectedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $temporaryRoot.StartsWith($expectedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a test directory outside the system temporary directory: $temporaryRoot"
}

function Invoke-Handoff([string]$Mode, [string]$InputText) {
    $output = $InputText | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -Mode $Mode -StateDirectory $temporaryRoot
    if ($LASTEXITCODE -ne 0) {
        throw "plaintext-handoff.ps1 $Mode failed with exit code $LASTEXITCODE"
    }
    [string]$output
}

try {
    $marker = "FLASH_PLAINTEXT_HANDOFF_{0}" -f [Guid]::NewGuid().ToString("N").ToUpperInvariant()
    $assignment = "Return exactly: $marker"
    $stageResult = Invoke-Handoff -Mode "stage" -InputText $assignment | ConvertFrom-Json
    if (-not $stageResult.staged -or $stageResult.agent_type -ne "v4_flash_worker") {
        throw "Stage result did not describe the expected worker."
    }
    if (-not (Test-Path -LiteralPath $stageResult.pending_path)) {
        throw "The staged handoff file was not created."
    }

    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $null = "Return exactly: SHOULD_NOT_REPLACE_PENDING" | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -Mode stage -StateDirectory $temporaryRoot 2>$null
    $collisionExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    if ($collisionExitCode -eq 0) {
        throw "A second assignment replaced an existing pending handoff."
    }

    $wrongRoleInput = [ordered]@{
        session_id = [Guid]::NewGuid().ToString()
        transcript_path = $null
        cwd = $PSScriptRoot
        hook_event_name = "SubagentStart"
        model = "gpt-5.6-luna"
        turn_id = [Guid]::NewGuid().ToString()
        agent_id = [Guid]::NewGuid().ToString()
        agent_type = "luna_worker"
        permission_mode = "default"
    } | ConvertTo-Json -Compress
    $wrongRoleOutput = Invoke-Handoff -Mode "hook" -InputText $wrongRoleInput
    if (-not [string]::IsNullOrWhiteSpace($wrongRoleOutput)) {
        throw "A non-Flash child received the staged assignment."
    }
    if (-not (Test-Path -LiteralPath $stageResult.pending_path)) {
        throw "A non-Flash child consumed the staged assignment."
    }

    $flashInput = [ordered]@{
        session_id = [Guid]::NewGuid().ToString()
        transcript_path = $null
        cwd = $PSScriptRoot
        hook_event_name = "SubagentStart"
        model = "deepseek-v4-flash"
        turn_id = [Guid]::NewGuid().ToString()
        agent_id = [Guid]::NewGuid().ToString()
        agent_type = "v4_flash_worker"
        permission_mode = "default"
    } | ConvertTo-Json -Compress
    $hookResult = Invoke-Handoff -Mode "hook" -InputText $flashInput | ConvertFrom-Json
    $context = [string]$hookResult.hookSpecificOutput.additionalContext
    if ($hookResult.hookSpecificOutput.hookEventName -ne "SubagentStart" -or -not $context.Contains($marker)) {
        throw "The Flash child did not receive the exact staged marker."
    }
    if (Test-Path -LiteralPath $stageResult.pending_path) {
        throw "The handoff was not consumed after successful injection."
    }

    $replayOutput = Invoke-Handoff -Mode "hook" -InputText $flashInput
    if (-not [string]::IsNullOrWhiteSpace($replayOutput)) {
        throw "The one-shot handoff was replayed."
    }

    $expiredResult = Invoke-Handoff -Mode "stage" -InputText "Return exactly: EXPIRED_ASSIGNMENT" | ConvertFrom-Json
    $expiredEnvelope = Get-Content -Raw -LiteralPath $expiredResult.pending_path | ConvertFrom-Json
    $expiredEnvelope.expires_at = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("O")
    [System.IO.File]::WriteAllText(
        $expiredResult.pending_path,
        ($expiredEnvelope | ConvertTo-Json -Compress -Depth 8),
        [System.Text.UTF8Encoding]::new($false)
    )
    $replacementMarker = "FLASH_PLAINTEXT_HANDOFF_REPLACEMENT_{0}" -f [Guid]::NewGuid().ToString("N").ToUpperInvariant()
    $replacementResult = Invoke-Handoff -Mode "stage" -InputText "Return exactly: $replacementMarker" | ConvertFrom-Json
    if ($replacementResult.handoff_id -eq $expiredResult.handoff_id) {
        throw "The expired handoff was not replaced with a fresh identity."
    }
    $replacementHook = Invoke-Handoff -Mode "hook" -InputText $flashInput | ConvertFrom-Json
    if (-not ([string]$replacementHook.hookSpecificOutput.additionalContext).Contains($replacementMarker)) {
        throw "The replacement assignment was not delivered after stale-state recovery."
    }

    $malformedPath = Join-Path $temporaryRoot "v4_flash_worker.pending.json"
    $malformedContent = '{"schema":99,"agent_type":"v4_flash_worker"}'
    [System.IO.File]::WriteAllText($malformedPath, $malformedContent, [System.Text.UTF8Encoding]::new($false))
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $null = "Return exactly: MUST_NOT_REPLACE_MALFORMED" | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -Mode stage -StateDirectory $temporaryRoot 2>$null
    $malformedExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    if ($malformedExitCode -eq 0 -or (Get-Content -Raw -LiteralPath $malformedPath) -ne $malformedContent) {
        throw "Malformed pending state was silently replaced."
    }

    Write-Output "PASS: collision rejection, exact-role delivery, exact marker preservation, one-shot consumption, replay rejection, expired-state recovery, and malformed-state rejection"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
