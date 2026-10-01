import type { ReactNode } from "react";
import { Heading, Link, Section, Text } from "react-email";
import type { Currency } from "@/lib/money";
import { formatMoney } from "@/lib/money";
import type { EmailContext, MoneyLine } from "./types";

/**
 * Small building blocks shared by the commerce templates. Plain inline styles (email clients ignore
 * stylesheets); alignment follows `ctx.dir`. Amounts are wrapped in `<bdi>`-like LTR spans via the
 * Unicode isolate already produced by `formatMoney`.
 */
export const textStyle = {
  fontSize: "15px",
  lineHeight: "1.6",
  margin: "0 0 8px",
};
export const mutedStyle = { ...textStyle, fontSize: "13px", color: "#555555" };

export function Title({ children }: { children: ReactNode }) {
  return (
    <Heading
      as="h1"
      style={{ fontSize: "22px", fontWeight: 400, margin: "0 0 16px" }}
    >
      {children}
    </Heading>
  );
}

export function Subtitle({ children }: { children: ReactNode }) {
  return (
    <Heading
      as="h2"
      style={{ fontSize: "17px", fontWeight: 700, margin: "20px 0 8px" }}
    >
      {children}
    </Heading>
  );
}

export function P({
  children,
  muted,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return <Text style={muted ? mutedStyle : textStyle}>{children}</Text>;
}

export function Greeting({ ctx, name }: { ctx: EmailContext; name?: string }) {
  return (
    <P>
      {name
        ? ctx.t("emails-core.greeting", { name })
        : ctx.t("emails-core.greetingNoName")}
    </P>
  );
}

export function SignOff({ ctx }: { ctx: EmailContext }) {
  return (
    <>
      <P>{ctx.t("emails-core.signOff")}</P>
      <P>{ctx.brand.tradeName}</P>
    </>
  );
}

export function money(
  ctx: EmailContext,
  amountMinor: number,
  currency: Currency,
) {
  return formatMoney(amountMinor, currency, ctx.locale);
}

/** Label / amount rows as a two-column table (tables survive every mail client). */
export function AmountTable({
  ctx,
  rows,
  currency,
}: {
  ctx: EmailContext;
  rows: (MoneyLine & { strong?: boolean })[];
  currency: Currency;
}) {
  const align = ctx.dir === "rtl" ? "left" : "right";
  return (
    <Section>
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        style={{ borderCollapse: "collapse", margin: "0 0 12px" }}
      >
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.title}-${r.amountMinor}`}>
              <td
                style={{
                  ...textStyle,
                  padding: "4px 0",
                  borderBottom: "1px solid #eeeeee",
                  fontWeight: r.strong ? 700 : 400,
                }}
              >
                {r.title}
              </td>
              <td
                style={{
                  ...textStyle,
                  padding: "4px 0",
                  borderBottom: "1px solid #eeeeee",
                  textAlign: align,
                  whiteSpace: "nowrap",
                  fontWeight: r.strong ? 700 : 400,
                }}
              >
                <span dir="ltr">{money(ctx, r.amountMinor, currency)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

export function ButtonLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Section style={{ margin: "16px 0" }}>
      <Link
        href={href}
        style={{
          display: "inline-block",
          backgroundColor: "#1a1a1a",
          color: "#ffffff",
          padding: "10px 18px",
          textDecoration: "none",
          fontSize: "15px",
        }}
      >
        {children}
      </Link>
    </Section>
  );
}
