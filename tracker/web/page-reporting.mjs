/**
 * The Reporting page (/reporting): a project's figures over a chosen range, its merge conflicts and growth.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { escapeHtml, stageLooks } from './render.mjs';
import { api, savedProject, setTitle, main, SignedOut, drawSignIn, showError, putTrail, when, statusName } from './app.mjs';

/**
 * A duration in ms in plain words: under an hour, whole hours up to two
 * days, then days to one decimal place.
 */
function spanOf(ms) {
  const hours = ms / 3_600_000;
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * The Reporting page: how many tasks were started and finished in each of
 * the server's time ranges (Task Productivity), and how many are open in each stage now, for the
 * selected project or for all of them, and how the finished ones flowed:
 * time to finish, how many were sent back, and time waiting on the
 * operator, and the human hours of work the finished ones add up to, by the
 * build loop's estimates, and where every task's time went (Where the Time
 * Goes: working, waiting for a lane, waiting on the operator, broken), with
 * the tasks that took the most time in the range picked. Every figure is worked out by the
 * server (pageData.mjs reportsOf); the page only draws them, so the ranges
 * and the stages come from its answer, never typed out here. A stage wears
 * its Settings colour as properties, never as markup. Task Productivity
 * also has its own range (SP-240): a Start Date and an End Date picker in
 * its header, 30 days ago to today on arrival (`range` keeps the picked dates
 * when the project changes); a picker change asks the server again and
 * redraws only those cells. Its last column, Growth Rate (SP-241), shows
 * the server's growth figures for the timeframe picked in its header
 * (Weekly on arrival), redrawn from the same answer. Merge Conflicts
 * (SP-295, conflictSection) shows conflicts per merged pull request by the
 * pipeline settings in force, and lists each conflict.
 */
export async function drawReporting(chosen, range = defaultReportRange()) {
  const { projects } = await api('GET', '/projects');
  const slug = chosen !== undefined ? chosen : (projects.some((p) => p.slug === savedProject()) ? savedProject() : '');
  const r = await api('GET', reportsPath(slug, range));
  setTitle('Reporting · Tracker');
  const head = `<tr><th>Report</th>${r.ranges.map((g) => `<th class="count">${escapeHtml(g.label)}</th>`).join('')}</tr>`;
  // Task Productivity's own range (SP-240): a Start Date and an End Date column after the fixed ones, a picker in each header.
  const productivityHead = `<tr><th>Report</th>${r.ranges.map((g) => `<th class="count">${escapeHtml(g.label)}</th>`).join('')}`
    + `<th class="count custom-range"><label for="report-from">Start Date</label><input type="date" id="report-from" value="${escapeHtml(range.from)}"></th>`
    + `<th class="count custom-range"><label for="report-to">End Date</label><input type="date" id="report-to" value="${escapeHtml(range.to)}"></th>`
    // Growth Rate (SP-241): the last column, its timeframe picked in the header; the periods come from the server's answer.
    + `<th class="count custom-range growth-rate"><label for="report-growth">Growth Rate</label><select id="report-growth">${r.growthPeriods.map((g, i) => `<option value="${escapeHtml(g.key)}"${i === 0 ? ' selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}</select></th></tr>`;
  const line = (label, counts) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => `<td class="count">${Number(counts[g.key])}</td>`).join('')}`
    + `<td class="count" data-custom-from></td><td class="count" data-custom="${counts === r.started ? 'started' : 'finished'}"></td>`
    + `<td class="count" data-growth="${counts === r.started ? 'started' : 'finished'}"></td></tr>`;
  // A flow row: one cell per range, "none finished in this range" where nothing finished.
  const flowLine = (label, cell) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => {
    const f = r.flow[g.key];
    return `<td class="count">${f.finished ? escapeHtml(cell(f)) : '<span class="quiet">none finished in this range</span>'}</td>`;
  }).join('')}</tr>`;
  const span = (ms) => (ms == null ? 'none counted' : spanOf(ms));
  const flow = (title, how, rows) => `
    <h2>${title}</h2>
    <p class="quiet">${how}</p>
    <div class="table-wrap"><table class="counts report flow"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  // A human-hours row: "no estimates yet in this range" where none was recorded, never 0 hours.
  const hoursLine = (label, cell) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => {
    const h = r.humanHours[g.key];
    return `<td class="count">${h.estimated ? escapeHtml(cell(h)) : '<span class="quiet">no estimates yet in this range</span>'}</td>`;
  }).join('')}</tr>`;
  const estimatedLine = `<tr><td class="name">Tasks with an estimate</td>${r.ranges.map((g) => {
    const h = r.humanHours[g.key];
    return `<td class="count">${h.finished ? `${Number(h.estimated)} of ${Number(h.finished)} estimated` : '<span class="quiet">none finished in this range</span>'}</td>`;
  }).join('')}</tr>`;
  const hoursOf = (n) => `${Number(n)} hour${Number(n) === 1 ? '' : 's'}`;
  // Where the Time Goes (SP-220): the four buckets by range, then the tickets with the most time in one range.
  const BUCKET_LABELS = [['working', 'Working'], ['lane', 'Waiting for a Lane'], ['operator', 'Waiting on You'], ['broken', 'Broken']];
  const bucketSpan = (ms) => (Number(ms) > 0 ? spanOf(Number(ms)) : 'none');
  const splitLine = (key, label) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => {
    const t = r.timeSplit[g.key];
    if (!t.total) return '<td class="count"><span class="quiet">none in this range</span></td>';
    const b = t.buckets[key];
    return `<td class="count">${escapeHtml(bucketSpan(b.ms))} (${Math.round(Number(b.share) * 100)}%)</td>`;
  }).join('')}</tr>`;
  const splitTable = BUCKET_LABELS.map(([key, label]) => splitLine(key, label)).join('');
  const splitTickets = (rangeKey) => {
    const t = r.timeSplit[rangeKey];
    if (!t || !t.tickets.length) return '<p class="quiet">No task was open in this range.</p>';
    const rows = t.tickets.map((x) => `<tr><td><a href="/t/${encodeURIComponent(x.id)}">${escapeHtml(x.id)}</a></td><td class="name">${escapeHtml(x.name)}</td><td class="count">${escapeHtml(bucketSpan(x.total))}</td>${BUCKET_LABELS.map(([key]) => `<td class="count">${escapeHtml(bucketSpan(x[key]))}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table class="counts report time-split-tickets"><thead><tr><th>Task</th><th>Name</th><th class="count">Total</th>${BUCKET_LABELS.map(([, label]) => `<th class="count">${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const conflictsHtml = conflictSection(r.conflicts);
  const open = r.open.map((s) => `<tr data-stage="${escapeHtml(s.status)}"><td class="status">${escapeHtml(s.status)}</td><td class="count">${Number(s.count)}</td></tr>`).join('');
  main.innerHTML = `
    <h1>Reporting</h1>
    <form class="report-scope">
      <label for="report-project">Project</label>
      <select id="report-project"><option value="">All projects</option>${projects.map((p) => `<option value="${escapeHtml(p.slug)}"${p.slug === r.project ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
    </form>
    <h2>Task Productivity</h2>
    <p class="quiet">Started: filed in that time. Finished: moved to Live in that time and still Live.</p>
    <div class="table-wrap"><table class="counts report productivity"><thead>${productivityHead}</thead><tbody>${line('Tasks started', r.started)}${line('Tasks finished', r.finished)}</tbody></table></div>
    <p class="quiet custom-range-note" hidden></p>
    <h2>Human Hours of Work Done</h2>
    <p class="quiet">For tasks finished in that time: the build loop's estimate, recorded on each pull request, of the hours an experienced programmer new to the code would take to do the same work. An estimate, not a measurement; tasks with none are left out of the total, and counted here.</p>
    <div class="table-wrap"><table class="counts report human-hours"><thead>${head}</thead><tbody>${hoursLine('Total', (h) => hoursOf(h.hours))}${estimatedLine}${hoursLine('Per day', (h) => `about ${Number(h.perDay)} human hour${Number(h.perDay) === 1 ? '' : 's'} a day`)}</tbody></table></div>
    ${flow('Time to Finish',
    'For tasks finished in that time: from first entering Queued to entering Live. Tasks that never entered Queued are left out, and counted here.',
    flowLine('Middle (median)', (f) => span(f.timeToFinish.median))
      + flowLine('Longest', (f) => span(f.timeToFinish.longest))
      + flowLine('Left out, never Queued', (f) => String(Number(f.timeToFinish.leftOut))))}
    ${flow('Sent Back',
    'Of the tasks finished in that time, how many review sent to Rework at least once (a task sent back twice counts once).',
    flowLine('Sent back at least once', (f) => `${Number(f.sentBack.count)} of ${Number(f.finished)} (${Math.round(f.sentBack.share * 100)}%)`))}
    ${flow('Waiting on You',
    'For tasks finished in that time: time spent in Needs your input or Ready to launch before going Live, added up and the middle (median) task.',
    flowLine('Total', (f) => span(f.waiting.total)) + flowLine('Middle (median)', (f) => span(f.waiting.median)))}
    <p class="waiting-now">Waiting on you right now: <strong>${Number(r.waitingNow)}</strong> task${Number(r.waitingNow) === 1 ? '' : 's'} in Needs your input or Ready to launch.</p>
    <h2>Where the Time Goes</h2>
    <p class="quiet">Every task's time in that range, open ones too, Live left out. Working: in Building. Waiting on You: in Needs your input or Ready to launch with your reply not yet the newest comment, and no merge word of yours still standing. Broken: from a loop's failure note on the task until its next move or your next comment. Waiting for a Lane: everything else, including all of In review, since nothing marks when a review starts. A loop that failed without writing on the task shows as waiting, not broken.</p>
    <div class="table-wrap"><table class="counts report time-split"><thead>${head}</thead><tbody>${splitTable}</tbody></table></div>
    <form class="report-scope time-split-range">
      <label for="time-split-range">Tasks with the Most Time In</label>
      <select id="time-split-range">${r.ranges.map((g, i) => `<option value="${escapeHtml(g.key)}"${i === 0 ? ' selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}</select>
    </form>
    <div class="time-split-list">${splitTickets(r.ranges[0]?.key)}</div>
    ${conflictsHtml}
    <h2>Open Now</h2>
    <p class="quiet">Tasks in each stage that is not Live.</p>
    <div class="table-wrap"><table class="counts stages"><thead><tr><th>Stage</th><th class="count">Tasks</th></tr></thead><tbody>${open}</tbody></table></div>`;
  const looks = stageLooks({ stages: r.open });
  for (const el of main.querySelectorAll('[data-stage]')) {
    const look = looks[el.dataset.stage];
    if (!look) continue;
    el.classList.add('coloured');
    el.style.setProperty('--stage-border', look.border);
    el.style.setProperty('--stage-tint', look.tint);
    el.style.setProperty('--stage-text', look.text);
  }
  main.querySelector('#time-split-range').addEventListener('change', (e) => {
    main.querySelector('.time-split-list').innerHTML = splitTickets(e.target.value);
  });
  // Growth Rate: the picker redraws both cells from the answer already here, never asking the server again.
  const growthPicker = main.querySelector('#report-growth');
  const showGrowth = () => {
    const period = r.growth[growthPicker.value];
    for (const cell of main.querySelectorAll('[data-growth]')) cell.innerHTML = growthCell(period?.[cell.dataset.growth]);
  };
  showGrowth();
  growthPicker.addEventListener('change', showGrowth);
  // The custom range: a picker change asks again and redraws only those cells; the newest ask wins.
  const fromPicker = main.querySelector('#report-from');
  const toPicker = main.querySelector('#report-to');
  let asked = 0;
  const showCustom = (figures, note) => {
    for (const cell of main.querySelectorAll('[data-custom-from]')) {
      cell.innerHTML = figures ? `<span class="quiet">from ${escapeHtml(dayLabel(fromPicker.value))}</span>` : '';
    }
    for (const cell of main.querySelectorAll('[data-custom]')) {
      cell.textContent = figures ? String(Number(figures[cell.dataset.custom])) : '';
    }
    const p = main.querySelector('.custom-range-note');
    p.textContent = note ?? '';
    p.hidden = !note;
  };
  const rangeProblem = (picked) => {
    if (!picked.from || !picked.to) return 'Pick both a start date and an end date.';
    return picked.from > picked.to ? 'The start date is after the end date.' : null;
  };
  showCustom(r.custom ?? null, rangeProblem(range));
  const repick = async () => {
    const picked = { from: fromPicker.value, to: toPicker.value };
    const ask = ++asked;
    const problem = rangeProblem(picked);
    if (problem) { showCustom(null, problem); return; }
    const again = await api('GET', reportsPath(r.project ?? '', picked));
    if (ask === asked) showCustom(again.custom, null);
  };
  for (const picker of [fromPicker, toPicker]) {
    picker.addEventListener('change', () => {
      repick().catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
    });
  }
  main.querySelector('#report-project').addEventListener('change', (e) => {
    drawReporting(e.target.value, { from: fromPicker.value, to: toPicker.value }).catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  });
  putTrail([{ label: 'Reporting' }]);
}

/** A share as a figure to two places: "0.29", or a quiet phrase when nothing merged. */
const perMerge = (rate) => (rate == null ? '<span class="quiet">nothing merged</span>' : escapeHtml(Number(rate).toFixed(2)));

/** What each note kind is called on the page. */
const CONFLICT_KINDS = { 'main-moved': 'after a merge', 'merge-refused': 'merge refused', 'catch-up': 'catch-up filed' };

/**
 * The Reporting page's Merge Conflicts section (SP-295) from the server's
 * `conflicts` answer (tracker/conflictReport.mjs works every figure out):
 * conflicts per merged pull request by the settings in force, the files
 * that conflict most, how many were between tickets split from one
 * request, and every conflict, newest first, each linking to its ticket.
 */
function conflictSection(c) {
  if (!c) return '';
  const intro = `<h2>Merge Conflicts</h2>
    <p class="quiet">A conflict: a pull request that stopped merging into main, from the loops' notes (a merge that left it conflicting, a merge word refused for a conflict, or a catch-up ticket filed). Notes on one pull request count once until it merges cleanly again. Each is counted under the wake times and work-in-progress cap in force when it happened; merges are counted the same way, so the last column compares settings fairly. All time.</p>`;
  if (!c.merged && !c.total) return `${intro}<p class="quiet">No merges or conflicts recorded yet.</p>`;
  const range = (g) => (g.since ? `${escapeHtml(when(g.since))} to ${escapeHtml(when(g.until))}` : '');
  const settingRows = c.bySetting.map((g) => `<tr><td class="name">${escapeHtml(g.setting)}</td><td>${range(g)}</td><td class="count">${Number(g.merged)}</td><td class="count">${Number(g.conflicts)}</td><td class="count">${perMerge(g.rate)}</td></tr>`).join('');
  const total = `<tr class="total"><td class="name">All settings</td><td></td><td class="count">${Number(c.merged)}</td><td class="count">${Number(c.total)}</td><td class="count">${perMerge(c.rate)}</td></tr>`;
  const files = c.topFiles.length
    ? `<div class="table-wrap"><table class="counts report conflict-files"><thead><tr><th>File</th><th class="count">Conflicts</th></tr></thead><tbody>${c.topFiles.map((f) => `<tr><td class="name"><code>${escapeHtml(f.file)}</code></td><td class="count">${Number(f.count)}</td></tr>`).join('')}</tbody></table></div>
      <p class="quiet">From the ${Number(c.withFiles)} of ${Number(c.total)} conflicts whose note names its files.</p>`
    : '<p class="quiet">No conflict note names its files yet.</p>';
  const siblings = `<p class="conflict-siblings">Between tickets split from one request: <strong>${Number(c.siblings.count)}</strong> of the ${Number(c.siblings.known)} conflicts whose cause is known.</p>`;
  const cause = (x) => {
    if (!x.causedBy) return '<span class="quiet">not known</span>';
    const pr = `PR #${Number(x.causedBy.pr)}`;
    const ticket = x.causedBy.ticket ? ` (<a href="/t/${encodeURIComponent(x.causedBy.ticket)}">${escapeHtml(x.causedBy.ticket)}</a>)` : '';
    return `${x.causedBy.inferred ? '<span class="quiet">probably</span> ' : ''}${pr}${ticket}`;
  };
  const rows = c.conflicts.map((x) => `<tr>
      <td class="when">${escapeHtml(when(x.at))}</td>
      <td class="ticket"><a href="/t/${encodeURIComponent(x.ticket)}">${escapeHtml(x.ticket)}</a></td>
      <td class="name">${escapeHtml(x.name)}</td>
      <td class="count">${x.pr == null ? '' : `#${Number(x.pr)}`}</td>
      <td>${x.kinds.map((k) => escapeHtml(CONFLICT_KINDS[k] ?? k)).join(', ')}</td>
      <td>${cause(x)}</td>
      <td>${escapeHtml(statusName(x.status))}</td>
      <td class="count">${x.prOpenMs == null ? '<span class="quiet">not known</span>' : escapeHtml(spanOf(x.prOpenMs))}</td>
      <td class="count">${Number(x.openPrs)}</td>
      <td>${x.sibling == null ? '' : x.sibling ? 'yes' : 'no'}</td>
      <td class="settings">${escapeHtml(x.setting)}</td>
      <td class="files">${x.files.length ? x.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(' ') : '<span class="quiet">not named</span>'}</td>
    </tr>`).join('');
  const list = c.conflicts.length
    ? `<div class="table-wrap"><table class="counts report conflict-list"><thead><tr><th>When</th><th>Task</th><th>Name</th><th class="count">Pull Request</th><th>Seen As</th><th>Caused By</th><th>Stage Then</th><th class="count">Open For</th><th class="count">Open Pull Requests</th><th>Siblings</th><th>Settings Then</th><th>Files</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${c.total > c.listed ? `<p class="quiet">The newest ${Number(c.listed)} of ${Number(c.total)} are listed; the counts above cover every one.</p>` : ''}`
    : '<p class="quiet">No conflict recorded yet.</p>';
  return `${intro}
    <div class="table-wrap"><table class="counts report conflict-settings"><thead><tr><th>Settings in Force</th><th>Dates</th><th class="count">Merged</th><th class="count">Conflicts</th><th class="count">Per Merged Pull Request</th></tr></thead><tbody>${settingRows}${total}</tbody></table></div>
    <p class="quiet">Open Pull Requests counts the project's tickets with a pull request opened and not yet merged at that moment; Caused By says "probably" where no note named the merge and it is the newest one before. Siblings: whether the two tickets were split from one request.</p>
    ${siblings}
    <h3>Files That Conflict Most</h3>
    ${files}
    <h3>Every Conflict</h3>
    ${list}`;
}

/**
 * One Growth Rate cell (SP-241) from the server's growth figure: the change
 * with its sign ("+25%", "-10%", "0%"), or a quiet phrase when there is no
 * fair number: not enough history yet, or none in the period before.
 */
function growthCell(figure) {
  if (!figure) return '';
  if (figure.change == null) {
    return `<span class="quiet">${figure.reason === 'too-young' ? 'not enough history yet' : 'none in the period before'}</span>`;
  }
  const n = Number(figure.change);
  return `${n > 0 ? '+' : ''}${n}%`;
}

/** A date picker's value (YYYY-MM-DD) for a local calendar day. */
function pickerDay(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The Task Productivity table's range on arrival: 30 days ago to today, in the browser's own time zone. */
function defaultReportRange(today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
  return { from: pickerDay(start), to: pickerDay(today) };
}

/** A picker's YYYY-MM-DD as a local Date at `hours:minutes:seconds.ms`, or null when it is not one. */
function localDay(value, ...time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), ...time) : null;
}

/** "Oct 14, 2026" for a picker's value. */
function dayLabel(value) {
  const day = localDay(value, 0, 0, 0, 0);
  return day ? day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : value;
}

/**
 * GET /reports for a project ('' for all) and, when both pickers hold a
 * date with the start not after the end, the custom range from the start of
 * the start date to the end of the end date, local time (SP-240).
 */
function reportsPath(slug, range) {
  const query = new URLSearchParams();
  if (slug) query.set('project', slug);
  const from = localDay(range?.from, 0, 0, 0, 0);
  const to = localDay(range?.to, 23, 59, 59, 999);
  if (from && to && from <= to) {
    query.set('from', from.toISOString());
    query.set('to', to.toISOString());
  }
  const text = query.toString();
  return `/reports${text ? `?${text}` : ''}`;
}
