#!/bin/sh
set -e

echo "Waiting for Ollama on host..."
until curl -sf http://host.docker.internal:11434/api/tags >/dev/null; do
  sleep 2
done

echo "Waiting for TrueForge..."
until curl -sf http://trueforge:8791/ >/dev/null; do
  sleep 2
done

echo "Registering MCP connector..."
TRUEFORGE_BASE_URL=http://trueforge:8791 \
TRUEFORGE_MCP_URL=http://aegis:7878/mcp \
npx tsx scripts/setup-trueforge.ts

echo "Starting Aegis..."
exec node dist/server/index.js