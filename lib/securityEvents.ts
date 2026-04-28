import { createLogger } from './logger';

export type SecurityEventCode =
  | 'archive_corruption_detected'
  | 'wrong_password'
  | 'version_mismatch'
  | 'unsafe_embed_context'
  | 'weak_password'
  | 'file_permission_denied';

export interface SecurityEvent {
  code: SecurityEventCode;
  message: string;
  data?: unknown;
}

const logger = createLogger('security');
const securityEvents: SecurityEvent[] = [];

export function logSecurityEvent(event: SecurityEvent): void {
  securityEvents.push(event);
  if (securityEvents.length > 200) {
    securityEvents.shift();
  }
  logger.warn(event.message, { code: event.code, ...((event.data as object | undefined) ?? {}) });
}

export function getSecurityEvents(): ReadonlyArray<SecurityEvent> {
  return [...securityEvents];
}
