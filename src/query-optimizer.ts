import {
  QueryHistoryEntry,
  QueryComplexity,
  IndexRecommendation,
  QueryPerformanceProfile,
  PerformanceBottleneck,
  PerformanceRecommendation,
  SlowQueryAlert,
  QueryOptimizationResult,
  DatabaseSchema,
  ExplainResult
} from './types.js';
import { extractTableNames } from './utils.js';
import { getLogger } from './logger.js';

export interface QueryOptimizerOptions {
  slowQueryThresholdMs: number;
  maxHistoryForAnalysis: number;
  enableAutoAnalysis: boolean;
}

export class QueryOptimizer {
  private logger = getLogger();
  private slowQueryThresholdMs: number;
  private maxHistoryForAnalysis: number;
  private enableAutoAnalysis: boolean;
  private slowQueryAlerts = new Map<string, SlowQueryAlert[]>();

  constructor(options: QueryOptimizerOptions = {
    slowQueryThresholdMs: 1000,
    maxHistoryForAnalysis: 1000,
    enableAutoAnalysis: true
  }) {
    this.slowQueryThresholdMs = options.slowQueryThresholdMs;
    this.maxHistoryForAnalysis = options.maxHistoryForAnalysis;
    this.enableAutoAnalysis = options.enableAutoAnalysis;
  }

  /**
   * Analyze query complexity and extract performance metrics
   */
  analyzeQueryComplexity(sql: string): QueryComplexity {
    const complexity: QueryComplexity = {
      selectColumns: this.countSelectColumns(sql),
      whereConditions: this.countWhereConditions(sql),
      joinCount: this.countJoins(sql),
      subqueryCount: this.countSubqueries(sql),
      hasAggregations: /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql),
      hasDistinct: /\bDISTINCT\b/i.test(sql),
      hasOrderBy: /\bORDER\s+BY\b/i.test(sql),
      hasGroupBy: /\bGROUP\s+BY\b/i.test(sql),
      estimatedComplexity: 'simple'
    };

    // Calculate complexity score
    let score = 0;
    score += complexity.selectColumns * 0.5;
    score += complexity.whereConditions * 1;
    score += complexity.joinCount * 2;
    score += complexity.subqueryCount * 3;
    score += complexity.hasAggregations ? 2 : 0;
    score += complexity.hasDistinct ? 1 : 0;
    score += complexity.hasOrderBy ? 1 : 0;
    score += complexity.hasGroupBy ? 1 : 0;

    if (score <= 3) complexity.estimatedComplexity = 'simple';
    else if (score <= 7) complexity.estimatedComplexity = 'medium';
    else if (score <= 12) complexity.estimatedComplexity = 'complex';
    else complexity.estimatedComplexity = 'very_complex';

