import pako from 'pako';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import * as tarjs from '@gera2ld/tarjs';
import xmldom from '@xmldom/xmldom';

const { TarFileType, TarReader, TarWriter } = tarjs?.default?.tarball || tarjs;
const { DOMParser, XMLSerializer } = xmldom;
const { subtle } = globalThis.crypto;

if (TarFileType?.[0]) {
  // todo workaround until https://github.com/gera2ld/tarjs/pull/1 is merged
  TarFileType.File = 48;
  TarFileType.Dir = 53;
  TarFileType[48] = 'File';
  TarFileType[53] = 'Dir';
  delete TarFileType[0];
  delete TarFileType[1];
}

let logger = console.log;
let patchedFiles = new Map();
let parser = new DOMParser();
let serializer = new XMLSerializer();
let files = {};
let backup = null;
let backupActivities = {};

function patch(activity, file, element, value) {
  if (!value) {
    return;
  }

  if (!activity.parsed[file]) {
    activity.parsed[file] = parser.parseFromString(activity.files[file].toString(), 'application/xml');
  }

  const doc = activity.parsed[file];
  const e = doc.getElementsByTagName(element)[0].childNodes[0];

  let oldValue;
  let newValue;

  if (typeof value === 'string') {
    oldValue = e.nodeValue;
    newValue = value;
  } else if (value instanceof Date) {
    oldValue = new Date(parseInt(e.nodeValue, 10) * 1000);
    newValue = String(Math.round(value.getTime() / 1000));
  } else {
    logger('ERROR', 'cannot set', element, value, 'is not a Date');
    return;
  }

  if (backup && element === 'name') {
    try {
      const b = backupActivities[activity.path.replace(/\/$/, '')];
      if (b && b.nodeValue !== value) {
        b.replaceData(0, b.nodeValue.length, newValue);
      }
    } catch (e) {
      logger('WARN', 'could not update moodle-backup.xml', e.message);
    }
  }

  if (e.nodeValue !== newValue) {
    e.replaceData(0, e.nodeValue.length, newValue);
    logger(`patching ${activity.path}${file} ${element}\n  - ${JSON.stringify(oldValue)}\n  + ${JSON.stringify(value)}\n`);
    patchedFiles.set(`${activity.path}${file}`, doc);
  }
}

function read(doc, element) {
  const x = doc.getElementsByTagName(element)?.[0]?.childNodes?.[0]?.nodeValue;
  if (!x) {
    // console.trace(serializer.serializeToString(doc), element);
    return '';
  }
  return x;
}

function deflateFile(file, inflate=false) {
  return inflate ? pako.ungzip(file) : pako.gzip(file);
}

function inflateFile(file) {
  return deflateFile(file, true);
}

function parseAvailability(module, field='availability') {
  const availability = read(module, field);
  let availableFrom = null;
  let availableTo = null;
  try {
    const parsed = JSON.parse(availability);
    if (parsed.op === '&') {
      availableFrom = parsed.c.find(e => e.type === 'date' && e.d === '>=')?.t;
      availableTo = parsed.c.find(e => e.type === 'date' && e.d === '<')?.t;
    }
  } catch {
      // ignore
  }

  const row = {};
  if (availableFrom) {
    row.availableFrom = new Date(availableFrom * 1000);
  }
  if (availableTo) {
    row.availableTo = new Date(availableTo * 1000);
  }

  return row;
}

function patchAvailability(activity, module, file, patchData, row, field='availability') {
  if (patchData && (patchData.get(row.id)?.availableFrom?.getTime?.() !== row.availableFrom?.getTime?.() || patchData.get(row.id)?.availableTo?.getTime?.() !== row.availableTo?.getTime?.())) {
    let availability;
    try {
      availability = JSON.parse(read(module, field));
    } catch {
      // default to creating a new availability constraint set
      availability = {
        op: '&',
        c: [],
        showc: []
      };
    }

    if (patchData.get(row.id)?.availableFrom?.getTime?.()) {
      const existingFrom = availability.c.find(e => e.type === 'date' && e.d === '>=');
      if (existingFrom) {
        existingFrom.t = Math.round(patchData.get(row.id).availableFrom.getTime() / 1000);
      } else {
        availability.showc.push(true);
        availability.c.push({
          type: 'date',
          d: '>=',
          t: Math.round(patchData.get(row.id).availableFrom.getTime() / 1000)
        });
      }
    }

    if (patchData.get(row.id)?.availableTo?.getTime?.()) {
      const existingTo = availability.c.find(e => e.type === 'date' && e.d === '<');
      if (existingTo) {
        existingTo.t = Math.round(patchData.get(row.id).availableTo.getTime() / 1000);
      } else {
        availability.showc.push(true);
        availability.c.push({
          type: 'date',
          d: '<',
          t: Math.round(patchData.get(row.id).availableTo.getTime() / 1000)
        });
      }
    }

    patch(activity, file, field, JSON.stringify(availability));
  }
}

