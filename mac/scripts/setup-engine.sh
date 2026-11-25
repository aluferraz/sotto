#!/bin/sh
# Installs the Python side of Sotto: an isolated environment with MLX, and the model weights.
# The app looks for it at ~/Library/Application Support/Sotto/venv, so the .app can live anywhere.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
venv="$HOME/Library/Application Support/Sotto/venv"
model=${1:-LiquidAI/LFM3-Audio-2B-MLX-8bit}

mkdir -p "$(dirname "$venv")"
if command -v uv >/dev/null 2>&1; then
    [ -x "$venv/bin/python" ] || uv venv --python 3.12 "$venv"
    uv pip install --python "$venv/bin/python" -r "$here/engine/requirements.txt"
else
    [ -x "$venv/bin/python" ] || python3 -m venv "$venv"
    "$venv/bin/python" -m pip install --upgrade pip
    "$venv/bin/python" -m pip install -r "$here/engine/requirements.txt"
fi

echo "Fetching $model (skipped if already cached)…"
"$venv/bin/python" - "$model" <<'PY'
import sys
from huggingface_hub import snapshot_download
print(snapshot_download(sys.argv[1]))
PY
echo "Engine ready at $venv"
