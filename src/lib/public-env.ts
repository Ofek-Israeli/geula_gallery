/**
 * Public (NEXT_PUBLIC_*) configuration, safe for client bundles. Each variable must be read with a
 * literal `process.env.NEXT_PUBLIC_*` expression so Next can inline it at build time.
 * This file and `src/server/env.ts` are the only places allowed to read `process.env` (spec §2.2).
 */
export const publicEnv = {
  /** Host of the public Vercel Blob store, e.g. `abc123.public.blob.vercel-storage.com`. */
  blobHost: process.env.NEXT_PUBLIC_BLOB_HOST || undefined,
} as const;

export type PublicEnv = typeof publicEnv;
