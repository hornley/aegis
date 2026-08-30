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

wait_for "http://host.docker.internal:11434/api/tags" "Ollama"
wait_for "http://trueforge:8791/" "TrueForge"

echo "Registering MCP connector..."
TRUEFORGE_BASE_URL=http://trueforge:8791 \
TRUEFORGE_MCP_URL=http://aegis:7878/mcp \
npx tsx scripts/setup-trueforge.ts

echo "Configuring TrueForge model provider..."
node -e "
  fetch('http://trueforge:8791/api/v1/settings/models', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ollama',
      type: 'openai-compatible',
      baseUrl: 'http://host.docker.internal:11434/v1',
      apiKey: 'ollama',
      models: [{ id: 'qwen3:1.7b', name: 'qwen3:1.7b' }]
    })
  }).then(r => {
    if (r.ok) console.log('Model provider configured.');
    else r.text().then(t => { console.error('Failed:', t); process.exit(1); });
  }).catch(e => { console.error(e); process.exit(1); });
"

echo "Configuring TrueForge sandbox provider..."
node -e "
  fetch('http://trueforge:8791/api/v1/settings/sandbox', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'daytona',
      image: 'ghcr.io/hornley/aegis/trueforge-sandbox-fixed:latest'
    })
  }).then(r => {
    if (r.ok) console.log('Sandbox provider configured.');
    else r.text().then(t => { console.error('Failed:', t); process.exit(1); });
  }).catch(e => { console.error(e); process.exit(1); });
"

echo "Starting Aegis..."
exec node dist/server/index.js