function extractAndPatchContent(row, doc, patchData, activity, file) {
  const intro = read(doc, 'intro').replace(/\r?\n/g, '\n');
  const patchedIntro = String(patchData?.get?.(row.id)?.content).replace(/\r?\n/g, '\n');

  if (patchData && patchedIntro !== intro) {
    const e = doc.getElementsByTagName('intro')[0].childNodes[0];
    e.replaceData(0, e.nodeValue.length, patchedIntro);
    logger(`patching ${activity.path}${file} intro\n  - ${JSON.stringify(intro)}\n  + ${JSON.stringify(patchedIntro)}\n`);
    patchedFiles.set(`${activity.path}${file}`, doc);
  }

  return intro;
}

export const FLAGS = {
};

export const COLUMNS = [
  'completionexpected',
  'availableFrom',
  'availableTo',
  'allowsubmissionsfromdate',
  'duedate',
  'cutoffdate'
];

export async function processPatchFile(file, flags = [], log = console.log) {
  logger = log;
  try {
    const patchData = new Map();
    const workbook = XLSX.read(file, {
      cellDates: true,
      dateNF: 'YYYY-MM-DD hh:mm:ss'
    });

    const data = XLSX.utils.sheet_to_json(workbook.Sheets['moodle-data']);
    for (const [i, row] of data.entries()) {
      for (const e of COLUMNS) {
        if (row[e] && !(row[e] instanceof Date || row[e] === undefined)) {
          // try to parse string as date as a fallback
          const d = new Date(row[e]);
          if (isNaN(d)) {
            // failed to parse, exit
            logger(`ERROR: invalid date in row ${i}: ${row[e]}`);
            logger(row);
            return;
          } else {
            row[e] = d;
          }
        }
      }
      patchData.set(row.id, row);
    }

    return patchData;
  } catch (e) {
    logger('ERROR', e);
  }
}

