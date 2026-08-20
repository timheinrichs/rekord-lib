#!/usr/bin/env bash
# Runs the app against a generated library, in its own app data directory.
#
# Why this exists: driving the real app is the only way to catch a broken wiring
# between a command and a view, but the app writes tempo tags, rewrites metadata
# and moves files to the trash. Doing that against a real collection has gone
# wrong before. So this points it at scripts/dev-library.py's output and gives it
# a separate identifier, which means a separate database, separate settings and a
# separate undo history — the installed app can keep running alongside.
#
# The identifier comes from a `--config` overlay rather than an edit to
# tauri.conf.json. That file is tracked, and "remember to change it back before
# committing" is exactly the kind of instruction that gets forgotten once.
#
#   scripts/dev-app.sh              # generate if needed, then run
#   scripts/dev-app.sh --fresh      # regenerate the library and wipe the
#                                   # devtest database first
#   scripts/dev-app.sh --reset      # only wipe the devtest data, then run
set -euo pipefail

cd "$(dirname "$0")/.."
LIBRARY="$PWD/.dev/library"
IDENTIFIER="$(python3 -c 'import json,sys; print(json.load(open("src-tauri/tauri.devtest.conf.json"))["identifier"])')"
DATA_DIR="$HOME/Library/Application Support/$IDENTIFIER"

fresh=false
reset=false
for arg in "$@"; do
  case "$arg" in
    --fresh) fresh=true; reset=true ;;
    --reset) reset=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# A guard, not a nicety: pointing this at a real collection would defeat the
# entire point of the script.
case "$LIBRARY" in
  "$PWD/.dev/"*) ;;
  *) echo "refusing to run against $LIBRARY" >&2; exit 1 ;;
esac

if $fresh; then
  python3 scripts/dev-library.py "$LIBRARY" --force
else
  python3 scripts/dev-library.py "$LIBRARY"
fi

if $reset; then
  rm -rf "$DATA_DIR"
  echo "wiped $DATA_DIR"
fi

# Seed the settings so the first launch already has a library folder; without it
# the app opens on the empty state and the folder has to be picked by hand every
# time the data directory is reset.
mkdir -p "$DATA_DIR"
STORE="$DATA_DIR/rekord-lib.json"
LIBRARY="$LIBRARY" python3 - "$STORE" <<'PY'
import json, os, sys

path = sys.argv[1]
store = {}
if os.path.exists(path):
    with open(path) as fh:
        store = json.load(fh)
# Only the folder is forced. Everything else the developer changed in the
# devtest instance — the tempo range, the target format — is left alone.
settings = store.get("settings") or {}
settings["library_dir"] = os.environ["LIBRARY"]
settings.setdefault("analyze_bpm", True)
store["settings"] = settings
with open(path, "w") as fh:
    json.dump(store, fh, indent=2)
print(f"library folder set to {settings['library_dir']}")
PY

echo "app data: $DATA_DIR"
exec npm run tauri dev -- --config src-tauri/tauri.devtest.conf.json
