import { QueryHistoryEntry, QueryComplexity } from './types.js';
import { extractTableNames } from './utils.js';
import { QueryOptimizer } from './query-optimizer.js';

export class QueryTracker {
  private history = new Map<string, QueryHistoryEntry[]>();
  private maxHistoryPerDb = 100;
  private optimizer = new QueryOptimizer();

  track(
    dbId: string,
    sql: string,
    executionTimeMs: number,
    rowCount: number,
    error?: string,
    explainPlan?: any
  ): void {
    const complexity = this.optimizer.analyzeQueryComplexity(sql);

    const entry: QueryHistoryEntry = {
      timestamp: new Date(),
      sql,
      tables: extractTableNames(sql),
      executionTimeMs,
      rowCount,
      error,
      explainPlan,
      queryComplexity: complexity,
      performanceScore: this.calculatePerformanceScore(executionTimeMs, complexity)
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
    performanceMetrics: {
      avgScore: number;
      slowQueryCount: number;
      complexityDistribution: Record<string, number>;
    };
  } {
    const dbHistory = this.history.get(dbId) || [];

    const stats = {
      totalQueries: dbHistory.length,
      avgExecutionTime: 0,
      errorCount: 0,
      tableUsage: {} as Record<string, number>,
      performanceMetrics: {
        avgScore: 0,
        slowQueryCount: 0,
        complexityDistribution: {} as Record<string, number>
      }
    };

    if (dbHistory.length === 0) {
      return stats;
    }

    let totalTime = 0;
    let totalScore = 0;

    for (const entry of dbHistory) {
      totalTime += entry.executionTimeMs;
      if (entry.error) {
        stats.errorCount++;
      }

      if (entry.performanceScore !== undefined) {
        totalScore += entry.performanceScore;
      }

      if (entry.executionTimeMs > 1000) { // Configurable threshold
        stats.performanceMetrics.slowQueryCount++;
      }

      if (entry.queryComplexity) {
        const complexity = entry.queryComplexity.estimatedComplexity;
        stats.performanceMetrics.complexityDistribution[complexity] =
          (stats.performanceMetrics.complexityDistribution[complexity] || 0) + 1;
      }

      for (const table of entry.tables) {
        stats.tableUsage[table] = (stats.tableUsage[table] || 0) + 1;
      }
    }

    stats.avgExecutionTime = totalTime / dbHistory.length;
    stats.performanceMetrics.avgScore = totalScore / dbHistory.length;

    return stats;
  }

  getPerformanceAnalytics(dbId: string) {
    const history = this.getHistory(dbId);
    return this.optimizer.getPerformanceAnalytics(history);
  }

  getIndexRecommendations(dbId: string, schema: any) {
    const history = this.getHistory(dbId);
    return this.optimizer.generateIndexRecommendations(history, schema);
  }

  getSlowQueryAlerts(dbId: string) {
    const history = this.getHistory(dbId);
    return this.optimizer.detectSlowQueries(history, dbId);
  }

  suggestQueryRewrite(sql: string, schema: any) {
    return this.optimizer.suggestQueryRewrites(sql, schema);
  }

  async profileQueryPerformance(dbId: string, sql: string, explainResult: any, executionTimeMs: number, rowCount: number) {
    return this.optimizer.profileQueryPerformance(dbId, sql, explainResult, executionTimeMs, rowCount);
  }

  clear(dbId?: string): void {
    if (dbId) {
      this.history.delete(dbId);
    } else {
      this.history.clear();
    }
  }

  private calculatePerformanceScore(executionTimeMs: number, complexity: QueryComplexity): number {
    // Simple scoring algorithm: penalize slow queries and complex queries
    let score = 100;

    // Time-based penalty
    if (executionTimeMs > 5000) score -= 40;
    else if (executionTimeMs > 1000) score -= 20;
    else if (executionTimeMs > 100) score -= 10;

    // Complexity-based penalty
    const complexityPenalty = {
      simple: 0,
      medium: 5,
      complex: 15,
      very_complex: 25
    };
    score -= complexityPenalty[complexity.estimatedComplexity];

    return Math.max(0, Math.min(100, score));
  }
}
