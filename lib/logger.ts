/**
 * Structured Logger for HDA Vault
 * Provides leveled, contextual logging for client-side debugging.
 * Supports console output + optional remote hook for production telemetry.
 */

/// <reference types="vite/client" />

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  context: string;
  message: string;
  data?: unknown;
}

export interface LoggerConfig {
  minLevel: LogLevel;
  maxEntries: number;
  remoteHook?: (entry: LogEntry) => void;
}

const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: import.meta.env.DEV ? LogLevel.DEBUG : LogLevel.INFO,
  maxEntries: 100,
};

let config: LoggerConfig = { ...DEFAULT_CONFIG };
const logHistory: LogEntry[] = [];

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DBG',
  [LogLevel.INFO]: 'INF',
  [LogLevel.WARN]: 'WRN',
  [LogLevel.ERROR]: 'ERR',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '#64748b',
  [LogLevel.INFO]: '#818cf8',
  [LogLevel.WARN]: '#fbbf24',
  [LogLevel.ERROR]: '#ef4444',
};

function formatTimestamp(): string {
  return new Date().toISOString();
}

function addToHistory(entry: LogEntry): void {
  logHistory.push(entry);
  if (logHistory.length > config.maxEntries) {
    logHistory.shift();
  }
}

function writeToConsole(entry: LogEntry): void {
  const color = LEVEL_COLORS[entry.level];
  const prefix = `%c[${LEVEL_LABELS[entry.level]}]%c [${entry.context}]`;

  switch (entry.level) {
    case LogLevel.DEBUG:
      console.debug(prefix, `color: ${color}`, 'color: inherit', entry.message, entry.data ?? '');
      break;
    case LogLevel.INFO:
      console.info(prefix, `color: ${color}`, 'color: inherit', entry.message, entry.data ?? '');
      break;
    case LogLevel.WARN:
      console.warn(prefix, `color: ${color}`, 'color: inherit', entry.message, entry.data ?? '');
      break;
    case LogLevel.ERROR:
      console.error(prefix, `color: ${color}`, 'color: inherit', entry.message, entry.data ?? '');
      break;
  }
}

export function createLogger(context: string) {
  return {
    debug(message: string, data?: unknown): void {
      if (config.minLevel > LogLevel.DEBUG) return;
      const entry: LogEntry = {
        level: LogLevel.DEBUG,
        timestamp: formatTimestamp(),
        context,
        message,
        data,
      };
      addToHistory(entry);
      writeToConsole(entry);
      config.remoteHook?.(entry);
    },

    info(message: string, data?: unknown): void {
      if (config.minLevel > LogLevel.INFO) return;
      const entry: LogEntry = {
        level: LogLevel.INFO,
        timestamp: formatTimestamp(),
        context,
        message,
        data,
      };
      addToHistory(entry);
      writeToConsole(entry);
      config.remoteHook?.(entry);
    },

    warn(message: string, data?: unknown): void {
      if (config.minLevel > LogLevel.WARN) return;
      const entry: LogEntry = {
        level: LogLevel.WARN,
        timestamp: formatTimestamp(),
        context,
        message,
        data,
      };
      addToHistory(entry);
      writeToConsole(entry);
      config.remoteHook?.(entry);
    },

    error(message: string, data?: unknown): void {
      const entry: LogEntry = {
        level: LogLevel.ERROR,
        timestamp: formatTimestamp(),
        context,
        message,
        data,
      };
      addToHistory(entry);
      writeToConsole(entry);
      config.remoteHook?.(entry);
    },

    getHistory(): ReadonlyArray<LogEntry> {
      return [...logHistory];
    },

    clearHistory(): void {
      logHistory.length = 0;
    },
  };
}

export function configureLogger(newConfig: Partial<LoggerConfig>): void {
  config = { ...config, ...newConfig };
}

export { logHistory };
