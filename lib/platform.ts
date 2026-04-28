export interface PlatformCapabilities {
  fileSystemAccess: boolean;
  compressionStreams: boolean;
  persistentSourceHandles: boolean;
  browserLabel: 'Chromium' | 'Firefox' | 'Safari' | 'Unknown';
}

export function getPlatformCapabilities(): PlatformCapabilities {
  const ua = navigator.userAgent;
  const browserLabel =
    /Firefox/i.test(ua) ? 'Firefox' :
    /Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua) ? 'Safari' :
    /Chrome|Chromium|Edg/i.test(ua) ? 'Chromium' :
    'Unknown';

  return {
    fileSystemAccess: 'showSaveFilePicker' in window && 'showOpenFilePicker' in window,
    compressionStreams: typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined',
    persistentSourceHandles: 'showOpenFilePicker' in window,
    browserLabel,
  };
}
