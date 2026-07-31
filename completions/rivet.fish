# Fish completion for Rivet (rivet)
#
# Install: copy this file to ~/.config/fish/completions/rivet.fish
#   mkdir -p ~/.config/fish/completions
#   cp rivet.fish ~/.config/fish/completions/

# Provider names are read from ~/.rivet/config.json when available.
function __rivet_providers
    node -e '
      const os = require("os")
      const path = require("path")
      try {
        const f = path.join(os.homedir(), ".rivet", "config.json")
        const c = JSON.parse(require("fs").readFileSync(f, "utf-8"))
        console.log(Object.keys((c.provider && c.provider.providers) || {}).join("\n"))
      } catch {}
    ' 2>/dev/null
end

function __rivet_no_subcommand
    not __fish_seen_subcommand_from config serve sessions browser logs
end

function __rivet_config_no_subcommand
    __fish_seen_subcommand_from config
    and not __fish_seen_subcommand_from show providers setup set-url set-model \
        set-key set-key-env set-default set-approval add-model remove-model mcp
end

# --- Top-level commands ---
complete -c rivet -n __rivet_no_subcommand -a config -d 'Manage providers, API keys and models'
complete -c rivet -n __rivet_no_subcommand -a serve -d 'Start the sidecar HTTP/SSE runtime server'
complete -c rivet -n __rivet_no_subcommand -a sessions -d 'Print the session list and exit'
complete -c rivet -n __rivet_no_subcommand -a browser -d 'Check or install the Chromium used by browser tools'
complete -c rivet -n __rivet_no_subcommand -a logs -d 'Show where sessions, caches and logs are written'

# --- Top-level flags ---
complete -c rivet -n __rivet_no_subcommand -s p -l print -r -d 'Run a single prompt headlessly and print the result'
complete -c rivet -n __rivet_no_subcommand -l json -d 'Emit a single JSON result object'
complete -c rivet -n __rivet_no_subcommand -l stream-json -d 'Emit the run as an NDJSON event stream'
complete -c rivet -n __rivet_no_subcommand -l goal -r -d 'Run headless autonomous goal mode'
complete -c rivet -n __rivet_no_subcommand -l budget -r -d 'Turn budget for goal mode (default 100)'
complete -c rivet -n __rivet_no_subcommand -l model -r -d 'Override the model for this session'
complete -c rivet -n __rivet_no_subcommand -l provider -r -a '(__rivet_providers)' -d 'Override the provider for this session'
complete -c rivet -n __rivet_no_subcommand -s c -l continue -d 'Resume the most recent session for this directory'
complete -c rivet -n __rivet_no_subcommand -s r -l resume -d 'Resume a session by id or prefix'
complete -c rivet -n __rivet_no_subcommand -l new -d 'Force a brand-new session'
complete -c rivet -n __rivet_no_subcommand -l list -d 'Print the session list and exit'
complete -c rivet -n __rivet_no_subcommand -l dangerously-skip-permissions -d 'Skip all tool approvals'
complete -c rivet -n __rivet_no_subcommand -l screen-reader -d 'Screen-reader friendly output'
complete -c rivet -n __rivet_no_subcommand -l skip-welcome -d 'Skip the welcome screen'
complete -c rivet -n __rivet_no_subcommand -l stream-events -r -F -d 'Mirror the run as an NDJSON SessionEvent file'

