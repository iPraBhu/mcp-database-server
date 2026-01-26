import pino from 'pino';

let logger: pino.Logger;

export function initLogger(level: string = 'info', pretty: boolean = false) {
  logger = pino({
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
  });
  
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = initLogger();
  }
  return logger;
}
