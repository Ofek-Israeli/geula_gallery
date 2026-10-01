/**
 * Placeholder for npm scripts whose implementation lands in a later milestone (spec §10.7: every
 * script exists from M1). Prints a notice and exits 0 so `verify` chains keep working.
 */
export function notImplemented(script: string, landsIn: string): never {
  console.log(
    `[${script}] not implemented yet (lands in ${landsIn}); skipping with exit code 0.`,
  );
  process.exit(0);
}
