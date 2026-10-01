import { Assistant, Frank_Ruhl_Libre } from "next/font/google";

/** Self-hosted by next/font (no third-party requests; CSP `font-src 'self'`). Spec §6.1. */
export const frankRuhl = Frank_Ruhl_Libre({
  subsets: ["hebrew", "latin"],
  display: "swap",
  variable: "--font-frank-ruhl",
});

export const assistant = Assistant({
  subsets: ["hebrew", "latin"],
  display: "swap",
  variable: "--font-assistant",
});

export const fontVariables = `${frankRuhl.variable} ${assistant.variable}`;
