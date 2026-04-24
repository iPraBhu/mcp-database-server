import pino from 'pino';

let logger: pino.Logger;
let redactSecrets = true;

export function initLogger(
  level: string = 'info',
  pretty: boolean = false,
  redactSecretsEnabled: boolean = true
) {
  redactSecrets = redactSecretsEnabled;
  // IMPORTANT: MCP uses stdout for JSON-RPC. Any logging to stdout can corrupt the protocol stream.
  // Always direct logs to stderr (fd 2), including pretty-print output.
  if (pretty) {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: 2,
      },
    });
    logger = pino({ level }, transport);
  } else {
    logger = pino({ level }, pino.destination({ dest: 2, sync: false }));
  }
  
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
