"use client";

import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  useActionState,
  useContext,
  useEffect,
  useId,
  useRef,
  useTransition,
} from "react";
import { type ButtonVariant, buttonClasses } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";

/**
 * Admin form kit (spec §6.10 "Zod forms"). `ActionForm` binds a Server Action created with
 * `adminAction` through `useActionState`; fields read their zod errors by name from context, so
 * server pages can lay fields out freely. Error codes are translated from `errorNamespace`
 * (`<ns>.<CODE>`), falling back to `admin-shell.errors.*`.
 */
export type AdminActionState =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: {
        code: string;
        fieldErrors?: Record<string, string[] | undefined>;
        formErrors?: string[];
        /** A localized message chosen by the handler (wins over the code lookup). */
        message?: string;
      };
    }
  | null;

/** Any `adminAction(...)` export (its state type is narrowed per action). */
export type AdminFormAction = (
  prev: never,
  payload: FormData,
) => Promise<AdminActionState>;

type BoundAction = (
  prev: AdminActionState,
  payload: FormData,
) => Promise<AdminActionState>;

interface FormCtx {
  idPrefix: string;
  state: AdminActionState;
}

const Ctx = createContext<FormCtx>({ idPrefix: "f", state: null });

export function useAdminFormState(): AdminActionState {
  return useContext(Ctx).state;
}

function fieldError(state: AdminActionState, name: string): string | undefined {
  return state && !state.ok ? state.error.fieldErrors?.[name]?.[0] : undefined;
}

export interface ConfirmSpec {
  title: string;
  message: ReactNode;
  confirmLabel: string;
}

export function ActionForm({
  action,
  locale,
  hidden = {},
  children,
  submitLabel,
  pendingLabel,
  successText,
  errorNamespace = "admin-shell.errors",
  submitVariant = "primary",
  submitSize = "md",
  confirm,
  className,
  testId,
  inline = false,
  resetOnSuccess = false,
}: {
  action: AdminFormAction;
  locale: Locale;
  hidden?: Record<string, string>;
  children?: ReactNode;
  submitLabel: ReactNode;
  pendingLabel?: ReactNode;
  successText?: ReactNode;
  errorNamespace?: string;
  submitVariant?: ButtonVariant;
  submitSize?: "md" | "sm";
  /** Ask in a native modal before submitting (money, overrides, voids). */
  confirm?: ConfirmSpec;
  className?: string;
  testId?: string;
  inline?: boolean;
  /** Clear the fields after a successful submit (e.g. a sent reply). */
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    action as unknown as BoundAction,
    null,
  );
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <Ctx.Provider value={{ idPrefix, state }}>
      <form
        ref={formRef}
        // Without JS the form posts to the Server Action (progressive enhancement). Once hydrated,
        // submit through a transition instead: React resets a form after an `action` submission,
        // which would wipe what the admin typed when the server answers with an error.
        action={formAction}
        onSubmit={(event) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          const data = new FormData(event.currentTarget, submitter);
          startTransition(() => formAction(data));
        }}
        className={
          className ??
          (inline ? "flex flex-wrap items-end gap-3" : "flex flex-col gap-4")
        }
        data-testid={testId}
        noValidate
      >
        <input type="hidden" name={LOCALE_FIELD} value={locale} />
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {children}
        <div className="flex flex-wrap items-center gap-3">
          {confirm ? (
            <ConfirmSubmit
              label={submitLabel}
              variant={submitVariant}
              size={submitSize}
              pending={pending}
              {...confirm}
            />
          ) : (
            <button
              type="submit"
              className={buttonClasses(submitVariant, submitSize)}
              disabled={pending}
              aria-disabled={pending || undefined}
            >
              {pending && pendingLabel ? pendingLabel : submitLabel}
            </button>
          )}
          <FormStatus
            successText={successText}
            errorNamespace={errorNamespace}
          />
        </div>
      </form>
    </Ctx.Provider>
  );
}

