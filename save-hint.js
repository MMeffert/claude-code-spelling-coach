'use strict';

// Usage: echo 'canonical|mnemonic text|type' | node save-hint.js
// Type is one of: decomposition, rhyme, visual, acronym, story
//
// This script is called by Claude after generating a mnemonic.
// It is IDEMPOTENT -- if a non-retired mnemonic already exists, it skips.

const fs = require('node:fs');
const path = require('node:path');

const HOOK_DIR = path.join(process.env.HOME, '.claude', 'hooks', 'spelling-coach');
const DATA_FILE = path.join(HOOK_DIR, 'data.json');
const LOCK_FILE = path.join(HOOK_DIR, 'data.json.lock');

function main() {
  // Read from stdin (pipe-delimited)
  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  const parts = raw.split('|');

  if (parts.length < 2) {
    process.stderr.write('Usage: echo "word|mnemonic|type" | node save-hint.js\n');
    process.exit(1);
  }

  const canonical = parts[0].trim().toLowerCase();
  const mnemonic = parts.slice(1, -1).join('|').trim() || parts[1].trim(); // Handle | in mnemonic text
  const type = (parts.length >= 3 ? parts[parts.length - 1].trim() : 'unknown').toLowerCase();

  // Recalculate: if there are only 2 parts, mnemonic is parts[1]
  const mnemonicText = parts.length === 2
    ? parts[1].trim()
    : parts.length === 3
      ? parts[1].trim()
      : parts.slice(1, -1).join('|').trim();

  if (!canonical || !mnemonicText) {
    process.stderr.write('Error: canonical word and mnemonic text are required\n');
    process.exit(1);
  }

  // Truncate mnemonic to 500 chars
  const truncated = mnemonicText.slice(0, 500);

  // Advisory lock
  let lockFd = null;
  try {
    try {
      lockFd = fs.openSync(LOCK_FILE, 'wx');
    } catch {
      // Lock held -- check if stale
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 5000) {
          fs.unlinkSync(LOCK_FILE);
          lockFd = fs.openSync(LOCK_FILE, 'wx');
        } else {
          process.stderr.write('Lock held by another process, skipping\n');
          process.exit(0);
        }
      } catch {
        process.stderr.write('Could not acquire lock, skipping\n');
        process.exit(0);
      }
    }

    // Load data
    let data;
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      process.stderr.write('Error: could not read data.json\n');
      process.exit(1);
    }

    // Check if word exists
    if (!data.words[canonical]) {
      process.stderr.write(`Warning: "${canonical}" not found in tracking data\n`);
      process.exit(0);
    }

    const word = data.words[canonical];

    // Idempotent: skip if a non-retired mnemonic already exists
    const activeMnemonics = (word.mnemonics || []).filter(m => !m.retired);
    if (activeMnemonics.length > 0) {
      console.log(`Mnemonic already exists for "${canonical}", skipping (idempotent)`);
      return;
    }

    // Retire any existing mnemonics
    for (const m of word.mnemonics || []) {
      m.retired = true;
    }

    // Add new mnemonic
    word.mnemonics = word.mnemonics || [];
    word.mnemonics.push({
      text: truncated,
      type: type,
      generatedAt: new Date().toISOString(),
      retired: false
    });

    // Update hint tracking (these are ONLY updated here, not in the main hook)
    word.lastHintAtCount = word.totalCount;
    word.lastHintDate = new Date().toISOString();
    word.hintsPending = 0;

    // Save atomically
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, DATA_FILE);

    console.log(`Saved mnemonic for "${canonical}": "${truncated}" (${type})`);
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[save-hint] Error: ${err.message}\n`);
  process.exit(1);
}
