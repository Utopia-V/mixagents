$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$agentType = "v4_flash_worker"
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "hooks\plaintext-handoff.ps1"
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("codex-plaintext-handoff-windows-{0}" -f [Guid]::NewGuid().ToString("N"))))
$expectedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $temporaryRoot.StartsWith($expectedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a test directory outside the system temporary directory: $temporaryRoot"
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message Expected=[$Expected] Actual=[$Actual]"
    }
}

function New-StateRoot([string]$Name) {
    $path = Join-Path $temporaryRoot $Name
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    $path
}

function New-Envelope(
    [string]$Assignment = "read the logs",
    [int]$ExpiresInSeconds = 300,
    [hashtable]$Overrides = @{}
) {
    $now = [DateTimeOffset]::UtcNow
    $value = [ordered]@{
        schema = 1
        handoff_id = [Guid]::NewGuid().ToString("D")
        agent_type = $agentType
        created_at = $now.ToString("O")
        expires_at = $now.AddSeconds($ExpiresInSeconds).ToString("O")
        assignment = $Assignment
    }
    foreach ($key in $Overrides.Keys) {
        $value[$key] = $Overrides[$key]
    }
    $value
}

function Write-StateJson([string]$Path, [object]$Value) {
    [System.IO.File]::WriteAllText(
        $Path,
        ($Value | ConvertTo-Json -Compress -Depth 8),
        [System.Text.UTF8Encoding]::new($false)
    )
}

function New-HookInput([string]$AgentType = "v4_flash_worker", [string]$AgentID = "agent-1") {
    [ordered]@{
        session_id = [Guid]::NewGuid().ToString()
        transcript_path = $null
        cwd = $PSScriptRoot
        hook_event_name = "SubagentStart"
        model = if ($AgentType -eq $agentType) { "deepseek-v4-flash" } else { "gpt-5.6-luna" }
        turn_id = [Guid]::NewGuid().ToString()
        agent_id = $AgentID
        agent_type = $AgentType
        permission_mode = "default"
    } | ConvertTo-Json -Compress
}

function Invoke-Handoff(
    [string]$Mode,
    [string]$InputText,
    [string]$StateRoot,
    [int]$TtlSeconds = 300
) {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = @(
            $InputText |
                & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -Mode $Mode -StateDirectory $StateRoot -TtlSeconds $TtlSeconds 2>&1
        )
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    [pscustomobject]@{
        ExitCode = $exitCode
        Output = (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    }
}

function Start-Handoff(
    [string]$Mode,
    [string]$InputText,
    [string]$StateRoot,
    [int]$TtlSeconds = 300
) {
    $escapedScriptPath = $scriptPath.Replace("'", "''")
    $escapedStateRoot = $StateRoot.Replace("'", "''")
    $invocation = "`$ProgressPreference = 'SilentlyContinue'`n[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)`n& '$escapedScriptPath' -Mode '$Mode' -StateDirectory '$escapedStateRoot' -TtlSeconds $TtlSeconds`nexit `$LASTEXITCODE"
    $encodedInvocation = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($invocation))
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powershellPath
    $startInfo.Arguments = "-NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encodedInvocation"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start plaintext handoff process."
    }
    $inputBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($InputText)
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.Close()
    $process
}

function Complete-Handoff([System.Diagnostics.Process]$Process) {
    $stdout = $Process.StandardOutput.ReadToEnd()
    $stderr = $Process.StandardError.ReadToEnd()
    if (-not $Process.WaitForExit(15000)) {
        $Process.Kill()
        throw "Timed out waiting for plaintext handoff process."
    }
    $result = [pscustomobject]@{
        ExitCode = $Process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
        Output = $stdout + $stderr
    }
    $Process.Dispose()
    $result
}

function Invoke-Test([string]$Name, [scriptblock]$Body) {
    & $Body
    Write-Output "PASS: $Name"
}

