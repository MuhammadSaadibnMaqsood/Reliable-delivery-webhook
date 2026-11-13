import { prisma } from '../src/db/prisma.js';

/**
 * Failure-proof suite cleanup: every step runs even when earlier steps (or
 * the tests themselves) failed — vitest executes afterAll on failing suites,
 * and this helper additionally isolates each step so one broken deletion
 * cannot strand the rows behind it. FK order is the caller's step order.
 * Always disconnects Prisma; failures are reported, never thrown (a cleanup
 * error must not mask the real test failure).
 */
export async function runCleanup(
  suite: string,
  steps: Array<[name: string, step: () => Promise<unknown>]>,
): Promise<void> {
  const failures: string[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      const message = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
      failures.push(`${name}: ${message}`);
    }
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* already disconnected */
  }
  if (failures.length > 0) {
    // eslint-disable-next-line no-console -- surfacing stranded-fixture info in test output
    console.warn(`[cleanup:${suite}] ${failures.length} step(s) failed:\n  ${failures.join('\n  ')}`);
  }
}
