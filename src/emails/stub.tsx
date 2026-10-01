import { Heading, Text } from "react-email";
import { Layout } from "./Layout";
import type { EmailContext, EmailTemplate, EmailTemplateId } from "./types";

/**
 * Builds the M1 placeholder for a template (spec §9.1 step 11: "stub templates for every id").
 * It renders the shared Layout with a greeting and the reference number only, using M1-owned
 * `emails-core` keys. The owning stream replaces the template file with the real content and
 * keys in its own `emails-*` namespace.
 */
export function createStubTemplate<P>(opts: {
  id: EmailTemplateId;
  audience: "buyer" | "painter";
  /** Order, cancellation or request reference shown in the subject and body. */
  reference: (props: P) => string | undefined;
  recipientName?: (props: P) => string | undefined;
  orderUrl?: (props: P) => string | undefined;
}): EmailTemplate<P> {
  const subject = (props: P, ctx: EmailContext) => {
    const ref = opts.reference(props);
    const suffix = ctx.t("emails-core.subjectSuffix");
    return ref ? `${ref} · ${suffix}` : suffix;
  };
  return {
    audience: opts.audience,
    subject,
    preview: subject,
    Component: ({ props, ctx }) => {
      const name = opts.recipientName?.(props);
      const ref = opts.reference(props);
      return (
        <Layout
          ctx={ctx}
          preview={subject(props, ctx)}
          orderUrl={opts.orderUrl?.(props)}
        >
          <Heading as="h1" style={{ fontSize: "20px", fontWeight: 400 }}>
            {ctx.t("emails-core.subjectSuffix")}
          </Heading>
          <Text>
            {name
              ? ctx.t("emails-core.greeting", { name })
              : ctx.t("emails-core.greetingNoName")}
          </Text>
          {ref ? <Text data-template={opts.id}>{ref}</Text> : null}
          <Text>{ctx.t("emails-core.signOff")}</Text>
        </Layout>
      );
    },
  };
}
