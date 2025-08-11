import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

export default class NeonService {
  private db: ReturnType<typeof drizzle>;

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error("NeonService: DATABASE_URL (connection string) is required");
    }
    const client = neon(connectionString);
    this.db = drizzle(client, { schema });
  }

  // Insert a row and return the inserted row with id
  async createRecord(tableName: string, data: Record<string, any>) {
    if (tableName === "user_xp") {
      const rows = await this.db.insert(schema.userXp).values(data as any).returning();
      return rows[0];
    }
    if (tableName === "users") {
      const rows = await this.db.insert(schema.users).values(data as any).returning();
      return rows[0];
    }
    throw new Error(`Unknown table: ${tableName}`);
  }

  async listRecords(tableName: string): Promise<any[]> {
    if (tableName === "user_xp") {
      return await this.db.select().from(schema.userXp);
    }
    if (tableName === "users") {
      return await this.db.select().from(schema.users);
    }
    throw new Error(`Unknown table: ${tableName}`);
  }

  async getRecordById(tableName: string, recordId: string | number) {
    if (tableName === "user_xp") {
      const rows = await this.db.select().from(schema.userXp).where(eq(schema.userXp.id, Number(recordId))).limit(1);
      if (!rows[0]) throw new Error(`Record not found: ${tableName}.${recordId}`);
      return rows[0];
    }
    if (tableName === "users") {
      const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, Number(recordId))).limit(1);
      if (!rows[0]) throw new Error(`Record not found: ${tableName}.${recordId}`);
      return rows[0];
    }
    throw new Error(`Unknown table: ${tableName}`);
  }

  async deleteRecord(tableName: string, recordId: string | number) {
    if (tableName === "user_xp") {
      await this.db.delete(schema.userXp).where(eq(schema.userXp.id, Number(recordId)));
      return;
    }
    if (tableName === "users") {
      await this.db.delete(schema.users).where(eq(schema.users.id, Number(recordId)));
      return;
    }
    throw new Error(`Unknown table: ${tableName}`);
  }

  async updateRecord(tableName: string, recordId: string | number, updates: Record<string, any>) {
    if (tableName === "user_xp") {
      const rows = await this.db
        .update(schema.userXp)
        .set(updates as any)
        .where(eq(schema.userXp.id, Number(recordId)))
        .returning();
      if (!rows[0]) throw new Error(`Record not found for update: ${tableName}.${recordId}`);
      return rows[0];
    }
    if (tableName === "users") {
      const rows = await this.db
        .update(schema.users)
        .set(updates as any)
        .where(eq(schema.users.id, Number(recordId)))
        .returning();
      if (!rows[0]) throw new Error(`Record not found for update: ${tableName}.${recordId}`);
      return rows[0];
    }
    throw new Error(`Unknown table: ${tableName}`);
  }

  // Fauna index-style helpers are intentionally not supported with Drizzle
  async getRecordByIndex(_indexName: string, _value: any) {
    throw new Error("NeonService.getRecordByIndex is not implemented. Use a table + column specific query.");
  }

  async fetchRecordsInIndex(_indexName: string, _value?: any) {
    throw new Error("NeonService.fetchRecordsInIndex is not implemented. Use a table + column specific query.");
  }
}
