/**
 * End-to-end smoke test against a running API (deployed or `sam local start-api`).
 * Usage: npm run smoke -- https://abc123.execute-api.us-east-1.amazonaws.com
 */
const baseUrl = (process.argv[2] ?? process.env.API_URL ?? 'http://127.0.0.1:3000').replace(
  /\/$/,
  '',
);
const customerId = `smoke-${Date.now()}`;

async function call(method: string, path: string, body?: unknown) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Math.round(performance.now() - started);
  const json = (await response.json()) as Record<string, unknown>;
  console.log(`${method.padEnd(5)} ${path} -> ${response.status} (${ms} ms)`);
  return { status: response.status, json };
}

function expectStatus(actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${actual}`);
  }
}

async function main() {
  console.log(`Smoke testing ${baseUrl} as customer ${customerId}\n`);

  const created = await call('POST', `/customers/${customerId}/orders`, {
    currency: 'USD',
    items: [
      { sku: 'KB-01', name: 'Mechanical keyboard', quantity: 1, unitPrice: 8999 },
      { sku: 'MS-02', name: 'Wireless mouse', quantity: 2, unitPrice: 2499 },
    ],
  });
  expectStatus(created.status, 201);
  const orderPath = `/customers/${customerId}/orders/${created.json.orderId as string}`;

  // First read is a cache miss (DynamoDB), second one is a cache hit (Valkey).
  expectStatus((await call('GET', orderPath)).status, 200);
  expectStatus((await call('GET', orderPath)).status, 200);

  expectStatus((await call('PATCH', orderPath, { status: 'PAID' })).status, 200);
  const afterUpdate = await call('GET', orderPath);
  expectStatus(afterUpdate.status, 200);
  if (afterUpdate.json.status !== 'PAID') throw new Error('Cache was not invalidated after update');

  expectStatus((await call('PATCH', orderPath, { status: 'PENDING' })).status, 409);
  expectStatus((await call('GET', `/customers/${customerId}/orders?limit=10`)).status, 200);

  console.log('\nSmoke test passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
