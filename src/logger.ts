import pino from 'pino';

let logger: pino.Logger;

export function initLogger(level: string = 'info', pretty: boolean = false) {
  logger = pino(
    {
      level,
      transport: pretty
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
    pino.destination({ dest: 2, sync: false }) // Write to stderr (fd 2) for MCP protocol compatibility
  );
  
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = initLogger();
  }
  return logger;
}
