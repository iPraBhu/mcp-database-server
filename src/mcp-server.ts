import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DatabaseManager } from './database-manager.js';
import { ServerConfig } from './types.js';
import { getLogger } from './logger.js';
import {
  extractTableNames,
  formatCsvValue,
  isReadOnlyQuery,
  limitRows,
  pushDownResultLimit,
  redactUrl,
  serializeCsvRow,
  trimRowsBySerializedSize,
} from './utils.js';

export class MCPServer {
  private server: Server;
  private logger = getLogger();

  constructor(
    private _dbManager: DatabaseManager,
    private _config: ServerConfig,
    private _version: string
  ) {
    this.server = new Server(
      {
        name: 'mcp-database-server',
        version: this._version,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle initialization
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      const { protocolVersion } = request.params;
      this.logger.info({ protocolVersion }, 'MCP server initializing');

      return {
        protocolVersion,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: 'mcp-database-server',
          version: this._version,
        },
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_databases',
          description: 'List all configured databases with their status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'introspect_schema',
          description: 'Introspect database schema and cache it',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID to introspect',
              },
              forceRefresh: {
                type: 'boolean',
                description: 'Force refresh even if cached',
                default: false,
              },
              schemaFilter: {
                type: 'object',
                description: 'Optional schema filtering options',
                properties: {
                  includeSchemas: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  excludeSchemas: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  includeViews: { type: 'boolean' },
                  maxTables: { type: 'number' },
                },
              },
            },
            required: ['dbId'],
          },
        },
        {
          name: 'get_schema',
          description: 'Get cached schema metadata',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              schema: {
                type: 'string',
                description: 'Optional schema name to filter',
              },
              table: {
                type: 'string',
                description: 'Optional table name to filter',
              },
            },
            required: ['dbId'],
          },
        },
        {
          name: 'run_query',
          description: 'Execute SQL query against a database',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              sql: {
                type: 'string',
                description: 'SQL query to execute',
              },
              params: {
                type: 'array',
                description: 'Query parameters',
                items: {},
              },
              limit: {
                type: 'number',
                description: 'Maximum number of rows to return',
              },
              offset: {
                type: 'number',
                description: 'Optional row offset for paginated reads. Requires limit.',
              },
              maxBytes: {
                type: 'number',
                description: 'Approximate max serialized bytes for returned rows.',
              },
              includeMetadata: {
                type: 'boolean',
                description: 'Include relationship and query statistics metadata in the response.',
                default: true,
              },
              trackQuery: {
                type: 'boolean',
                description: 'Track this query in history and performance analytics. Default: true.',
                default: true,
              },
              timeoutMs: {
                type: 'number',
                description: 'Query timeout in milliseconds',
              },
            },
            required: ['dbId', 'sql'],
          },
        },
        {
          name: 'explain_query',
          description: 'Get query execution plan',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              sql: {
                type: 'string',
                description: 'SQL query to explain',
              },
              params: {
                type: 'array',
                description: 'Query parameters',
                items: {},
              },
            },
            required: ['dbId', 'sql'],
          },
        },
        {
          name: 'export_query',
          description: 'Export large read-only query results to a local file',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              sql: {
                type: 'string',
                description: 'Read-only SQL query to export',
              },
              params: {
                type: 'array',
                description: 'Query parameters',
                items: {},
              },
              format: {
                type: 'string',
                enum: ['jsonl', 'csv'],
                description: 'Output file format',
              },
              pageSize: {
                type: 'number',
                description: 'Page size for non-streaming adapters',
              },
              fileName: {
                type: 'string',
                description: 'Optional output file name written inside the export directory',
              },
              timeoutMs: {
                type: 'number',
                description: 'Query timeout in milliseconds',
              },
            },
            required: ['dbId', 'sql'],
          },
        },
        {
          name: 'suggest_joins',
          description: 'Suggest join paths between tables based on relationships',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              tables: {
                type: 'array',
                description: 'List of table names to join',
                items: { type: 'string' },
                minItems: 2,
              },
            },
            required: ['dbId', 'tables'],
          },
        },
        {
          name: 'clear_cache',
          description: 'Clear schema cache',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Optional database ID (clears all if omitted)',
              },
            },
          },
        },
        {
          name: 'cache_status',
          description: 'Get cache status and statistics',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Optional database ID',
              },
            },
          },
        },
        {
          name: 'health_check',
          description: 'Check database connectivity and get version info',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Optional database ID (checks all if omitted)',
              },
            },
          },
        },
        {
          name: 'analyze_performance',
          description: 'Get detailed performance analytics for a database',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID to analyze',
              },
            },
            required: ['dbId'],
          },
        },
        {
          name: 'suggest_indexes',
          description: 'Analyze query patterns and suggest optimal indexes',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID to analyze',
              },
            },
            required: ['dbId'],
          },
        },
        {
          name: 'detect_slow_queries',
          description: 'Identify and alert on slow-running queries',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID to analyze',
              },
            },
            required: ['dbId'],
          },
        },
        {
          name: 'rewrite_query',
          description: 'Suggest optimized versions of SQL queries',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              sql: {
                type: 'string',
                description: 'SQL query to optimize',
              },
            },
            required: ['dbId', 'sql'],
          },
        },
        {
          name: 'profile_query',
          description: 'Profile query performance with detailed analysis',
          inputSchema: {
            type: 'object',
            properties: {
              dbId: {
                type: 'string',
                description: 'Database ID',
              },
              sql: {
                type: 'string',
                description: 'SQL query to profile',
              },
              params: {
                type: 'array',
                description: 'Query parameters',
                items: {},
              },
            },
            required: ['dbId', 'sql'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_databases':
            return await this.handleListDatabases();

          case 'introspect_schema':
            return await this.handleIntrospectSchema(args as any);

          case 'get_schema':
            return await this.handleGetSchema(args as any);

          case 'run_query':
            return await this.handleRunQuery(args as any);

          case 'explain_query':
            return await this.handleExplainQuery(args as any);

          case 'export_query':
            return await this.handleExportQuery(args as any);

          case 'suggest_joins':
            return await this.handleSuggestJoins(args as any);

          case 'clear_cache':
            return await this.handleClearCache(args as any);

          case 'cache_status':
            return await this.handleCacheStatus(args as any);

          case 'health_check':
            return await this.handleHealthCheck(args as any);

          case 'analyze_performance':
            return await this.handleAnalyzePerformance(args as any);

          case 'suggest_indexes':
            return await this.handleSuggestIndexes(args as any);

          case 'detect_slow_queries':
            return await this.handleDetectSlowQueries(args as any);

          case 'rewrite_query':
            return await this.handleRewriteQuery(args as any);

          case 'profile_query':
            return await this.handleProfileQuery(args as any);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        this.logger.error({ tool: name, error }, 'Tool execution failed');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error.message,
                code: error.code || 'TOOL_ERROR',
              }),
            },
          ],
        };
      }
    });

    // List resources (cached schemas)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const statuses = await this._dbManager.getCacheStatus();
      const resources = statuses
        .filter((s) => s.exists)
        .map((s) => ({
          uri: `schema://${s.dbId}`,
          name: `Schema: ${s.dbId}`,
          description: `Cached schema for ${s.dbId} (${s.tableCount} tables, ${s.relationshipCount} relationships)`,
          mimeType: 'application/json',
        }));

      return { resources };
    });

    // Read resource (return cached schema)
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^schema:\/\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const dbId = match[1];
      const cacheEntry = await this._dbManager.getSchema(dbId);

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(cacheEntry, null, 2),
          },
        ],
      };
    });
  }

  private async handleListDatabases() {
    const configs = this._dbManager.getConfigs();
    const statuses = await Promise.all(
      configs.map(async (config) => {
        const connected = await this._dbManager.testConnection(config.id);
        const cacheStatus = (await this._dbManager.getCacheStatus(config.id))[0];

        return {
          id: config.id,
          type: config.type,
          url: this._config.security?.redactSecrets ? redactUrl(config.url || '') : config.url,
          connected,
          cached: cacheStatus?.exists || false,
          cacheAge: cacheStatus?.age,
          version: cacheStatus?.version,
        };
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(statuses, null, 2),
        },
      ],
    };
  }

  private async handleIntrospectSchema(args: {
    dbId: string;
    forceRefresh?: boolean;
    schemaFilter?: any;
  }) {
    const result = await this._dbManager.introspectSchema(
      args.dbId,
      args.forceRefresh || false,
      args.schemaFilter
    );

    const summary = {
      dbId: args.dbId,
      version: result.schema.version,
      introspectedAt: result.schema.introspectedAt,
      schemas: result.schema.schemas.map((s) => ({
        name: s.name,
        tableCount: s.tables.length,
        viewCount: s.tables.filter((t) => t.type === 'view').length,
      })),
      totalTables: result.schema.schemas.reduce((sum, s) => sum + s.tables.length, 0),
      totalRelationships: result.relationships.length,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async handleGetSchema(args: { dbId: string; schema?: string; table?: string }) {
    const cacheEntry = await this._dbManager.getSchema(args.dbId);
    let result: any = cacheEntry.schema;

    // Filter by schema
    if (args.schema) {
      result = {
        ...result,
        schemas: result.schemas.filter((s: any) => s.name === args.schema),
      };
    }

    // Filter by table
    if (args.table) {
      result = {
        ...result,
        schemas: result.schemas.map((s: any) => ({
          ...s,
          tables: s.tables.filter((t: any) => t.name === args.table),
        })),
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleRunQuery(args: {
    dbId: string;
    sql: string;
    params?: any[];
    limit?: number;
    offset?: number;
    maxBytes?: number;
    includeMetadata?: boolean;
    trackQuery?: boolean;
    timeoutMs?: number;
  }) {
    if (args.offset !== undefined && args.limit === undefined) {
      throw new Error('offset requires limit');
    }

    const config = this._dbManager.getConfig(args.dbId);
    if (!config) {
      throw new Error(`Database not found: ${args.dbId}`);
    }

    const paginationLimit =
      args.limit !== undefined && args.limit >= 0 ? Math.floor(args.limit) : undefined;
    const paginationOffset =
      args.offset !== undefined && args.offset >= 0 ? Math.floor(args.offset) : 0;
    const fetchLimit =
      paginationLimit !== undefined ? paginationLimit + 1 : paginationLimit;
    const includeMetadata = args.includeMetadata !== false;
    const trackQuery = args.trackQuery !== false;

    const limitedQuery = pushDownResultLimit(args.sql, fetchLimit, config.type, paginationOffset);
    const rawResult = await this._dbManager.runQuery(
      args.dbId,
      limitedQuery.sql,
      args.params,
      args.timeoutMs,
      includeMetadata,
      trackQuery
    );
    const hasMore =
      paginationLimit !== undefined
        ? limitedQuery.applied
          ? rawResult.rows.length > paginationLimit
          : rawResult.rows.length > paginationOffset + paginationLimit
        : false;
    const pagedResult = limitRows(
      rawResult,
      paginationLimit,
      limitedQuery.applied ? 0 : paginationOffset
    );
    const sizedResult = trimRowsBySerializedSize(pagedResult, args.maxBytes);
    const result = sizedResult.result;
    const effectiveHasMore = hasMore || sizedResult.truncated;

    let metadata;
    if (includeMetadata) {
      const queryStats = this._dbManager.getQueryStats(args.dbId);
      const referencedTables = new Set(extractTableNames(args.sql));
      const includeRelationships = isReadOnlyQuery(args.sql) && referencedTables.size > 0;
      const relationships = includeRelationships
        ? (await this._dbManager.getSchema(args.dbId)).relationships.filter((r) =>
            referencedTables.has(`${r.fromSchema}.${r.fromTable}`.toLowerCase()) ||
            referencedTables.has(`${r.toSchema}.${r.toTable}`.toLowerCase()) ||
            referencedTables.has(r.fromTable.toLowerCase()) ||
            referencedTables.has(r.toTable.toLowerCase())
          )
        : [];

      metadata = {
        relationships,
        queryStats,
        limitPushdownApplied: limitedQuery.applied,
        pagination:
          paginationLimit !== undefined
            ? {
                limit: paginationLimit,
                offset: paginationOffset,
                hasMore: effectiveHasMore,
                nextOffset: effectiveHasMore ? paginationOffset + result.rowCount : null,
              }
            : undefined,
        responseSize:
          args.maxBytes !== undefined
            ? {
                maxBytes: Math.floor(args.maxBytes),
                rowsBytes: sizedResult.sizeBytes,
                rowsTrimmed: sizedResult.truncated,
                omittedRowCount: sizedResult.omittedRowCount,
              }
            : undefined,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...result,
              ...(metadata ? { metadata } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleExplainQuery(args: { dbId: string; sql: string; params?: any[] }) {
    const result = await this._dbManager.explainQuery(args.dbId, args.sql, args.params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleExportQuery(args: {
    dbId: string;
    sql: string;
    params?: any[];
    format?: 'jsonl' | 'csv';
    pageSize?: number;
    fileName?: string;
    timeoutMs?: number;
  }) {
    const config = this._dbManager.getConfig(args.dbId);
    if (!config) {
      throw new Error(`Database not found: ${args.dbId}`);
    }

    const format = args.format === 'csv' ? 'csv' : 'jsonl';
    const pageSize = args.pageSize !== undefined && args.pageSize > 0 ? Math.floor(args.pageSize) : 1000;
    const exportDir = path.resolve(this._config.cache?.directory || '.sql-mcp-cache', 'exports');
    await fsPromises.mkdir(exportDir, { recursive: true });

    const defaultFileName = `${args.dbId}-${Date.now()}.${format}`;
    const requestedFileName = args.fileName ? path.basename(args.fileName) : defaultFileName;
    const outputFileName = path.extname(requestedFileName)
      ? requestedFileName
      : `${requestedFileName}.${format}`;
    const outputPath = path.join(exportDir, outputFileName);

    const writer = fs.createWriteStream(outputPath, { encoding: 'utf8' });
    let columns: string[] = [];
    let rowsExported = 0;
    let wroteCsvHeader = false;
    let strategy: 'stream' | 'paged' = 'paged';
    let executionTimeMs = 0;
    let pages = 0;

    const writeChunk = async (chunk: string) =>
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          writer.off('drain', onDrain);
          reject(error);
        };
        const onDrain = () => {
          writer.off('error', onError);
          resolve();
        };

        writer.once('error', onError);
        if (writer.write(chunk, 'utf8')) {
          writer.off('error', onError);
          resolve();
        } else {
          writer.once('drain', onDrain);
        }
      });

    const closeWriter = async () =>
      await new Promise<void>((resolve, reject) => {
        writer.once('error', reject);
        writer.end(() => resolve());
      });

    const ensureCsvHeader = async () => {
      if (format !== 'csv' || wroteCsvHeader || columns.length === 0) {
        return;
      }

      await writeChunk(`${columns.map((column) => formatCsvValue(column)).join(',')}\n`);
      wroteCsvHeader = true;
    };

    const writeRow = async (row: Record<string, unknown>) => {
      if (columns.length === 0) {
        columns = Object.keys(row);
      }

      await ensureCsvHeader();
      await writeChunk(
        format === 'jsonl' ? `${JSON.stringify(row)}\n` : `${serializeCsvRow(row, columns)}\n`
      );
      rowsExported++;
    };

    try {
      const streamResult = await this._dbManager.streamReadQuery(
        args.dbId,
        args.sql,
        args.params,
        args.timeoutMs,
        {
          onColumns: async (nextColumns) => {
            if (columns.length === 0) {
              columns = nextColumns;
            }
            await ensureCsvHeader();
          },
          onRow: async (row) => {
            await writeRow(row);
          },
        }
      );

      if (streamResult) {
        strategy = 'stream';
        executionTimeMs = streamResult.executionTimeMs;
        if (columns.length === 0 && streamResult.columns.length > 0) {
          columns = streamResult.columns;
          await ensureCsvHeader();
        }
      } else {
        let offset = 0;

        while (true) {
          const pagedQuery = pushDownResultLimit(args.sql, pageSize + 1, config.type, offset);
          if (!pagedQuery.applied) {
            throw new Error(
              'export_query requires a pushdown-compatible read-only query for this adapter. For MySQL/MariaDB, streaming export is used automatically. For other adapters, avoid top-level LIMIT/OFFSET.'
            );
          }

          const result = await this._dbManager.runReadQueryPage(
            args.dbId,
            pagedQuery.sql,
            args.params,
            args.timeoutMs
          );
          executionTimeMs += result.executionTimeMs;
          pages++;

          if (columns.length === 0 && result.columns.length > 0) {
            columns = result.columns;
            await ensureCsvHeader();
          }

          const hasMore = result.rows.length > pageSize;
          const rows = result.rows.slice(0, pageSize);

          for (const row of rows) {
            await writeRow(row);
          }

          offset += rows.length;
          if (!hasMore || rows.length === 0) {
            break;
          }
        }
      }

      await closeWriter();
      const stats = await fsPromises.stat(outputPath);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                dbId: args.dbId,
                outputPath,
                format,
                strategy,
                rowsExported,
                columns,
                fileSizeBytes: stats.size,
                executionTimeMs,
                pageSize: strategy === 'paged' ? pageSize : undefined,
                pages: strategy === 'paged' ? pages : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      writer.destroy();
      await fsPromises.unlink(outputPath).catch(() => undefined);
      throw error;
    }
  }

  private async handleSuggestJoins(args: { dbId: string; tables: string[] }) {
    const joinPaths = await this._dbManager.suggestJoins(args.dbId, args.tables);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(joinPaths, null, 2),
        },
      ],
    };
  }

  private async handleClearCache(args: { dbId?: string }) {
    await this._dbManager.clearCache(args.dbId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: args.dbId ? `Cache cleared for ${args.dbId}` : 'All caches cleared',
          }),
        },
      ],
    };
  }

  private async handleCacheStatus(args: { dbId?: string }) {
    const statuses = await this._dbManager.getCacheStatus(args.dbId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(statuses, null, 2),
        },
      ],
    };
  }

  private async handleHealthCheck(args: { dbId?: string }) {
    const configs = args.dbId
      ? [this._dbManager.getConfig(args.dbId)!]
      : this._dbManager.getConfigs();

    const results = await Promise.all(
      configs.map(async (config) => {
        try {
          const connected = await this._dbManager.testConnection(config.id);
          const version = connected ? await this._dbManager.getVersion(config.id) : 'N/A';

          return {
            dbId: config.id,
            healthy: connected,
            version,
          };
        } catch (error: any) {
          return {
            dbId: config.id,
            healthy: false,
            error: error.message,
          };
        }
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async handleAnalyzePerformance(args: { dbId: string }) {
    const analytics = this._dbManager.getPerformanceAnalytics(args.dbId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(analytics, null, 2),
        },
      ],
    };
  }

  private async handleSuggestIndexes(args: { dbId: string }) {
    const recommendations = await this._dbManager.getIndexRecommendations(args.dbId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(recommendations, null, 2),
        },
      ],
    };
  }

  private async handleDetectSlowQueries(args: { dbId: string }) {
    const alerts = this._dbManager.getSlowQueryAlerts(args.dbId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(alerts, null, 2),
        },
      ],
    };
  }

  private async handleRewriteQuery(args: { dbId: string; sql: string }) {
    const suggestion = await this._dbManager.suggestQueryRewrite(args.dbId, args.sql);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(suggestion, null, 2),
        },
      ],
    };
  }

  private async handleProfileQuery(args: {
    dbId: string;
    sql: string;
    params?: any[];
  }) {
    const profile = await this._dbManager.profileQueryPerformance(args.dbId, args.sql, args.params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(profile, null, 2),
        },
      ],
    };
  }

  async start(): Promise<void> {
    console.error('Starting MCP server...');
    const transport = new StdioServerTransport();
    console.error('Created transport, connecting...');
    await this.server.connect(transport);
    console.error('MCP server connected and started');
    this.logger.info('MCP server started');
  }
}
