# Fish completion for Rivet (rivet)
#
# Install: copy this file to ~/.config/fish/completions/rivet.fish
#   (mkdir -p ~/.config/fish/completions && cp rivet.fish ~/.config/fish/completions/)

# Provider names are read from ~/.rivet/config.json when available.
function __rivet_providers
    node -e "const os=require('os');try{const c=JSON.parse(require('fs').readFileSync(os.homedir()+'/.rivet/config.json','utf-8'));console.log(Object.keys(c.provider?.providers||{}).join('\n'));}catch{}"
end

# --- Top-level commands ---
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -a "config" -d "Manage API keys and model configuration"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -a "serve" -d "Start the sidecar HTTP/SSE server"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -a "sessions" -d "List recent sessions"

# --- Top-level flags (from the user guide) ---
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l help -s h -d "Show help"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l version -s v -d "Show version"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l print -s p -d "Single prompt, print and exit"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l json -d "Output a single JSON result (with -p)"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l stream-json -d "NDJSON event stream, output de-identified (CI)"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l goal -d "Headless autonomous goal mode"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l budget -d "Goal turn budget (default 100)"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l model -d "Override the model for this session"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l provider -d "Override the provider for this session"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l continue -s c -d "Resume the most recent session in cwd"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l resume -s r -d "Resume a session by id/prefix"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l new -d "Force a new session"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l list -d "List sessions and exit"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l dangerously-skip-permissions -d "Skip all approvals (YOLO)"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l screen-reader -d "Screen-reader mode"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l skip-welcome -d "Skip the welcome screen"
complete -c rivet -n "not __fish_seen_subcommand_from config serve sessions" -l stream-events -d "Mirror this run as a NDJSON SessionEvent file"

# --- config subcommands ---
complete -c rivet -n "__fish_seen_subcommand_from config" -a "show" -d "Show current configuration"
complete -c rivet -n "__fish_seen_subcommand_from config" -a "providers" -d "List configured providers"
complete -c rivet -n "__fish_seen_subcommand_from config" -a "set-key" -d "Set API key for a provider"
complete -c rivet -n "__fish_seen_subcommand_from config" -a "set-key-env" -d "Set API key from an environment variable"
complete -c rivet -n "__fish_seen_subcommand_from config" -a "set-default" -d "Set the default provider"
complete -c rivet -n "__fish_seen_subcommand_from config" -a "add-model" -d "Add a model to a provider"
complete -c rivet -n "__fish_seen_subcommand_from config" -a "remove-model" -d "Remove a model from a provider"

# --- Provider name completion (read from ~/.rivet/config.json) ---
complete -c rivet -n "__fish_seen_subcommand_from config set-key" -a "(__rivet_providers)" -d "Provider"
complete -c rivet -n "__fish_seen_subcommand_from config set-key-env" -a "(__rivet_providers)" -d "Provider"
complete -c rivet -n "__fish_seen_subcommand_from config set-default" -a "(__rivet_providers)" -d "Provider"
complete -c rivet -n "__fish_seen_subcommand_from config add-model" -a "(__rivet_providers)" -d "Provider"
complete -c rivet -n "__fish_seen_subcommand_from config remove-model" -a "(__rivet_providers)" -d "Provider"
