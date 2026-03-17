'use strict';

const fs = require('node:fs');
const path = require('node:path');

// --- Constants ---
const HOOK_DIR = path.join(process.env.HOME, '.claude', 'hooks', 'spelling-coach');
const DATA_FILE = path.join(HOOK_DIR, 'data.json');
const LOCK_FILE = path.join(HOOK_DIR, 'data.json.lock');
const DICT_FILE = '/usr/share/dict/words';
const CUSTOM_DICT_FILE = path.join(HOOK_DIR, 'custom-dictionary.txt');
const CURRENT_VERSION = 1;
const HARD_TIMEOUT_MS = 1800;
const MAX_SUGGEST_PER_PROMPT = 3;
const MIN_WORD_LENGTH = 3;
const QUICK_COMMAND_THRESHOLD = 15;

// --- Hard timeout ---
const timeoutHandle = setTimeout(() => {
  process.stdout.write('{}');
  process.exit(0);
}, HARD_TIMEOUT_MS);
timeoutHandle.unref();

// --- Default data ---
function defaultData() {
  return {
    version: CURRENT_VERSION,
    config: {
      threshold: 3,
      cooldownInterval: 10,
      minDaysBetweenHints: 7,
      maxHintsPerSession: 1,
      maxMnemonics: 3
    },
    stats: {
      totalPromptsChecked: 0,
      totalMisspellingsDetected: 0,
      totalHintsShown: 0
    },
    words: {},
    grammarPatterns: {},
    ignoreList: [],
    sessionHintsShown: 0
  };
}

