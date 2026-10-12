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
