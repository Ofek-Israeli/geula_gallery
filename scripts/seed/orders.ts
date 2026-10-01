import type { SeedModule } from "./types";

/**
 * Sample-order seed — STUB. Owner: WS6 (M2 ships a stub that marks the three sold works SOLD
 * through `sales` OFFLINE `is_mock`). Spec §8.4: three sample orders with SUCCEEDED MOCK attempts,
 * ONLINE is_mock sales and ISSUED mock receipts; no outbox jobs.
 */
export const ordersSeed: SeedModule = {
  name: "orders",
  modes: ["demo"],
  async run({ log }) {
    log("orders: not implemented yet (lands in M2/WS6); skipped");
  },
};
