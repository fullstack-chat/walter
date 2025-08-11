import { pgTable, serial, text, integer, bigint, timestamp, jsonb } from "drizzle-orm/pg-core";

// Users table (lightweight) for reference/usernames used by the bot
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  userId: text("userId").notNull().unique(),
  username: text("username").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
});

// XP table used by XpManager
export const userXp = pgTable("user_xp", {
  id: serial("id").primaryKey(),
  userId: text("userId").notNull().unique(),
  currentXp: integer("currentXp").notNull().default(0),
  lastAppliedTimestamp: bigint("lastAppliedTimestamp", { mode: "number" }).notNull(),
  multiplier: integer("multiplier").notNull().default(1),
  username: text("username").notNull(),
  penaltyCount: integer("penaltyCount").notNull().default(0),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull()
});

// Memory for project forum rollups per thread
export const projectThreadMemory = pgTable("project_thread_memory", {
  id: serial("id").primaryKey(),
  threadId: text("threadId").notNull().unique(),
  threadName: text("threadName").notNull(),
  lastSeenMessageId: text("lastSeenMessageId"),
  lastSummaryAt: timestamp("lastSummaryAt", { withTimezone: true }),
  memory: jsonb("memory"), // arbitrary memory to help future summaries
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});
