const baseUrl = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

type DependencyHealth = {
  status?: string;
  required?: boolean;
  detail?: string;
};

type HealthPayload = {
  ok?: boolean;
  service?: string;
  dependencies?: Record<string, DependencyHealth>;
};

const readJson = async (path: string) => {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();

  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 280)}`);
  }

  return { response, body };
};

const assertHealthPayload = (payload: HealthPayload) => {
  if (!payload.ok) {
    throw new Error('Health payload reported ok=false');
  }

  for (const [name, dependency] of Object.entries(payload.dependencies ?? {})) {
    if (dependency.required === false) continue;
    if (dependency.status !== 'ok') {
      throw new Error(`${name} is ${dependency.status ?? 'unknown'}${dependency.detail ? ` (${dependency.detail})` : ''}`);
    }
  }
};

const main = async (): Promise<void> => {
  const { response: healthResponse, body: healthBody } = await readJson('/healthz');
  if (!healthResponse.ok) {
    throw new Error(`/healthz returned ${healthResponse.status}`);
  }
  assertHealthPayload(healthBody as HealthPayload);

  const { response: latencyResponse, body: latencyBody } = await readJson('/health/latency');
  if (!latencyResponse.ok) {
    throw new Error(`/health/latency returned ${latencyResponse.status}`);
  }
  if (!(latencyBody as { ok?: boolean }).ok) {
    throw new Error('/health/latency reported ok=false');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        checked: ['/healthz', '/health/latency'],
        dependencies: (healthBody as HealthPayload).dependencies ?? {}
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(`[smoke-health] ${(error as Error).message}`);
  process.exit(1);
});
