'use strict';

/**
 * The CommonJS config bridge (task 86bcgmnpy, slice 1).
 *
 * Three things are worth a test here and nothing else is: that a consumer reads
 * ITS OWN config rather than this package's, that an ABSENT config degrades to
 * wording that names no product instead of throwing, and that a config which is
 * PRESENT AND BROKEN does the opposite and fails loudly. The first was a real
 * bug, found by installing the package into a throwaway consumer and reading
 * the sender tag back; it said "[CC-spirality]" inside what was standing in for
 * StarCaster.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sc = require('./substrateConfig.js');

/** A complete, valid config, as a product's own file would be. */
const configFor = (overrides) => JSON.stringify({
  workspaceId: '111',
  spaceId: '222',
  loopQueueListId: '333',
  operatorUserId: '444',
  machineUserId: '555',
  githubRepo: 'owner/repo',
  dopplerProject: 'proj',
  dopplerConfig: 'dev',
  launchdPrefix: 'com.example',
  logDir: '~/loop-logs',
  mergePhrases: ['merge'],
  governancePaths: ['CLAUDE.md'],
  autoMergeLanes: [],
  operatorName: 'Dana',
  productSlug: 'example',
  legacyMachinePrefixes: [],
  productScripts: {},
  ...overrides,
});

/** Run `fn` with the process rooted in a throwaway folder holding `contents`. */
function inRepoWith(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-config-'));
  if (contents !== null) fs.writeFileSync(path.join(dir, 'spirality.project.json'), contents);
  const before = process.cwd();
  try {
    process.chdir(dir);
    sc.resetProjectConfig();
    return fn(dir);
  } finally {
    process.chdir(before);
    sc.resetProjectConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the config read is the CONSUMER's, found from the working directory", () => {
  inRepoWith(configFor({ operatorName: 'Dana', productSlug: 'starcaster' }), () => {
    assert.equal(sc.operatorName(), 'Dana');
    assert.equal(sc.machineSenderTag('bus-relay'), '[CC-starcaster bus-relay]');
    assert.equal(sc.machineSenderTag(), '[CC-starcaster]');
    assert.equal(sc.machineSenderTag('bus-relay', { agent: 'AG' }), '[AG-starcaster bus-relay]');
  });
});

