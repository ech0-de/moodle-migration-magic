# moodle-migration-magic
A tool that allows patching a Moodle backup using an Excel file to conveniently update due dates each semester

:warning: Still work in progress and very hacky! Use with caution! :warning:

## Usage

 1. Clone repo
 1. Run `npm install` to install dependencies
 1. Run `node main.js BACKUP.mbz` to create the xlsx representation of your backup
 1. Adjust your xlsx as desired
 1. Run `node main.js BACKUP.mbz BACKUP.xlsx` to apply changes to the archive

Side-note: If we get this a bit more mature, it would make sense to deploy it to npm to allow for an easier usage using `npx`.  

