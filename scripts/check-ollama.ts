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

const probe = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Call get_incident with incident_id=INC-1042.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_incident',
        description: 'Read an incident by ID.',
        parameters: {
          type: 'object',
          properties: { incident_id: { type: 'string' } },
          required: ['incident_id'],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: 'required',
    stream: false,
  }),
});
if (!probe.ok) throw new Error(`Ollama model probe failed (HTTP ${probe.status}).`);

const probePayload = (await probe.json()) as {
  choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
};
const toolCall = probePayload.choices?.[0]?.message?.tool_calls?.[0]?.function;
if (toolCall?.name !== 'get_incident' || toolCall.arguments !== '{"incident_id":"INC-1042"}') {
  throw new Error('Ollama model did not return the expected structured tool call.');
}

console.log(`Ollama is ready at ${baseUrl} with ${model}; structured tool calls passed.`);