test('the config is found from a subfolder too, the way a loop is run', () => {
  inRepoWith(configFor({ productSlug: 'wavecenter' }), (dir) => {
    const deep = path.join(dir, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    sc.resetProjectConfig();
    assert.equal(sc.machineSenderTag(), '[CC-wavecenter]');
  });
});

test('no config at all degrades to wording that names no product', () => {
  inRepoWith(null, () => {
    assert.equal(sc.projectConfig(), null);
    assert.equal(sc.operatorName(), 'the operator');
    assert.equal(sc.machineSenderTag('bus-relay'), '[CC-loop bus-relay]');
    assert.deepEqual(sc.legacyMachinePrefixes(), []);
  });
});

test('A CONFIG THAT IS PRESENT AND BROKEN FAILS LOUDLY — it is not "no config"', () => {
  // The whole point: an absent config is an expected state, a broken one is a
  // fault. Reading them the same way let one typo'd key take the product name,
  // the legacy prefixes and the whole `productScripts` map out silently, which
  // re-skipped the wiring tests green (review of 86bcgmnpy, round 2).
  const broken = {
    'a key that is not a key at all': configFor({ operatorNmae: 'Sam' }),
    'a key with the wrong shape': configFor({ loopQueueListId: 'not-an-id' }),
    'a required key missing': configFor({ operatorName: undefined }),
    'not JSON': '{ not json',
    'an empty object': '{}',
  };
  for (const [label, contents] of Object.entries(broken)) {
    inRepoWith(contents, () => {
      assert.throws(() => sc.projectConfig(), { name: 'ProjectConfigError' }, label);
      // AND EVERY READER THROUGH IT, so no caller gets a quiet fallback either.
      assert.throws(() => sc.operatorName(), { name: 'ProjectConfigError' }, label);
      assert.throws(() => sc.machineSenderTag(), { name: 'ProjectConfigError' }, label);
      assert.throws(() => sc.legacyMachinePrefixes(), { name: 'ProjectConfigError' }, label);
      assert.throws(() => sc.mergePhrases(), { name: 'ProjectConfigError' }, label);
      // EVERY TIME, not just the first: a cached failure would be one loud line
      // followed by quiet ones.
      assert.throws(() => sc.operatorName(), { name: 'ProjectConfigError' }, label);
    });
  }
});

test('a broken config fails the product-script read too, instead of skipping green', () => {
  // This is the exact chain round 1's fix closed and a quiet fallback reopened:
  // `productScripts` became `{}` and 45 door checks skipped saying nothing was
  // configured, which was untrue.
  const ps = require('./productScripts.js');
  inRepoWith(configFor({ operatorNmae: 'Sam', productScripts: { door: 'door.mjs' } }), () => {
    let skipped = null;
    assert.throws(() => ps.skipWithoutDoor({ skip: (why) => { skipped = why; } }),
      { name: 'ProjectConfigError' });
    assert.equal(skipped, null, 'a broken config never turns into a skip');
  });
});

test('merge phrases are the PRODUCT\'s, not a literal in the module', () => {
  // CLAUDE.md rule 2 names merge phrases as config. A product that adds a
  // phrase must be able to merge with it; one that drops "approve" must not.
  const names = ['mergeOnComment.js'];
  const [mergeOnComment] = inRepoWith(null, () => freshRequire(names));
  try {
    inRepoWith(configFor({ mergePhrases: ['land it', 'merge'] }), () => {
      assert.deepEqual(sc.mergePhrases(), ['land it', 'merge']);
      assert.deepEqual(mergeOnComment.MERGE_PHRASES, ['land it', 'merge']);
      assert.equal(mergeOnComment.isMergeCommand('land it'), true);
      assert.equal(mergeOnComment.isMergeCommand('Land it.'), true, 'and still normalised');
      assert.equal(mergeOnComment.isMergeCommand('approve'), false,
        'a phrase this product dropped must not merge');
      assert.equal(mergeOnComment.isMergeCommand('do not land it yet'), false,
        'still a WHOLE-comment match, never a substring');
    });
    // With no config at all, StarCaster's four, which is what every product
    // config lists today — so nothing in service changes behaviour.
    inRepoWith(null, () => {
      assert.deepEqual(sc.mergePhrases(), ['merge', 'merge it', 'ship it', 'approve']);
      assert.deepEqual(mergeOnComment.MERGE_PHRASES, ['merge', 'merge it', 'ship it', 'approve']);
      assert.equal(mergeOnComment.isMergeCommand('ship it'), true);
    });
  } finally {
    for (const n of names) delete require.cache[require.resolve(`./${n}`)];
  }
});

test('A CONFIGURED PHRASE WRITTEN THE WAY A PERSON WRITES IT STILL MERGES', () => {
  // Round 3's bug (review of 86bcgmnpy). `isMergeCommand` normalized the
  // COMMENT and then looked for an exact match among the phrases AS WRITTEN.
  // That was safe while the phrases were a lower-case literal in the module
  // and unsafe the moment they became a product's config value: a product that
  // wrote "Ship it" loaded with no error and then never merged on anything,
  // which is the operator's merge word being ignored in silence. Both sides are
  // normalized now.
  const names = ['mergeOnComment.js'];
  const [mergeOnComment] = inRepoWith(null, () => freshRequire(names));
  try {
    inRepoWith(configFor({ mergePhrases: ['Ship it', 'Merge!', 'land  it', '**go**'] }), () => {
      for (const said of ['ship it', 'Ship it', 'SHIP IT.', '  ship it\n']) {
        assert.equal(mergeOnComment.isMergeCommand(said), true, said);
      }
      assert.equal(mergeOnComment.isMergeCommand('merge'), true, 'punctuation in the phrase');
      assert.equal(mergeOnComment.isMergeCommand('land it'), true, 'a double space in the phrase');
      assert.equal(mergeOnComment.isMergeCommand('go'), true, 'emphasis in the phrase');
      // Normalizing both sides must not loosen the whole-comment rule.
      assert.equal(mergeOnComment.isMergeCommand('do not ship it yet'), false);
      assert.equal(mergeOnComment.isMergeCommand('approve'), false,
        'a phrase this product does not list must not merge');
      // The exported list still reads as the config wrote it.
      assert.deepEqual(mergeOnComment.MERGE_PHRASES, ['Ship it', 'Merge!', 'land  it', '**go**']);
    });
  } finally {
    for (const n of names) delete require.cache[require.resolve(`./${n}`)];
  }
});

test('A PHRASE THAT NORMALIZES AWAY NEVER MERGES ON SILENCE', () => {
  // `projectConfig.mjs` refuses such a phrase at load time, so this is the
  // matcher's own belt for the no-config path and for any caller that hands it
  // a list directly: an empty phrase must not equal an empty comment.
  const names = ['mergeOnComment.js'];
  const [mergeOnComment] = inRepoWith(null, () => freshRequire(names));
  try {
    assert.throws(
      () => inRepoWith(configFor({ mergePhrases: ['merge', '.'] }), () => sc.mergePhrases()),
      { name: 'ProjectConfigError' },
      'a phrase with no letter or digit is refused where the config is read',
    );
    inRepoWith(null, () => {
      assert.equal(mergeOnComment.isMergeCommand(''), false);
      assert.equal(mergeOnComment.isMergeCommand('   '), false);
      assert.equal(mergeOnComment.isMergeCommand('.'), false);
    });
  } finally {
    for (const n of names) delete require.cache[require.resolve(`./${n}`)];
  }
});

test("legacy machine prefixes come from the product's own history", () => {
  inRepoWith(configFor({ legacyMachinePrefixes: ['[CC-starcaster]', '[AG-starcaster]'] }), () => {
    assert.deepEqual(sc.legacyMachinePrefixes(), ['[CC-starcaster]', '[AG-starcaster]']);
  });
});

test('machineComment builds its marker and prefix list from that config', () => {
  // The point of the move: the module holds no product name of its own.
  inRepoWith(configFor({ operatorName: 'Dana', legacyMachinePrefixes: ['[CC-oldname]'] }), () => {
    const file = require.resolve('./machineComment.js');
    delete require.cache[file];
    // eslint-disable-next-line global-require
    const mc = require('./machineComment.js');
    try {
      assert.match(mc.MACHINE_MARKER_LINE, /under Dana's token/);
      assert.ok(mc.LEGACY_MACHINE_PREFIXES.includes('[CC-oldname]'),
        "the product's retired prefix is honoured");
      assert.ok(mc.LEGACY_MACHINE_PREFIXES.includes('[auto-merge]'),
        'a lane name is the same everywhere and stays in the module');
      assert.equal(mc.isMachineComment('[CC-oldname] built something'), true);
    } finally {
      delete require.cache[file];
    }
  });
});

/** Require `names` fresh, as a process that has never loaded them would. */
function freshRequire(names) {
  const files = names.map((n) => require.resolve(`./${n}`));
  for (const f of files) delete require.cache[f];
  // eslint-disable-next-line global-require
  return files.map((f) => require(f));
}

test('NOTHING FREEZES AT LOAD — a module required with no config still names the operator later', () => {
  // A launchd runner starts with its working directory at `/`. If a module
  // read the name while loading, every card it stamped afterwards would say
  // "the operator" no matter where the work happened (review of 86bcgmnpy).
  const names = ['machineComment.js', 'refusalClass.js', 'operatorCard.js', 'waitingOnOperator.js'];
  const [mc, rc, oc, wo] = inRepoWith(null, () => freshRequire(names));
  try {
    inRepoWith(configFor({ operatorName: 'Sam', legacyMachinePrefixes: ['[CC-oldname]'] }), () => {
      assert.match(mc.MACHINE_MARKER_LINE, /under Sam's token/);
      assert.match(mc.stampMachineComment('built it'), /under Sam's token/);
      assert.equal(mc.isMachineComment('[CC-oldname] built something'), true);
      assert.match(rc.refusalNeeds(rc.REFUSAL_CODES.prAlreadyMerged), /\*\*an agent session or Sam\*\*/);
      assert.match(rc.refusalNeeds(rc.REFUSAL_CODES.authorizationPredatesVerdict), /\*\*Sam\*\*/);
      assert.equal(oc.BANNER_LABEL, 'NEEDED FROM SAM: ');
      assert.ok(oc.cardBlocks({ asked: 'x' })[0].text.startsWith("SAM'S WORDS"));
      assert.match(wo.verdictLine({ verdict: wo.WAITING, why: 'a card' }), /^WAITING ON SAM — /);
      assert.match(wo.verdictLine({ verdict: wo.NOT_WAITING, why: 'none' }), /^NOT waiting on Sam — /);
    });
  } finally {
    for (const n of names) delete require.cache[require.resolve(`./${n}`)];
  }
});

test('a product script that is configured but missing FAILS — it never skips green', () => {
  const ps = require('./productScripts.js');
  inRepoWith(configFor({ productScripts: { door: 'scripts/not_there.mjs' } }), () => {
    let skipped = null;
    const t = { skip: (why) => { skipped = why; } };
    assert.throws(() => ps.skipWithoutDoor(t), /"door" script is configured .* cannot be read/);
    assert.equal(skipped, null, 'a configured script never turns into a skip');
  });
  inRepoWith(configFor({ productScripts: {} }), () => {
    let skipped = null;
    assert.equal(ps.skipWithoutDoor({ skip: (why) => { skipped = why; } }), true);
    assert.match(skipped, /no product "door" script configured here/);
  });
  inRepoWith(configFor({ productScripts: { door: 'door.mjs' } }), (dir) => {
    fs.writeFileSync(path.join(dir, 'door.mjs'), '// the door\n');
    assert.equal(ps.doorSource(), '// the door\n');
  });
});
