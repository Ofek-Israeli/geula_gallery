import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/** Locale-aware navigation APIs (spec §6.4). Use these instead of `next/link` / `next/navigation`. */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
