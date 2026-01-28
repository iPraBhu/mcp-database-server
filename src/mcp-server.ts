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
import { redactUrl } from './utils.js';

export class MCPServer {
  private server: Server;
  private logger = getLogger();

  constructor(
    private _dbManager: DatabaseManager,
    private _config: ServerConfig
  ) {
    this.server = new Server(
      {
        name: 'mcp-database-server',
        version: '1.0.0',
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
          version: '1.0.0',
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
    timeoutMs?: number;
  }) {
    let sql = args.sql;

    // Apply row limit if specified
    if (args.limit && !sql.toUpperCase().includes('LIMIT')) {
      sql += ` LIMIT ${args.limit}`;
    }

    const result = await this._dbManager.runQuery(args.dbId, sql, args.params, args.timeoutMs);

    // Get relevant relationships for the query
    const cacheEntry = await this._dbManager.getSchema(args.dbId);
    const queryStats = this._dbManager.getQueryStats(args.dbId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...result,
              metadata: {
                relationships: cacheEntry.relationships.filter((r) =>
                  result.columns.some(
                    (col) =>
                      col.includes(r.fromTable) ||
                      col.includes(r.toTable)
                  )
                ),
                queryStats,
              },
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
