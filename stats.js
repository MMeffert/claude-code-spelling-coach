'use strict';

// Usage: node stats.js
// Prints a summary of spelling coach progress

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(process.env.HOME, '.claude', 'hooks', 'spelling-coach', 'data.json');

function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    console.log('No spelling coach data yet. Use Claude Code and the hook will start tracking.');
    process.exit(0);
  }

  const words = Object.values(data.words || {});
  const active = words.filter(w => !w.learned && !w.dismissed);
  const learned = words.filter(w => w.learned);
  const dismissed = words.filter(w => w.dismissed);
  const withHints = words.filter(w => (w.mnemonics || []).length > 0);

  console.log('== Spelling Coach Stats ==\n');
  console.log(`Prompts checked:     ${data.stats.totalPromptsChecked}`);
  console.log(`Misspellings caught: ${data.stats.totalMisspellingsDetected}`);
  console.log(`Hints shown:         ${data.stats.totalHintsShown}`);
  console.log(`Words tracked:       ${words.length} (${active.length} active, ${learned.length} learned, ${dismissed.length} dismissed)`);
  console.log(`Words with hints:    ${withHints.length}`);
  console.log(`Ignored words:       ${(data.ignoreList || []).length}`);

  if (active.length > 0) {
    console.log('\n== Active Words ==\n');
    const sorted = active.sort((a, b) => b.totalCount - a.totalCount);
    for (const word of sorted) {
      const variants = Object.entries(word.variants)
        .sort((a, b) => b[1] - a[1])
        .map(([v, c]) => `${v}(${c})`)
        .join(', ');
      const hint = (word.mnemonics || []).find(m => !m.retired);
      const hintText = hint ? ` -- hint: "${hint.text}"` : '';
      console.log(`  ${word.canonical} (${word.totalCount}x): ${variants}${hintText}`);
    }
  }

  if (learned.length > 0) {
    console.log('\n== Learned (congrats!) ==\n');
    for (const word of learned) {
      console.log(`  ${word.canonical} (was ${word.totalCount}x)`);
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[stats] Error: ${err.message}\n`);
  process.exit(1);
}
