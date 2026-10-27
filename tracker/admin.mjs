#!/usr/bin/env node
/**
 * Set up the tracker's store: make the actors (people and loops) that sign in,
 * and the projects their tickets belong to. The store is at TRACKER_DB.
 *
 *   node tracker/admin.mjs create-actor --kind human|machine --name <name>
 *   node tracker/admin.mjs create-project --slug <slug> --name <name> --prefix <PREFIX> [--operator <actor id>]
 *
 * create-actor prints the new token ONCE, alone on stdout, so it can be piped
 * straight into a secret store without reaching a terminal log; everything
 * else it says goes to stderr. Only the token's hash is kept.
 */
import { parseArgs } from 'node:util';
import { openStore } from './store.mjs';

const USAGE = `usage:
  node tracker/admin.mjs create-actor --kind human|machine --name <name>
  node tracker/admin.mjs create-project --slug <slug> --name <name> --prefix <PREFIX> [--operator <actor id>]
The store is opened at TRACKER_DB.`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
let values;
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      kind: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
      prefix: { type: 'string' },
      operator: { type: 'string' },
    },
    strict: true,
  }));
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}

if (!process.env.TRACKER_DB) fail(`set TRACKER_DB to the store's database path.\n${USAGE}`);

let store;
let made = null;
try {
  store = openStore(process.env.TRACKER_DB);
  if (command === 'create-actor') {
    const actor = store.createActor({ kind: values.kind, name: values.name });
    made = `actor ${actor.id} was created but has no token; run create-actor again and ignore that one`;
    const token = store.issueToken(actor.id);
    console.error(`actor ${actor.id} (${actor.kind}, "${actor.name}") created; its token follows on stdout and is not kept.`);
    process.stdout.write(`${token}\n`);
  } else if (command === 'create-project') {
    let operator = null;
    if (values.operator != null) {
      operator = Number(values.operator);
      if (!Number.isInteger(operator)) fail(`--operator is an actor id (a whole number), not "${values.operator}".`);
    }
    const project = store.createProject({ slug: values.slug, name: values.name, prefix: values.prefix, operator });
    console.log(`project "${project.slug}" created: name "${project.name}", tickets ${project.prefix}-1 onwards, operator ${project.operator ?? '(none)'}.`);
  } else {
    fail(USAGE);
  }
} catch (err) {
  fail(`${command} failed: ${err.message}\n${made ?? 'nothing was created.'}`);
} finally {
  store?.close();
}
