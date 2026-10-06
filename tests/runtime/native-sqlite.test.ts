import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("native SQLite installation", () => {
  it("loads the native binding and executes a query", () => {
    const db = new Database(":memory:");

    try {
      expect(db.prepare("SELECT ? AS result").get(42)).toEqual({ result: 42 });
    } finally {
      db.close();
    }
  });
});
