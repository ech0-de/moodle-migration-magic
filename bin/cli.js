#!/usr/bin/env node

import { basename } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { processBackup, processPatchFile, FLAGS } from '../src/magic.js';

const args = process.argv.slice(2).filter(e => !/^-.*/.test(e));
const flags = process.argv.slice(2).filter(e => /^-.*/.test(e));

if (args.length !== 1 && args.length !== 2 || flags.includes('-h') || flags.includes('--help')) {
  console.error('Usage: npx mmm BACKUP.mbz [PATCH.xlsx]');
  console.error();

  const flags = {
      '--help': 'output this help text',
      '--force': 'overwrite output file if it already exists',
      ...FLAGS
  };

  const padding = Math.max(...Object.keys(FLAGS).map(e => e.length));
  const spaces = Array(padding + 3).fill(' ').join('');

  for (const flag of Object.keys(flags)) {
    const words = flags[flag].split(' ');
    let line = ` ${flag.padEnd(padding)}  `;

    while (words.length) {
      while (words.length && (line.length + words[0].length) < 70) {
        line += ` ${words.shift()}`;
      }

      console.error(line);
      line = spaces;
    }
  }

  console.error();
  console.error();
  console.error('Hint: the full documentation of the process is available');
  console.error('      in the web deployment of moodle-migration-magic:');
  console.error('      -> https://ech0-de.github.io/moodle-migration-magic/');
  console.error();
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
  patchData = await processPatchFile(file, flags);
  if (!patchData) {
    console.error('ERROR: patch file is invalid');
  }
}

const backupFile = await readFile(args[0]);
const result = await processBackup(backupFile, basename(args[0]), patchData, {}, flags);

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
