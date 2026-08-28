import type { LabSnapshot, RunSnapshot } from '../shared/types';

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'Request failed.';
    throw new Error(message);
  }
  return payload as T;
}

export function getDemo(): Promise<LabSnapshot> {
  return request<LabSnapshot>('/api/demo');
}

export function startRun(message: string): Promise<RunSnapshot> {
  return request<RunSnapshot>('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export function decideApproval(runId: string, decision: 'allow' | 'deny'): Promise<RunSnapshot> {
  return request<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}/approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
}

export function subscribeToRun(runId: string, onSnapshot: (snapshot: RunSnapshot) => void, onError: () => void): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  source.addEventListener('snapshot', (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent<string>).data) as RunSnapshot);
    } catch {
      onError();
    }
  });
  source.onerror = onError;
  return () => source.close();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
