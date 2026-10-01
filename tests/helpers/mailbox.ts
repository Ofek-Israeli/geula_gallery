/**
 * Read the log email driver's outbox (`email_messages`; spec §4.5; frozen at contracts-v1).
 * The log driver stores subject, html and text, so tests assert on what would have been sent.
 * Uses a short-lived dedicated `pg.Client` per call, so it works against the integration
 * database and the E2E database (pass `E2E_DATABASE_URL`) alike.
 */
import pg from "pg";

export interface MailboxMessage {
  id: string;
  template: string;
  toEmail: string;
  locale: "he" | "en";
  subject: string;
  status: "PENDING" | "SENT" | "FAILED";
  html: string | null;
  text: string | null;
  attachments: unknown;
  orderId: string | null;
  createdAt: Date;
}

export interface MailQuery {
  to?: string;
  template?: string;
  orderId?: string;
  status?: MailboxMessage["status"];
}

export interface Mailbox {
  list(q?: MailQuery): Promise<MailboxMessage[]>;
  latest(q?: MailQuery): Promise<MailboxMessage | undefined>;
  /** Poll until at least `count` messages match (default 1) or throw after `timeoutMs`. */
  waitFor(
    q: MailQuery,
    opts?: { count?: number; timeoutMs?: number; intervalMs?: number },
  ): Promise<MailboxMessage[]>;
}

export function createMailbox(connectionString: string): Mailbox {
  async function list(q: MailQuery = {}): Promise<MailboxMessage[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.to) add("lower(to_email) = lower(?)", q.to);
    if (q.template) add("template = ?", q.template);
    if (q.orderId) add("order_id = ?", q.orderId);
    if (q.status) add("status = ?", q.status);
    const client = new pg.Client({
      connectionString,
      application_name: "geula-mailbox",
    });
    await client.connect();
    try {
      const res = await client.query<MailboxMessage>(
        `SELECT id, template, to_email AS "toEmail", locale, subject, status, html, text,
                attachments, order_id AS "orderId", created_at AS "createdAt"
           FROM email_messages
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at, id`,
        params,
      );
      return res.rows;
    } finally {
      await client.end();
    }
  }

  return {
    list,
    async latest(q) {
      const rows = await list(q);
      return rows[rows.length - 1];
    },
    async waitFor(q, opts = {}) {
      const count = opts.count ?? 1;
      const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
      for (;;) {
        const rows = await list(q);
        if (rows.length >= count) return rows;
        if (Date.now() > deadline) {
          throw new Error(
            `mailbox: expected ${count} message(s) for ${JSON.stringify(q)}, found ${rows.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 200));
      }
    },
  };
}
