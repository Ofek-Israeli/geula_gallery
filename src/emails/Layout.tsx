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
import type { EmailContext } from "./types";

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
              {t("emails-core.footer.contact", {
                email: brand.email,
                phone: brand.phone,
              })}
            </Text>
            <Text style={small}>{t("emails-core.footer.merchantCountry")}</Text>
            <Text style={{ ...small, fontWeight: 700 }}>
              {t("emails-core.footer.cancelTitle")}
            </Text>
            <Text style={small}>
              {t("emails-core.footer.cancelChannels", {
                url: brand.cancelUrl,
                email: brand.email,
                phone: brand.phone,
              })}
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
