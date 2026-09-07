import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the host keeps its configuration and logs (plan sections 38 and 39).
 *
 * `BRB_DATA_DIR` overrides everything. That exists for the tests, which must
 * never touch a developer's real config, and it is also the escape hatch for a
 * locked-down machine where %APPDATA% is not writable.
 */
export const DATA_DIR_ENV = 'BRB_DATA_DIR';

const APP_FOLDER = 'BooksyReceiptBridge';

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_DIR_ENV];
  if (override !== undefined && override !== '') return override;

  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData !== undefined && appData !== '') return join(appData, APP_FOLDER);
    return join(homedir(), 'AppData', 'Roaming', APP_FOLDER);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_FOLDER);
  }
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return join(xdg, APP_FOLDER);
  return join(homedir(), '.config', APP_FOLDER);
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'config.json');
}

export function logDir(env?: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'logs');
}
