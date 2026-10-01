import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  buyerIp,
  e2eQuery,
  mailbox,
  messages,
  runCron,
} from "./support/commerce";

/**
 * The contact form (spec §5.8, §6.2 `/contact`): `?topic=commission` preselects the topic; the
 * message is stored as a QUESTION without an artwork (topic COMMISSION) and acknowledged by email;
 * the s.11 privacy notice is shown with the form.
 */
const en = messages("en", "catalog").contact;
const er = messages("en", "requests");

test.use({ extraHTTPHeaders: buyerIp(44) });

test("contact form: a commission enquiry → stored request + acknowledgement", async ({
  page,
  request,
}) => {
  const buyer = uniqueBuyer("contact");
  await page.goto("/en/contact?topic=commission");
  const form = page.getByTestId("contact-form");
  await expect(form.getByLabel(new RegExp(`^${en.topic}`))).toHaveValue(
    "COMMISSION",
  );
  await expect(page.getByText(en.privacy)).toBeVisible();
  await form.getByLabel(new RegExp(`^${er.fields.name}`)).fill(buyer.name);
  await form.getByLabel(new RegExp(`^${er.fields.email}`)).fill(buyer.email);
  await form
    .getByLabel(new RegExp(`^${er.fields.message}`))
    .fill("A large landscape for a living room, about 120 × 80 cm.");
  await form.getByTestId("contact-submit").click();
  await expect(page.getByTestId("contact-thanks")).toContainText(buyer.email);

  const [row] = await e2eQuery<{
    kind: string;
    topic: string | null;
    artwork_id: string | null;
    status: string;
    locale: string;
  }>(
    "SELECT kind, topic, artwork_id, status, locale FROM buyer_requests WHERE lower(email) = $1",
    [buyer.email.toLowerCase()],
  );
  expect(row).toEqual({
    kind: "QUESTION",
    topic: "COMMISSION",
    artwork_id: null,
    status: "NEW",
    locale: "en",
  });
  for (let i = 0; i < 2; i++) await runCron(request, "outbox");
  const ack = await mailbox.waitFor({
    template: "request-ack",
    to: buyer.email,
  });
  expect(ack[0]?.locale).toBe("en");
  await mailbox.waitFor({ template: "painter-new-request" });
});

test("contact form: a missing message is reported", async ({ page }) => {
  await page.goto("/en/contact");
  const form = page.getByTestId("contact-form");
  await expect(form.getByLabel(new RegExp(`^${en.topic}`))).toHaveValue(
    "GENERAL",
  );
  await form.getByLabel(new RegExp(`^${er.fields.name}`)).fill("Test Buyer");
  await form
    .getByLabel(new RegExp(`^${er.fields.email}`))
    .fill("contact-empty@example.test");
  await form.getByTestId("contact-submit").click();
  await expect(page.getByRole("alert").first()).toContainText(
    er.fields.message,
  );
});
