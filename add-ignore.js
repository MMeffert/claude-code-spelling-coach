'use strict';

// Usage: node add-ignore.js word1 word2 word3
// Adds words to the spelling coach ignore list in data.json

const fs = require('node:fs');
const path = require('node:path');

const HOOK_DIR = path.join(process.env.HOME, '.claude', 'hooks', 'spelling-coach');
const DATA_FILE = path.join(HOOK_DIR, 'data.json');

function main() {
  const words = process.argv.slice(2).map(w => w.toLowerCase().trim()).filter(Boolean);

  if (words.length === 0) {
    console.log('Usage: node add-ignore.js word1 [word2] [word3] ...');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    console.log('Error: could not read data.json. Run the hook at least once first.');
    process.exit(1);
  }

  const ignoreSet = new Set((data.ignoreList || []).map(w => w.toLowerCase()));
  const added = [];

  for (const word of words) {
    if (!ignoreSet.has(word)) {
      ignoreSet.add(word);
      added.push(word);
    }
  }

  data.ignoreList = [...ignoreSet].sort();

  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);

  if (added.length > 0) {
    console.log(`Added to ignore list: ${added.join(', ')}`);
  } else {
    console.log('All words already in ignore list');
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[add-ignore] Error: ${err.message}\n`);
  process.exit(1);
}
