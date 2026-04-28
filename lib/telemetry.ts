import { configureLogger, LogEntry, LogLevel } from './logger';

declare const __APP_BUILD_METADATA__: {
  version: string;
  protocol: string;
  commit: string;
  buildTime: string;
};

const BUILD_METADATA =
  typeof __APP_BUILD_METADATA__ !== 'undefined'
    ? __APP_BUILD_METADATA__
    : {
        version: '0.0.0',
        protocol: '4.0',
        commit: 'dev',
        buildTime: new Date(0).toISOString(),
      };

const DIAGNOSTICS_KEY = 'hda:diagnostics-opt-in';

function canSend(): boolean {
  return typeof navigator !== 'undefined' && typeof window !== 'undefined';
}

function getEndpoint(kind: 'telemetry' | 'error'): string | null {
  const value =
    kind === 'telemetry'
      ? import.meta.env.VITE_TELEMETRY_ENDPOINT
      : import.meta.env.VITE_ERROR_REPORT_ENDPOINT;
  return value?.trim() ? value : null;
}

export function getDiagnosticsOptIn(): boolean {
  try {
    return localStorage.getItem(DIAGNOSTICS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setDiagnosticsOptIn(enabled: boolean): void {
  try {
    localStorage.setItem(DIAGNOSTICS_KEY, String(enabled));
  } catch {
    // Ignore storage failures.
  }
}

async function postJson(url: string, payload: unknown): Promise<void> {
  if (!canSend()) {
    return;
  }

  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    return;
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === 'string' ? error : 'Unknown error',
  };
}

export function captureError(error: unknown, context: string): void {
  const endpoint = getEndpoint('error');
  if (!endpoint || !getDiagnosticsOptIn()) {
    return;
  }

  void postJson(endpoint, {
    kind: 'app_error',
    context,
    error: serializeError(error),
    build: BUILD_METADATA,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
  });
}

export function initTelemetry(): void {
  const endpoint = getEndpoint('telemetry');
  configureLogger({
    minLevel: import.meta.env.DEV ? LogLevel.DEBUG : LogLevel.INFO,
    remoteHook: (entry: LogEntry) => {
      if (!endpoint || !getDiagnosticsOptIn()) {
        return;
      }
      void postJson(endpoint, {
        kind: 'log',
        entry,
        build: BUILD_METADATA,
        userAgent: navigator.userAgent,
      });
    },
  });

  window.addEventListener('error', (event) => {
    captureError(event.error ?? event.message, 'window.error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    captureError(event.reason, 'window.unhandledrejection');
  });
}
