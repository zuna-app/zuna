# Sourced by the scripts in dev/. Tools installed per user may not be on PATH
# when a script is started from a file manager or an IDE rather than a terminal.

cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin"
case ":$PATH:" in
  *":$cargo_bin:"*) ;;
  *) PATH="$cargo_bin:$PATH" ;;
esac
# Where Go's own installer puts it. Last, so a Go from the package manager wins.
case ":$PATH:" in
  *":/usr/local/go/bin:"*) ;;
  *) PATH="$PATH:/usr/local/go/bin" ;;
esac
export PATH

# Node from nvm or fnm is set up by the shell's startup files, which only run
# in a terminal.
if ! command -v node >/dev/null 2>&1; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  elif command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
  fi
fi
