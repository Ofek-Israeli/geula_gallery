import type { ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";
import type { EmailContext, EmailT } from "./types";

/**
 * A message whose values (URLs, emails, phones) are isolated LTR runs, so a Hebrew sentence never
 * reorders or splits them (spec §6.4). `nowrap` values (phones) never break across lines.
 */
function isolated(
  t: EmailT,
  key: string,
  values: Record<string, string>,
  nowrap: readonly string[] = [],
): ReactNode[] {
  const names = Object.keys(values);
  const text = t(key, Object.fromEntries(names.map((n, i) => [n, `⟦${i}⟧`])));
  return text.split(/⟦(\d+)⟧/).map((part, i) => {
    if (i % 2 === 0) return part;
    const name = names[Number(part)] ?? "";
    return (
      <span
        key={name}
        dir="ltr"
        style={{
          unicodeBidi: "isolate",
          ...(nowrap.includes(name) ? { whiteSpace: "nowrap" } : {}),
        }}
      >
        {values[name]}
      </span>
    );
  });
}

/**
 * Shared email layout (spec §4.5): `lang`/`dir` from the locale, and a footer with the seller
 * identity (never the ID number — `EmailBrand` has no such field), "Merchant country: Israel",
 * the cancellation channels, the order link when there is one, and the transactional notice.
 * Plain inline styles: email clients ignore stylesheets and logical CSS properties.
 */
export interface LayoutProps {
  ctx: EmailContext;
  preview: string;
  orderUrl?: string;
  children: ReactNode;
}

const FONT_STACK =
  "Assistant, 'Segoe UI', Arial, 'Noto Sans Hebrew', 'Helvetica Neue', sans-serif";

export function Layout({ ctx, preview, orderUrl, children }: LayoutProps) {
  const { t, brand, dir, locale } = ctx;
  // Physical alignment is intentional here: many mail clients ignore `start`/`end`.
  const align = dir === "rtl" ? "right" : "left";
  const text = { fontSize: "15px", lineHeight: "1.6", margin: "0 0 8px" };
  const small = { ...text, fontSize: "12px", color: "#555555" };

  return (
    <Html lang={locale} dir={dir}>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#ffffff",
          color: "#1a1a1a",
          fontFamily: FONT_STACK,
          direction: dir,
          textAlign: align,
        }}
      >
        <Container style={{ maxWidth: "600px", padding: "24px 16px" }}>
          <Section>{children}</Section>
          {orderUrl ? (
            <Section style={{ margin: "16px 0" }}>
              <Link href={orderUrl} style={{ color: "#1a1a1a" }}>
                {t("emails-core.viewOrder")}
              </Link>
            </Section>
          ) : null}
          <Hr style={{ borderColor: "#e5e5e5", margin: "24px 0" }} />
          <Section data-testid="email-footer">
            <Text style={{ ...small, fontWeight: 700 }}>
              {t("emails-core.footer.sellerTitle")}
            </Text>
            <Text style={small}>
              {t("emails-core.footer.seller", {
                tradeName: brand.tradeName,
                address: brand.address,
              })}
            </Text>
            <Text style={small}>
              {isolated(
                t,
                "emails-core.footer.contact",
                { email: brand.email, phone: brand.phone },
                ["phone"],
              )}
            </Text>
            <Text style={small}>{t("emails-core.footer.merchantCountry")}</Text>
            <Text style={{ ...small, fontWeight: 700 }}>
              {t("emails-core.footer.cancelTitle")}
            </Text>
            <Text style={small}>
              {isolated(
                t,
                "emails-core.footer.cancelChannels",
                {
                  url: brand.cancelUrl,
                  email: brand.email,
                  phone: brand.phone,
                },
                ["phone"],
              )}
            </Text>
            <Text style={small}>{t("emails-core.footer.transactional")}</Text>
            {ctx.demo ? (
              <Text style={small}>{t("emails-core.footer.demo")}</Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