// --- Levenshtein distance ---
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost  // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// --- Strip non-prose content ---
function stripNonProse(text) {
  let cleaned = text;
  // Fenced code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  // Indented code blocks (4+ spaces at line start)
  cleaned = cleaned.replace(/^[ \t]{4,}\S.*$/gm, ' ');
  // Inline code
  cleaned = cleaned.replace(/`[^`]+`/g, ' ');
  // URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s)>\]]+/g, ' ');
  // File paths (Unix)
  cleaned = cleaned.replace(/(?:~|\.{1,2})?\/[\w./-]+/g, ' ');
  // File paths (Windows)
  cleaned = cleaned.replace(/[A-Z]:\\[\w.\\/]+/g, ' ');
  // CLI flags
  cleaned = cleaned.replace(/--?[\w-]+=?\S*/g, ' ');
  // Hex colors/values
  cleaned = cleaned.replace(/#[0-9a-fA-F]{3,8}\b/g, ' ');
  cleaned = cleaned.replace(/0x[0-9a-fA-F]+/g, ' ');
  // @mentions
  cleaned = cleaned.replace(/@[\w.-]+/g, ' ');
  // JSON-like content
  cleaned = cleaned.replace(/\{[^}]*"[^"]*"[^}]*\}/g, ' ');
  return cleaned;
}

// --- Tokenize ---
function tokenize(text) {
  const words = text
    .split(/[\s,;:!?()\[\]{}"'<>]+/)
    .map(w => w.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, ''))
    .filter(w => {
      if (w.length < MIN_WORD_LENGTH) return false;
      // Skip ALL_CAPS (acronyms)
      if (/^[A-Z]+$/.test(w)) return false;
      // Skip words with digits
      if (/\d/.test(w)) return false;
      // Skip camelCase / PascalCase
      if (/[a-z][A-Z]/.test(w)) return false;
      return true;
    })
    .map(w => w.toLowerCase());

  // Deduplicate within this prompt
  return [...new Set(words)];
}

// --- Stem check ---
// The macOS /usr/share/dict/words only has root forms. Instead of inflating
// the Set (1.6M entries, 575ms), we strip common suffixes lazily to find
// the root word. This keeps the Set at 234K and loads in ~50ms.
function isKnownWord(word, dictSet) {
  if (dictSet.has(word)) return true;

  // Try stripping common suffixes to find root
  const suffixes = [
    // Order matters: try longer suffixes first
    { suffix: 'iest', replace: 'y' },   // happiest -> happy
    { suffix: 'ily', replace: 'y' },    // happily -> happy
    { suffix: 'ier', replace: 'y' },    // happier -> happy
    { suffix: 'ied', replace: 'y' },    // carried -> carry
    { suffix: 'ies', replace: 'y' },    // carries -> carry
    { suffix: 'ness', replace: '' },     // darkness -> dark
    { suffix: 'ment', replace: '' },     // management -> manage... needs 'e' too
    { suffix: 'able', replace: '' },     // readable -> read
    { suffix: 'ting', replace: 'te' },   // creating -> create
    { suffix: 'ding', replace: 'de' },   // providing -> provide
    { suffix: 'ging', replace: 'ge' },   // managing -> manage
    { suffix: 'sing', replace: 'se' },   // using -> use
    { suffix: 'ving', replace: 've' },   // moving -> move
    { suffix: 'ning', replace: 'ne' },   // defining -> define
    { suffix: 'ring', replace: 're' },   // configuring -> configure
    { suffix: 'ling', replace: 'le' },   // handling -> handle
    { suffix: 'zing', replace: 'ze' },   // analyzing -> analyze
    { suffix: 'ted', replace: 'te' },    // created -> create
    { suffix: 'ded', replace: 'de' },    // provided -> provide
    { suffix: 'ged', replace: 'ge' },    // managed -> manage
    { suffix: 'sed', replace: 'se' },    // used -> use
    { suffix: 'ved', replace: 've' },    // moved -> move
    { suffix: 'red', replace: 're' },    // configured -> configure
    { suffix: 'led', replace: 'le' },    // handled -> handle
    { suffix: 'zed', replace: 'ze' },    // analyzed -> analyze
    { suffix: 'ing', replace: '' },      // running -> run
    { suffix: 'ing', replace: 'e' },     // coming -> come
    { suffix: 'ers', replace: '' },      // workers -> work
    { suffix: 'ers', replace: 'e' },     // users -> use
    { suffix: 'est', replace: '' },      // fastest -> fast
    { suffix: 'ful', replace: '' },      // helpful -> help
    { suffix: 'ous', replace: '' },      // dangerous -> danger
    { suffix: 'ion', replace: 'e' },     // creation -> create
    { suffix: 'ity', replace: '' },      // ability -> abil... not always clean
    { suffix: 'lly', replace: 'l' },     // actually -> actual
    { suffix: 'ally', replace: 'al' },   // finally -> final
    { suffix: 'ed', replace: '' },       // worked -> work
    { suffix: 'er', replace: '' },       // worker -> work
    { suffix: 'er', replace: 'e' },      // user -> use
    { suffix: 'ly', replace: '' },       // quickly -> quick
    { suffix: 'es', replace: '' },       // boxes -> box
    { suffix: 's', replace: '' },        // cats -> cat
  ];

  for (const { suffix, replace } of suffixes) {
    if (word.endsWith(suffix) && word.length > suffix.length + 1) {
      const stem = word.slice(0, -suffix.length) + replace;
      if (dictSet.has(stem)) return true;
    }
  }

  return false;
}

// --- Load dictionary ---
function loadDictionary() {
  const dictSet = new Set();
  const prefixIndex = new Map();

  try {
    const raw = fs.readFileSync(DICT_FILE, 'utf8');
    const words = raw.split('\n');
    for (const word of words) {
      const lower = word.toLowerCase().trim();
      if (lower.length < MIN_WORD_LENGTH) continue;
      dictSet.add(lower);

      // Build prefix index for suggest()
      const prefix = lower.slice(0, 2);
      if (!prefixIndex.has(prefix)) {
        prefixIndex.set(prefix, []);
      }
      prefixIndex.get(prefix).push(lower);
    }
  } catch {
    // Dictionary not available -- return empty, hook will skip spell checking
  }

  return { dictSet, prefixIndex };
}

// --- Load custom dictionary ---
function loadCustomDictionary() {
  const words = new Set();
  try {
    const raw = fs.readFileSync(CUSTOM_DICT_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const word = line.trim().toLowerCase();
      if (word && !word.startsWith('#')) {
        words.add(word);
      }
    }
  } catch {
    // Custom dictionary not available -- skip
  }
  return words;
}

// --- Suggest corrections ---
function suggest(misspelled, prefixIndex, maxResults = 3) {
  const lower = misspelled.toLowerCase();
  const prefix = lower.slice(0, 2);
  const candidates = [];

  // Check words with same prefix
  const samePrefix = prefixIndex.get(prefix) || [];
  for (const word of samePrefix) {
    if (Math.abs(word.length - lower.length) > 2) continue;
    const dist = levenshtein(lower, word);
    if (dist > 0 && dist <= 2) {
      candidates.push({ word, dist });
    }
  }

  // Also check words with swapped first two chars (common typo)
  if (lower.length >= 2) {
    const swapped = lower[1] + lower[0] + lower.slice(2);
    const swappedPrefix = swapped.slice(0, 2);
    if (swappedPrefix !== prefix) {
      const swappedWords = prefixIndex.get(swappedPrefix) || [];
      for (const word of swappedWords) {
        if (Math.abs(word.length - lower.length) > 2) continue;
        const dist = levenshtein(lower, word);
        if (dist > 0 && dist <= 2) {
          candidates.push({ word, dist });
        }
      }
    }
  }

  return candidates
    .sort((a, b) => a.dist - b.dist)
    .slice(0, maxResults)
    .map(c => c.word);
}

// --- Data file operations ---
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);

    // Future-proof: don't touch newer versions
    if (data.version > CURRENT_VERSION) {
      return null; // Signal to bail
    }

    // Reset session counter (each hook invocation is within one session, but
    // sessionHintsShown persists across prompts in the same session via file)
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultData();
    }
    // Corrupted file -- backup and reinit
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(DATA_FILE, path.join(HOOK_DIR, `data.json.corrupt.${ts}`));
    } catch {
      // Can't backup -- just reinit
    }
    return defaultData();
  }
}

function saveData(data) {
  let lockFd = null;
  try {
    // Advisory lock
    try {
      lockFd = fs.openSync(LOCK_FILE, 'wx');
    } catch {
      // Lock held -- check if stale (> 5 seconds)
      try {
        const lockStat = fs.statSync(LOCK_FILE);
        if (Date.now() - lockStat.mtimeMs > 5000) {
          fs.unlinkSync(LOCK_FILE);
          lockFd = fs.openSync(LOCK_FILE, 'wx');
        } else {
          return; // Lock held by active process, skip save
        }
      } catch {
        return; // Can't check lock, skip save
      }
    }

    // Atomic write
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, DATA_FILE);
  } finally {
    // Release lock
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }
}

// --- Build variantMap from words ---
function buildVariantMap(words) {
  const map = new Map();
  for (const [canonical, entry] of Object.entries(words)) {
    for (const variant of Object.keys(entry.variants)) {
      map.set(variant, canonical);
    }
  }
  return map;
}

// --- Threshold checking ---
function checkThresholds(data, affectedWords) {
  const cfg = data.config;
  const triggered = [];

  for (const canonical of affectedWords) {
    const word = data.words[canonical];
    if (!word || word.dismissed || word.learned) continue;
    if (data.sessionHintsShown >= cfg.maxHintsPerSession) break;

    const activeMnemonics = (word.mnemonics || []).filter(m => !m.retired);
    const retiredMnemonics = (word.mnemonics || []).filter(m => m.retired);
    const allMnemonics = word.mnemonics || [];
    const daysSinceLastHint = word.lastHintDate
      ? (Date.now() - new Date(word.lastHintDate).getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    // Fallback: hook asked 3+ times but Claude never saved
    if (word.hintsPending >= 3 && allMnemonics.length === 0) {
      const mostCommon = getMostCommonVariant(word);
      triggered.push({
        type: 'fallback',
        canonical,
        mostCommonVariant: mostCommon,
        totalCount: word.totalCount
      });
      continue;
    }

    // First hint: threshold met, no mnemonics yet
    if (word.totalCount >= cfg.threshold && allMnemonics.length === 0 && word.hintsPending < 3) {
      const mostCommon = getMostCommonVariant(word);
      triggered.push({
        type: 'first',
        canonical,
        mostCommonVariant: mostCommon,
        totalCount: word.totalCount
      });
      continue;
    }

    // Rotation: all mnemonics retired
    if (activeMnemonics.length === 0 && retiredMnemonics.length > 0
        && retiredMnemonics.length < cfg.maxMnemonics
        && word.totalCount >= (word.lastHintAtCount || 0) + cfg.cooldownInterval
        && daysSinceLastHint >= cfg.minDaysBetweenHints) {
      triggered.push({
        type: 'rotation',
        canonical,
        mostCommonVariant: getMostCommonVariant(word),
        totalCount: word.totalCount,
        retiredHints: retiredMnemonics,
        usedTypes: retiredMnemonics.map(m => m.type).filter(Boolean)
      });
      continue;
    }

    // Cooldown: show existing mnemonic again
    if (activeMnemonics.length > 0
        && word.totalCount >= (word.lastHintAtCount || 0) + cfg.cooldownInterval
        && daysSinceLastHint >= cfg.minDaysBetweenHints) {
      triggered.push({
        type: 'cooldown',
        canonical,
        totalCount: word.totalCount,
        mnemonic: activeMnemonics[activeMnemonics.length - 1].text
      });
      continue;
    }
  }

  return triggered;
}

function getMostCommonVariant(word) {
  let max = 0;
  let result = '';
  for (const [variant, count] of Object.entries(word.variants)) {
    if (count > max) {
      max = count;
      result = variant;
    }
  }
  return result;
}

// --- Build additionalContext ---
function buildContext(triggered) {
  const parts = [];

  for (const t of triggered) {
    switch (t.type) {
      case 'first':
        parts.push(
          `[Spelling Coach] Mitchell has typed "${t.mostCommonVariant}" ${t.totalCount} times (correct: "${t.canonical}").`
          + ` Generate a memorable, personal mnemonic -- use vivid imagery, humor, or decomposition.`
          + ` Example quality: "there's A RAT in sepARATE".`
          + ` Then save it by running: echo '${t.canonical}|YOUR_MNEMONIC|TYPE' | node ~/.claude/hooks/spelling-coach/save-hint.js`
          + ` (TYPE is one of: decomposition, rhyme, visual, acronym, story)`
          + ` Keep the coaching brief and natural -- weave it in, don't lecture.`
        );
        break;

      case 'cooldown':
        parts.push(
          `[Spelling Coach] Spelling reminder for "${t.canonical}" (${t.totalCount}x): ${t.mnemonic}`
          + ` Mention this casually in one sentence. Do not generate a new one.`
        );
        break;

      case 'rotation': {
        const retiredList = t.retiredHints.map(h => `"${h.text}" (${h.type || 'unknown'})`).join(', ');
        const allTypes = ['decomposition', 'rhyme', 'visual', 'acronym', 'story'];
        const available = allTypes.filter(t2 => !t.usedTypes.includes(t2));
        parts.push(
          `[Spelling Coach] "${t.canonical}" (${t.totalCount}x) -- previous approach didn't stick: ${retiredList}.`
          + ` Try a DIFFERENT style (${available.join(', ')}).`
          + ` Save: echo '${t.canonical}|MNEMONIC|TYPE' | node ~/.claude/hooks/spelling-coach/save-hint.js`
        );
        break;
      }

      case 'fallback':
        parts.push(
          `[Spelling Coach] Reminder: "${t.mostCommonVariant}" -> "${t.canonical}" (${t.totalCount}x)`
        );
        break;
    }
  }

  return parts.join('\n\n');
}

