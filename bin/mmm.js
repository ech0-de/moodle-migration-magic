#!/usr/bin/env node

import { basename } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { processBackup, processPatchFile } from '../src/magic.js';

const args = process.argv.slice(2).filter(e => !/^-.*/.test(e));
const flags = process.argv.slice(2).filter(e => /^-.*/.test(e));

if (args.length !== 1 && args.length !== 2 || flags.includes('-h') || flags.includes('--help')) {
  console.error('Usage: npx mmm BACKUP.mbz [PATCH.xlsx]');
  console.error();
  console.error(' --help    output this help text');
  console.error(' --force   overwrite output file if it already exists');
  console.error(' --files   produce and consume a zip patch file that');
  console.error('           also contains editable activity contents');

  process.exit(1);
}

(await Promise.allSettled(args.map(e => stat(e)))).forEach((e, i) => {
  if (e.status === 'rejected') {
    console.error('ERROR: error reading file "%s"', args[i]);
    process.exit(2);
  }
});


let patchData = false;
if (args.length === 2) {
  const file = await readFile(args[1]);
  patchData = await processPatchFile(file);
  if (!patchData) {
    console.error('ERROR: patch file is invalid');
  }
}

const backupFile = await readFile(args[0]);
const result = await processBackup(backupFile, basename(args[0]), patchData);

try {
  const s = await stat(result.name);
  if (!flags.includes('--force')) {
    console.error('ERROR: output file already exists and --force is not set');
    process.exit(3);
  }
} catch {
  // ignore
}

try {
  await writeFile(result.name, Buffer.from(result.file));
} catch (e) {
  console.error('ERROR: error writing file "%s"', result.name);
  console.error(e);
  process.exit(4);
}