    return complexity;
  }

  /**
   * Generate index recommendations based on query history and schema
   */
  generateIndexRecommendations(
    queryHistory: QueryHistoryEntry[],
    schema: DatabaseSchema
  ): IndexRecommendation[] {
    const recommendations: IndexRecommendation[] = [];
    const columnUsage = new Map<string, { table: string; usage: number; inWhere: boolean; inJoin: boolean }>();

    // Analyze query patterns
    for (const entry of queryHistory) {
      if (entry.error) continue;

      const tables = entry.tables;

      // Extract WHERE conditions
      const whereMatch = entry.sql.match(/WHERE\s+(.+?)(?:\s+(GROUP|ORDER|LIMIT|$))/i);
      if (whereMatch) {
        const whereClause = whereMatch[1];
        const columns = this.extractColumnsFromCondition(whereClause, tables, schema);
        for (const col of columns) {
          const key = `${col.table}.${col.column}`;
          const existing = columnUsage.get(key) || { table: col.table, usage: 0, inWhere: false, inJoin: false };
          existing.usage++;
          existing.inWhere = true;
          columnUsage.set(key, existing);
        }
      }

      // Extract JOIN conditions
      const joinMatches = entry.sql.match(/JOIN\s+\w+\s+ON\s+(.+?)(?:\s+(WHERE|GROUP|ORDER|LIMIT|$))/gi);
      if (joinMatches) {
        for (const joinMatch of joinMatches) {
          const joinClause = joinMatch.replace(/JOIN\s+\w+\s+ON\s+/i, '');
          const columns = this.extractColumnsFromCondition(joinClause, tables, schema);
          for (const col of columns) {
            const key = `${col.table}.${col.column}`;
            const existing = columnUsage.get(key) || { table: col.table, usage: 0, inWhere: false, inJoin: false };
            existing.usage++;
            existing.inJoin = true;
            columnUsage.set(key, existing);
          }
        }
      }
    }

    // Generate recommendations
    for (const [key, usage] of columnUsage) {
      if (usage.usage < 3) continue; // Need minimum usage

      const [tableName, columnName] = key.split('.');
      const table = this.findTableInSchema(schema, tableName);
      if (!table) continue;

      // Check if index already exists
      const existingIndex = table.indexes.find(idx =>
        idx.columns.includes(columnName) && !idx.isPrimary
      );

      if (existingIndex) continue;

      const recommendation: IndexRecommendation = {
        table: tableName,
        columns: [columnName],
        type: 'single',
        reason: `Column ${columnName} is frequently used in ${usage.inWhere ? 'WHERE' : ''}${usage.inWhere && usage.inJoin ? ' and ' : ''}${usage.inJoin ? 'JOIN' : ''} conditions`,
        impact: usage.usage > 10 ? 'high' : usage.usage > 5 ? 'medium' : 'low'
      };

      recommendations.push(recommendation);
    }

    // Sort by impact and usage
    return recommendations.sort((a, b) => {
      const impactOrder = { high: 3, medium: 2, low: 1 };
      return impactOrder[b.impact] - impactOrder[a.impact];
    });
  }

  /**
   * Profile query performance using EXPLAIN plan
   */
  async profileQueryPerformance(
    dbId: string,
    sql: string,
    explainResult: ExplainResult,
    executionTimeMs: number,
    rowCount: number
  ): Promise<QueryPerformanceProfile> {
    const bottlenecks: PerformanceBottleneck[] = [];
    const recommendations: PerformanceRecommendation[] = [];

    // Analyze EXPLAIN plan for bottlenecks
    if (explainResult.plan) {
      bottlenecks.push(...this.analyzeExplainPlan(explainResult.plan));
    }

    // Time-based analysis
    if (executionTimeMs > this.slowQueryThresholdMs) {
      bottlenecks.push({
        type: 'table_scan',
        severity: executionTimeMs > this.slowQueryThresholdMs * 5 ? 'critical' : 'high',
        description: `Query execution time (${executionTimeMs}ms) exceeds threshold (${this.slowQueryThresholdMs}ms)`,
        estimatedCost: executionTimeMs
      });
    }

    // Generate recommendations based on bottlenecks
    for (const bottleneck of bottlenecks) {
      switch (bottleneck.type) {
        case 'table_scan':
          recommendations.push({
            type: 'add_index',
            description: `Consider adding an index on ${bottleneck.table || 'frequently queried columns'}`,
            impact: 'high',
            effort: 'medium'
          });
          break;
        case 'join':
          recommendations.push({
            type: 'optimize_join',
            description: 'Review JOIN conditions and ensure proper indexing on join columns',
            impact: 'high',
            effort: 'medium'
          });
          break;
        case 'sort':
          recommendations.push({
            type: 'add_index',
            description: 'Consider adding an index to avoid sorting operations',
            impact: 'medium',
            effort: 'medium'
          });
          break;
      }
    }

    // Calculate overall performance score (0-100)
    let score = 100;
    for (const bottleneck of bottlenecks) {
      const severityPenalty = { critical: 30, high: 20, medium: 10, low: 5 };
      score -= severityPenalty[bottleneck.severity];
    }
    score = Math.max(0, Math.min(100, score));

    return {
      queryId: this.generateQueryId(sql),
      sql,
      executionTimeMs,
      rowCount,
      bottlenecks,
      recommendations,
      overallScore: score
    };
  }

  /**
   * Detect and alert on slow queries
   */
  detectSlowQueries(queryHistory: QueryHistoryEntry[], dbId: string): SlowQueryAlert[] {
    for (const entry of queryHistory) {
      if (entry.executionTimeMs > this.slowQueryThresholdMs) {
        const queryId = this.generateQueryId(entry.sql);
        const existingAlerts = this.slowQueryAlerts.get(dbId) || [];
        const existingAlert = existingAlerts.find(a => a.queryId === queryId);

        if (existingAlert) {
          existingAlert.frequency++;
          existingAlert.timestamp = entry.timestamp;
          if (entry.executionTimeMs > existingAlert.executionTimeMs) {
            existingAlert.executionTimeMs = entry.executionTimeMs;
          }
        } else {
          const alert: SlowQueryAlert = {
            dbId,
            queryId,
            sql: entry.sql,
            executionTimeMs: entry.executionTimeMs,
            thresholdMs: this.slowQueryThresholdMs,
            timestamp: entry.timestamp,
            frequency: 1,
            recommendations: []
          };
          existingAlerts.push(alert);
        }

        this.slowQueryAlerts.set(dbId, existingAlerts);
      }
    }

    return this.slowQueryAlerts.get(dbId) || [];
  }

  /**
   * Suggest optimized versions of queries
   */
  suggestQueryRewrites(sql: string, schema: DatabaseSchema): QueryOptimizationResult {
    const optimizations: string[] = [];
    let optimizedQuery = sql;
    let performanceGain = 0;

    // Remove unnecessary DISTINCT
    if (/\bDISTINCT\b/i.test(sql) && this.canRemoveDistinct(sql, schema)) {
      optimizedQuery = optimizedQuery.replace(/\bDISTINCT\b/i, '');
      optimizations.push('Removed unnecessary DISTINCT clause');
      performanceGain += 15;
    }

    // Suggest LIMIT for queries without it
    if (!/\bLIMIT\b/i.test(sql) && !/\bCOUNT\b/i.test(sql)) {
      optimizedQuery += ' LIMIT 1000';
      optimizations.push('Added LIMIT clause to prevent large result sets');
      performanceGain += 10;
    }

    // Check for SELECT *
    if (/\bSELECT\s+\*\s+FROM\b/i.test(sql)) {
      optimizations.push('Consider selecting only required columns instead of SELECT *');
      performanceGain += 5;
    }

    // Check for missing WHERE clauses on large tables
    const tables = extractTableNames(sql);
    for (const table of tables) {
      const tableMeta = this.findTableInSchema(schema, table);
      if (tableMeta && !/\bWHERE\b/i.test(sql)) {
        optimizations.push(`Consider adding WHERE clause for table ${table} to reduce data scanned`);
        performanceGain += 20;
      }
    }

    return {
      originalQuery: sql,
      optimizedQuery,
      improvements: optimizations,
      performanceGain: Math.min(100, performanceGain),
      confidence: optimizations.length > 2 ? 'high' : optimizations.length > 0 ? 'medium' : 'low'
    };
  }

  /**
   * Get performance analytics across all queries
   */
  getPerformanceAnalytics(queryHistory: QueryHistoryEntry[]) {
    const analytics = {
      totalQueries: queryHistory.length,
      slowQueries: queryHistory.filter(q => q.executionTimeMs > this.slowQueryThresholdMs).length,
      avgExecutionTime: 0,
      p95ExecutionTime: 0,
      errorRate: 0,
      mostFrequentTables: [] as Array<{ table: string; count: number }>,
      performanceTrend: 'stable' as 'improving' | 'stable' | 'degrading'
    };

    if (queryHistory.length === 0) return analytics;

    // Calculate metrics
    const executionTimes = queryHistory.map(q => q.executionTimeMs).sort((a, b) => a - b);
    analytics.avgExecutionTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
    analytics.p95ExecutionTime = executionTimes[Math.floor(executionTimes.length * 0.95)];
    analytics.errorRate = (queryHistory.filter(q => q.error).length / queryHistory.length) * 100;

    // Table usage analysis
    const tableUsage = new Map<string, number>();
    for (const query of queryHistory) {
      for (const table of query.tables) {
        tableUsage.set(table, (tableUsage.get(table) || 0) + 1);
      }
    }

    analytics.mostFrequentTables = Array.from(tableUsage.entries())
      .map(([table, count]) => ({ table, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Performance trend (simple analysis of recent vs older queries)
    const midpoint = Math.floor(queryHistory.length / 2);
    const recentAvg = executionTimes.slice(midpoint).reduce((a, b) => a + b, 0) / (executionTimes.length - midpoint);
    const olderAvg = executionTimes.slice(0, midpoint).reduce((a, b) => a + b, 0) / midpoint;

    if (recentAvg < olderAvg * 0.8) analytics.performanceTrend = 'improving';
    else if (recentAvg > olderAvg * 1.2) analytics.performanceTrend = 'degrading';

    return analytics;
  }

  // Helper methods

  private countSelectColumns(sql: string): number {
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
    if (!selectMatch) return 0;

    const selectClause = selectMatch[1];
    if (selectClause.includes('*')) return 1;

    return (selectClause.match(/,/g) || []).length + 1;
  }

  private countWhereConditions(sql: string): number {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+(GROUP|ORDER|LIMIT|$))/i);
    if (!whereMatch) return 0;

    const whereClause = whereMatch[1];
    return (whereClause.match(/\bAND\b/gi) || []).length + 1;
  }

  private countJoins(sql: string): number {
    return (sql.match(/\bJOIN\b/gi) || []).length;
  }

  private countSubqueries(sql: string): number {
    return (sql.match(/\(\s*SELECT/gi) || []).length;
  }

  private extractColumnsFromCondition(condition: string, tables: string[], schema: DatabaseSchema): Array<{ table: string; column: string }> {
    const columns: Array<{ table: string; column: string }> = [];

    // Simple column extraction (table.column or just column)
    const columnMatches = condition.match(/\b(\w+\.)?(\w+)\b/g) || [];

    for (const match of columnMatches) {
      if (match.includes('.')) {
        const [table, column] = match.split('.');
        if (tables.includes(table)) {
          columns.push({ table, column });
        }
      } else {
        // Ambiguous column, check all tables
        const column = match;
        for (const table of tables) {
          const tableMeta = this.findTableInSchema(schema, table);
          if (tableMeta?.columns.some(col => col.name === column)) {
            columns.push({ table, column });
            break;
          }
        }
      }
    }

    return columns;
  }

  private analyzeExplainPlan(plan: any): PerformanceBottleneck[] {
    const bottlenecks: PerformanceBottleneck[] = [];

    // This is a simplified analysis - real implementation would parse database-specific EXPLAIN formats
    const planStr = JSON.stringify(plan).toLowerCase();

    if (planStr.includes('table scan') || planStr.includes('seq scan')) {
      bottlenecks.push({
        type: 'table_scan',
        severity: 'high',
        description: 'Full table scan detected - consider adding indexes',
        estimatedCost: 100
      });
    }

    if (planStr.includes('sort') && !planStr.includes('index')) {
      bottlenecks.push({
        type: 'sort',
        severity: 'medium',
        description: 'In-memory sort operation - consider indexed ORDER BY',
        estimatedCost: 50
      });
    }

    return bottlenecks;
  }

  private canRemoveDistinct(sql: string, _schema: DatabaseSchema): boolean {
    // Simple heuristic: if query has GROUP BY or primary key is selected, DISTINCT might be unnecessary
    return /\bGROUP\s+BY\b/i.test(sql) || /\bPRIMARY\s+KEY\b/i.test(sql);
  }

  private findTableInSchema(schema: DatabaseSchema, tableName: string) {
    for (const schemaMeta of schema.schemas) {
      const table = schemaMeta.tables.find(t => t.name === tableName);
      if (table) return table;
    }
    return null;
  }

  private generateQueryId(sql: string): string {
    // Simple hash for query identification
    let hash = 0;
    for (let i = 0; i < sql.length; i++) {
      const char = sql.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }
}