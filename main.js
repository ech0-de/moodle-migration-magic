import 'water.css';
import './src/style.css';

import { extractAttachment, processBackup, processPatchFile, FLAGS } from './src/magic';
import prettyBytes from 'pretty-bytes';

function preventDefaults(e) {
  e.stopPropagation();
  e.preventDefault();
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((e) => {
  document.body.addEventListener(e, preventDefaults, false);
});

const flags = new Set();
let patchURL = null;
let patchData = null;
let loadedBackup = null;
let updatedAttachments = {};
let note = document.querySelector('#patch-upload').innerHTML;
let downloadNote = document.querySelector('#patch-download').innerHTML;

function setupFlagPicker(selector) {
  if (!Object.keys(FLAGS).length) {
    return;
  }

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

function updatePreview(result) {
  const preview = document.querySelector('#course-preview');
  preview.innerHTML = '';
  let section = null;

  for (const row of result.rows) {
    const patched = patchData ? patchData.get(row.id) : null;
    if (row.id.startsWith('section_')) {
      const title = document.createElement('b');
      title.innerText = patched?.name || row.name;

      section = document.createElement('ul');

      preview.appendChild(title);
      preview.appendChild(section);
    } else {
      const element = document.createElement('li');
      element.innerText = `[${row.id}] ${patched?.name || row.name}`;
      section.appendChild(element);

      if (row.content) {
        const content = document.createElement('blockquote');
        content.style.paddingBlock = '0em';
        content.style.fontSize = '80%';
        content.innerHTML = patched?.content || row.content;
        for (const e of content.querySelectorAll('img')) {
          try {
            const src = new URL(e.src).pathname.replace(location.pathname, '');
            e.alt = `${e.alt || ''} (${src})`.trim();
            e.src = `#${src}`;
          } catch {
            e.alt = `${e.alt || ''} (${e.src})`.trim();
          }
        }
        element.appendChild(content);
      }

      if (row.files?.length) {
        const list = document.createElement('ul');
        list.style.marginBottom = '1em';
        list.style.marginLeft = '-1.5em';
        list.style.marginTop = '.5em';


        const filesTree = row.files.map(e => [e, result.attachments[e]])
          .sort((a, b) => {
            const l = a[1].filepath.replace(/[^\/]/g, '').length;
            const r = b[1].filepath.replace(/[^\/]/g, '').length;

            if (l === r) {
              const tmp = a[1].filepath.localeCompare(b[1].filepath);
              if (!tmp) {
                return a[1].source.localeCompare(b[1].source);
              } else {
                return tmp;
              }
            } else {
              return l - r;
            }
          })
          .reduce((a, [k, v]) => {
            if (!a[v.filepath]) {
              a[v.filepath] = [];
            }
            a[v.filepath].push(k);
            return a;
          }, {});

        for (const [path, files] of Object.entries(filesTree)) {
          const segments = (updatedAttachments?.[files[0]]?.filepath ?? path)
            .replace(/\/$/, '')
            .split('/');

          const d = document.createElement('li');
          d.style.fontFamily = 'monospace';
          d.innerText = `📁 ${segments.slice(0, -1).join('/')}/`;
          list.appendChild(d);

          if (segments.at(-1)) {
            const dirname = document.createElement('span');
            dirname.style.fontFamily = 'monospace';
            dirname.innerText = segments.at(-1);
            d.appendChild(dirname);

            const dirEdit = document.createElement('a');
            dirEdit.href = '#';
            dirEdit.innerText = '✏️';
            dirEdit.style.marginLeft = '4px';
            dirEdit.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();

              const newDirname = String(window.prompt(
                'Specify the desired directory name:',
                segments.at(-1)
              ) || segments.at(-1)).replaceAll('/', '');

              dirname.innerText = newDirname;
              const newPath = [...segments.slice(0, -1), newDirname, ''].join('/');
              const childItems = Object.entries(filesTree)
                .flatMap(([p, f]) => p.startsWith(path) ? f : []);

              for (const id of childItems) {
                if (!updatedAttachments[id]) {
                  const file = result.attachments[id];
                  updatedAttachments[id] = {
                    author: file.author,
                    source: file.source,
                    timecreated: file.timecreated,
                    timemodified: file.timemodified,
                    contenthash: file.contenthash,
                    filesize: file.filesize,
                    filepath: file.filepath,
                    mimetype: file.mimetype,
                    blob: null
                  };
                }

                updatedAttachments[id].filepath = newPath;
              }
            });
            d.appendChild(dirEdit);
          }

          const dir = document.createElement('ul');
          d.appendChild(dir);

          for (const id of files) {
            const file = result.attachments[id];

            if (!Number(file.filesize)) {
              continue;
            }

            const e = document.createElement('li');
            e.style.fontFamily = 'monospace';
            e.innerText = `🔗 `;

            const source = document.createElement('span');
            source.innerText = (updatedAttachments[id]?.source || file.source || id);

            const sourceEdit = document.createElement('a');
            sourceEdit.href = '#';
            sourceEdit.innerText = '✏️';
            sourceEdit.style.marginLeft = '4px';
            sourceEdit.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();

              if (!updatedAttachments[id]) {
                updatedAttachments[id] = {
                  author: file.author,
                  source: file.source,
                  timecreated: file.timecreated,
                  timemodified: file.timemodified,
                  contenthash: file.contenthash,
                  filesize: file.filesize,
                  filepath: file.filepath,
                  mimetype: file.mimetype,
                  blob: null
                };
              }

              updatedAttachments[id].source = window.prompt(
                'Specify the source file name of the attachment:',
                updatedAttachments[id]?.source || file.source
              ) || file.source || updatedAttachments[id].source;
              source.innerText = updatedAttachments[id].source || id;
            });
            e.appendChild(source);
            e.appendChild(sourceEdit);
            e.appendChild(document.createElement('br'));

            const previewBtn = document.createElement('button');
            previewBtn.style.paddingInline = '1em';
            previewBtn.style.paddingBlock = '.5em';
            previewBtn.style.marginTop = '.75em';
            previewBtn.innerText = '👁️ preview';
            previewBtn.addEventListener('click', async () => {
              let blob;

              if (updatedAttachments[id]?.blob) {
                blob = new Blob([updatedAttachments[id].blob], { type: updatedAttachments[id].mimetype });
              } else {
                blob = await extractAttachment(result, file.contenthash, file.mimetype);
              }

              const fileURL = URL.createObjectURL(blob);
              window.open(fileURL, '_blank');
              URL.revokeObjectURL(fileURL);
            });
            e.appendChild(previewBtn);

            const author = document.createElement('span');
            author.innerText = `Author: ${updatedAttachments[id]?.author || file.author}`;

            const size = document.createElement('span');
            size.innerText = `Size: ${prettyBytes(Number(updatedAttachments[id]?.filesize || file.filesize))}`;

            const created = document.createElement('span');
            created.innerText = `Created: ${new Date(Number(updatedAttachments[id]?.timecreated || file.timecreated) * 1000).toLocaleString()}`;

            const modified = document.createElement('span');
            modified.innerText = `Modified: ${new Date(Number(updatedAttachments[id]?.timemodified || file.timemodified) * 1000).toLocaleString()}`;

            const authorEdit = document.createElement('a');
            authorEdit.href = '#';
            authorEdit.innerText = '✏️';
            authorEdit.style.marginLeft = '4px';
            authorEdit.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();

              if (!updatedAttachments[id]) {
                updatedAttachments[id] = {
                  author: file.author,
                  source: file.source,
                  timecreated: file.timecreated,
                  timemodified: file.timemodified,
                  contenthash: file.contenthash,
                  filesize: file.filesize,
                  filepath: file.filepath,
                  mimetype: file.mimetype,
                  blob: null
                };
              }

              updatedAttachments[id].author = window.prompt(
                'Specify the name of the author:',
                updatedAttachments[id]?.author || file.author
              ) || file.author || updatedAttachments[id].author;
              author.innerText = `Author: ${updatedAttachments[id].author}`;
            });

            const input = document.createElement('input');
            input.style.display = 'none';
            input.accept = file.mimetype;
            input.type = 'file';
            input.addEventListener('change', () => {
              const reader = new FileReader();
              reader.onload = (evt) => {
                updatedAttachments[id] = {
                  author: updatedAttachments[id]?.author ?? file.author,
                  source: input?.files[0].name,
                  timecreated: Math.round(input.files[0].lastModified / 1000),
                  timemodified: Math.round(input.files[0].lastModified / 1000),
                  contenthash: null,
                  filesize: input.files[0].size,
                  filepath: updatedAttachments[id]?.filepath ?? file.filepath,
                  mimetype: input.files[0].type,
                  blob: evt.target.result
                };

                source.innerText = updatedAttachments[id].source || id;
                size.innerText = `Size: ${prettyBytes(Number(updatedAttachments[id].filesize))}`;
                created.innerText = `Created: ${new Date(Number(updatedAttachments[id].timecreated) * 1000).toLocaleString()}`;
                modified.innerText = `Modified: ${new Date(Number(updatedAttachments[id].timemodified) * 1000).toLocaleString()}`;
              };
              reader.readAsArrayBuffer(input?.files[0]);
            }, false);
            e.appendChild(input);

            const updateBtn = document.createElement('button');
            updateBtn.style.paddingInline = '1em';
            updateBtn.style.paddingBlock = '.5em';
            updateBtn.style.marginTop = '.75em';
            updateBtn.innerText = '✏️️ update';
            updateBtn.addEventListener('click', () => input.click());
            e.appendChild(updateBtn);

            const s = document.createElement('small');
            s.insertAdjacentText('afterbegin', '(');
            s.appendChild(author);
            s.appendChild(authorEdit);
            s.insertAdjacentText('beforeend', ', ');
            s.appendChild(size);
            s.insertAdjacentText('beforeend', ', ');
            s.appendChild(created);
            s.insertAdjacentText('beforeend', ', ');
            s.appendChild(modified);
            s.insertAdjacentText('beforeend', ')');

            e.appendChild(document.createElement('br'));
            e.appendChild(s);

            dir.appendChild(e);
          }
        }

        element.appendChild(list);
      }
    }
  }
}

