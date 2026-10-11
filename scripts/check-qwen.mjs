import assert from 'node:assert/strict';
import { seedSessions } from '../lib/booking.mjs';
import { createQwen } from '../lib/qwen.mjs';

const timeZone = 'America/Los_Angeles';
const sessions = seedSessions();
const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' });
const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
const weekend = session => ['Saturday', 'Sunday'].includes(day.format(new Date(session.startsAt)));
const afternoon = session => { const localHour = Number(hour.format(new Date(session.startsAt))); return localHour >= 12 && localHour < 18; };
const morning = session => Number(hour.format(new Date(session.startsAt))) < 12;
const ids = predicate => sessions.filter(predicate).map(session => session.id).sort();

const provider = createQwen({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model: process.env.QWEN_MODEL || 'qwen3.5:4b-q4_K_M' });
const readiness = await provider.readiness();
console.log(JSON.stringify({ evidence: 'live-local-qwen', checkedAt: new Date().toISOString(), readiness,
  schedule: sessions.map(({ id, startsAt, priceCents }) => ({ id, startsAt, priceCents })) }));
if (!readiness.ready) {
  console.error('Local Qwen is unavailable. This check does not use a simulated fallback.');
  process.exitCode = 1;
} else {
  const cases = [
    { text: 'two of us any weekend afternoon up to $75 total', groupSize: 2, maxTotalCents: 7500,
      expectedIds: ids(session => weekend(session) && afternoon(session) && session.priceCents * 2 <= 7500) },
    { text: 'Saturday afternoon please', groupSize: null, maxTotalCents: null,
      expectedIds: ids(session => day.format(new Date(session.startsAt)) === 'Saturday' && afternoon(session)) },
    { text: 'three of us weekend morning, $40 per person', groupSize: 3, maxTotalCents: 12000,
      expectedIds: ids(session => weekend(session) && morning(session) && session.priceCents * 3 <= 12000) },
  ];
  let passed = 0;
  for (const check of cases) {
    let result;
    try {
      result = await provider.parsePreferences({ text: check.text, sessions, timeZone });
      assert.equal(result.groupSize, check.groupSize, 'Group size differs from the customer request.');
      assert.equal(result.maxTotalCents, check.maxTotalCents, 'Budget differs from the customer request.');
      assert.deepEqual([...result.sessionIds].sort(), check.expectedIds, 'Acceptable dates differ from the supplied calendar.');
      passed++;
      console.log(JSON.stringify({ passed: true, text: check.text, expectedIds: check.expectedIds, result }));
    } catch (error) {
      console.error(JSON.stringify({ passed: false, text: check.text, expectedIds: check.expectedIds,
        ...(result ? { result } : {}), error: { code: error.code || 'CHECK_FAILED', message: error.message } }));
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({ evidence: 'live-local-qwen', passed, total: cases.length }));
}
