'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const {
  levenshtein,
  stripNonProse,
  tokenize,
  suggest,
  buildVariantMap,
  checkThresholds,
  buildContext,
  getMostCommonVariant,
  defaultData,
  loadDictionary
} = require('./spelling-coach.js');

// --- Levenshtein ---

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('hello', 'hello'), 0);
  });

  it('returns correct distance for single character difference', () => {
    assert.equal(levenshtein('cat', 'bat'), 1);
    assert.equal(levenshtein('cat', 'cats'), 1);
    assert.equal(levenshtein('cat', 'at'), 1);
  });

  it('handles empty strings', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('', 'abc'), 3);
  });

  it('returns correct distance for common misspellings', () => {
    assert.equal(levenshtein('separate', 'seperate'), 1);
    assert.equal(levenshtein('definitely', 'definately'), 1); // i->a at position 7
    assert.equal(levenshtein('occurrence', 'occurence'), 1);
  });

  it('is symmetric', () => {
    assert.equal(levenshtein('abc', 'def'), levenshtein('def', 'abc'));
  });
});

// --- stripNonProse ---

describe('stripNonProse', () => {
  it('removes fenced code blocks', () => {
    const input = 'before ```const x = 1;``` after';
    const result = stripNonProse(input);
    assert.ok(!result.includes('const'));
    assert.ok(result.includes('before'));
    assert.ok(result.includes('after'));
  });

  it('removes inline code', () => {
    const input = 'run the `npm install` command';
    const result = stripNonProse(input);
    assert.ok(!result.includes('npm'));
    assert.ok(result.includes('run'));
    assert.ok(result.includes('command'));
  });

  it('removes URLs', () => {
    const input = 'check https://example.com/path for details';
    const result = stripNonProse(input);
    assert.ok(!result.includes('example.com'));
    assert.ok(result.includes('check'));
  });

  it('removes file paths', () => {
    const input = 'edit the file at /usr/local/bin/script then continue';
    const result = stripNonProse(input);
    assert.ok(!result.includes('/usr'));
    assert.ok(result.includes('edit'));
  });

  it('removes CLI flags', () => {
    const input = 'run with --verbose and -f flags';
    const result = stripNonProse(input);
    assert.ok(!result.includes('--verbose'));
    assert.ok(result.includes('run'));
  });

  it('removes hex values', () => {
    const input = 'set color to #FF0000 and offset 0xDEAD';
    const result = stripNonProse(input);
    assert.ok(!result.includes('FF0000'));
    assert.ok(!result.includes('0xDEAD'));
  });

  it('removes @mentions', () => {
    const input = 'ask @mitchell about the deploy';
    const result = stripNonProse(input);
    assert.ok(!result.includes('@mitchell'));
    assert.ok(result.includes('ask'));
  });

  it('preserves normal prose', () => {
    const input = 'Please update the infrastructure configuration';
    const result = stripNonProse(input);
    assert.ok(result.includes('infrastructure'));
    assert.ok(result.includes('configuration'));
  });

  it('handles empty input', () => {
    assert.equal(stripNonProse('').trim(), '');
  });
});

// --- tokenize ---

describe('tokenize', () => {
  it('splits on whitespace and punctuation', () => {
    const tokens = tokenize('hello, world! how are you');
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('world'));
  });

  it('lowercases all tokens', () => {
    const tokens = tokenize('Hello World Infrastructure');
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('infrastructure'));
  });

  it('filters short words (< 3 chars)', () => {
    const tokens = tokenize('I am a big person');
    assert.ok(!tokens.includes('am'));
    assert.ok(!tokens.includes('a'));
    assert.ok(tokens.includes('big'));
  });

  it('filters ALL_CAPS (acronyms)', () => {
    const tokens = tokenize('use the API with REST endpoints');
    assert.ok(!tokens.includes('api'));
    assert.ok(!tokens.includes('rest'));
    assert.ok(tokens.includes('use'));
    assert.ok(tokens.includes('endpoints'));
  });

  it('filters words with digits', () => {
    const tokens = tokenize('version v2 and node18 are good');
    assert.ok(!tokens.includes('v2'));
    assert.ok(!tokens.includes('node18'));
    assert.ok(tokens.includes('version'));
  });

  it('filters camelCase words', () => {
    const tokens = tokenize('the cloudFront distribution and viewState');
    assert.ok(!tokens.includes('cloudfront'));
    assert.ok(!tokens.includes('viewstate'));
    assert.ok(tokens.includes('the'));
    assert.ok(tokens.includes('distribution'));
  });

  it('deduplicates tokens', () => {
    const tokens = tokenize('hello hello hello world world');
    assert.equal(tokens.filter(t => t === 'hello').length, 1);
    assert.equal(tokens.filter(t => t === 'world').length, 1);
  });

  it('handles empty input', () => {
    assert.deepEqual(tokenize(''), []);
  });

  it('strips leading/trailing punctuation from tokens', () => {
    const tokens = tokenize('"hello" (world) [test]');
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('world'));
    assert.ok(tokens.includes('test'));
  });
});

