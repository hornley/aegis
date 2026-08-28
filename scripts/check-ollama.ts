import 'dotenv/config';

const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const model = process.env.OLLAMA_MODEL ?? 'qwen2.5:1.5b';

const response = await fetch(`${baseUrl}/api/tags`);
if (!response.ok) {
  throw new Error(`Ollama is not reachable at ${baseUrl} (HTTP ${response.status}).`);
}

const payload = (await response.json()) as { models?: Array<{ name?: string }> };
const installed = payload.models?.some((entry) => entry.name === model);
if (!installed) {
  const available = payload.models?.map((entry) => entry.name).filter(Boolean).join(', ') || 'none';
  throw new Error(`Model ${model} is not installed. Available models: ${available}.`);
}

console.log(`Ollama is ready at ${baseUrl} with ${model}.`);
