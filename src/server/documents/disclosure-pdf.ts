import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { formatDateTime } from "@/lib/format";
import type { Locale } from "@/lib/locale";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { generatedDocuments, type Order, orders } from "@/server/db/schema";
import { NotFoundError } from "@/server/domain/errors";
import { getUntypedTranslator } from "@/server/i18n";
import {
  storage as defaultStorage,
  type StorageAdapter,
} from "@/server/storage";
import { loadDisclosure } from "./data";
import { renderDisclosurePdf } from "./pdf/render";

/**
 * `ensureDisclosurePdf(orderId, locale)` (spec §5.4 SEND_EMAIL, Tier B): renders the s.14C(b)
 * disclosure PDF once per (order, locale, version), stores it in **private** storage and records it
 * in `generated_documents` (sha256). Later calls return the stored bytes. The caller (the
 * SEND_EMAIL handler) sends without the attachment and raises a WARNING if this throws.
 */
export interface DisclosurePdf {
  filename: string;
  content: Uint8Array;
  fileKey: string;
  sha256: string;
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function ensureDisclosurePdf(
  orderId: string,
  locale: Locale,
  deps: { db?: DbOrTx; storage?: StorageAdapter } = {},
): Promise<DisclosurePdf> {
  const db = deps.db ?? defaultDb;
  const store = deps.storage ?? defaultStorage();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order", orderId);
  const doc = await loadDisclosure(order as Order, locale, { db });
  const filename = `disclosure-${order.number}-${locale}.pdf`;

  const [existing] = await db
    .select()
    .from(generatedDocuments)
    .where(
      and(
        eq(generatedDocuments.orderId, orderId),
        eq(generatedDocuments.kind, "DISCLOSURE"),
        eq(generatedDocuments.locale, locale),
        eq(generatedDocuments.version, doc.version),
      ),
    );
  if (existing) {
    const obj = await store.get(existing.fileKey, "private");
    if (obj) {
      return {
        filename,
        content: await readAll(obj.body),
        fileKey: existing.fileKey,
        sha256: existing.sha256,
      };
    }
  }

  const t = getUntypedTranslator(locale);
  const content = await renderDisclosurePdf(doc, {
    meta: t("documents-compliance.disclosure.meta", {
      number: doc.orderNumber,
      date: formatDateTime(doc.issuedAt, locale),
      version: doc.version,
    }),
    footer: t("documents-compliance.disclosure.printNote"),
  });
  const sha256 = createHash("sha256").update(content).digest("hex");
  const fileKey = `documents/disclosure/${order.number}/${locale}-${sha256.slice(0, 16)}.pdf`;
  await store.put(fileKey, content, {
    contentType: "application/pdf",
    access: "private",
  });
  if (existing) {
    await db
      .update(generatedDocuments)
      .set({ fileKey, sha256, updatedAt: new Date() })
      .where(eq(generatedDocuments.id, existing.id));
  } else {
    await db
      .insert(generatedDocuments)
      .values({
        orderId,
        kind: "DISCLOSURE",
        locale,
        version: doc.version,
        fileKey,
        sha256,
      })
      .onConflictDoNothing();
  }
  return { filename, content, fileKey, sha256 };
}
