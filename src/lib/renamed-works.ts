/**
 * Works whose link changed with their title (the painter's corrections, 2026-10-20): old slug →
 * new slug. `next.config.ts` redirects the old links permanently (the work page, its request
 * pages and "Buy now"), so shared or bookmarked links keep working.
 */
export const RENAMED_WORK_SLUGS: Readonly<Record<string, string>> = {
  "expecting-women": "rachel",
  twain: "the-bridge",
};

/** Next.js redirect rules for `RENAMED_WORK_SLUGS`, in both locales. */
export function renamedWorkRedirects() {
  return Object.entries(RENAMED_WORK_SLUGS).flatMap(([from, to]) => [
    {
      source: `/:locale(he|en)/works/${from}/:rest*`,
      destination: `/:locale/works/${to}/:rest*`,
      permanent: true,
    },
    {
      source: `/:locale(he|en)/checkout/${from}`,
      destination: `/:locale/checkout/${to}`,
      permanent: true,
    },
  ]);
}