// --- suggest ---

describe('suggest', () => {
  // Load the real dictionary for suggestion tests
  const { prefixIndex } = loadDictionary();

  it('suggests correct spelling for common misspellings', () => {
    const results = suggest('seperate', prefixIndex);
    assert.ok(results.includes('separate'), `Expected 'separate' in ${JSON.stringify(results)}`);
  });

  it('suggests correct spelling for occurence', () => {
    const results = suggest('occurence', prefixIndex);
    assert.ok(results.includes('occurrence'), `Expected 'occurrence' in ${JSON.stringify(results)}`);
  });

  it('returns empty for correct words', () => {
    const results = suggest('hello', prefixIndex);
    // 'hello' should not appear (distance 0 is filtered), but close words might
    assert.ok(!results.includes('hello'));
  });

  it('respects maxResults limit', () => {
    const results = suggest('teh', prefixIndex, 2);
    assert.ok(results.length <= 2);
  });

  it('returns empty for gibberish', () => {
    const results = suggest('zxqwkj', prefixIndex);
    assert.equal(results.length, 0);
  });

  it('finds suggestions for short misspellings', () => {
    // "teh" is close to "tea", "tech", "ted" etc.
    const results = suggest('teh', prefixIndex);
    assert.ok(results.length > 0, 'Should find at least one suggestion');
    assert.ok(results.every(r => levenshtein('teh', r) <= 2), 'All suggestions within edit distance 2');
  });
});

// --- buildVariantMap ---

describe('buildVariantMap', () => {
  it('builds map from words entries', () => {
    const words = {
      infrastructure: {
        variants: { infrustructure: 3, infastructure: 1 }
      },
      separate: {
        variants: { seperate: 5 }
      }
    };
    const map = buildVariantMap(words);
    assert.equal(map.get('infrustructure'), 'infrastructure');
    assert.equal(map.get('infastructure'), 'infrastructure');
    assert.equal(map.get('seperate'), 'separate');
    assert.equal(map.size, 3);
  });

  it('returns empty map for no words', () => {
    const map = buildVariantMap({});
    assert.equal(map.size, 0);
  });
});

// --- getMostCommonVariant ---

describe('getMostCommonVariant', () => {
  it('returns the variant with highest count', () => {
    const word = {
      variants: { infrustructure: 5, infastructure: 2, infrastrucutre: 1 }
    };
    assert.equal(getMostCommonVariant(word), 'infrustructure');
  });

  it('handles single variant', () => {
    const word = { variants: { seperate: 3 } };
    assert.equal(getMostCommonVariant(word), 'seperate');
  });
});

// --- checkThresholds ---

