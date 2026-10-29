'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLICKUP_LINK_RE, ticketLinkRe, findTicketId, findTicketIds, bodyNamesTicket, ticketLink, ticketLine,
} = require('./clickupTicketLink.js');

// The two settings come from the caller here, so these tests do not lean on
// this repository's own config; the last test checks the config default.
const TRACKER = { tracker: 'api', trackerPrefix: 'SP', trackerUrl: 'http://mac-mini.local:4180' };
const CLICKUP = { tracker: 'clickup', trackerPrefix: null, trackerUrl: null };

test('a tracker id is read whole from the tracker link and from a ClickUp link (SP-32)', () => {
  assert.equal(findTicketId('Ticket: http://mac-mini.local:4180/tickets/SP-12', TRACKER), 'SP-12');
  assert.equal(findTicketId('Ticket: http://127.0.0.1:4180/tickets/SP-12', TRACKER), 'SP-12');
  // BREAK TEST: the id pattern before SP-32 stopped at the hyphen and read "SP".
  assert.equal(findTicketId('https://app.clickup.com/t/SP-12', TRACKER), 'SP-12');
  assert.equal(findTicketId('see https://app.clickup.com/t/90141423066/SP-12.', TRACKER), 'SP-12');
  assert.deepEqual(
    findTicketIds('https://app.clickup.com/t/86bbmmv7t then http://mac-mini.local:4180/tickets/SP-7', TRACKER),
    ['86bbmmv7t', 'sp-7'],
  );
});

test('a ClickUp id still returns itself, with or without a tracker configured', () => {
  for (const opts of [TRACKER, CLICKUP]) {
    assert.equal(findTicketId('Ticket: https://app.clickup.com/t/86bbmmv7t', opts), '86bbmmv7t');
    assert.equal(findTicketId('https://app.clickup.com/t/90141423066/86bbjv681', opts), '86bbjv681');
    assert.equal(findTicketId('no link here', opts), '');
  }
});

test('the tracker link is read only with the configured prefix and port', () => {
  assert.equal(findTicketId('http://mac-mini.local:4180/tickets/WC-3', TRACKER), '', 'another product\'s prefix');
  assert.equal(findTicketId('http://mac-mini.local:9999/tickets/SP-3', TRACKER), '', 'another port');
  assert.equal(findTicketId('http://mac-mini.local:4180/tickets/SP-12', CLICKUP), '', 'no tracker configured');
  assert.equal(findTicketId('http://mac-mini.local:4180/tickets/WC-3', { ...TRACKER, trackerPrefix: 'WC' }), 'WC-3');
  assert.equal(findTicketId('https://t.example/sp/tickets/SP-4', { ...TRACKER, trackerUrl: 'https://t.example/sp/' }), 'SP-4');
});

test('bodyNamesTicket: both shapes name SP-12, and neither names SP-1', () => {
  for (const body of ['Ticket: http://mac-mini.local:4180/tickets/SP-12', 'ClickUp: https://app.clickup.com/t/SP-12']) {
    assert.equal(bodyNamesTicket(body, 'SP-12', '', TRACKER), true, body);
    assert.equal(bodyNamesTicket(body, 'sp-12', '', TRACKER), true, `${body} (any case)`);
    assert.equal(bodyNamesTicket(body, 'SP-1', '', TRACKER), false, `${body} does not name SP-1`);
  }
  assert.equal(bodyNamesTicket('Ticket: http://mac-mini.local:4180/tickets/SP-12', '', 'http://127.0.0.1:4180/tickets/SP-12', TRACKER), true);
});

test('the link a reader is told to paste follows the configured tracker', () => {
  assert.equal(ticketLink('SP-12', TRACKER), 'http://mac-mini.local:4180/tickets/SP-12');
  assert.equal(ticketLine('SP-12', TRACKER), 'Ticket: http://mac-mini.local:4180/tickets/SP-12');
  assert.equal(ticketLine('86bbmmv7t', CLICKUP), 'Ticket: https://app.clickup.com/t/86bbmmv7t');
  // What it prints, it reads back.
  assert.equal(findTicketId(ticketLine('SP-12', TRACKER), TRACKER), 'SP-12');
});

test('CLICKUP_LINK_RE keeps a tracker-shaped id whole', () => {
  assert.equal(CLICKUP_LINK_RE.exec('https://app.clickup.com/t/SP-12')[1], 'SP-12');
  assert.equal(CLICKUP_LINK_RE.exec('https://app.clickup.com/t/86bbmmv7t')[1], '86bbmmv7t');
});

test('with no options, the prefix and address are the project config\'s, never a literal', () => {
  const { projectConfig } = require('./substrateConfig.js');
  const config = projectConfig();
  const source = ticketLinkRe().source;
  if (config && config.trackerPrefix) {
    assert.ok(source.includes(`${config.trackerPrefix}-`), source);
    assert.equal(findTicketId(`${config.trackerUrl}/tickets/${config.trackerPrefix}-12`), `${config.trackerPrefix}-12`);
  }
  const text = require('node:fs').readFileSync(require.resolve('./clickupTicketLink.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(text, /['"`]SP['"`-]|4180|mac-mini/, 'no prefix, port or host is written into the module');
});

test('the review gate reads a tracker ticket whole and prints the configured tracker\'s line', () => {
  const { reviewGateDecision, gateMessage } = require('./reviewGate.js');
  const { projectConfig } = require('./substrateConfig.js');
  const config = projectConfig();
  if (!config || !config.trackerPrefix) return;
  const id = `${config.trackerPrefix}-12`;
  const link = ticketLink(id);
  const decision = reviewGateDecision({ prBody: `Summary.\n\n${ticketLine(id)}\n`, prNumber: 7, headCommittedAt: Date.now(), comments: null });
  assert.equal(decision.ticketId, id, 'the gate judges the right ticket, not its prefix');
  assert.ok(gateMessage(decision, { prNumber: 7 }).includes(`Ticket: ${link}`));
  const none = reviewGateDecision({ prBody: 'no link', prNumber: 7, headCommittedAt: Date.now(), comments: [] });
  assert.ok(gateMessage(none, { prNumber: 7 }).includes(ticketLink('<id>')));
});
