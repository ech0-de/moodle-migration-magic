const fs = require('fs');
const tar = require('tar');
const XLSX = require('xlsx');
const zlib = require('zlib');
const { BufferList } = require('bl');
const { pipeline } = require('stream');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const parser = new DOMParser();
const serializer = new XMLSerializer();

const patchedFiles = new Map();

function patch(activity, file, element, value) {
    if (!activity.parsed[file]) {
        activity.parsed[file] = parser.parseFromString(activity.files[file].toString());
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
        console.error('cannot set', element, value, 'is not a Date');
        return;
    }

    if (e.nodeValue !== newValue) {
        e.replaceData(0, e.nodeValue.length, newValue);
        console.log('patching', `${activity.path}${file}`, element, 'from', oldValue, 'to', value);
        patchedFiles.set(`${activity.path}${file}`, doc);
    }
}

function read(doc, element) {
    const x = doc.getElementsByTagName(element)?.[0]?.childNodes?.[0]?.nodeValue;
    if (!x) {
        console.trace(serializer.serializeToString(doc), element);
        return '';
    }
    return x;
}

(async () => {
    const activities = new Map();
    const sections = new Map();

    await tar.t({
        file: process.argv[2],
        onentry: (e) => {
            const entries = e.path.startsWith('activities/') ? activities : sections;
            if ((e.path.startsWith('activities/') || e.path.startsWith('sections/')) && e.path.endsWith('.xml')) {
                const [ prefix, id, file ] = e.path.split('/');
                if (!entries.has(id)) {
                    entries.set(id, {
                        path: `${prefix}/${id}/`,
                        files: {},
                        parsed: {}
                    });
                }

                const bl = new BufferList();
                e.on('data', b => bl.append(b));
                entries.get(id).files[file] = bl;
            }
        }
    });

    const rows = [];
    for (const [id, section] of sections.entries()) {
        const data = parser.parseFromString(section.files['section.xml'].toString());
        section.number = parseInt(read(data, 'number'), 10) * 1000;
        section.sequence = read(data, 'sequence').split(',');

        const row = {
            id: id,
            name: read(data, 'name'),
            number: section.number
        };

        let availableFrom = null;
        let availableTo = null;
        try {
            const parsed = JSON.parse(read(data, 'availabilityjson'));
            if (parsed.op === '&') {
                availableFrom = parsed.c.find(e => e.type === 'date' && e.d === '>=')?.t;
                availableTo = parsed.c.find(e => e.type === 'date' && e.d === '<')?.t;
            }
        } catch {
            // ignore
        }

        if (availableFrom) {
            row.availableFrom = new Date(availableFrom * 1000);
        }
        if (availableTo) {
            row.availableTo = new Date(availableTo * 1000);
        }

        rows.push(row);
    }

    let patchData = new Map();
    if (process.argv[3]) {
        // patch mode
        const workbook = XLSX.readFileSync(process.argv[3], {
            cellDates: true,
            dateNF: 'YYYY-MM-DD hh:mm:ss'
        });
        const data = XLSX.utils.sheet_to_json(workbook.Sheets['moodle-data']);
        data.forEach((row) => {
            if (['completionexpected', 'availableFrom', 'availableTo', 'allowsubmissionsfromdate', 'duedate', 'cutoffdate'].some(e => !(row[e] instanceof Date || row[e] === undefined))) {
                console.error(`invalid date in row ${i}`);
                console.error(row);
                process.exit(1);
            }
            patchData.set(row.id, row);
        });
    }

    for (const [id, activity] of activities.entries()) {
        const module = parser.parseFromString(activity.files['module.xml'].toString());

        const section = sections.get(`section_${read(module, 'sectionid')}`);
        const offset = section.number;
        const number = section.sequence.indexOf(module.documentElement.getAttribute('id'));

        const row = {
            id: id,
            number: number + offset + 1
        };

        const availability = read(module, 'availability');
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

        if (availableFrom) {
            row.availableFrom = new Date(availableFrom * 1000);
        }
        if (availableTo) {
            row.availableTo = new Date(availableTo * 1000);
        }

        if (process.argv[3] && (patchData.get(row.id)?.availableFrom?.getTime?.() !== row.availableFrom?.getTime?.() || patchData.get(row.id)?.availableTo?.getTime?.() !== row.availableTo?.getTime?.())) {
            try {
                if (availableFrom === null || availableTo === null) {
                    throw new Error('existing availability does not feature from and to dates');
                }

                const parsed = JSON.parse(availability);
                // patch existing constraint
                parsed.c.find(e => e.type === 'date' && e.d === '>=').t = Math.round(patchData.get(row.id).availableFrom.getTime() / 1000);
                parsed.c.find(e => e.type === 'date' && e.d === '<').t = Math.round(patchData.get(row.id).availableTo.getTime() / 1000);

                patch(activity, 'module.xml', 'availability', JSON.stringify(availability));
            } catch {
                // default to creating a new availability constraint set
                const availability = {
                    op: '&',
                    c: [],
                    showc: []
                };

                if (patchData.get(row.id)?.availableFrom?.getTime?.()) {
                    availability.showc.push(true);
                    availability.c.push({
                        type: 'date',
                        d: '>=',
                        t: Math.round(patchData.get(row.id).availableFrom.getTime() / 1000)
                    });
                }

                if (patchData.get(row.id)?.availableTo?.getTime?.()) {
                    availability.showc.push(true);
                    availability.c.push({
                        type: 'date',
                        d: '<',
                        t: Math.round(patchData.get(row.id).availableTo.getTime() / 1000)
                    });
                }

                patch(activity, 'module.xml', 'availability', JSON.stringify(availability));
            }
        }

        // todo patch

        const completionexpected = parseInt(read(module, 'completionexpected'), 10);
        if (completionexpected) {
            row.completionexpected = new Date(parseInt(read(module, 'completionexpected'), 10) * 1000);
        }
        if (process.argv[3] && patchData.get(row.id)?.completionexpected) {
            patch(activity, 'module.xml', 'completionexpected', patchData.get(row.id)?.completionexpected);
        }

        if (activity.files['assign.xml']) {
            const doc = parser.parseFromString(activity.files['assign.xml'].toString());
            row.name = read(doc, 'name');
            row.allowsubmissionsfromdate = new Date(parseInt(read(doc, 'allowsubmissionsfromdate'), 10) * 1000);
            row.duedate = new Date(parseInt(read(doc, 'duedate'), 10) * 1000);
            row.cutoffdate = new Date(parseInt(read(doc, 'cutoffdate'), 10) * 1000);

            if (process.argv[3]) {
                patch(activity, 'assign.xml', 'allowsubmissionsfromdate', patchData.get(row.id)?.allowsubmissionsfromdate);
                patch(activity, 'assign.xml', 'duedate', patchData.get(row.id)?.duedate);
                patch(activity, 'assign.xml', 'cutoffdate', patchData.get(row.id)?.cutoffdate);
                patch(activity, 'assign.xml', 'name', patchData.get(row.id)?.name);
            }
        } else if (activity.files['quiz.xml']) {
            const doc = parser.parseFromString(activity.files['quiz.xml'].toString());
            row.name = read(doc, 'name');

            row.allowsubmissionsfromdate = new Date(parseInt(read(doc, 'timeopen'), 10) * 1000);
            row.duedate = new Date(parseInt(read(doc, 'timeclose'), 10) * 1000);

            if (process.argv[3]) {
                patch(activity, 'quiz.xml', 'timeopen', patchData.get(row.id)?.allowsubmissionsfromdate);
                patch(activity, 'quiz.xml', 'timeclose', patchData.get(row.id)?.duedate);
                patch(activity, 'quiz.xml', 'name', patchData.get(row.id)?.name);
            }
        } else {
            const doc = parser.parseFromString(activity.files[`${read(module, 'modulename')}.xml`].toString());
            row.name = read(doc, 'name').split('\n')[0].trim();

            if (process.argv[3]) {
                patch(activity, `${read(module, 'modulename')}.xml`, 'name', patchData.get(row.id)?.name);
            }
        }
        rows.push(row);
    }

    if (!process.argv[3]) {
        // read mode
        rows.sort((a, b) => a.number - b.number).forEach(e => {
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
            ]
        });
        worksheet['!cols'] = [20, 80, 20, 20, 20, 20, 20, 20].map(e => ({ wch: e }));
        XLSX.utils.book_append_sheet(workbook, worksheet, 'moodle-data');
        XLSX.writeFileSync(workbook, `${process.argv[2].replace(/\.[^.]*$/, '')}.xlsx`);
        console.log(`wrote data to ${process.argv[2].replace(/\.[^.]*$/, '')}.xlsx`);
    } else {
        console.log();
        console.log('writing patched archive...');
        const patchedArchive = `${process.argv[2].replace(/\.[^.]*$/, '.patched')}.mbz`;

        const packer = new tar.Pack({ gzip: true, onwarn: console.log });
        const parser = new tar.Parse({ strict: true, onwarn: console.log });
        const gzip = zlib.createGzip();

        const source = fs.createReadStream(process.argv[2]);
        const destination = fs.createWriteStream(patchedArchive);

        parser.on('entry', (entry) => {
            if (patchedFiles.has(entry.path)) {
                const file = Buffer.from(serializer.serializeToString(patchedFiles.get(entry.path)));
                const header = new tar.Header({
                    ...entry.header,
                    size: file.length,
                    cksum: undefined,
                    mtime: new Date()
                });
                const transformed = new tar.ReadEntry(header);
                transformed.write(file);
                transformed.end();
                packer.add(transformed);
                entry.resume();
            } else {
                packer.add(entry);
            }
        });

        source.pipe(parser);
        await new Promise(resolve => parser.on('end', resolve));
        packer.end();

        packer.pipe(destination);
        await new Promise(resolve => packer.on('end', resolve));

        console.log(`wrote archive to ${patchedArchive}`);
    }
})().catch(e => console.error(e));
