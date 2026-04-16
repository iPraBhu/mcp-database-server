import pino from 'pino';

let logger: pino.Logger;
let redactSecrets = true;

export function initLogger(
  level: string = 'info',
  pretty: boolean = false,
  redactSecretsEnabled: boolean = true
) {
  redactSecrets = redactSecretsEnabled;
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

export function shouldRedactSecrets(): boolean {
  return redactSecrets;
}
