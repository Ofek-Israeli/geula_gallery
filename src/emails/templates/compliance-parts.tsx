import { Section } from "react-email";
import { textStyle } from "../parts";
import type { EmailContext } from "../types";

/**
 * Label/value rows for the compliance templates (cancellation acknowledgement, painter notice).
 * Values are LTR-isolated where they are identifiers (numbers, IDs, dates in Latin digits).
 */
export function DetailsTable({
  ctx,
  rows,
}: {
  ctx: EmailContext;
  rows: { label: string; value: string; ltr?: boolean }[];
}) {
  const align = ctx.dir === "rtl" ? "right" : "left";
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
            <tr key={r.label}>
              <td
                style={{
                  ...textStyle,
                  padding: "4px 0",
                  borderBottom: "1px solid #eeeeee",
                  color: "#555555",
                  textAlign: align,
                  verticalAlign: "top",
                  width: "40%",
                }}
              >
                {r.label}
              </td>
              <td
                style={{
                  ...textStyle,
                  padding: "4px 0",
                  borderBottom: "1px solid #eeeeee",
                  textAlign: align,
                }}
              >
                {r.ltr ? <span dir="ltr">{r.value}</span> : r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