function ConfirmSubmit({
  label,
  variant,
  size,
  title,
  message,
  confirmLabel,
  pending,
}: ConfirmSpec & {
  label: ReactNode;
  variant: ButtonVariant;
  size: "md" | "sm";
  pending: boolean;
}) {
  const t = useTranslations("common.form");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  return (
    <>
      <button
        type="button"
        className={buttonClasses(variant, size)}
        aria-haspopup="dialog"
        disabled={pending}
        onClick={() => ref.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-sm border border-line bg-paper p-5 text-ink"
      >
        <h2 id={titleId} className="text-xl">
          {title}
        </h2>
        <div id={messageId} className="mbs-2">
          {message}
        </div>
        <div className="mbs-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className={buttonClasses("secondary")}
            onClick={() => ref.current?.close()}
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            className={buttonClasses(variant)}
            onClick={() => ref.current?.close()}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

function FormStatus({
  successText,
  errorNamespace,
}: {
  successText?: ReactNode;
  errorNamespace: string;
}) {
  const state = useAdminFormState();
  const t = useTranslations();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state && !state.ok) ref.current?.focus();
  }, [state]);
  if (!state) return null;
  if (state.ok) {
    return successText ? (
      <p role="status" className="text-sm" data-testid="form-success">
        {successText}
      </p>
    ) : null;
  }
  const code = state.error.code;
  const key = (ns: string) => `${ns}.${code}` as never;
  const text = state.error.message
    ? state.error.message
    : t.has(key(errorNamespace))
      ? t(key(errorNamespace))
      : t.has(key("admin-shell.errors"))
        ? t(key("admin-shell.errors"))
        : t("admin-shell.errors.generic");
  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="text-sm font-medium text-reddot"
      data-testid="form-error"
      data-code={code}
    >
      {text}
    </p>
  );
}

/** Renders `children` only after a submit failed with `code` (e.g. a confirmation checkbox). */
export function ShowOnError({
  code,
  children,
}: {
  code: string;
  children: ReactNode;
}) {
  const state = useAdminFormState();
  return state && !state.ok && state.error.code === code ? children : null;
}

type FieldKind =
  | "text"
  | "textarea"
  | "select"
  | "number"
  | "email"
  | "url"
  | "date"
  | "datetime-local"
  | "password"
  | "tel";

export function FormField({
  name,
  label,
  hint,
  required,
  type = "text",
  defaultValue,
  options,
  placeholder,
  dir,
  inputMode,
  step,
  min,
  rows,
  readOnly,
  className,
  autoComplete,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  type?: FieldKind;
  defaultValue?: string | number | null;
  options?: readonly SelectOption[];
  placeholder?: string;
  dir?: "ltr" | "rtl" | "auto";
  inputMode?: "decimal" | "numeric" | "text" | "email" | "tel" | "url";
  step?: string;
  min?: string;
  rows?: number;
  readOnly?: boolean;
  className?: string;
  autoComplete?: string;
}) {
  const { idPrefix, state } = useContext(Ctx);
  const id = `${idPrefix}-${name}`;
  const error = fieldError(state, name);
  const value =
    defaultValue === null || defaultValue === undefined
      ? ""
      : String(defaultValue);
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      required={required}
      error={error}
      className={className}
    >
      {(c) =>
        type === "textarea" ? (
          <Textarea
            {...c}
            name={name}
            defaultValue={value}
            rows={rows}
            dir={dir}
            readOnly={readOnly}
          />
        ) : type === "select" ? (
          <Select
            {...c}
            name={name}
            defaultValue={value}
            options={options ?? []}
            placeholder={placeholder}
          />
        ) : (
          <Input
            {...c}
            name={name}
            type={type === "number" ? "text" : type}
            inputMode={type === "number" ? (inputMode ?? "decimal") : inputMode}
            defaultValue={value}
            placeholder={placeholder}
            dir={dir ?? (type === "number" ? "ltr" : undefined)}
            step={step}
            min={min}
            readOnly={readOnly}
            autoComplete={autoComplete}
          />
        )
      }
    </Field>
  );
}

export function FormCheckbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  defaultChecked?: boolean;
}) {
  const { idPrefix, state } = useContext(Ctx);
  return (
    <Checkbox
      id={`${idPrefix}-${name}`}
      name={name}
      label={label}
      hint={hint}
      error={fieldError(state, name)}
      defaultChecked={defaultChecked}
    />
  );
}
