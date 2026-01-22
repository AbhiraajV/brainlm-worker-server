/**
 * Test Runner
 *
 * Run all tests or specific test suites.
 *
 * Usage:
 *   npx ts-node src/tests/run-tests.ts           # Run all tests
 *   npx ts-node src/tests/run-tests.ts queue     # Run queue tests only
 *   npx ts-node src/tests/run-tests.ts e2e       # Run E2E tests only
 */

import { execSync } from 'child_process';
import path from 'path';

const TESTS_DIR = __dirname;

const TEST_SUITES: Record<string, string> = {
  queue: 'integration/queue.test.ts',
  chain: 'integration/worker-chain.test.ts',
  scheduler: 'integration/scheduler.test.ts',
  e2e: 'e2e/full-flow.test.ts', // Note: E2E makes real API calls, use sparingly
};

function runTest(testFile: string): boolean {
  const fullPath = path.join(TESTS_DIR, testFile);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${testFile}`);
  console.log('='.repeat(60) + '\n');

  try {
    execSync(`npx ts-node ${fullPath}`, {
      stdio: 'inherit',
      cwd: path.join(TESTS_DIR, '../..'),
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let testsToRun: string[] = [];

  if (args.length === 0) {
    // Run all tests EXCEPT e2e (which makes real API calls)
    testsToRun = Object.entries(TEST_SUITES)
      .filter(([key]) => key !== 'e2e')
      .map(([, value]) => value);
    console.log('Note: Skipping E2E tests (use "npm run test:e2e" to run them)');
  } else if (args[0] === 'all') {
    // Run ALL tests including e2e
    testsToRun = Object.values(TEST_SUITES);
  } else {
    // Run specific tests
    for (const arg of args) {
      if (TEST_SUITES[arg]) {
        testsToRun.push(TEST_SUITES[arg]);
      } else {
        console.error(`Unknown test suite: ${arg}`);
        console.log('Available suites:', Object.keys(TEST_SUITES).join(', '));
        process.exit(1);
      }
    }
  }

  console.log('🧪 BrainLM Test Runner');
  console.log(`Running ${testsToRun.length} test suite(s)...`);

  let passed = 0;
  let failed = 0;

  for (const test of testsToRun) {
    if (runTest(test)) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`📊 Final Results: ${passed} suites passed, ${failed} suites failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main();
