# OSS Local Model Readiness

## Goal

Make the Aegis demo submission-ready using an open-source model served locally by Ollama, without hiding model or provider failures behind scripted results.

## Constraints

- The local machine has an NVIDIA GTX 1050 with 2 GiB VRAM and approximately 3.3 GiB available system memory.
- The model must be open-source and tool-capable.
- Aegis must remain fail-closed: rollback requires operator approval, and a failed diagnostic or verification must not be presented as success.
- The repository must contain no provider credentials or private production data.

## Approach

Use `qwen3:1.7b` through Ollama's OpenAI-compatible API. It is the strongest tested local candidate that fits the available hardware, and it showed better MCP argument handling than the tested 0.5B, 0.6B, and 1.5B alternatives. Configure TrueForge's custom provider with the Ollama base URL and expose the model through the `ollama/<model>` FQN.

Do not add argument repair, synthetic sandbox events, automatic remediation, or a hosted fallback. These would obscure whether the required agent workflow actually ran. If the model cannot complete the workflow, the run remains failed and the limitation is documented.

## Repository Changes

- Update `.env.example` to show the OSS Ollama model and local endpoint expectations.
- Add a small setup/check command or equivalent documented commands that verify Ollama availability, model presence, and the TrueForge provider configuration without printing secrets.
- Update README setup, demo, model, hardware, and limitations sections with verified local-model behavior.
- Add or update tests only for repository-owned setup/configuration behavior; live Ollama and Daytona calls remain manual verification.

## Verification

1. Ollama lists `qwen2.5:1.5b` and answers a structured tool-call probe.
2. Aegis reports the configured OSS model through `/api/health`.
3. A deny run reaches the approval boundary and leaves the incident open.
4. An allow run records the real sandbox diagnostic, approval, MCP rollback, fresh metrics verification, and `RESOLVED` state.
5. `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass.

## Acceptance Criteria

The project is locally submission-ready only if all verification steps pass with the OSS model. If the model fits but fails the complete workflow, the code remains fail-closed and the README explicitly states that the local model is experimental rather than claiming readiness.
