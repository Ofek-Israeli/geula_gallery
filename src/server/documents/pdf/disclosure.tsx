import "server-only";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { DisclosureDoc } from "@/content/disclosure";
import { stripBidi } from "@/lib/format";
import { PDF_BODY_FONT, PDF_HEADING_FONT, rtlText } from "./fonts";

/**
 * The s.14C(b) disclosure document as a PDF (spec §5.4, Tier B), rendered from the same
 * `DisclosureDoc` as the HTML page and the email summary. Rules from the M1 spike (a): every Hebrew
 * paragraph has `direction: 'rtl'`, label/value rows use `row-reverse` in Hebrew, fonts are the
 * static TTFs registered by `registerPdfFonts()`. The PDF is untagged (the accessibility statement
 * says so and points to the HTML version).
 */
const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_BODY_FONT,
    fontSize: 10,
    lineHeight: 1.5,
    paddingVertical: 36,
    paddingHorizontal: 40,
    color: "#1d1c1a",
  },
  title: { fontFamily: PDF_HEADING_FONT, fontSize: 16, marginBottom: 4 },
  meta: { fontSize: 8, color: "#5e5a53", marginBottom: 12 },
  section: { marginBottom: 10 },
  heading: { fontSize: 11, fontWeight: 700, marginBottom: 3 },
  row: { flexDirection: "row", gap: 8, marginBottom: 1 },
  label: { width: "38%", color: "#5e5a53" },
  value: { width: "62%" },
  footer: { marginTop: 12, fontSize: 8, color: "#5e5a53" },
});

/** Bidi control characters are dropped: react-pdf shapes runs itself. */
const clean = (s: string) => stripBidi(s);
const HEBREW = /[\u0590-\u05FF]/;

export function DisclosurePdf({
  doc,
  meta,
  footer,
}: {
  doc: DisclosureDoc;
  meta: string;
  footer: string;
}) {
  const rtl = doc.locale === "he";
  const dir = rtlText(rtl);
  return (
    <Document title={clean(doc.title)} language={doc.locale}>
      <Page size="A4" style={styles.page}>
        <Text style={[styles.title, dir]}>{clean(doc.title)}</Text>
        <Text style={[styles.meta, dir]}>{clean(meta)}</Text>
        {doc.sections.map((s) => (
          <View
            key={`${s.id}:${s.heading}`}
            style={styles.section}
            wrap={false}
          >
            <Text style={[styles.heading, dir]}>{clean(s.heading)}</Text>
            {(s.rows ?? []).map((r) => (
              <View
                key={`${r.label}:${r.value}`}
                style={[
                  styles.row,
                  { flexDirection: rtl ? "row-reverse" : "row" },
                ]}
              >
                <Text style={[styles.label, dir]}>{clean(r.label)}</Text>
                {/* A value without Hebrew (phone, amount, number) keeps LTR order. */}
                <Text
                  style={[
                    styles.value,
                    rtl && !HEBREW.test(r.value)
                      ? { textAlign: "right" as const }
                      : dir,
                  ]}
                >
                  {clean(r.value)}
                </Text>
              </View>
            ))}
            {s.paragraphs.map((p) => (
              <Text key={p} style={dir}>
                {clean(p)}
              </Text>
            ))}
          </View>
        ))}
        <Text style={[styles.footer, dir]}>{clean(footer)}</Text>
      </Page>
    </Document>
  );
}
