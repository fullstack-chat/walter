import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL as string;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const client = neon(connectionString);
export const db = drizzle(client, { schema });
export * as dbSchema from "./schema";
