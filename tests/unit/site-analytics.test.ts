import { describe, expect, it } from "vitest";
import { cleanAnalyticsUrl } from "@/components/site/SiteAnalytics";

describe("analytics URLs", () => {
  it("keep the path only: no query string, order numbers masked", () => {
    expect(
      cleanAnalyticsUrl(
        "https://x.example/he/checkout/puzzle?to=IL&city=%D7%97%D7%99%D7%A4%D7%94&zip=3100000",
      ),
    ).toBe("https://x.example/he/checkout/puzzle");
    expect(
      cleanAnalyticsUrl("https://x.example/en/orders/GG-7K3M9Q?k=secret-token"),
    ).toBe("https://x.example/en/orders/[number]");
    expect(cleanAnalyticsUrl("https://x.example/en/works/puzzle")).toBe(
      "https://x.example/en/works/puzzle",
    );
  });
});
