"use client";

import { useId } from "react";
import { controlClasses } from "@/components/ui/Input";

/**
 * Templated replies (spec §6.10 inbox): picking a template fills the reply textarea of the same
 * form (the texts are rendered on the server in the buyer's language). Without JS the textarea is
 * simply typed by hand.
 */
export function ReplyTemplatePicker({
  label,
  placeholder,
  target,
  templates,
}: {
  label: string;
  placeholder: string;
  target: string;
  templates: { key: string; label: string; text: string }[];
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <select
        id={id}
        className={controlClasses}
        defaultValue=""
        onChange={(event) => {
          const form = event.currentTarget.form;
          const tpl = templates.find(
            (x) => x.key === event.currentTarget.value,
          );
          const el = form?.elements.namedItem(target);
          if (tpl && el instanceof HTMLTextAreaElement) {
            el.value = tpl.text;
            el.focus();
          }
        }}
      >
        <option value="">{placeholder}</option>
        {templates.map((x) => (
          <option key={x.key} value={x.key}>
            {x.label}
          </option>
        ))}
      </select>
    </div>
  );
}
