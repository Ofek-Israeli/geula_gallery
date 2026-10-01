import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  apiPaths,
  isLegalDoc,
  localePath,
  paths,
  withQuery,
} from "@/lib/routes";

describe("routes", () => {
  it("builds locale-less paths for next-intl", () => {
    expect(paths.home()).toBe("/");
    expect(paths.artwork("sunset-jaffa")).toBe("/works/sunset-jaffa");
    expect(paths.artworkRequest("sunset", "quote")).toBe(
      "/works/sunset/request?kind=quote",
    );
    expect(paths.works({ availability: "sold", page: undefined })).toBe(
      "/works?availability=sold",
    );
    expect(paths.checkout("sunset", { to: "US", ship: "CARRIER_TABLE" })).toBe(
      "/checkout/sunset?to=US&ship=CARRIER_TABLE",
    );
    expect(paths.order("GG-7K3M9Q", "a b")).toBe("/orders/GG-7K3M9Q?k=a+b");
    expect(paths.cancel()).toBe("/cancel");
    expect(paths.cancel("GG-7K3M9Q")).toBe("/cancel?order=GG-7K3M9Q");
    expect(paths.legal("privacy")).toBe("/legal/privacy");
    expect(paths.admin.fulfill("abc")).toBe("/admin/orders/abc/fulfill");
    expect(paths.admin.print.packingSlip("abc")).toBe(
      "/print/admin/packing-slip/abc",
    );
  });

  it("adds the locale prefix", () => {
    expect(localePath("he", "/")).toBe("/he");
    expect(localePath("en", paths.artwork("x"))).toBe("/en/works/x");
    expect(localePath("he", "/?a=1")).toBe("/he?a=1");
    expect(() => localePath("he", "works")).toThrow(RangeError);
  });

  it("builds API paths", () => {
    expect(apiPaths.paymentWebhook("cardcom", { a: "id", t: "tok" })).toBe(
      "/api/payments/cardcom/webhook?a=id&t=tok",
    );
    expect(apiPaths.cron("outbox")).toBe("/api/cron/outbox");
    expect(apiPaths.publicFile("artworks/a b.jpg")).toBe(
      "/api/files/public/artworks/a%20b.jpg",
    );
    expect(apiPaths.privateFile("labels/x.pdf", { exp: 1, sig: "s" })).toBe(
      "/api/files/private/labels/x.pdf?exp=1&sig=s",
    );
    expect(apiPaths.adminUploads("packing")).toBe(
      "/api/admin/uploads?purpose=packing",
    );
  });

  it("joins absolute URLs and queries", () => {
    expect(absoluteUrl("http://localhost:3000", "/he")).toBe(
      "http://localhost:3000/he",
    );
    expect(absoluteUrl("https://example.com/", "/api/x?a=1")).toBe(
      "https://example.com/api/x?a=1",
    );
    expect(withQuery("/a?x=1", { y: 2, z: "", w: null })).toBe("/a?x=1&y=2");
    expect(isLegalDoc("terms")).toBe(true);
    expect(isLegalDoc("cookies")).toBe(false);
  });
});
