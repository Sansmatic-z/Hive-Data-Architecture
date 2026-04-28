import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('hdaDesktop', {
  platform: process.platform,
  desktop: true,
});
