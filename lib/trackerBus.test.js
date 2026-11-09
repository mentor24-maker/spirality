'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const bus = require('./trackerBus.js');
const { FALLBACK_TASK_NAME } = require('./busFallback.js');

const comment = (id, at, authorId, text, username = `actor ${authorId}`) => ({
  id: String(id), date: at, user: { id: authorId, username }, comment_text: text,
});

test('every bus use has a tracker equivalent, and docs/TRACKER_MVP.md prints the same table (SP-24)', () => {
  assert.ok(bus.BUS_USES.length >= 10, 'every StarCaster bus use is listed');
  const doc = readFileSync(join(__dirname, '..', 'docs', 'TRACKER_MVP.md'), 'utf8');
  for (const u of bus.BUS_USES) {
    assert.ok(u.use.trim() && u.tracker.trim(), `a use with no equivalent: ${JSON.stringify(u)}`);
    assert.ok(doc.includes(`| ${u.use} | ${u.tracker} |`), `docs/TRACKER_MVP.md lacks the row for: ${u.use.slice(0, 60)}`);
  }
  const rows = doc.split('\n').filter((l) => /^\| .* \| .* \|$/.test(l));
  const section = doc.slice(doc.indexOf('## The bus'), doc.indexOf('## Decisions'));
  const sectionRows = section.split('\n').filter((l) => rows.includes(l)).slice(1);
  assert.equal(sectionRows.length, bus.BUS_USES.length, 'the doc has a bus row that BUS_USES does not');
});

test('pickTeamChat finds the Team chat ticket under its old name too, oldest first, and null when none', () => {
  assert.equal(bus.pickTeamChat([]), null);
  assert.equal(bus.pickTeamChat([{ id: 'B-1', name: 'Something else', date_created: '1' }]), null);
  const picked = bus.pickTeamChat([
    { id: 'B-3', name: FALLBACK_TASK_NAME, date_created: '300' },
    { id: 'B-2', name: 'undelivered alarms', date_created: '200' },
    { id: 'B-4', name: ' team chat ', date_created: '400' },
  ]);
  assert.equal(picked.id, 'B-2');
  assert.equal(bus.pickTeamChat(null), null);
});

test('renderBusPost keeps the message verbatim under who and when, and refuses an empty one', () => {
  assert.equal(bus.renderBusPost({ text: '  \n ', node: 'mini' }), null);
  assert.equal(
    bus.renderBusPost({ text: 'heartbeat stopped\n\nsecond line', node: 'mini', at: '2026-11-09T16:00:00Z' }),
    '**From mini** · 2026-11-09T16:00:00Z\n\nheartbeat stopped\n\nsecond line',
  );
  assert.match(bus.renderBusPost({ text: 'x' }), /^\*\*From an unnamed machine\*\*\n\nx$/);
});

test('busMessages reads every bus ticket oldest first, marks the operator by actor id, and filters by --operator and --since', () => {
  const tickets = [
    { id: 'B-1', name: 'Team chat', comments: [comment(2, 3000, 7, 'machine report'), comment(1, 1000, 1, 'pause the merges', 'Dane')] },
    { id: 'B-2', name: 'A steward question', comments: [comment(3, 2000, 1, 'yes, go\nmore', 'Dane')] },
  ];
  const all = bus.busMessages(tickets, { operatorId: 1 });
  assert.deepEqual(all.map((m) => [m.ticket, m.at, m.byOperator]), [['B-1', 1000, true], ['B-2', 2000, true], ['B-1', 3000, false]]);
  const his = bus.busMessages(tickets, { operatorId: '1', operatorOnly: true });
  assert.deepEqual(his.map((m) => m.text), ['pause the merges', 'yes, go\nmore']);
  const after = bus.busMessages(tickets, { operatorId: 1, since: 1000 });
  assert.deepEqual(after.map((m) => m.at), [2000, 3000], 'since drops what is at or before it');
  assert.deepEqual(bus.busMessages(tickets, { operatorOnly: true }), [], 'no operator id: nothing is his');
  assert.equal(bus.busLine(after[0]), '1970-01-01T00:00:02.000Z\tB-2\toperator\tDane\tyes, go');
  const posted = { ...after[1], text: bus.renderBusPost({ text: 'heartbeat stopped', node: 'mini', at: 'now' }) };
  assert.match(bus.busLine(posted), /\tmachine\tactor 7\theartbeat stopped$/, 'the line is the message, not its From header');
});

