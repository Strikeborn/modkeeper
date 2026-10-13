import os from 'node:os';
import path from 'node:path';

/**
 * ModKeeper's data folder: %APPDATA%\mod-hub (the old name, kept so existing data carries over).
 * MODKEEPER_DATA_DIR overrides it, e.g. to try a fresh profile or run portable. No electron import,
 * so probes and tests can use it too.
 */
export function dataDir(): string {
  const override = process.env.MODKEEPER_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(process.env.APPDATA ?? os.homedir(), 'mod-hub');
}
