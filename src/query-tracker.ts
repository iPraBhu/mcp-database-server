import { QueryHistoryEntry } from './types.js';
import { extractTableNames } from './utils.js';

export class QueryTracker {
  private history = new Map<string, QueryHistoryEntry[]>();
  private maxHistoryPerDb = 100;

  track(
    dbId: string,
    sql: string,
    executionTimeMs: number,
    rowCount: number,
    error?: string
  ): void {
    const entry: QueryHistoryEntry = {
      timestamp: new Date(),
      sql,
      tables: extractTableNames(sql),
      executionTimeMs,
      rowCount,
      error,
    };

    if (!this.history.has(dbId)) {
      this.history.set(dbId, []);
    }

    const dbHistory = this.history.get(dbId)!;
    dbHistory.push(entry);

    // Keep only recent queries
    if (dbHistory.length > this.maxHistoryPerDb) {
      dbHistory.shift();
    }
  }

  getHistory(dbId: string, limit?: number): QueryHistoryEntry[] {
    const dbHistory = this.history.get(dbId) || [];
    if (limit) {
      return dbHistory.slice(-limit);
    }
    return [...dbHistory];
  }

  getStats(dbId: string): {
    totalQueries: number;
    avgExecutionTime: number;
    errorCount: number;
    tableUsage: Record<string, number>;
  } {
    const dbHistory = this.history.get(dbId) || [];

    const stats = {
      totalQueries: dbHistory.length,
      avgExecutionTime: 0,
      errorCount: 0,
      tableUsage: {} as Record<string, number>,
    };

    if (dbHistory.length === 0) {
      return stats;
    }

    let totalTime = 0;
    for (const entry of dbHistory) {
      totalTime += entry.executionTimeMs;
      if (entry.error) {
        stats.errorCount++;
      }

      for (const table of entry.tables) {
        stats.tableUsage[table] = (stats.tableUsage[table] || 0) + 1;
      }
    }

    stats.avgExecutionTime = totalTime / dbHistory.length;

    return stats;
  }

  clear(dbId?: string): void {
    if (dbId) {
      this.history.delete(dbId);
    } else {
      this.history.clear();
    }
  }
}