export async function processBackup(file, filename, patchData = false, updatedAttachments = {}, flags = [], log = console.log) {
  logger = log;
  try {
    patchedFiles = new Map();
    parser = new DOMParser();
    serializer = new XMLSerializer();

    const activities = new Map();
    const sections = new Map();

    const reader = new TarReader();
    const items = await reader.readFile(await inflateFile(file));

    for (const e of items) {
      const entries = e.name.startsWith('activities/') ? activities : sections;
      if ((e.name.startsWith('activities/') || e.name.startsWith('sections/')) && e.name.endsWith('.xml')) {
        const [ prefix, id, file ] = e.name.split('/');
        if (!entries.has(id)) {
          entries.set(id, {
            path: `${prefix}/${id}/`,
            files: {},
            parsed: {}
          });
        }

        entries.get(id).files[file] = reader.getTextFile(e.name);
      } else if (e.name === 'moodle_backup.xml') {
        try {
          const contents = reader.getTextFile(e.name);
          backup = parser.parseFromString(contents, 'application/xml');
          const activities = backup.getElementsByTagName('activities')[0].getElementsByTagName('activity');
          for (let i = 0; i < activities.length; i += 1)  {
            const path = activities[i].getElementsByTagName('directory')[0].childNodes[0].nodeValue;
            const title = activities[i].getElementsByTagName('title')[0].childNodes[0];
            backupActivities[path] = title;
          }
        } catch (e) {
          logger('WARN', 'could not parse moodle_backup.xml', e.message);
          backupActivities = {};
          backup = null;
        }
      } else if (e.name === 'files.xml') {
        try {
          const contents = reader.getTextFile(e.name);
          const doc = parser.parseFromString(contents, 'application/xml');
          for (const e of doc.getElementsByTagName('file')) {
            files[e.getAttribute('id')] = {
              itemid: e.getElementsByTagName('itemid')?.[0]?.childNodes[0]?.nodeValue,
              contenthash: e.getElementsByTagName('contenthash')?.[0]?.childNodes[0]?.nodeValue,
              timecreated: e.getElementsByTagName('timecreated')?.[0]?.childNodes[0]?.nodeValue,
              timemodified: e.getElementsByTagName('timemodified')?.[0]?.childNodes[0]?.nodeValue,
              filesize: e.getElementsByTagName('filesize')?.[0]?.childNodes[0]?.nodeValue,
              mimetype: e.getElementsByTagName('mimetype')?.[0]?.childNodes[0]?.nodeValue,
              source: e.getElementsByTagName('source')?.[0]?.childNodes[0]?.nodeValue,
              author: e.getElementsByTagName('author')?.[0]?.childNodes[0]?.nodeValue,
            };
          }
        } catch (e) {
          logger('WARN', 'could not parse files.xml', e.message);
        }
      }
    }

    const rows = [];
    for (const [id, section] of sections.entries()) {
      const data = parser.parseFromString(section.files['section.xml'].toString(), 'application/xml');
      section.number = parseInt(read(data, 'number'), 10) * 1000;
      section.sequence = read(data, 'sequence').split(',');

      const row = {
        id: id,
        name: read(data, 'name'),
        number: section.number
      };

      const availability = parseAvailability(data, 'availabilityjson');
      row.availableFrom = availability.availableFrom;
      row.availableTo = availability.availableTo;

      if (patchData) {
        patchAvailability(section, data, 'section.xml', patchData, row, 'availabilityjson');
        patch(section, 'section.xml', 'name', patchData.get(row.id)?.name);
      }

      rows.push(row);
    }

    for (const [id, activity] of activities.entries()) {
      const module = parser.parseFromString(activity.files['module.xml'].toString(), 'application/xml');

      const section = sections.get(`section_${read(module, 'sectionid')}`);
      const offset = section.number;
      const number = section.sequence.indexOf(module.documentElement.getAttribute('id'));

      const row = {
        id: id,
        number: number + offset + 1
      };

      const availability = parseAvailability(module);
      row.availableFrom = availability.availableFrom;
      row.availableTo = availability.availableTo;

      patchAvailability(activity, module, 'module.xml', patchData, row);

      const completionexpected = parseInt(read(module, 'completionexpected'), 10);
      if (completionexpected) {
        row.completionexpected = new Date(parseInt(read(module, 'completionexpected'), 10) * 1000);
      }
      if (patchData && patchData.get(row.id)?.completionexpected) {
        patch(activity, 'module.xml', 'completionexpected', patchData.get(row.id)?.completionexpected);
      }

      if (activity.files['label.xml']) {
        const doc = parser.parseFromString(activity.files['label.xml'].toString(), 'application/xml');
        row.name = read(doc, 'name');
        row.content = extractAndPatchContent(row, doc, patchData, activity, 'label.xml');
      } else if (activity.files['assign.xml']) {
        const doc = parser.parseFromString(activity.files['assign.xml'].toString(), 'application/xml');
        row.name = read(doc, 'name');

        row.content = extractAndPatchContent(row, doc, patchData, activity, 'assign.xml');
        row.allowsubmissionsfromdate = new Date(parseInt(read(doc, 'allowsubmissionsfromdate'), 10) * 1000);
        row.duedate = new Date(parseInt(read(doc, 'duedate'), 10) * 1000);
        row.cutoffdate = new Date(parseInt(read(doc, 'cutoffdate'), 10) * 1000);

        if (patchData) {
          patch(activity, 'assign.xml', 'allowsubmissionsfromdate', patchData.get(row.id)?.allowsubmissionsfromdate);
          patch(activity, 'assign.xml', 'duedate', patchData.get(row.id)?.duedate);
          patch(activity, 'assign.xml', 'cutoffdate', patchData.get(row.id)?.cutoffdate);
          patch(activity, 'assign.xml', 'name', patchData.get(row.id)?.name);
        }
      } else if (activity.files['quiz.xml']) {
        const doc = parser.parseFromString(activity.files['quiz.xml'].toString(), 'application/xml');
        row.name = read(doc, 'name');

        row.allowsubmissionsfromdate = new Date(parseInt(read(doc, 'timeopen'), 10) * 1000);
        row.duedate = new Date(parseInt(read(doc, 'timeclose'), 10) * 1000);

        if (patchData) {
          patch(activity, 'quiz.xml', 'timeopen', patchData.get(row.id)?.allowsubmissionsfromdate);
          patch(activity, 'quiz.xml', 'timeclose', patchData.get(row.id)?.duedate);
          patch(activity, 'quiz.xml', 'name', patchData.get(row.id)?.name);
        }
      } else {
        const type = `${read(module, 'modulename')}.xml`;
        const doc = parser.parseFromString(activity.files[type].toString(), 'application/xml');
        row.name = read(doc, 'name');

        if (patchData) {
          patch(activity, type, 'name', patchData.get(row.id)?.name);
        }
      }

      try {
        const doc = parser.parseFromString(activity.files['inforef.xml'].toString(), 'application/xml');
        row.files = [...doc.getElementsByTagName('file')].map(e => read(e, 'id'));
      } catch (e) {
        logger('WARN', 'could not parse activities\' inforef.xml', e.message);
      }

      rows.push(row);
    }

    rows.sort((a, b) => a.number - b.number);

    if (!patchData) {
      // read mode
      rows.forEach((e) => {
        delete e.number;
      });

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(rows, {
        cellDates: true,
        dateNF: 'YYYY-MM-DD hh:mm:ss',
        header: [
          'id',
          'name',
          'completionexpected',
          'availableFrom',
          'availableTo',
          'allowsubmissionsfromdate',
          'duedate',
          'cutoffdate',
          'content',
        ]
      });
      worksheet['!cols'] = [20, 80, 20, 20, 20, 20, 20, 20, 80].map(e => ({ wch: e }));
      const name = `${filename.replace(/\.[^.]*$/, '')}.xlsx`;
      XLSX.utils.book_append_sheet(workbook, worksheet, 'moodle-data');
      const res = XLSX.write(workbook, { type: 'array'});

      const tmp = await JSZip.loadAsync(res);
      const styles = parser.parseFromString(await tmp.file('xl/styles.xml').async('string'), 'application/xml');
      const fonts = styles.getElementsByTagName('fonts')[0];
      const boldFont = fonts.childNodes[0].cloneNode(true);
      boldFont.appendChild(styles.createElement('b'));
      fonts.appendChild(boldFont);
      const boldFontId = fonts.childNodes.length - 1;

      const monoFont = styles.createElement('font');
      monoFont.appendChild(styles.createElement('sz'));
      monoFont.appendChild(styles.createElement('color'));
      monoFont.appendChild(styles.createElement('name'));
      monoFont.appendChild(styles.createElement('family'));
      monoFont.getElementsByTagName('sz')[0].setAttribute('val', '11');
      monoFont.getElementsByTagName('color')[0].setAttribute('val', '1');
      monoFont.getElementsByTagName('name')[0].setAttribute('val', 'Courier New');
      monoFont.getElementsByTagName('family')[0].setAttribute('val', '3');
      fonts.appendChild(monoFont);
      const monoFontId = fonts.childNodes.length - 1;

      fonts.setAttribute('count', fonts.childNodes.length);
      
      const cellXfs = styles.getElementsByTagName('cellXfs')[0];

      const bold = styles.createElement('xf');
      bold.setAttribute('numFmtId', '0');
      bold.setAttribute('fontId', boldFontId);
      bold.setAttribute('fillId', '0');
      bold.setAttribute('borderId', '0');
      bold.setAttribute('xfId', '0');
      bold.setAttribute('applyNumberFormat', '1');
      cellXfs.appendChild(bold);
      const boldStyleId = cellXfs.childNodes.length - 1;

      const wrapped = styles.createElement('xf');
      wrapped.setAttribute('numFmtId', '0');
      wrapped.setAttribute('fontId', monoFontId);
      wrapped.setAttribute('fillId', '0');
      wrapped.setAttribute('borderId', '0');
      wrapped.setAttribute('xfId', '0');
      wrapped.setAttribute('applyNumberFormat', '1');
      wrapped.setAttribute('applyAlignment', '1');
      const alignment = styles.createElement('alignment');
      alignment.setAttribute('wrapText', '1');
      wrapped.appendChild(alignment);
      cellXfs.appendChild(wrapped);
      const wrappedStyleId = cellXfs.childNodes.length - 1;

      cellXfs.setAttribute('count', cellXfs.childNodes.length);
      tmp.file('xl/styles.xml', serializer.serializeToString(styles));

      const sheet = parser.parseFromString(await tmp.file('xl/worksheets/sheet1.xml').async('string'), 'application/xml');
      for (const row of sheet.getElementsByTagName('row')) {
          for (const col of row.childNodes) {
              if (row.getAttribute('r') === '1') {
                  col.setAttribute('s', boldStyleId);
              } else if (col.getAttribute('r').startsWith('I')) {
                  col.setAttribute('s', wrappedStyleId);
              }
          }
      }
      tmp.file('xl/worksheets/sheet1.xml', serializer.serializeToString(sheet));

      logger(`writing data to ${name}`);

      return {
        name: name,
        file: await tmp.generateAsync({ type: 'uint8array' }),
        reader: reader,
        attachments: files,
        rows: rows
      };
    } else {
      logger();
      logger('writing patched archive...');
      const patchedArchive = `${filename.replace(/\.[^.]*$/, '.patched')}.mbz`;

      const rewriteFiles = Object.values(updatedAttachments).length > 0;

      const writer = new TarWriter();
      const mtime = Math.round(Date.now() / 1000);

      for (const file of Object.values(updatedAttachments)) {
        if (file.blob) {
          const digest = await subtle.digest('SHA-1', file.blob);
          const hashArray = Array.from(new Uint8Array(digest));
          file.contenthash = hashArray
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        }
      }

      for (const entry of items) {
        if (entry.name.endsWith('/')) {
          writer.addFolder(entry.name, { mtime, mode: 0o755 });
        } else if (entry.name === 'files.xml' && rewriteFiles) {
          try {
            const contents = reader.getTextFile(entry.name);
            const doc = parser.parseFromString(contents, 'application/xml');
            for (const e of doc.getElementsByTagName('file')) {
              if (updatedAttachments[e.getAttribute('id')]) {
                for (const attribute of ['contenthash', 'timecreated', 'timemodified', 'filesize', 'mimetype', 'source', 'author']) {
                  const node = e.getElementsByTagName(attribute)?.[0]?.childNodes[0];
                  const newValue = String(updatedAttachments[e.getAttribute('id')][attribute]);
                  const oldValue = node?.nodeValue;

                  if (node && newValue && oldValue !== newValue) {
                    node.replaceData(0, node.nodeValue.length, newValue);
                    logger(`patching files.xml ${e.getAttribute('id')}:${attribute}\n  - ${JSON.stringify(oldValue)}\n  + ${JSON.stringify(newValue)}\n`);
                  }
                }
              }
            }
          } catch (e) {
            logger('WARN', 'could not parse files.xml', e.message);
          }
        } else if (patchedFiles.has(entry.name)) {
          const content = serializer.serializeToString(patchedFiles.get(entry.name));
          writer.addFile(entry.name, content, { mtime, mode: 0o644 });
        } else {
          writer.addFile(entry.name, reader.getFileBlob(entry.name), { mtime, mode: 0o644 });
        }
      }

      for (const file of Object.values(updatedAttachments)) {
        if (file.blob) {
          writer.addFile(`${file.contenthash.slice(0, 2)}/${file.contenthash}`, file.blob, { mtime, mode: 0o644 });
        }
      }

      const blob = await writer.write();
      const result = await blob.arrayBuffer();
      const compressedBackup = await deflateFile(result);
      logger(`wrote archive to ${patchedArchive}`);

      return {
        name: patchedArchive,
        file: compressedBackup,
        reader: reader,
        attachments: files,
        rows: rows
      };
    }
  } catch (e) {
    console.log(e);
    logger('ERROR', e.message, e);
  }
}

export async function extractAttachment(backup, id, mimetype, flags = [], log = console.log) {
  logger = log;
  try {
    return backup.reader.getFileBlob(`files/${id.slice(0, 2)}/${id}`, mimetype);
  } catch (e) {
    logger('ERROR', e.message, e);
  }
}
