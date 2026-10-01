import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/next/auth";

/** Better Auth endpoints (`/api/auth/*`): sign-in, sign-out, session, two-factor (spec §6.10). */
export const { GET, POST } = toNextJsHandler(auth);