# --- config subcommands ---
complete -c rivet -n __rivet_config_no_subcommand -a show -d 'Print the resolved configuration as JSON'
complete -c rivet -n __rivet_config_no_subcommand -a providers -d 'List configured providers and key status'
complete -c rivet -n __rivet_config_no_subcommand -a setup -d 'Configure a provider in one shot'
complete -c rivet -n __rivet_config_no_subcommand -a set-url -d 'Set the base URL for a provider'
complete -c rivet -n __rivet_config_no_subcommand -a set-model -d 'Set the active model for a provider'
complete -c rivet -n __rivet_config_no_subcommand -a set-key -d 'Set the API key for a provider'
complete -c rivet -n __rivet_config_no_subcommand -a set-key-env -d 'Read the API key from an environment variable'
complete -c rivet -n __rivet_config_no_subcommand -a set-default -d 'Set the default provider'
complete -c rivet -n __rivet_config_no_subcommand -a set-approval -d 'Set the tool approval mode'
complete -c rivet -n __rivet_config_no_subcommand -a add-model -d 'Add a model to a provider'
complete -c rivet -n __rivet_config_no_subcommand -a remove-model -d 'Remove a model from a provider'
complete -c rivet -n __rivet_config_no_subcommand -a mcp -d 'Manage MCP servers'

# --- Provider names for the config subcommands that take one ---
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup set-url set-model set-key set-key-env set-default add-model remove-model' \
    -a '(__rivet_providers)' -d Provider

# --- config setup flags ---
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l key -r -d 'API key literal'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l key-env -r -d 'Environment variable holding the key'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l url -r -d 'Base URL'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l model -r -d 'Model id'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l context-window -r -d 'Context window size in tokens'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l max-tokens -r -d 'Max output tokens'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l alias -r -d 'Model alias'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from setup' -l default -d 'Make this the default provider'

# --- config set-approval modes ---
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from set-approval' -a auto-safe -d 'Auto-approve read-only tools, ask for the rest'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from set-approval' -a manual -d 'Ask before every tool call'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from set-approval' -a auto-accept -d 'Auto-approve everything except destructive actions'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from set-approval' -a dangerously-skip-permissions -d 'Skip all approvals'

# --- config mcp subcommands ---
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mcp; and not __fish_seen_subcommand_from list add-stdio add-sse remove enable disable' -a list -d 'List configured MCP servers'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mcp; and not __fish_seen_subcommand_from list add-stdio add-sse remove enable disable' -a add-stdio -d 'Add a stdio MCP server'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mcp; and not __fish_seen_subcommand_from list add-stdio add-sse remove enable disable' -a add-sse -d 'Add an SSE MCP server'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mcp; and not __fish_seen_subcommand_from list add-stdio add-sse remove enable disable' -a remove -d 'Remove an MCP server'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mcp; and not __fish_seen_subcommand_from list add-stdio add-sse remove enable disable' -a enable -d 'Enable an MCP server'
complete -c rivet -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from mcp; and not __fish_seen_subcommand_from list add-stdio add-sse remove enable disable' -a disable -d 'Disable an MCP server'

# --- serve ---
complete -c rivet -n '__fish_seen_subcommand_from serve' -l port -r -d 'Port to listen on'

# --- browser ---
complete -c rivet -n '__fish_seen_subcommand_from browser; and not __fish_seen_subcommand_from status check install help' -a status -d 'Report whether Chromium is ready'
complete -c rivet -n '__fish_seen_subcommand_from browser; and not __fish_seen_subcommand_from status check install help' -a check -d 'Alias for status'
complete -c rivet -n '__fish_seen_subcommand_from browser; and not __fish_seen_subcommand_from status check install help' -a install -d 'Download and install Chromium'
complete -c rivet -n '__fish_seen_subcommand_from browser; and not __fish_seen_subcommand_from status check install help' -a help -d 'Show browser command help'
complete -c rivet -n '__fish_seen_subcommand_from browser; and __fish_seen_subcommand_from install' -l no-mirror -d 'Skip the download mirror'

# --- logs ---
complete -c rivet -n '__fish_seen_subcommand_from logs; and not __fish_seen_subcommand_from open' -a open -d 'Open the log location'
complete -c rivet -n '__fish_seen_subcommand_from logs; and __fish_seen_subcommand_from open' -a desktop -d 'Open the desktop log directory'
complete -c rivet -n '__fish_seen_subcommand_from logs' -l session -r -d 'Restrict the report to one session'
complete -c rivet -n '__fish_seen_subcommand_from logs' -l json -d 'Emit a structured manifest'
