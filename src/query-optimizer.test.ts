import { describe, expect, it } from 'vitest';
import { QueryOptimizer } from './query-optimizer.js';
import type { QueryHistoryEntry } from './types.js';

describe('QueryOptimizer', () => {
  it('should not double count slow-query alerts when read multiple times', () => {
    const optimizer = new QueryOptimizer();
    const history: QueryHistoryEntry[] = [
      {
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sql: 'SELECT * FROM users',
        tables: ['users'],
        executionTimeMs: 1500,
        rowCount: 10,
      },
    ];

    const first = optimizer.detectSlowQueries(history, 'db1');
    const second = optimizer.detectSlowQueries(history, 'db1');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].frequency).toBe(1);
  });

  it('should compute performance trend from chronological history, not sorted timings', () => {
    const optimizer = new QueryOptimizer();
    const history: QueryHistoryEntry[] = [
      {
        timestamp: new Date('2026-01-01T00:00:00Z'),
        sql: 'SELECT * FROM users',
        tables: ['users'],
        executionTimeMs: 2000,
        rowCount: 10,
      },
      {
        timestamp: new Date('2026-01-01T00:01:00Z'),
        sql: 'SELECT * FROM users',
        tables: ['users'],
        executionTimeMs: 1800,
        rowCount: 10,
      },
      {
        timestamp: new Date('2026-01-01T00:02:00Z'),
        sql: 'SELECT * FROM users',
        tables: ['users'],
        executionTimeMs: 200,
        rowCount: 10,
      },
      {
        timestamp: new Date('2026-01-01T00:03:00Z'),
        sql: 'SELECT * FROM users',
        tables: ['users'],
        executionTimeMs: 100,
        rowCount: 10,
      },
    ];

    const analytics = optimizer.getPerformanceAnalytics(history);

    expect(analytics.performanceTrend).toBe('improving');
  });
});