try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

    Invoke-Test "basic one-shot delivery and controlled replay failure" {
        $state = New-StateRoot "basic"
        $marker = "WINDOWS_BASIC_{0}" -f [Guid]::NewGuid().ToString("N").ToUpperInvariant()
        $stage = Invoke-Handoff "stage" "Return exactly: $marker" $state
        Assert-Equal 0 $stage.ExitCode "Stage failed."
        Assert-True (-not $stage.Output.Contains($marker)) "Stage echoed the assignment."
        $stageJson = $stage.Output | ConvertFrom-Json
        Assert-Equal $agentType $stageJson.agent_type "Stage selected the wrong role."
        Assert-True (Test-Path -LiteralPath $stageJson.pending_path) "Stage did not publish pending state."

        $wrongRole = Invoke-Handoff "hook" (New-HookInput "luna_worker") $state
        Assert-Equal 0 $wrongRole.ExitCode "A non-target Hook failed."
        Assert-True ([string]::IsNullOrWhiteSpace($wrongRole.Output)) "A non-target Hook emitted context."
        Assert-True (Test-Path -LiteralPath $stageJson.pending_path) "A non-target Hook consumed pending state."

        $hook = Invoke-Handoff "hook" (New-HookInput) $state
        Assert-Equal 0 $hook.ExitCode "The target Hook failed."
        Assert-True $hook.Output.Contains($marker) "The target Hook did not receive the assignment."
        Assert-True (-not (Get-ChildItem -LiteralPath $state -Filter "$agentType.*.json" -ErrorAction SilentlyContinue)) "A successful Hook left assignment state behind."

        $replay = Invoke-Handoff "hook" (New-HookInput) $state
        Assert-Equal 10 $replay.ExitCode "A target Hook without pending state must fail explicitly."
        Assert-True $replay.Output.ToLowerInvariant().Contains("handoff") "Missing state did not report a transport failure."
    }

    Invoke-Test "dispatch lock contention fails before state mutation" {
        $state = New-StateRoot "lock-contention"
        $lockPath = Join-Path $state ".$agentType.lock"
        $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        try {
            $stage = Invoke-Handoff "stage" "must not publish" $state
        } finally {
            $lock.Dispose()
        }
        Assert-Equal 13 $stage.ExitCode "Lock contention returned the wrong result."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $state "$agentType.pending.json"))) "A contending stage mutated pending state."
    }

    Invoke-Test "UTF-8 assignment survives stage and Hook output" {
        $state = New-StateRoot "utf8-roundtrip"
        $assignment = [string]::Concat([char[]]@(0x603B, 0x7ED3, 0x65E5, 0x5FD7, 0xFF1A, 0x5E76, 0x53D1, 0x4EA4, 0x4ED8, 0x20, 0x2713))
        $stageProcess = Start-Handoff "stage" $assignment $state
        $stage = Complete-Handoff $stageProcess
        Assert-Equal 0 $stage.ExitCode "UTF-8 stage failed: $($stage.Output)"
        $hookProcess = Start-Handoff "hook" (New-HookInput -AgentID "utf8-child") $state
        $hook = Complete-Handoff $hookProcess
        Assert-Equal 0 $hook.ExitCode "UTF-8 Hook failed: $($hook.Output)"
        Assert-True $hook.Stdout.Contains($assignment) "UTF-8 assignment changed during delivery: $($hook.Stdout)"
    }

    Invoke-Test "active claims block stage and expired orphan claims recover" {
        $activeState = New-StateRoot "active-claim"
        $activeClaim = Join-Path $activeState "$agentType.claimed.running-agent.json"
        Write-StateJson $activeClaim (New-Envelope "owned by a live Hook")
        $blocked = Invoke-Handoff "stage" "must remain blocked" $activeState
        Assert-Equal 3 $blocked.ExitCode "An active claim did not block stage."
        Assert-True (Test-Path -LiteralPath $activeClaim) "An active claim was removed."

        $expiredState = New-StateRoot "expired-claim"
        $expiredClaim = Join-Path $expiredState "$agentType.claimed.crashed-agent.json"
        Write-StateJson $expiredClaim (New-Envelope "orphaned" -ExpiresInSeconds -10)
        $recovered = Invoke-Handoff "stage" "replacement" $expiredState
        Assert-Equal 0 $recovered.ExitCode "An expired orphan claim was not recovered."
        Assert-True (-not (Test-Path -LiteralPath $expiredClaim)) "The expired orphan claim survived recovery."
    }

    Invoke-Test "active pending blocks and valid expired pending is replaced atomically" {
        $state = New-StateRoot "pending-recovery"
        $first = Invoke-Handoff "stage" "first assignment" $state
        Assert-Equal 0 $first.ExitCode "Could not create the first pending assignment."
        $firstResult = $first.Output | ConvertFrom-Json
        $collision = Invoke-Handoff "stage" "must not replace active pending" $state
        Assert-Equal 3 $collision.ExitCode "An active pending assignment did not block stage."

        $pendingPath = Join-Path $state "$agentType.pending.json"
        $pending = [System.IO.File]::ReadAllText($pendingPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $pending.expires_at = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("O")
        Write-StateJson $pendingPath $pending
        $replacement = Invoke-Handoff "stage" "replacement assignment" $state
        Assert-Equal 0 $replacement.ExitCode "A valid expired pending assignment was not replaced: $($replacement.Output)"
        $replacementResult = $replacement.Output | ConvertFrom-Json
        Assert-True ($replacementResult.handoff_id -ne $firstResult.handoff_id) "Expired replacement reused the old handoff identity."
        $published = [System.IO.File]::ReadAllText($pendingPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Equal "replacement assignment" ([string]$published.assignment).TrimEnd() "Expired replacement published the wrong assignment."
    }

    Invoke-Test "malformed claimed state is quarantined and blocks stage" {
        $state = New-StateRoot "malformed-claim"
        $claim = Join-Path $state "$agentType.claimed.broken-agent.json"
        $malformed = New-Envelope "   " -ExpiresInSeconds -10
        Write-StateJson $claim $malformed
        $stage = Invoke-Handoff "stage" "must not replace malformed state" $state
        Assert-Equal 3 $stage.ExitCode "Malformed claimed state did not block stage."
        Assert-True (-not (Test-Path -LiteralPath $claim)) "Malformed claimed state was not quarantined."
        $failed = @(Get-ChildItem -LiteralPath $state -Filter "$agentType.failed.*.json")
        Assert-Equal 1 $failed.Count "Malformed claimed state did not produce one quarantine file."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $state "$agentType.pending.json"))) "Malformed claimed state was replaced."
    }

    Invoke-Test "strict pending validation preserves malformed state" {
        $cases = [ordered]@{
            invalid_guid = New-Envelope "must survive" -ExpiresInSeconds -10 -Overrides @{ handoff_id = "not-a-guid" }
            blank_assignment = New-Envelope "   " -ExpiresInSeconds -10
            naive_created_at = New-Envelope "must survive" -ExpiresInSeconds -10 -Overrides @{ created_at = "2026-08-08T12:00:00" }
            naive_expires_at = New-Envelope "must survive" -ExpiresInSeconds -10 -Overrides @{ expires_at = "2026-08-08T12:05:00" }
        }
        foreach ($caseName in $cases.Keys) {
            $state = New-StateRoot "strict-pending-$caseName"
            $pending = Join-Path $state "$agentType.pending.json"
            Write-StateJson $pending $cases[$caseName]
            $original = [System.IO.File]::ReadAllBytes($pending)
            $stage = Invoke-Handoff "stage" "must not replace malformed state" $state
            Assert-Equal 9 $stage.ExitCode "Malformed pending state returned the wrong result for $caseName."
            Assert-True ([System.Linq.Enumerable]::SequenceEqual([byte[]]$original, [byte[]][System.IO.File]::ReadAllBytes($pending))) "Malformed pending state changed for $caseName."
        }

        $corruptState = New-StateRoot "strict-pending-corrupt-json"
        $corruptPending = Join-Path $corruptState "$agentType.pending.json"
        $corrupt = [System.Text.Encoding]::UTF8.GetBytes('{"schema":1,"assignment":"unfinished')
        [System.IO.File]::WriteAllBytes($corruptPending, $corrupt)
        $stage = Invoke-Handoff "stage" "must not replace corrupt state" $corruptState
        Assert-Equal 9 $stage.ExitCode "Corrupt pending JSON returned the wrong result."
        Assert-True ([System.Linq.Enumerable]::SequenceEqual([byte[]]$corrupt, [byte[]][System.IO.File]::ReadAllBytes($corruptPending))) "Corrupt pending JSON was changed."

        $encodingState = New-StateRoot "strict-pending-invalid-utf8"
        $encodingPending = Join-Path $encodingState "$agentType.pending.json"
        $encodingEnvelope = New-Envelope "INVALID_UTF8_MARKER" -ExpiresInSeconds -10
        $encodingJson = $encodingEnvelope | ConvertTo-Json -Compress -Depth 8
        $invalidUtf8 = [System.Text.Encoding]::UTF8.GetBytes($encodingJson)
        $markerOffset = $encodingJson.IndexOf("INVALID_UTF8_MARKER", [System.StringComparison]::Ordinal)
        Assert-True ($markerOffset -ge 0) "Could not locate the UTF-8 corruption marker."
        $invalidUtf8[$markerOffset] = 0xFF
        [System.IO.File]::WriteAllBytes($encodingPending, $invalidUtf8)
        $stage = Invoke-Handoff "stage" "must not replace invalid UTF-8" $encodingState
        Assert-Equal 9 $stage.ExitCode "Invalid UTF-8 pending state returned the wrong result."
        Assert-True ([System.Linq.Enumerable]::SequenceEqual([byte[]]$invalidUtf8, [byte[]][System.IO.File]::ReadAllBytes($encodingPending))) "Invalid UTF-8 pending state was changed."
    }

    Invoke-Test "invalid Hook claim is preserved in quarantine" {
        $state = New-StateRoot "hook-quarantine"
        $pending = Join-Path $state "$agentType.pending.json"
        $invalid = New-Envelope "must survive" -Overrides @{ schema = 99 }
        Write-StateJson $pending $invalid
        $original = [System.IO.File]::ReadAllBytes($pending)
        $hook = Invoke-Handoff "hook" (New-HookInput) $state
        Assert-Equal 5 $hook.ExitCode "Invalid claimed state returned the wrong result."
        Assert-True (-not (Test-Path -LiteralPath $pending)) "Invalid pending state remained under the pending name."
        $failed = @(Get-ChildItem -LiteralPath $state -Filter "$agentType.failed.*.json")
        Assert-Equal 1 $failed.Count "Invalid claimed state was not quarantined once."
        Assert-True ([System.Linq.Enumerable]::SequenceEqual([byte[]]$original, [byte[]][System.IO.File]::ReadAllBytes($failed[0].FullName))) "Quarantine changed the invalid state."
    }

    Invoke-Test "concurrent stages publish one complete assignment" {
        $state = New-StateRoot "concurrent-stage"
        $processes = @()
        foreach ($index in 1..6) {
            $processes += Start-Handoff "stage" "job-$index" $state
        }
        $results = @($processes | ForEach-Object { Complete-Handoff $_ })
        $successes = @($results | Where-Object ExitCode -eq 0)
        Assert-Equal 1 $successes.Count "Concurrent stages did not produce exactly one winner."
        foreach ($failure in @($results | Where-Object ExitCode -ne 0)) {
            Assert-True ($failure.ExitCode -in @(3, 13)) "A losing stage failed outside the controlled collision boundary (exit $($failure.ExitCode)): $($failure.Output)"
        }
        $pending = [System.IO.File]::ReadAllText((Join-Path $state "$agentType.pending.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-True (([string]$pending.assignment) -match '^job-[1-6]$') "The published concurrent assignment was incomplete: [$($pending.assignment)]"
    }

    Invoke-Test "pending publication never exposes partial JSON" {
        $state = New-StateRoot "atomic-publication"
        $ioRoot = New-StateRoot "atomic-publication-io"
        $inputPath = Join-Path $ioRoot "input.txt"
        $stdoutPath = Join-Path $ioRoot "stdout.txt"
        $stderrPath = Join-Path $ioRoot "stderr.txt"
        $assignment = "atomic-" + ("x" * (16 * 1024 * 1024))
        [System.IO.File]::WriteAllText($inputPath, $assignment, [System.Text.UTF8Encoding]::new($false))
        $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Mode stage -StateDirectory `"$state`" -TtlSeconds 60"
        $process = Start-Process -FilePath $powershellPath -ArgumentList $arguments -RedirectStandardInput $inputPath -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
        $pendingPath = Join-Path $state "$agentType.pending.json"
        $malformedObservation = $null
        while (-not $process.HasExited) {
            if (Test-Path -LiteralPath $pendingPath) {
                try {
                    $null = [System.IO.File]::ReadAllText($pendingPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
                } catch {
                    $malformedObservation = $_.Exception.Message
                    break
                }
            }
            Start-Sleep -Milliseconds 1
        }
        if (-not $process.HasExited) {
            if (-not $process.WaitForExit(15000)) {
                $process.Kill()
                throw "Atomic publication stage timed out."
            }
        }
        $process.WaitForExit()
        $process.Refresh()
        $atomicStderr = [System.IO.File]::ReadAllText($stderrPath)
        Assert-True ([string]::IsNullOrWhiteSpace($atomicStderr)) "Atomic publication stage failed: $atomicStderr"
        $atomicStage = [System.IO.File]::ReadAllText($stdoutPath) | ConvertFrom-Json
        Assert-True ([bool]$atomicStage.staged) "Atomic publication stage did not report success."
        Assert-True ($null -eq $malformedObservation) "A partial pending document was observable: $malformedObservation"
        $published = [System.IO.File]::ReadAllText($pendingPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Equal $assignment.Length ([string]$published.assignment).Length "Atomic publication changed the assignment length."
        $process.Dispose()
    }

    Invoke-Test "concurrent target Hooks deliver at most once" {
        $state = New-StateRoot "concurrent-hook"
        $marker = "WINDOWS_CONCURRENT_HOOK_{0}" -f [Guid]::NewGuid().ToString("N").ToUpperInvariant()
        $stage = Invoke-Handoff "stage" "Return exactly: $marker" $state
        Assert-Equal 0 $stage.ExitCode "Could not prepare concurrent Hook state."
        $first = Start-Handoff "hook" (New-HookInput -AgentID "first") $state
        $second = Start-Handoff "hook" (New-HookInput -AgentID "second") $state
        $results = @(Complete-Handoff $first; Complete-Handoff $second)
        $successes = @($results | Where-Object ExitCode -eq 0)
        Assert-Equal 1 $successes.Count "Concurrent Hooks did not deliver exactly once in the no-fault run."
        Assert-True $successes[0].Stdout.Contains($marker) "The winning Hook received the wrong assignment."
        foreach ($failure in @($results | Where-Object ExitCode -ne 0)) {
            Assert-True ($failure.ExitCode -in @(10, 13)) "The losing Hook failed outside the controlled transport boundary (exit $($failure.ExitCode)): $($failure.Output)"
        }
        Assert-True (-not (Get-ChildItem -LiteralPath $state -Filter "$agentType.*.json" -ErrorAction SilentlyContinue)) "Concurrent Hook delivery left assignment state behind."
    }

    Invoke-Test "claim remains protected until Hook output is flushed" {
        $state = New-StateRoot "active-delivery"
        $marker = "WINDOWS_ACTIVE_DELIVERY_{0}" -f [Guid]::NewGuid().ToString("N").ToUpperInvariant()
        $assignment = "Return marker $marker`n" + ("x" * (2 * 1024 * 1024))
        $stage = Invoke-Handoff "stage" $assignment $state 60
        Assert-Equal 0 $stage.ExitCode "Could not prepare the active-delivery state."
        $hookProcess = $null
        try {
            $hookProcess = Start-Handoff "hook" (New-HookInput -AgentID "slow-output") $state 60
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            $claim = $null
            while ([DateTime]::UtcNow -lt $deadline -and -not $hookProcess.HasExited) {
                $claim = Get-ChildItem -LiteralPath $state -Filter "$agentType.claimed.*.json" -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($null -ne $claim) {
                    break
                }
                Start-Sleep -Milliseconds 1
            }
            Assert-True ($null -ne $claim) "The Hook did not retain a visible claim during blocked output."
            $competing = Invoke-Handoff "stage" "must not publish during delivery" $state
            Assert-Equal 13 $competing.ExitCode "A stage entered while Hook delivery held the dispatch lock."

            $stdout = $hookProcess.StandardOutput.ReadToEnd()
            $stderr = $hookProcess.StandardError.ReadToEnd()
            Assert-True ($hookProcess.WaitForExit(15000)) "The Hook did not finish after output was drained."
            Assert-Equal 0 $hookProcess.ExitCode "The active Hook failed: $stderr"
            Assert-True $stdout.Contains($marker) "The active Hook delivered the wrong assignment."
            $hookProcess.Dispose()
            $hookProcess = $null
            Assert-True (-not (Get-ChildItem -LiteralPath $state -Filter "$agentType.*.json" -ErrorAction SilentlyContinue)) "The completed Hook left assignment state behind."
        } finally {
            if ($null -ne $hookProcess) {
                if (-not $hookProcess.HasExited) {
                    $hookProcess.Kill()
                    $hookProcess.WaitForExit()
                }
                $hookProcess.Dispose()
            }
        }
    }

    Write-Output "PASS: Windows plaintext handoff protocol"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
        if (-not $resolvedRoot.StartsWith($expectedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a test directory outside the system temporary directory: $resolvedRoot"
        }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
