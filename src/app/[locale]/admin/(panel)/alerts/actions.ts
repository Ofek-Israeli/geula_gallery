"use server";

import { z } from "zod";
import { acknowledge, retryDead } from "@/server/admin/alerts";
import { adminAction } from "@/server/next/actions";
import { domainErrors } from "../_shared/action-errors";

/** Alert actions (spec §6.10 `/admin/alerts`). Every export is wrapped by `adminAction`. */
export const acknowledgeAction = adminAction(
  z.object({ alertId: z.uuid() }),
  async (i, ctx) => domainErrors(() => acknowledge(ctx, i.alertId)),
  { name: "alerts.acknowledge" },
);

export const retryDeadJobAction = adminAction(
  z.object({ jobId: z.coerce.number().int().positive() }),
  async (i, ctx) => domainErrors(() => retryDead(ctx, i.jobId)),
  { name: "alerts.retry_dead" },
);
