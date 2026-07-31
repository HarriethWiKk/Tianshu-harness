# PowerShell completion for Rivet (rivet)
#
# Install: dot-source this file from your $PROFILE so the completer loads in every session:
#   Add-Content $PROFILE ". C:\path\to\rivet.ps1"
# Then restart PowerShell (or run `. .\rivet.ps1` once).
#
# Works on Windows PowerShell 5.1 and PowerShell 7+.

function Get-RivetProviders {
    $configFile = Join-Path $env:USERPROFILE ".rivet\config.json"
    if (-not (Test-Path $configFile)) { return @() }
    try {
        $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
        if ($cfg.provider -and $cfg.provider.providers) {
            return @($cfg.provider.providers.PSObject.Properties.Name)
        }
    } catch { }
    return @()
}

# The completer is self-contained (all tables defined inside) so it does not depend
# on outer-scope variable resolution when invoked by the PowerShell engine.
$rivetCompleter = {
    param($wordToComplete, $commandAst, $cursorPosition)

    # NOTE: both helpers are always consumed via @(...) at the call sites. PowerShell
    # unwraps a single-element array into a scalar, and `CompletionResult + array`
    # throws op_Addition, so the @() cast around every call is load-bearing.
    function Add-Match($map, $type, $prefix) {
        $out = @()
        foreach ($k in $map.Keys) {
            if ($k -like "$prefix*") {
                $out += [System.Management.Automation.CompletionResult]::new($k, $k, $type, $map[$k])
            }
        }
        return $out
    }

    function Add-List($items, $type, $prefix) {
        $out = @()
        foreach ($k in $items) {
            if ($k -like "$prefix*") {
                $out += [System.Management.Automation.CompletionResult]::new($k, $k, $type, $k)
            }
        }
        return $out
    }

    $topCommands = [ordered]@{
        'config'   = 'Manage providers, API keys and models'
        'serve'    = 'Start the sidecar HTTP/SSE runtime server'
        'sessions' = 'Print the session list and exit'
        'browser'  = 'Check or install the Chromium used by browser tools'
        'logs'     = 'Show where sessions, caches and logs are written'
    }

    $topFlags = [ordered]@{
        '-p'                             = 'Run a single prompt headlessly and print the result'
        '--print'                        = 'Run a single prompt headlessly and print the result'
        '--json'                         = 'Emit a single JSON result object'
        '--stream-json'                  = 'Emit the run as an NDJSON event stream'
        '--goal'                         = 'Run headless autonomous goal mode'
        '--budget'                       = 'Turn budget for goal mode (default 100)'
        '--model'                        = 'Override the model for this session'
        '--provider'                     = 'Override the provider for this session'
        '-c'                             = 'Resume the most recent session for this directory'
        '--continue'                     = 'Resume the most recent session for this directory'
        '-r'                             = 'Resume a session by id or prefix'
        '--resume'                       = 'Resume a session by id or prefix'
        '--new'                          = 'Force a brand-new session'
        '--list'                         = 'Print the session list and exit'
        '--dangerously-skip-permissions' = 'Skip all tool approvals'
        '--screen-reader'                = 'Screen-reader friendly output'
        '--skip-welcome'                 = 'Skip the welcome screen'
        '--stream-events'                = 'Mirror the run as an NDJSON SessionEvent file'
    }

    $configCommands = [ordered]@{
        'show'         = 'Print the resolved configuration as JSON'
        'providers'    = 'List configured providers and key status'
        'setup'        = 'Configure a provider in one shot'
        'set-url'      = 'Set the base URL for a provider'
        'set-model'    = 'Set the active model for a provider'
        'set-key'      = 'Set the API key for a provider'
        'set-key-env'  = 'Read the API key from an environment variable'
        'set-default'  = 'Set the default provider'
        'set-approval' = 'Set the tool approval mode'
        'add-model'    = 'Add a model to a provider'
        'remove-model' = 'Remove a model from a provider'
        'mcp'          = 'Manage MCP servers'
    }

    $mcpCommands = [ordered]@{
        'list'      = 'List configured MCP servers'
        'add-stdio' = 'Add a stdio MCP server'
        'add-sse'   = 'Add an SSE MCP server'
        'remove'    = 'Remove an MCP server'
        'enable'    = 'Enable an MCP server'
        'disable'   = 'Disable an MCP server'
    }

    $approvalModes = [ordered]@{
        'auto-safe'                      = 'Auto-approve read-only tools, ask for the rest'
        'manual'                         = 'Ask before every tool call'
        'auto-accept'                    = 'Auto-approve everything except destructive actions'
        'dangerously-skip-permissions'   = 'Skip all approvals'
    }

    $setupFlags = [ordered]@{
        '--key'            = 'API key literal'
        '--key-env'        = 'Environment variable holding the key'
        '--url'            = 'Base URL'
        '--model'          = 'Model id'
        '--context-window' = 'Context window size in tokens'
        '--max-tokens'     = 'Max output tokens'
        '--alias'          = 'Model alias'
        '--default'        = 'Make this the default provider'
    }

    $browserCommands = [ordered]@{
        'status'  = 'Report whether Chromium is ready'
        'check'   = 'Alias for status'
        'install' = 'Download and install Chromium'
        'help'    = 'Show browser command help'
    }

    $logsFlags = [ordered]@{
        '--session' = 'Restrict the report to one session'
        '--json'    = 'Emit a structured manifest'
    }

    $providerVerbs = @('setup', 'set-url', 'set-model', 'set-key', 'set-key-env', 'set-default', 'add-model', 'remove-model')

    # --- Tokenise the line, excluding the word currently being typed ---
    $all = @(($commandAst.ToString().Trim()) -split '\s+' | Where-Object { $_ })
    $tokens = @()
    if ($all.Count -gt 1) { $tokens = @($all[1..($all.Count - 1)]) }
    if ($wordToComplete -and $tokens.Count -gt 0 -and $tokens[-1] -eq $wordToComplete) {
        if ($tokens.Count -eq 1) { $tokens = @() }
        else { $tokens = @($tokens[0..($tokens.Count - 2)]) }
    }

    # A value-taking flag immediately before the cursor wins over positional logic.
    if ($tokens.Count -gt 0) {
        switch ($tokens[-1]) {
            '--provider' { return @(Add-List (Get-RivetProviders) 'ParameterValue' $wordToComplete) }
            '--model'    { return @() }
            '--budget'   { return @() }
            '--goal'     { return @() }
            '--port'     { return @() }
            '--session'  { return @() }
        }
    }

    # Positional tokens only (flags filtered out), so interleaved flags do not shift positions.
    $positional = @($tokens | Where-Object { $_ -notlike '-*' })

    if ($positional.Count -eq 0) {
        return @(Add-Match $topCommands 'Command' $wordToComplete) +
               @(Add-Match $topFlags 'ParameterName' $wordToComplete)
    }

    switch ($positional[0]) {
        'config' {
            if ($positional.Count -eq 1) {
                return @(Add-Match $configCommands 'Command' $wordToComplete)
            }
            $sub = $positional[1]
            switch ($sub) {
                'mcp' {
                    if ($positional.Count -eq 2) {
                        return @(Add-Match $mcpCommands 'Command' $wordToComplete)
                    }
                    return @()
                }
                'set-approval' {
                    if ($positional.Count -eq 2) {
                        return @(Add-Match $approvalModes 'ParameterValue' $wordToComplete)
                    }
                    return @()
                }
                'setup' {
                    if ($positional.Count -eq 2) {
                        return @(Add-List (Get-RivetProviders) 'ParameterValue' $wordToComplete) +
                               @(Add-Match $setupFlags 'ParameterName' $wordToComplete)
                    }
                    return @(Add-Match $setupFlags 'ParameterName' $wordToComplete)
                }
            }
            if ($positional.Count -eq 2 -and $providerVerbs -contains $sub) {
                return @(Add-List (Get-RivetProviders) 'ParameterValue' $wordToComplete)
            }
            return @()
        }
        'serve' {
            return @(Add-Match ([ordered]@{ '--port' = 'Port to listen on' }) 'ParameterName' $wordToComplete)
        }
        'browser' {
            if ($positional.Count -eq 1) {
                return @(Add-Match $browserCommands 'Command' $wordToComplete)
            }
            if ($positional[1] -eq 'install') {
                return @(Add-Match ([ordered]@{ '--no-mirror' = 'Skip the download mirror' }) 'ParameterName' $wordToComplete)
            }
            return @()
        }
        'logs' {
            if ($positional.Count -eq 1) {
                return @(Add-Match ([ordered]@{ 'open' = 'Open the log location' }) 'Command' $wordToComplete) +
                       @(Add-Match $logsFlags 'ParameterName' $wordToComplete)
            }
            if ($positional[1] -eq 'open' -and $positional.Count -eq 2) {
                return @(Add-Match ([ordered]@{ 'desktop' = 'Open the desktop log directory' }) 'Command' $wordToComplete) +
                       @(Add-Match $logsFlags 'ParameterName' $wordToComplete)
            }
            return @(Add-Match $logsFlags 'ParameterName' $wordToComplete)
        }
        'sessions' { return @() }
    }

    return @()
}

# -Native is required for external commands on PowerShell 7+, but is not a valid
# switch on Windows PowerShell 5.1 (where native completion is implicit).
$registerParams = @{ CommandName = 'rivet'; ScriptBlock = $rivetCompleter }
if ((Get-Command Register-ArgumentCompleter).Parameters.ContainsKey('Native')) {
    $registerParams['Native'] = $true
}
Register-ArgumentCompleter @registerParams
