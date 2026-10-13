// Probe: scan the emulation library (read-only) and print a summary.
import os from 'node:os';
import path from 'node:path';
import { scanEmulationLibrary, defaultEmulationRoot } from '../electron/emulation.ts';

const lib = await scanEmulationLibrary(process.argv[2] || defaultEmulationRoot(), path.join(os.tmpdir(), 'modhub-emu-probe'));
console.log('root', lib.root, 'exists', lib.exists);
console.log('systems', JSON.stringify(lib.systems));
for (const r of lib.roms) console.log(r.system.padEnd(5), (r.title + (r.region ? ` [${r.region}]` : '')).padEnd(60), r.tags.join('|').padEnd(14), r.hack ? 'HACK' : '', r.duplicateCount ? `dup${r.duplicateCount}` : '', r.hasSave ? 'save' : '', r.stateCount ? `${r.stateCount}st` : '', r.location);
console.log('emulators', lib.emulators.map((e) => `${e.id}: ${e.detail ?? e.exe}`));
console.log('synced', JSON.stringify(lib.synced));
console.log('sohMods', lib.sohMods.map((m) => m.file));
