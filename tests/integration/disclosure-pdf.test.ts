import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { paidTestOrder } from "../helpers/factories/compliance";

/**
 * Tier B: the disclosure PDF (spec §5.4). The order confirmation carries it as an attachment; it is
 * rendered once per (order, locale, version), stored privately and recorded with its sha256.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const { processOutbox } = await import("@/server/outbox/process");
const { ensureDisclosurePdf } = await import(
  "@/server/documents/disclosure-pdf"
);

cleanDatabaseBeforeEach();

describe("disclosure PDF", () => {
  it("is attached to the order confirmation and stored once", async () => {
    const { order } = await paidTestOrder();
    for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
    const [mail] = await db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.template, "order-confirmation"));
    expect(mail?.status).toBe("SENT");
    expect(JSON.stringify(mail?.attachments)).toContain(
      `disclosure-${order.number}-he.pdf`,
    );
    const docs = await db
      .select()
      .from(schema.generatedDocuments)
      .where(eq(schema.generatedDocuments.orderId, order.id));
    expect(docs).toHaveLength(1);
    expect(docs[0]?.kind).toBe("DISCLOSURE");

    const again = await ensureDisclosurePdf(order.id, "he");
    expect(again.sha256).toBe(docs[0]?.sha256);
    expect(Buffer.from(again.content.slice(0, 5)).toString()).toBe("%PDF-");
    expect(again.content.byteLength).toBeGreaterThan(5_000);
    if (process.env.WRITE_SAMPLE_PDF) {
      await writeFile(process.env.WRITE_SAMPLE_PDF, again.content);
      const en = await ensureDisclosurePdf(order.id, "en");
      await writeFile(
        process.env.WRITE_SAMPLE_PDF.replace(".pdf", "-en.pdf"),
        en.content,
      );
    }
  });
});
