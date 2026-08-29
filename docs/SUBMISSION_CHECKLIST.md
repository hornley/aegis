# Submission Checklist

## Repository

- [x] Source, fixtures, tests, and setup documentation are committed.
- [x] `.env` and provider credentials are ignored.
- [x] `main` is pushed to `https://github.com/hornley/aegis`.
- [x] OSS submission branch is `submission/oss-local-model`.

## Local Verification

- [x] Ollama has a credential-free availability check.
- [x] The configured Ollama model passes a structured tool-call probe.
- [x] `npm run typecheck` passes.
- [x] `npm run lint` passes.
- [x] `npm test` passes: 15 tests.
- [x] `npm run build` passes.
- [x] GitHub Actions CI passes on `main`.
- [x] Rollback approval is bound to the active failed deployment.
- [ ] OSS live run completes Code Mode, approval, rollback, and verification.

## Known External Blocker

The current Daytona sandbox image does not provide `/usr/bin/bash`. The OSS model reaches the sandbox but its generated diagnostic currently fails there, so Aegis correctly leaves the incident unresolved. This is not represented as a successful recovery.

## Fix Available in Repo

- `Dockerfile.trueforge-fixed` — extends TrueForge's sandbox image with `bash` and `python3`
- `.github/workflows/build-trueforge-sandbox.yml` — builds and pushes to GHCR
- Run the workflow once to publish: `ghcr.io/hornley/aegis/trueforge-sandbox-fixed:latest`
- Configure TrueForge to use this image:
  - Self-hosted: set `TRUEFORGE_SANDBOX_IMAGE=ghcr.io/hornley/aegis/trueforge-sandbox-fixed:latest`
  - Restart TrueForge
- After update, rerun `npm run check:ollama` — diagnostic should pass

## Review Evidence

- [x] Pull request URL recorded: https://github.com/hornley/aegis/pull/1
- [ ] Qodo review result recorded.
- [ ] Valid Qodo findings addressed or intentionally dismissed.