// --- Main ---
function main() {
  // Environment disable check
  if (process.env.SPELLING_COACH_DISABLED) {
    process.stdout.write('{}');
    return;
  }

  // Read stdin
  let input;
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf8');
    input = JSON.parse(raw);
  } catch {
    process.stdout.write('{}');
    return;
  }

  // Extract prompt (user_prompt per hook contract, fallback to prompt)
  const prompt = input.user_prompt || input.prompt || '';
  if (!prompt) {
    process.stdout.write('{}');
    return;
  }

  // Strip non-prose and tokenize
  const cleaned = stripNonProse(prompt);
  const tokens = tokenize(cleaned);

  // Skip if too few tokens (likely all code or a quick command)
  if (tokens.length < 3) {
    process.stdout.write('{}');
    return;
  }

  // Load data
  const data = loadData();
  if (data === null) {
    // Future version -- bail
    process.stdout.write('{}');
    return;
  }

  // Load dictionaries
  const { dictSet, prefixIndex } = loadDictionary();
  if (dictSet.size === 0) {
    // No dictionary available -- skip spell checking
    process.stdout.write('{}');
    return;
  }

  const customDict = loadCustomDictionary();

  // Build ignore set (data.ignoreList + custom dictionary)
  const ignoreSet = new Set([
    ...(data.ignoreList || []).map(w => w.toLowerCase()),
    ...customDict
  ]);

  // Add ignore words to dictionary for correct() checks
  for (const word of ignoreSet) {
    dictSet.add(word);
  }

  // Build variantMap from words
  const variantMap = buildVariantMap(data.words);

  // Check each token
  const affectedWords = new Set();
  let newSuggestCalls = 0;
  let misspellingsThisPrompt = 0;

  for (const token of tokens) {
    if (ignoreSet.has(token)) continue;

    // Correctly spelled (including inflected forms via stem check)
    if (isKnownWord(token, dictSet)) continue;

    // Known variant -- fast path
    if (variantMap.has(token)) {
      const canonical = variantMap.get(token);
      if (data.words[canonical]) {
        data.words[canonical].variants[token] = (data.words[canonical].variants[token] || 0) + 1;
        data.words[canonical].totalCount++;
        data.words[canonical].lastSeen = new Date().toISOString();
        affectedWords.add(canonical);
        misspellingsThisPrompt++;
      }
      continue;
    }

    // New unknown word -- suggest (limited per prompt)
    if (newSuggestCalls >= MAX_SUGGEST_PER_PROMPT) continue;
    newSuggestCalls++;

    const suggestions = suggest(token, prefixIndex);
    if (suggestions.length === 0) {
      // No suggestions -- probably a tech term, add to ignore list
      data.ignoreList.push(token);
      continue;
    }

    const topSuggestion = suggestions[0];

    // Check if this canonical already exists
    if (data.words[topSuggestion]) {
      // Join existing group
      data.words[topSuggestion].variants[token] = (data.words[topSuggestion].variants[token] || 0) + 1;
      data.words[topSuggestion].totalCount++;
      data.words[topSuggestion].lastSeen = new Date().toISOString();
      affectedWords.add(topSuggestion);
    } else {
      // Create new entry
      data.words[topSuggestion] = {
        canonical: topSuggestion,
        variants: { [token]: 1 },
        totalCount: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastCorrectlySeen: null,
        correctStreak: 0,
        learned: false,
        dismissed: false,
        mnemonics: [],
        lastHintAtCount: 0,
        lastHintDate: null,
        hintsPending: 0
      };
      affectedWords.add(topSuggestion);
    }
    misspellingsThisPrompt++;
  }

  // Update stats
  data.stats.totalPromptsChecked++;
  data.stats.totalMisspellingsDetected += misspellingsThisPrompt;

  // Check thresholds (skip for quick commands)
  let context = '';
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount >= QUICK_COMMAND_THRESHOLD && affectedWords.size > 0) {
    const triggered = checkThresholds(data, affectedWords);
    if (triggered.length > 0) {
      context = buildContext(triggered);
      data.sessionHintsShown = (data.sessionHintsShown || 0) + triggered.length;
      data.stats.totalHintsShown += triggered.length;

      // Increment hintsPending for first-hint and rotation requests
      for (const t of triggered) {
        if ((t.type === 'first' || t.type === 'rotation') && data.words[t.canonical]) {
          data.words[t.canonical].hintsPending = (data.words[t.canonical].hintsPending || 0) + 1;
        }
      }
    }
  }

  // Save data
  saveData(data);

  // Output
  if (context) {
    process.stdout.write(JSON.stringify({ additionalContext: context }));
  } else {
    process.stdout.write('{}');
  }
}

// Export for testing
module.exports = {
  levenshtein,
  stripNonProse,
  tokenize,
  suggest,
  isKnownWord,
  buildVariantMap,
  checkThresholds,
  buildContext,
  getMostCommonVariant,
  defaultData,
  loadDictionary,
  CURRENT_VERSION
};

// Only run main() when executed directly (not when required by tests)
if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[spelling-coach] Error: ${err.message}\n`);
    process.stdout.write('{}');
  }
}
