# PowerShell completion for Rivet (rivet)
#
# Install: dot-source this file from your $PROFILE so the completer loads in every session:
#   Add-Content $PROFILE ". $PSScriptRoot\rivet.ps1"   # or the absolute path to this file
# Then restart PowerShell (or run `. .\rivet.ps1` once).

function Get-RivetProviders {
    $configFile = Join-Path $env:USERPROFILE ".rivet\config.json"
    if (-not (Test-Path $configFile)) { return @() }
    try {
        $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
        if ($cfg.provider -and $cfg.provider.providers) {
            return $cfg.provider.providers.PSObject.Properties.Name
        }
    } catch { }
    return @()
}

# The completer scriptblock is self-contained (arrays defined inside) so it does not
# depend on outer-scope variable resolution when invoked by the PowerShell engine.
$rivetCompleter = {
    param($wordToComplete, $commandAst, $cursorPosition)

    $rivetTopCommands   = @('config', 'serve', 'sessions')
    $rivetConfigCommands = @('show', 'providers', 'set-key', 'set-key-env', 'set-default', 'add-model', 'remove-model')
    $rivetProviderVerbs  = @('set-key', 'set-key-env', 'set-default', 'add-model', 'remove-model')
    $rivetTopFlags = @(
        '--help', '-h', '--version', '-v',
        '--print', '-p', '--json', '--stream-json',
        '--goal', '--budget', '--model', '--provider',
        '--continue', '-c', '--resume', '-r', '--new', '--list',
        '--dangerously-skip-permissions', '--screen-reader', '--skip-welcome', '--stream-events'
    )

    # Parse the command line into tokens (works for native commands).
    $line = $commandAst.ToString().Trim()
    $words = $line.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)

    $result = @()

    $hasConfig = $words -contains 'config'
    if ($hasConfig) {
        $configIdx = [array]::IndexOf($words, 'config')
        $afterConfig = @($words[($configIdx + 1)..($words.Length - 1)] | Where-Object { $_ -and $_ -ne 'config' })
        if ($afterConfig.Count -eq 0) {
            # No token after `config` yet — offer every config subcommand.
            foreach ($c in $rivetConfigCommands) {
                if ($c -like "$wordToComplete*") {
                    $result += [System.Management.Automation.CompletionResult]::new($c, $c, 'Command', $c)
                }
            }
            return $result
        }
        $only = $afterConfig[0]
        if ($afterConfig.Count -eq 1) {
            if ($rivetProviderVerbs -contains $only) {
                # A complete provider verb is present — next token is the provider name.
                foreach ($p in (Get-RivetProviders)) {
                    if ($p -like "$wordToComplete*") {
                        $result += [System.Management.Automation.CompletionResult]::new($p, $p, 'ParameterValue', $p)
                    }
                }
                return $result
            }
            if ($rivetConfigCommands -contains $only) {
                # A complete subcommand with no further arguments — nothing more to offer.
                return $result
            }
            # Still typing the subcommand (partial) — offer matching subcommands.
            foreach ($c in $rivetConfigCommands) {
                if ($c -like "$wordToComplete*") {
                    $result += [System.Management.Automation.CompletionResult]::new($c, $c, 'Command', $c)
                }
            }
            return $result
        }
        # Two or more tokens after `config` — the first is the verb, the rest are its args.
        if ($rivetProviderVerbs -contains $only) {
            foreach ($p in (Get-RivetProviders)) {
                if ($p -like "$wordToComplete*") {
                    $result += [System.Management.Automation.CompletionResult]::new($p, $p, 'ParameterValue', $p)
                }
            }
            return $result
        }
        return $result
    }

    # Top-level: commands + flags.
    foreach ($c in $rivetTopCommands) {
        if ($c -like "$wordToComplete*") {
            $result += [System.Management.Automation.CompletionResult]::new($c, $c, 'Command', $c)
        }
    }
    foreach ($f in $rivetTopFlags) {
        if ($f -like "$wordToComplete*") {
            $result += [System.Management.Automation.CompletionResult]::new($f, $f, 'ParameterName', $f)
        }
    }
    return $result
}

# -Native is required for external commands on PowerShell 7+, but is not a valid
# switch on Windows PowerShell 5.1 (where native completion is implicit).
$registerParams = @{ CommandName = 'rivet'; ScriptBlock = $rivetCompleter }
if ((Get-Command Register-ArgumentCompleter).Parameters.ContainsKey('Native')) {
    $registerParams['Native'] = $true
}
Register-ArgumentCompleter @registerParams
