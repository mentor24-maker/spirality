'use strict';

/**
 * The CommonJS config bridge (task 86bcgmnpy, slice 1).
 *
 * Two things are worth a test here and nothing else is: that a consumer reads
 * ITS OWN config rather than this package's, and that a missing or broken
 * config degrades to wording that names no product instead of throwing. The
 * first was a real bug, found by installing the package into a throwaway
 * consumer and reading the sender tag back; it said "[CC-spirality]" inside
 * what was standing in for StarCaster.
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

test('a config that fails its own checks degrades too, and never throws', () => {
  // A module imported to format one sentence must not turn a wording detail
  // into an outage, so an invalid config reads the same as an absent one.
  for (const broken of ['{ not json', configFor({ loopQueueListId: 'not-an-id' }), '{}']) {
    inRepoWith(broken, () => {
      assert.equal(sc.projectConfig(), null);
      assert.equal(sc.operatorName(), 'the operator');
    });
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
