import test from 'node:test';
import assert from 'node:assert/strict';
import { abortableSleep, createQueryRunner, withQueryDeadline } from '../src/query-runtime.mjs';

test('query failures identify their layer without leaking command or database details, then report recovery', async () => {
  const logs = []; let mode = 'process';
  const query = createQueryRunner({ log: x => logs.push(x), run: async () => {
    if (mode === 'process') throw Object.assign(new Error('private arguments'), { stderr: 'private statement timeout' });
    return { stdout: mode === 'parse' ? 'private invalid content' : '1' };
  }});
  await assert.rejects(query('', [], {}, 'trip_snapshot'), { code: 'DB_STATEMENT_TIMEOUT' });
  mode = 'parse';
  await assert.rejects(query('', [], {}, 'trip_snapshot'), { code: 'DB_INVALID_JSON' });
  mode = 'ok'; assert.equal(await query('', [], {}, 'trip_snapshot'), 1);
  assert.equal(logs.at(-1).status, 'recovered');
  assert.equal(logs[1].failures, 2);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

test('monitor deadline aborts the underlying operation', async () => {
  let aborted = false;
  await assert.rejects(withQueryDeadline(({signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); });
  }), 5, 'fixture'), /timed out|cancelled/);
  assert.equal(aborted, true);
});

test('a bounded wait ends when its signal aborts and never starts on a spent one', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(abortableSleep(60_000, controller.signal), { name: 'AbortError' });
  await assert.rejects(abortableSleep(1, controller.signal), { name: 'AbortError' });
  await abortableSleep(1);
  await abortableSleep(1, new AbortController().signal);
});