function setupPatchUpload() {
  document.querySelector('#patch-upload').innerHTML = '';
  document.querySelector('#patch-download').innerHTML = '';

  if (!loadedBackup) {
    document.querySelector('#patch-upload').innerHTML = note;
    document.querySelector('#patch-download').innerHTML = downloadNote;
    return;
  }

  setupFilePicker(
    '#patch-upload',
    `Select your xlsx patch file using the file dialog or by dragging and dropping it onto the dashed region.`,
    '.xlsx',
    async (file, loader) => {
      const logger = setupLogger('#patch-log');
      const f = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = (e) => reject(e);
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsArrayBuffer(file);
      });
      patchData = await processPatchFile(f, [...flags], logger);
      if (!patchData) {
        alert('ERROR: patch file is invalid');
        document.querySelector('#patch-download').innerHTML = downloadNote;
      } else {
        await generatePatchedBackup();
      }

      loader();
    }
  );
}

async function generatePatchedBackup() {
  const logger = setupLogger('#patch-log');

  try {
    if (!document.querySelector('#patch-download .drop-area')) {
      const form = document.createElement('div');
      form.className = 'drop-area loading';

      const button = document.createElement('button');
      button.innerText = '🚀️ Generate Patched Backup File';
      button.disabled = true;
      button.addEventListener('click', () => {
        button.disabled = true;
        form.classList.add('loading');
        form.querySelector('#patch-download a')?.remove?.();
        setTimeout(() => generatePatchedBackup(), 50);
      }, false);

      form.appendChild(button);
      form.appendChild(document.createElement('br'));
      form.appendChild(document.createElement('br'));

      document.querySelector('#patch-download').appendChild(form);
    }

    const result = await processBackup(loadedBackup.blob, loadedBackup.name, patchData, updatedAttachments, [...flags], logger);
    updatePreview(result);

    const download = document.createElement('a');
    download.innerText = '✅ Download Patched Course Backup';
    download.download = result.name;
    document.querySelector('#patch-download .drop-area').appendChild(download);

    if (patchURL) {
      URL.revokeObjectURL(patchURL);
    }

    const blob = new Blob([result.file], { type: 'application/gzip' });	
    patchURL = URL.createObjectURL(blob);
    download.href = patchURL;
  } catch (e) {
    logger(e);
  } finally {
    document.querySelector('#patch-download .drop-area').classList.remove('loading');
    document.querySelector('#patch-download .drop-area button').disabled = false;
  }
}

setupFilePicker(
  '#backup-upload',
  'Select your backup file using the file dialog or by dragging and dropping it onto the dashed region.',
  '.mbz',
  async (backupFile, loader, form) => {
    const logger = setupLogger('#backup-log');
    try {
      const b = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = (e) => reject(e);
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsArrayBuffer(backupFile);
      });
      const result = await processBackup(b, backupFile.name, false, {}, [...flags], logger);
      updatedAttachments = {};
      loadedBackup = {
        blob: b,
        name: backupFile.name
      };
      updatePreview(result);

      form.querySelector('a')?.remove?.();

      const download = document.createElement('a');
      download.innerText = '✅ Download Course Spreadsheet';
      download.download = result.name;
      form.appendChild(download);

      const blob = new Blob([result.file], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });	
      download.href = URL.createObjectURL(blob);
    } catch (e) {
      logger(e);
      loadedBackup = null;
    } finally {
      setupPatchUpload();
      loader();
    }
  }
);
