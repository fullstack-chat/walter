import 'dotenv/config';
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL as string,
  },
  strict: process.env.NODE_CI ? false : true,
  verbose: true,
} satisfies Config;