test('parseSince reads an ISO time or milliseconds, and a typo is an error, never "everything"', () => {
  assert.equal(bus.parseSince(null), null);
  assert.equal(bus.parseSince(''), null);
  assert.equal(bus.parseSince('1700000000000'), 1700000000000);
  assert.equal(bus.parseSince('2026-11-09T16:00:00Z'), Date.parse('2026-11-09T16:00:00Z'));
  assert.match(bus.parseSince('yesterday').error, /--since/);
});

test('the Team chat ticket sits in a status no loop claims from', () => {
  assert.equal(bus.TEAM_CHAT_STATUS.toLowerCase(), 'live');
  assert.match(bus.renderTeamChatSeed(), /Do not build this/);
});

test('a post header shows Mountain time, never UTC (CLAUDE.md), and the steward-question rows say task THEN ask', () => {
  // 16:15 UTC on 11/9/2026 is 9:15 AM MST.
  assert.equal(bus.mountainTime(Date.parse('2026-11-09T16:15:00Z')), '11/9/2026, 9:15 AM MT');
  // In summer it is MDT, still "MT": 18:00 UTC on 7/4/2026 is noon.
  assert.equal(bus.mountainTime(Date.parse('2026-07-04T18:00:00Z')), '7/4/2026, 12:00 PM MT');
  assert.equal(bus.mountainTime('not a time'), '');
  const header = bus.renderBusPost({ text: 'x', node: 'mini', at: bus.mountainTime(Date.parse('2026-11-09T16:15:00Z')) }).split('\n')[0];
  assert.equal(header, '**From mini** · 11/9/2026, 9:15 AM MT');
  assert.doesNotMatch(header, /Z\b|T\d\d:/, 'no ISO time in what the operator reads');
  const question = bus.BUS_USES.find((u) => /steward filing a question/.test(u.use));
  assert.match(question.tracker, /task --list <busProject>/);
  assert.match(question.tracker, /ask --task <id> --status "Needs your input"/, 'task alone leaves the question in Queued, off the Waiting on You list');
  const waiting = bus.BUS_USES.find((u) => /`waiting` sweeping/.test(u.use));
  assert.match(waiting.tracker, /through `ask`/);
});

test('the alarm rule (SP-163): a message starting ALARM:, below the From header, any capitals; nothing else', () => {
  const posted = (text) => bus.renderBusPost({ text, node: 'mini', at: '11/9/2026, 10:15 AM MT' });
  assert.equal(bus.isAlarmPost(posted('ALARM: the heartbeat stopped')), true);
  assert.equal(bus.isAlarmPost(posted('alarm: lower case')), true);
  assert.equal(bus.isAlarmPost('ALARM: with no header'), true);
  assert.equal(bus.isAlarmPost(posted('weekly report: 12 merged')), false);
  assert.equal(bus.isAlarmPost(posted('it said ALARM: earlier')), false);
  assert.equal(bus.isAlarmPost(posted('ALARM without the colon')), false);
  assert.equal(bus.isAlarmPost(''), false);
  assert.equal(bus.postMessage(posted('line one\nline two')), 'line one\nline two');
  assert.equal(bus.postSender(posted('x')), 'mini');
  assert.equal(bus.postSender('no header'), null);
});

test('alarmText: the bus, the machine, the alarm on one line cut to about 300 characters, the link', () => {
  const text = bus.renderBusPost({ text: `ALARM: ${'x'.repeat(400)}\nsecond line`, node: 'mini', at: 'now' });
  const out = bus.alarmText({ ticketId: 'SB-1', projectName: 'StarCaster\nBus', text, pageUrl: 'http://t.example/' }).split('\n');
  assert.equal(out.length, 3);
  assert.equal(out[0], 'Alarm on StarCaster Bus from mini');
  assert.equal(out[1].length, bus.ALARM_TEXT_LIMIT);
  assert.ok(out[1].startsWith('ALARM: x') && out[1].endsWith('…'));
  assert.equal(out[2], 'http://t.example/t/SB-1');
  assert.equal(bus.alarmText({ ticketId: 'SB-1', projectName: 'B', text: 'ALARM: no header', pageUrl: 'http://t' }).split('\n')[0], 'Alarm on B');
});
