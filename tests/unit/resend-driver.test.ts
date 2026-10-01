import { describe, expect, it } from "vitest";
import {
  createResendEmailSender,
  type ResendLike,
} from "@/server/email/drivers/resend";
import {
  ProviderNotConfiguredError,
  ProviderRejectedError,
  ProviderUnavailableError,
  parseBodyText,
  type RecordedExchange,
  recordingFetch,
} from "@/server/integrations/http";

/** Resend driver (spec §4.5) and the fixture recorder of `integrations/http.ts`. */
function fakeClient(answer: Awaited<ReturnType<ResendLike["emails"]["send"]>>) {
  const calls: { payload: unknown; options: unknown }[] = [];
  const client: ResendLike = {
    emails: {
      send: async (payload, options) => {
        calls.push({ payload, options });
        return answer;
      },
    },
  };
  return { client, calls };
}

const message = {
  to: "buyer@example.com",
  subject: "Order GG-1",
  html: "<p>hi</p>",
  text: "hi",
  idempotencyKey: "email:order-confirmation:o1:buyer@example.com",
  attachments: [
    {
      filename: "a.pdf",
      contentType: "application/pdf",
      content: new Uint8Array([37, 80]),
    },
  ],
};

describe("resend driver", () => {
  it("sends with the dedupe key as Idempotency-Key and returns the message id", async () => {
    const { client, calls } = fakeClient({
      data: { id: "msg_1" },
      error: null,
    });
    const sender = createResendEmailSender({
      from: "Geula Gallery <studio@example.com>",
      replyTo: "studio@example.com",
      client,
    });
    expect(sender.storesBody).toBe(false);
    expect(await sender.send(message)).toEqual({ providerMessageId: "msg_1" });
    expect(calls[0]?.options).toEqual({
      idempotencyKey: message.idempotencyKey,
    });
    expect(calls[0]?.payload).toMatchObject({
      from: "Geula Gallery <studio@example.com>",
      to: ["buyer@example.com"],
      subject: "Order GG-1",
      replyTo: "studio@example.com",
      attachments: [{ filename: "a.pdf", contentType: "application/pdf" }],
    });
  });

  it("classifies errors: rate limits and 5xx retry, validation is rejected", async () => {
    const limited = fakeClient({
      data: null,
      error: {
        name: "rate_limit_exceeded",
        message: "slow down",
        statusCode: 429,
      },
    });
    await expect(
      createResendEmailSender({
        from: "x@example.com",
        client: limited.client,
      }).send(message),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    const invalid = fakeClient({
      data: null,
      error: { name: "validation_error", message: "bad", statusCode: 422 },
    });
    await expect(
      createResendEmailSender({
        from: "x@example.com",
        client: invalid.client,
      }).send(message),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("needs an API key", async () => {
    await expect(
      createResendEmailSender({ from: "x@example.com" }).send(message),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});

describe("recordingFetch", () => {
  it("records method, path, redacted bodies and status; never headers or host", async () => {
    const sink: RecordedExchange[] = [];
    const fetch = recordingFetch(
      async () => Response.json({ secret: "s", ok: true }, { status: 201 }),
      sink,
      (b) => (b && typeof b === "object" ? { ...b, secret: "REDACTED" } : b),
    );
    const res = await fetch(
      new Request("https://api.example.com/v1/x?y=1", {
        method: "POST",
        headers: { Authorization: "Bearer t" },
        body: JSON.stringify({ secret: "s", a: 1 }),
      }),
    );
    expect(await res.json()).toEqual({ secret: "s", ok: true });
    expect(sink).toEqual([
      {
        request: {
          method: "POST",
          path: "/v1/x?y=1",
          body: { secret: "REDACTED", a: 1 },
        },
        response: { status: 201, body: { secret: "REDACTED", ok: true } },
      },
    ]);
    expect(JSON.stringify(sink)).not.toContain("Bearer");
    expect(parseBodyText("<html>")).toEqual({ nonJsonBodyLength: 6 });
  });
});
