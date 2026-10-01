import "server-only";
import { env } from "@/server/env";
import { createBlobStorage } from "./blob";
import { createLocalStorage } from "./local";
import type { StorageAdapter } from "./types";

export * from "./keys";
export * from "./types";

let instance: StorageAdapter | undefined;

/** The configured storage driver (`STORAGE_DRIVER`, spec §4.6). One instance per process. */
export function storage(): StorageAdapter {
  instance ??=
    env.STORAGE_DRIVER === "blob"
      ? createBlobStorage({
          publicToken: env.BLOB_READ_WRITE_TOKEN,
          privateToken: env.BLOB_PRIVATE_READ_WRITE_TOKEN,
          publicHost: env.NEXT_PUBLIC_BLOB_HOST,
        })
      : createLocalStorage(env.LOCAL_STORAGE_DIR);
  return instance;
}
