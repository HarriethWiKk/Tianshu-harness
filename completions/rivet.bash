# Bash completion for Rivet (rivet)
#
# Install (pick one):
#   source /path/to/rivet.bash            # from ~/.bashrc
#   cp rivet.bash ~/.local/share/bash-completion/completions/rivet
#   sudo cp rivet.bash /usr/share/bash-completion/completions/rivet

# Provider names are read from ~/.rivet/config.json when available.
_rivet_providers() {
  local config_file="${HOME}/.rivet/config.json"
  [[ -f $config_file ]] || return 0
  node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"))
      console.log(Object.keys((c.provider && c.provider.providers) || {}).join(" "))
    } catch {}
  ' "$config_file" 2>/dev/null
}

_rivet() {
  local cur prev words cword
  if declare -F _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    COMPREPLY=()
    cur=${COMP_WORDS[COMP_CWORD]}
    prev=${COMP_WORDS[COMP_CWORD-1]}
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  fi

  local commands='config serve sessions browser logs'
  local global_flags='-p --print --json --stream-json --goal --budget --model
    --provider -c --continue -r --resume --new --list
    --dangerously-skip-permissions --screen-reader --skip-welcome --stream-events'
  local config_commands='show providers setup set-url set-model set-key set-key-env
    set-default set-approval add-model remove-model mcp'
  local provider_commands=' setup set-url set-model set-key set-key-env set-default add-model remove-model '
  local approval_modes='auto-safe manual auto-accept dangerously-skip-permissions'
  local mcp_commands='list add-stdio add-sse remove enable disable'
  local setup_flags='--key --key-env --url --model --context-window --max-tokens --alias --default'

  # Value-taking flags win over positional logic.
  case $prev in
    --provider)
      COMPREPLY=($(compgen -W "$(_rivet_providers)" -- "$cur"))
      return ;;
    --stream-events)
      COMPREPLY=($(compgen -f -- "$cur"))
      return ;;
    --model|--budget|--goal|--port|--session)
      return ;;
  esac

  # Locate the first non-flag word after `rivet` — the top-level subcommand.
  local cmd='' idx=0 i
  for ((i = 1; i < cword; i++)); do
    case ${words[i]} in
      -*) ;;
      *) cmd=${words[i]}; idx=$i; break ;;
    esac
  done

  case $cmd in
    config)
      local sub=${words[idx+1]:-}
      if ((cword <= idx + 1)); then
        COMPREPLY=($(compgen -W "$config_commands" -- "$cur"))
        return
      fi
      case $sub in
        mcp)
          ((cword == idx + 2)) && COMPREPLY=($(compgen -W "$mcp_commands" -- "$cur"))
          return ;;
        set-approval)
          ((cword == idx + 2)) && COMPREPLY=($(compgen -W "$approval_modes" -- "$cur"))
          return ;;
        setup)
          # `setup` may target a provider that does not exist yet, so the flags are
          # offered alongside the known provider names at the first argument slot.
          if ((cword == idx + 2)); then
            COMPREPLY=($(compgen -W "$(_rivet_providers) $setup_flags" -- "$cur"))
          else
            COMPREPLY=($(compgen -W "$setup_flags" -- "$cur"))
          fi
          return ;;
      esac
      if [[ $provider_commands == *" $sub "* ]] && ((cword == idx + 2)); then
        COMPREPLY=($(compgen -W "$(_rivet_providers)" -- "$cur"))
      fi
      return ;;
    serve)
      COMPREPLY=($(compgen -W '--port' -- "$cur"))
      return ;;
    browser)
      if ((cword == idx + 1)); then
        COMPREPLY=($(compgen -W 'status check install help' -- "$cur"))
      elif [[ ${words[idx+1]:-} == install ]]; then
        COMPREPLY=($(compgen -W '--no-mirror' -- "$cur"))
      fi
      return ;;
    logs)
      if ((cword == idx + 1)); then
        COMPREPLY=($(compgen -W 'open --session --json' -- "$cur"))
      elif [[ ${words[idx+1]:-} == open ]] && ((cword == idx + 2)); then
        COMPREPLY=($(compgen -W 'desktop --session --json' -- "$cur"))
      else
        COMPREPLY=($(compgen -W '--session --json' -- "$cur"))
      fi
      return ;;
    sessions)
      return ;;
  esac

  COMPREPLY=($(compgen -W "$commands $global_flags" -- "$cur"))
}

complete -F _rivet rivet
