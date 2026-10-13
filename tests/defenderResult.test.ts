import { describe, expect, it } from 'vitest';
import { parseDefenderResult } from '../electron/security';

describe('parseDefenderResult', () => {
  it('reads a clean scan', () => {
    expect(parseDefenderResult(0, 'Scan starting...\nScan finished.\nScanning mod.zip found no threats.').status).toBe('clean');
  });
  it('reads a real detection', () => {
    const out = 'Scan starting...\nScan finished.\nScanning mod.zip found 1 threats.\n\nThreat                  : Trojan:Win32/Test\n';
    expect(parseDefenderResult(2, out).status).toBe('threat');
  });
  it('does not call a failed scan a threat (Defender off: exit 2 + 0x80004005)', () => {
    const r = parseDefenderResult(2, '[Failed][0x80004005] Unspecified error\nCmdTool: Failed with hr = 0x80004005.');
    expect(r.status).toBe('unavailable');
  });
});
