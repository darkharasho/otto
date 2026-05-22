import log from 'electron-log';
import path from 'node:path';
import os from 'node:os';

const configDir = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'otto')
  : path.join(os.homedir(), '.config', 'otto');

log.transports.file.resolvePathFn = () => path.join(configDir, 'logs', 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB rotate
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';
log.transports.file.level = 'info';

export const logger = log;
export const ottoConfigDir = configDir;
