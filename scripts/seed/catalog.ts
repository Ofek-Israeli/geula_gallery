import type { SeedModule } from "./types";

/**
 * Demo catalog seed — STUB. Owner: M2 (commerce lead).
 * Will ingest 5 series and the 16 AIC works (`is_demo=true`) from data/demo-manifest.json via
 * `media/ingest.ts` and the StorageAdapter (spec §8.3, §8.4).
 */
export const catalogSeed: SeedModule = {
  name: "catalog",
  modes: ["demo"],
  async run({ log }) {
    log("catalog: not implemented yet (lands in M2); skipped");
  },
};
