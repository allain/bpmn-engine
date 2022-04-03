// From https://github.com/hapijs/joi/blob/master/generate-readme-toc.js

// Load modules

import Toc from 'markdown-toc';
import fs from 'fs';
const { version } = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

// Declare internals

const filenames = getFileNames();

function getFileNames() {
  const arg = process.argv[2] || './API.md';
  return arg.split(',');
}

function generate(filename) {
  const api = fs.readFileSync(filename, 'utf8');
  const tocOptions = {
    bullets: '-',
    slugify(text) {
      return text
        .toLowerCase()
        .replace(/\s/g, '-')
        .replace(/[^\w-]/g, '');
    }
  };

  const output = Toc.insert(api, tocOptions).replace(
    /<!-- version -->(.|\n)*<!-- versionstop -->/,
    '<!-- version -->\n# ' + version + ' API Reference\n<!-- versionstop -->'
  );

  fs.writeFileSync(filename, output);
}

filenames.forEach(generate);