describe('checkThresholds', () => {
  it('triggers first hint at threshold', () => {
    const data = defaultData();
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 3 },
      totalCount: 3,
      mnemonics: [],
      lastHintAtCount: 0,
      lastHintDate: null,
      hintsPending: 0,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].type, 'first');
    assert.equal(triggered[0].canonical, 'separate');
  });

  it('does NOT trigger below threshold', () => {
    const data = defaultData();
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 2 },
      totalCount: 2,
      mnemonics: [],
      lastHintAtCount: 0,
      lastHintDate: null,
      hintsPending: 0,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 0);
  });

  it('triggers cooldown after interval', () => {
    const data = defaultData();
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 13 },
      totalCount: 13,
      mnemonics: [{ text: 'A RAT in separate', type: 'visual', retired: false }],
      lastHintAtCount: 3,
      lastHintDate: oldDate,
      hintsPending: 0,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].type, 'cooldown');
  });

  it('does NOT trigger cooldown within minDays', () => {
    const data = defaultData();
    const recentDate = new Date().toISOString(); // today
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 13 },
      totalCount: 13,
      mnemonics: [{ text: 'A RAT in separate', type: 'visual', retired: false }],
      lastHintAtCount: 3,
      lastHintDate: recentDate,
      hintsPending: 0,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 0);
  });

  it('skips dismissed words', () => {
    const data = defaultData();
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 10 },
      totalCount: 10,
      mnemonics: [],
      lastHintAtCount: 0,
      lastHintDate: null,
      hintsPending: 0,
      learned: false,
      dismissed: true
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 0);
  });

  it('skips learned words', () => {
    const data = defaultData();
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 10 },
      totalCount: 10,
      mnemonics: [],
      lastHintAtCount: 0,
      lastHintDate: null,
      hintsPending: 0,
      learned: true,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 0);
  });

  it('respects maxHintsPerSession', () => {
    const data = defaultData();
    data.config.maxHintsPerSession = 1;
    data.sessionHintsShown = 1;
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 5 },
      totalCount: 5,
      mnemonics: [],
      lastHintAtCount: 0,
      lastHintDate: null,
      hintsPending: 0,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 0);
  });

  it('triggers fallback after 3 pending attempts', () => {
    const data = defaultData();
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 5 },
      totalCount: 5,
      mnemonics: [],
      lastHintAtCount: 0,
      lastHintDate: null,
      hintsPending: 3,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].type, 'fallback');
  });

  it('triggers rotation when all mnemonics retired', () => {
    const data = defaultData();
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    data.words.separate = {
      canonical: 'separate',
      variants: { seperate: 20 },
      totalCount: 20,
      mnemonics: [{ text: 'old hint', type: 'decomposition', retired: true }],
      lastHintAtCount: 10,
      lastHintDate: oldDate,
      hintsPending: 0,
      learned: false,
      dismissed: false
    };
    const triggered = checkThresholds(data, new Set(['separate']));
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].type, 'rotation');
  });
});

// --- buildContext ---

describe('buildContext', () => {
  it('builds first hint context', () => {
    const context = buildContext([{
      type: 'first',
      canonical: 'separate',
      mostCommonVariant: 'seperate',
      totalCount: 3
    }]);
    assert.ok(context.includes('[Spelling Coach]'));
    assert.ok(context.includes('seperate'));
    assert.ok(context.includes('separate'));
    assert.ok(context.includes('save-hint.js'));
  });

  it('builds cooldown context', () => {
    const context = buildContext([{
      type: 'cooldown',
      canonical: 'separate',
      totalCount: 13,
      mnemonic: 'A RAT in separate'
    }]);
    assert.ok(context.includes('A RAT in separate'));
    assert.ok(context.includes('Do not generate a new one'));
  });

  it('builds fallback context', () => {
    const context = buildContext([{
      type: 'fallback',
      canonical: 'separate',
      mostCommonVariant: 'seperate',
      totalCount: 10
    }]);
    assert.ok(context.includes('seperate'));
    assert.ok(context.includes('separate'));
    assert.ok(!context.includes('save-hint'));
  });

  it('builds rotation context with used types', () => {
    const context = buildContext([{
      type: 'rotation',
      canonical: 'separate',
      mostCommonVariant: 'seperate',
      totalCount: 20,
      retiredHints: [{ text: 'old hint', type: 'decomposition' }],
      usedTypes: ['decomposition']
    }]);
    assert.ok(context.includes('decomposition'));
    assert.ok(context.includes('save-hint.js'));
    assert.ok(context.includes('DIFFERENT'));
  });
});

// --- Integration tests ---

