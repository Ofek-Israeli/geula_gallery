/**
 * A stand-in for Isracard's PayMe service, for the `preview` E2E project only:
 * playwright.config.ts points the preview server's ISRACARD_BASE_URL and ISRACARD_HF_SCRIPT_URL
 * here (env.ts refuses both overrides in production).
 *
 * It answers the calls the adapter makes (`providers/isracard.ts`, docs.payme.io read 2026-10-14):
 * generate-sale, pay-sale and get-transactions. Its hosted-fields script stands in for PayMe's
 * card iframes with plain inputs: the card number stays in the browser and only a one-time token
 * reaches the shop's server, as with PayMe. A card ending 0002 is declined. `GET /__log` lists the
 * API requests received, so a spec can check what the server sent.
 *
 *   node tests/e2e/support/payme-stub.mjs <port>
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3102);
/** saleId → { attemptId, price, currency, status } */
const sales = new Map();
/** API requests received: { path, body } (generate-sale also records the sale id it returned). */
const log = [];

const HOSTED_FIELDS = `
(() => {
  const LABELS = { cardNumber: "Card number", cardExpiration: "Expiry", cvc: "CVV" };
  window.PayMe = {
    create(key, opts) {
      return Promise.resolve({
        hostedFields() {
          return {
            create(field) {
              return {
                mount(selector) {
                  const input = document.createElement("input");
                  input.setAttribute("data-stub-field", field);
                  input.setAttribute("aria-label", LABELS[field] || field);
                  input.style.width = "100%";
                  input.style.border = "0";
                  document.querySelector(selector).appendChild(input);
                },
                on() {},
                teardown() {},
              };
            },
          };
        },
        tokenize() {
          const number = document.querySelector("[data-stub-field=cardNumber]").value.trim();
          if (!number) return Promise.reject({ type: "tokenize-error" });
          return Promise.resolve({
            type: "tokenize-success",
            token: "BUYER-STUB-" + number.slice(-4),
            testMode: Boolean(opts && opts.testMode),
          });
        },
      });
    },
    clientData() {
      return Promise.resolve({ hash: "stub-client-data" });
    },
  };
})();
`;

function transactions(body) {
  return [...sales.entries()]
    .filter(
      ([id, s]) =>
        (body.transaction_id && s.attemptId === body.transaction_id) ||
        id === body.sale_payme_id,
    )
    .map(([id, s]) => ({
      seller_payme_id: body.seller_payme_id,
      sale_payme_id: id,
      transaction_id: s.attemptId,
      payme_transaction_id: `TRAN-${id}`,
      sale_status: s.status,
      transaction_action: "Debit",
      transaction_type: 1,
      transaction_price: s.price,
      sale_currency: s.currency,
      sale_installments: 1,
      sale_auth_number: "0000000",
      transaction_error_code: s.status === "completed" ? 20000 : 33,
      sale_buyer_details: {
        buyer_card_mask: "532610******5846",
        buyer_card_brand: "Mastercard",
        buyer_card_is_foreign: false,
      },
    }));
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : {};
  const json = (code, value) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/health") return json(200, { ok: true });
  if (path === "/__log") return json(200, log);
  if (path === "/hostedfields.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    return res.end(HOSTED_FIELDS);
  }
  const entry = { path, body };
  log.push(entry);
  if (path === "/api/generate-sale") {
    const id = `SALE-STUB-${sales.size + 1}`;
    entry.saleId = id;
    sales.set(id, {
      attemptId: body.transaction_id,
      price: body.sale_price,
      currency: body.currency,
      status: "initial",
    });
    return json(200, {
      status_code: 0,
      payme_sale_id: id,
      payme_sale_code: sales.size,
      price: body.sale_price,
      transaction_id: body.transaction_id,
      currency: body.currency,
    });
  }
  if (path === "/api/pay-sale") {
    const sale = sales.get(body.payme_sale_id);
    if (!sale) {
      return json(500, {
        status_code: 1,
        status_error_code: 404,
        status_error_details: "unknown sale",
      });
    }
    if (String(body.buyer_key).endsWith("0002")) {
      sale.status = "failed";
      return json(200, {
        status_code: 1,
        sale_status: "failure",
        status_error_code: 301,
        status_error_details: "Card declined",
      });
    }
    sale.status = "completed";
    return json(200, {
      status_code: 0,
      payme_status: "success",
      sale_status: "completed",
      payme_sale_id: body.payme_sale_id,
    });
  }
  if (path === "/api/get-transactions") {
    const items = transactions(body);
    return json(200, { status_code: 0, items_count: items.length, items });
  }
  return json(404, { status_code: 1, status_error_code: 404 });
}).listen(port, "127.0.0.1", () => {
  console.log(`[payme-stub] listening on ${port}`);
});
