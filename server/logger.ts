export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(`[passage] ${message}`),
  warn: (message) => console.warn(`[passage] ${message}`),
  error: (message) => console.error(`[passage] ${message}`),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
