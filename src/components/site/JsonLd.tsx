import { type JsonLdObject, serializeJsonLd } from "./structured-data";

/**
 * A JSON-LD block (spec §6.6). Not executed by the browser, so the static CSP is unaffected; the
 * payload is escaped by `serializeJsonLd` so text fields cannot close the script element.
 */
export function JsonLd({ data }: { data: JsonLdObject | JsonLdObject[] }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped JSON, not HTML (serializeJsonLd)
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
