import 'water.css';
import './src/style.css';

import { processBackup, processPatchFile } from './src/magic';

function preventDefaults(e) {
  e.stopPropagation();
  e.preventDefault();
}


['dragenter', 'dragover', 'dragleave', 'drop'].forEach((e) => {
  document.body.addEventListener(e, preventDefaults, false);
});

function setupFilePicker(selector, description, accept, handleFile) {
  const p = document.createElement('p');
  p.innerText = description;

  const setupLoader = async (file) => {
    if (file) {
      try {
        await new Promise((resolve) => {
          form.classList.add('loading');
          input.disabled = true;
          handleFile(file, resolve, form);
        });
      } finally {
        form.classList.remove('loading');
        input.disabled = false;
      }
    }
  };

  const input = document.createElement('input');
  input.accept = accept; 
  input.type = 'file';
  input.addEventListener('change', () => setupLoader(input?.files[0]), false);

  const form = document.createElement('form');
  form.className = 'drop-area';
  form.appendChild(p);
  form.appendChild(input);

  document.querySelector(selector).appendChild(form);

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => form.addEventListener(e, preventDefaults, false));
  ['dragenter', 'dragover'].forEach(e => form.addEventListener(e, () => form.classList.add('highlight'), false));
  ['dragleave', 'drop'].forEach(e => form.addEventListener(e, () => form.classList.remove('highlight'), false));
  form.addEventListener('drop', (e) => setupLoader(e.dataTransfer?.files?.[0]), false);
}

function setupLogger(selector) {
  return (...s) => {
    console.log(...s);
    try {
      document.querySelector(selector).innerText += [...s].map(e => typeof e === 'object' ? JSON.stringify(e) : e).join(' ') + '\n';
    } catch {
      // ignore
    }
  };
}

setupFilePicker(
  '#backup-upload',
  'Select your backup file using the file dialog or by dragging and dropping it onto the dashed region.',
  '.mbz',
  async (backupFile, loader, form) => {
    const logger = setupLogger('#backup-log');
    const result = await processBackup(backupFile, false, logger);

    const download = document.createElement('a');
    download.innerText = '✅ Download Course Spreadsheet'
    download.download = result.name;
    form.appendChild(download);

    const blob = new Blob([result.file], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });	
    download.href = URL.createObjectURL(blob);

    document.querySelector('#patch-upload').innerHTML = '';

    setupFilePicker(
      '#patch-upload',
      'Select your xlsx patch file using the file dialog or by dragging and dropping it onto the dashed region.',
      '.xlsx',
      async (file, loader, form) => {
        const logger = setupLogger('#patch-log');
        const patchData = await processPatchFile(file, logger);
        if (!patchData) {
          alert('ERROR: patch file is invalid');
        }

        const result = await processBackup(backupFile, patchData, logger);

        const download = document.createElement('a');
        download.innerText = '✅ Download Patched Course Backup'
        download.download = result.name;
        form.appendChild(download);

        const blob = new Blob([result.file], { type: 'application/gzip' });	
        download.href = URL.createObjectURL(blob);

        loader();
      }
    );

    loader();
  }

);