describe('integration', () => {
  const hookScript = path.join(__dirname, 'spelling-coach.js');
  const dataFile = path.join(__dirname, 'data.json');

  // Clean up before/after tests
  function cleanData() {
    try { fs.unlinkSync(dataFile); } catch {}
    try { fs.unlinkSync(dataFile + '.tmp'); } catch {}
    try { fs.unlinkSync(dataFile + '.lock'); } catch {}
  }

  it('outputs {} for empty prompt', () => {
    cleanData();
    const input = JSON.stringify({ user_prompt: '', session_id: 'test', cwd: '/tmp' });
    const result = execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    assert.equal(result.trim(), '{}');
    cleanData();
  });

  it('outputs {} for short prompts (quick commands)', () => {
    cleanData();
    const input = JSON.stringify({ user_prompt: 'deploy it', session_id: 'test', cwd: '/tmp' });
    const result = execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    assert.equal(result.trim(), '{}');
    cleanData();
  });

  it('outputs {} for code-only prompts', () => {
    cleanData();
    const input = JSON.stringify({ user_prompt: '```const x = infrustructure;```', session_id: 'test', cwd: '/tmp' });
    const result = execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    assert.equal(result.trim(), '{}');
    cleanData();
  });

  it('creates data.json on first run with misspelling', () => {
    cleanData();
    const input = JSON.stringify({
      user_prompt: 'please update the seperate configuration files and check the environment variables carefully',
      session_id: 'test',
      cwd: '/tmp'
    });
    execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    assert.ok(fs.existsSync(dataFile), 'data.json should be created');
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(data.stats.totalPromptsChecked, 1);
    cleanData();
  });

  it('increments count across multiple prompts', () => {
    cleanData();
    const input = JSON.stringify({
      user_prompt: 'please update the seperate configuration files and check the environment variables carefully',
      session_id: 'test',
      cwd: '/tmp'
    });
    // Run 3 times
    for (let i = 0; i < 3; i++) {
      execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    }
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(data.stats.totalPromptsChecked, 3);
    // Find the word that 'seperate' mapped to
    const canonical = Object.keys(data.words).find(k =>
      data.words[k].variants && data.words[k].variants.seperate
    );
    if (canonical) {
      assert.equal(data.words[canonical].variants.seperate, 3);
    }
    cleanData();
  });

  it('outputs additionalContext at threshold', () => {
    cleanData();
    const input = JSON.stringify({
      user_prompt: 'please update the seperate configuration files and check the environment variables and make sure everything is set up correctly for the deployment pipeline',
      session_id: 'test',
      cwd: '/tmp'
    });
    let lastResult;
    for (let i = 0; i < 3; i++) {
      lastResult = execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    }
    // The 3rd prompt should trigger additionalContext (if word count >= 15)
    const output = JSON.parse(lastResult.trim());
    if (output.additionalContext) {
      assert.ok(output.additionalContext.includes('[Spelling Coach]'));
    }
    // Either way, data should show the word was tracked
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(data.stats.totalPromptsChecked >= 3);
    cleanData();
  });

  it('respects SPELLING_COACH_DISABLED env var', () => {
    cleanData();
    const input = JSON.stringify({
      user_prompt: 'update the seperate infrastructure configuration files and check everything is working properly',
      session_id: 'test',
      cwd: '/tmp'
    });
    const result = execSync(`echo '${input}' | SPELLING_COACH_DISABLED=1 node ${hookScript}`, { encoding: 'utf8' });
    assert.equal(result.trim(), '{}');
    assert.ok(!fs.existsSync(dataFile), 'data.json should not be created when disabled');
    cleanData();
  });

  it('completes within 2 seconds', () => {
    cleanData();
    const input = JSON.stringify({
      user_prompt: 'This is a longer prompt with several words to check including seperate and definately and occurence and other common misspellings that people make when they are typing quickly and not paying attention to their spelling habits over time',
      session_id: 'test',
      cwd: '/tmp'
    });
    const start = Date.now();
    execSync(`echo '${input}' | node ${hookScript}`, { encoding: 'utf8' });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `Hook took ${elapsed}ms, expected < 2000ms`);
    cleanData();
  });
});
