import { defineConfig } from "drizzle-kit";

// `npm run db:generate` runs drizzle-kit with `--conditions=react-server` so the schema modules'
// `import "server-only"` resolves to the empty build. Migrations are applied by scripts/db-migrate.ts
// and scripts/db-reset.ts (drizzle node-postgres migrator), not by drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      "postgres://localhost:5432/geula_dev",
  },
});
