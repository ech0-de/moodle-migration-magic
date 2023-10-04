<p style="padding-left: 90px;">
  <a href="https://ech0-de.github.io/moodle-migration-magic/">
    <img width="200" src="https://ech0-de.github.io/moodle-migration-magic/mmm.svg">
  </a>
</p>

# ✨ moodle-migration-magic ✨
A tool that allows patching a Moodle backup using an Excel file to conveniently update due dates each semester.

⚠ Still work in progress and very hacky! Use with caution! 👷‍♀️

## 🚀 Getting Started
Navigate to the [GitHub-Pages deployment](https://ech0-de.github.io/moodle-migration-magic/) and follow the instructions there.

## 👩‍💻 Getting Started CLI
If you have Node.js installed on your machine, you can use `npx` to use moodle-migration-magic from the comfort of your command line.

```
$ npx moodle-migration-magic
Usage: npx mmm BACKUP.mbz [PATCH.xlsx]

 --help    output this help text
 --force   overwrite output file if it already exists
 --files   produce and consume a zip patch file that also contains
           editable activity contents (EXPERIMENTAL)


Hint: the full documentation of the process is available
      in the web deployment of moodle-migration-magic:
      -> https://ech0-de.github.io/moodle-migration-magic/
```

## 🛠 Development
 1. Clone repo
 1. Run `npm install` to install dependencies
 1. Run `npm run dev` to start development server

## ⚖ License
MIT