#!/usr/bin/env ts-node

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function main() {
  console.log('Testing POST /memory...\n');

  const response = await fetch(`${BASE_URL}/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Test memory entry',
      occurredAt: new Date().toISOString(),
    }),
  });

  const data = await response.json();
  console.log('Status:', response.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (response.ok && data.eventId) {
    console.log('\n✓ Endpoint working!');
  } else {
    console.log('\n✗ Endpoint failed');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
