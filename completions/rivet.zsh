#compdef rivet
#
# Zsh completion for Rivet (rivet)
#
# Install: put this file somewhere on your $fpath as `_rivet`, e.g.
#   mkdir -p ~/.zsh/completions && cp rivet.zsh ~/.zsh/completions/_rivet
#   echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc

# Provider names are read from ~/.rivet/config.json when available.
_rivet_providers() {
  local config_file="$HOME/.rivet/config.json"
  [[ -f $config_file ]] || return 0
  local -a providers
  providers=(${(f)"$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"))
      console.log(Object.keys((c.provider && c.provider.providers) || {}).join("\n"))
    } catch {}
  ' "$config_file" 2>/dev/null)"})
  (( ${#providers} )) && _describe -t providers 'provider' providers
}

_rivet_config() {
  local -a config_commands mcp_commands approval_modes

  config_commands=(
    'show:Print the resolved configuration as JSON'
    'providers:List configured providers and key status'
    'setup:Configure a provider in one shot'
    'set-url:Set the base URL for a provider'
    'set-model:Set the active model for a provider'
    'set-key:Set the API key for a provider'
    'set-key-env:Read the API key from an environment variable'
    'set-default:Set the default provider'
    'set-approval:Set the tool approval mode'
    'add-model:Add a model to a provider'
    'remove-model:Remove a model from a provider'
    'mcp:Manage MCP servers'
  )

  mcp_commands=(
    'list:List configured MCP servers'
    'add-stdio:Add a stdio MCP server'
    'add-sse:Add an SSE MCP server'
    'remove:Remove an MCP server'
    'enable:Enable an MCP server'
    'disable:Disable an MCP server'
  )

  approval_modes=(
    'auto-safe:Auto-approve read-only tools, ask for the rest'
    'manual:Ask before every tool call'
    'auto-accept:Auto-approve everything except destructive actions'
    'dangerously-skip-permissions:Skip all approvals'
  )

  _arguments -C \
    '1:config command:->config_cmd' \
    '*::config arg:->config_args'

  case $state in
    config_cmd)
      _describe -t commands 'config command' config_commands
      ;;
    config_args)
      case $words[1] in
        mcp)
          if (( CURRENT == 2 )); then
            _describe -t commands 'mcp command' mcp_commands
          fi
          ;;
        set-approval)
          if (( CURRENT == 2 )); then
            _describe -t modes 'approval mode' approval_modes
          fi
          ;;
        setup)
          # `setup` may target a provider that does not exist yet, so the flags are
          # offered alongside the known provider names at the first argument slot.
          if (( CURRENT == 2 )); then
            _rivet_providers
            _arguments \
              '--key[API key literal]:key:' \
              '--key-env[Environment variable holding the key]:env var:' \
              '--url[Base URL]:url:' \
              '--model[Model id]:model:' \
              '--context-window[Context window size]:tokens:' \
              '--max-tokens[Max output tokens]:tokens:' \
              '--alias[Model alias]:alias:' \
              '--default[Make this the default provider]'
          else
            _arguments \
              '--key[API key literal]:key:' \
              '--key-env[Environment variable holding the key]:env var:' \
              '--url[Base URL]:url:' \
              '--model[Model id]:model:' \
              '--context-window[Context window size]:tokens:' \
              '--max-tokens[Max output tokens]:tokens:' \
              '--alias[Model alias]:alias:' \
              '--default[Make this the default provider]'
          fi
          ;;
        set-url|set-model|set-key|set-key-env|set-default|add-model|remove-model)
          if (( CURRENT == 2 )); then
            _rivet_providers
          fi
          ;;
      esac
      ;;
  esac
}

_rivet() {
  local -a commands
  commands=(
    'config:Manage providers, API keys and models'
    'serve:Start the sidecar HTTP/SSE runtime server'
    'sessions:Print the session list and exit'
    'browser:Check or install the Chromium used by browser tools'
    'logs:Show where sessions, caches and logs are written'
  )

  _arguments -C \
    '(-p --print)'{-p,--print}'[Run a single prompt headlessly and print the result]:prompt:' \
    '--json[Emit a single JSON result object]' \
    '--stream-json[Emit the run as an NDJSON event stream]' \
    '--goal[Run headless autonomous goal mode]:goal:' \
    '--budget[Turn budget for goal mode (default 100)]:turns:' \
    '--model[Override the model for this session]:model:' \
    '--provider[Override the provider for this session]:provider:_rivet_providers' \
    '(-c --continue)'{-c,--continue}'[Resume the most recent session for this directory]' \
    '(-r --resume)'{-r,--resume}'[Resume a session by id or prefix]:session id:' \
    '--new[Force a brand-new session]' \
    '--list[Print the session list and exit]' \
    '--dangerously-skip-permissions[Skip all tool approvals]' \
    '--screen-reader[Screen-reader friendly output]' \
    '--skip-welcome[Skip the welcome screen]' \
    '--stream-events[Mirror the run as an NDJSON SessionEvent file]:path:_files' \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'command' commands
      ;;
    args)
      case $words[1] in
        config)
          _rivet_config
          ;;
        serve)
          _arguments '--port[Port to listen on]:port:'
          ;;
        browser)
          if (( CURRENT == 2 )); then
            local -a browser_commands
            browser_commands=(
              'status:Report whether Chromium is ready'
              'check:Alias for status'
              'install:Download and install Chromium'
              'help:Show browser command help'
            )
            _describe -t commands 'browser command' browser_commands
          elif [[ $words[2] == install ]]; then
            _arguments '--no-mirror[Skip the download mirror]'
          fi
          ;;
        logs)
          if (( CURRENT == 2 )); then
            local -a logs_commands
            logs_commands=('open:Open the log location')
            _describe -t commands 'logs command' logs_commands
            _arguments '--session[Restrict to one session]:session id:' '--json[Emit a structured manifest]'
          elif [[ $words[2] == open ]] && (( CURRENT == 3 )); then
            local -a open_targets
            open_targets=('desktop:Open the desktop log directory')
            _describe -t targets 'target' open_targets
          else
            _arguments '--session[Restrict to one session]:session id:' '--json[Emit a structured manifest]'
          fi
          ;;
      esac
      ;;
  esac
}

_rivet "$@"
