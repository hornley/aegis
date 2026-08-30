#!/bin/sh
set -e

wait_for() {
  local url="$1"
  local label="$2"
  echo "Waiting for $label..."
  until node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
    sleep 2
  done
  echo "$label is up."
}

wait_for "http://localhost:11434/api/tags" "Ollama"
wait_for "http://localhost:8791/" "TrueForge"

echo "Registering MCP connector..."
TRUEFORGE_BASE_URL=http://localhost:8791 \
TRUEFORGE_MCP_URL=http://localhost:7878/mcp \
npx tsx scripts/setup-trueforge.ts

echo "NOTE: The TrueForge SDK does not expose model-provider or sandbox-provider creation."
echo "If TrueForge settings are empty, configure once in the TrueForge UI (Settings -> Models):"
echo "  - Custom OpenAI-compatible provider named 'ollama', base URL http://localhost:11434/v1, model qwen3:1.7b"
echo "  - The Daytona sandbox provider with snapshot creation permission"

echo "Starting Aegis..."
exec node dist/server/index.js
