#!/usr/bin/env ts-node
import { execSync, spawn, ChildProcess } from 'child_process';

const PORT = process.env.PORT || 3000;
const HEALTH_URL = `http://localhost:${PORT}/health`;

// Polling config for CI stability
const POLL_INTERVAL_MS = 500;
const MAX_RETRIES = 20; // 10 seconds total

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHealth(): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(HEALTH_URL);
      const data = await response.json();

      if (response.ok && data.status === 'ok') {
        return { ok: true, data };
      }

      // Server responded but unhealthy - keep trying
      console.log(
        `   Attempt ${attempt}/${MAX_RETRIES}: Server not ready yet...`
      );
    } catch {
      // Server not reachable yet - keep trying
      console.log(`   Attempt ${attempt}/${MAX_RETRIES}: Waiting for server...`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { ok: false, error: `Health check failed after ${MAX_RETRIES} attempts` };
}

async function validate(): Promise<void> {
  console.log('Starting validation...\n');

  // Step 1: TypeScript check
  console.log('1. Type-checking TypeScript...');
  try {
    execSync('npx tsc --noEmit', { stdio: 'inherit' });
    console.log('   TypeScript OK\n');
  } catch {
    console.error('   TypeScript errors found');
    process.exit(1);
  }

  // Step 2: Prisma generate
  console.log('2. Verifying Prisma client...');
  try {
    execSync('npx prisma generate', { stdio: 'inherit' });
    console.log('   Prisma client OK\n');
  } catch {
    console.error('   Prisma generation failed');
    process.exit(1);
  }

  // Step 3: Boot server
  console.log('3. Booting server...');
  const server: ChildProcess = spawn('npx', ['ts-node', 'src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Step 4: Poll health endpoint with retries
  console.log('4. Checking /health endpoint...');
  const result = await pollHealth();

  if (result.ok) {
    console.log('   Health check passed');
    console.log(`   Response: ${JSON.stringify(result.data)}\n`);
  } else {
    console.error(`   ${result.error}`);
    server.kill();
    process.exit(1);
  }

  // Cleanup
  server.kill();
  console.log('All validations passed!\n');
  process.exit(0);
}

validate().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
