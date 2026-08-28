# Aegis Incident Lab

These fixtures belong to the Aegis demo environment. They describe one coherent checkout incident:

- `incidents/checkout-1042.json` identifies the open SEV-1 incident.
- `metrics/checkout.json` contains degraded and recovered telemetry.
- `logs/checkout.json` contains the timeout and connection-pool evidence before rollback plus healthy records after rollback.
- `deployments/checkout.json` contains the regressing deployment `8f31a2` and known-good deployment `7d20c1`.

`IncidentLab` validates the fixtures at startup. Its in-memory state starts degraded, changes only after the approval-gated MCP rollback runs, and resets between demo runs.
