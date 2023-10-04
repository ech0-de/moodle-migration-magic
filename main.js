import 'water.css';
import './src/style.css';

import { processBackup, processPatchFile, FLAGS } from './src/magic';

function preventDefaults(e) {
  e.stopPropagation();
  e.preventDefault();
}


['dragenter', 'dragover', 'dragleave', 'drop'].forEach((e) => {
  document.body.addEventListener(e, preventDefaults, false);
});

const flags = new Set();
let loadedBackup = null;
let note = document.querySelector('#patch-upload').innerHTML;

function setupFlagPicker(selector) {
  const container = document.createElement('blockquote');

  const b = document.createElement('b');
  b.style.marginBottom = '1em';
  b.style.display = 'block';
  b.innerText = '⚙ Options';

  container.appendChild(b);

  for (const flag of Object.keys(FLAGS)) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.flag = flag;
    input.checked = flags.has(flag);
    input.addEventListener('change', () => {
      if (input.checked) {
        flags.add(flag);
      } else {
        flags.delete(flag);
      }

      document.querySelectorAll(`input[data-flag="${flag}"]`).forEach(e => e.checked = input.checked);
      setupPatchUpload();
    });

    const label = document.createElement('label');
    label.innerText = FLAGS[flag];
    label.insertAdjacentElement('afterbegin', input);

    container.appendChild(label);
  }

  document.querySelector(selector).appendChild(container);
}

function setupFilePicker(selector, description, accept, handleFile) {
  setupFlagPicker(selector);
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

function setupPatchUpload() {
  document.querySelector('#patch-upload').innerHTML = '';

  if (!loadedBackup) {
    document.querySelector('#patch-upload').innerHTML = note;
    return;
  }

  setupFilePicker(
    '#patch-upload',
    `Select your ${flags.has('--files') ? 'zip' : 'xlsx'} patch file using the file dialog or by dragging and dropping it onto the dashed region.`,
    flags.has('--files') ? '.zip' : '.xlsx',
    async (file, loader, form) => {
      const logger = setupLogger('#patch-log');
      const f = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = (e) => reject(e);
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsArrayBuffer(file);
      });
      const patchData = await processPatchFile(f, [...flags], logger);
      if (!patchData) {
        alert('ERROR: patch file is invalid');
      }

      const b = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = (e) => reject(e);
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsArrayBuffer(loadedBackup);
      });

      const result = await processBackup(b, loadedBackup.name, [...flags], patchData, logger);

      const download = document.createElement('a');
      download.innerText = '✅ Download Patched Course Backup';
      download.download = result.name;
      form.appendChild(download);

      const blob = new Blob([result.file], { type: 'application/gzip' });	
      download.href = URL.createObjectURL(blob);

      loader();
    }
  );
}

setupFilePicker(
  '#backup-upload',
  'Select your backup file using the file dialog or by dragging and dropping it onto the dashed region.',
  '.mbz',
  async (backupFile, loader, form) => {
    const logger = setupLogger('#backup-log');
    const b = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = (e) => reject(e);
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsArrayBuffer(backupFile);
    });
    const result = await processBackup(b, backupFile.name, [...flags], false, logger);
    loadedBackup = backupFile;

    const download = document.createElement('a');
    download.innerText = '✅ Download Course Spreadsheet';
    download.download = result.name;
    form.appendChild(download);

    const blob = new Blob([result.file], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });	
    download.href = URL.createObjectURL(blob);

    setupPatchUpload();
    loader();
  }
);

