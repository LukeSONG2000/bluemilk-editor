#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('BlueMilk CLI requires Windows x64.'); process.exit(1);
}
if (process.argv[2] === '--version') {
  console.log(require('../package.json').version); process.exit(0);
}
const child = spawn(path.join(__dirname, '../payload/bluemilk.exe'), process.argv.slice(2), {stdio:'inherit', windowsHide:true, shell:false});
child.on('error', error => { console.error(error.message); process.exitCode=1; });
child.on('exit', code => { process.exitCode=code ?? 1; });
