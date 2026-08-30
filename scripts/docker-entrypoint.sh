#!/bin/sh
set -e

echo "Waiting for Ollama..."
until curl -sf http://ollama:11434/api/tags >/dev/null; do
  sleep 2
done

echo "Pulling qwen3:1.7b model..."
curl -sf -X POST http://ollama:11434/api/pull -d '{"name":"qwen3:1.7b"}' >/dev/null

echo "Waiting for TrueForge..."
until curl -sf http://trueforge:8791/ >/dev/null; do
  sleep 2
done

echo "Registering MCP connector..."
curl -sf -X POST "http://trueforge:8791/api/v1/settings/mcp/servers" \
  -H "Content-Type: application/json" \
  -d '{"name":"aegis-incident-lab","url":"http://aegis:7878/mcp","transport":"streamable-http"}' >/dev/null

echo "Starting Aegis..."
exec node dist/server/index.js