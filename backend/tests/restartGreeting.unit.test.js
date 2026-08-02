'use strict';
/**
 * Which words restart the conversation (dropping the patient's clinic) versus
 * which ones the bot engine handles itself. The distinction has two sharp edges:
 *
 *   "start" — the RE-SUBSCRIBE keyword. The opt-out reply says "to re-subscribe,
 *             reply START", and that only clears opted_out if the message reaches
 *             the engine with the clinic still attached. Restarting on it would
 *             leave an opted-out patient unable to ever opt back in.
 *   "menu"  — the one-step trip back to the CURRENT clinic's menu, which is what
 *             every "Reply *Menu*" prompt in the bot promises.
 *
 * Run: node tests/restartGreeting.unit.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const webhook = require('../src/routes/webhook');
const { RESTART_GREETING_RE, GREETING_RE } = webhook;

let passed = 0, failed = 0;
function check(name, actual, expected) {
  if (actual === expected) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${expected}\n     actual:   ${actual}`); failed++; }
}

console.log('\nrestart greeting — what "Hi" resets, and what it must not\n');

// ── Restarts the whole conversation ──────────────────────────
for (const word of ['hi', 'Hi', 'HELLO', 'hey', 'restart', 'hai', 'hy', 'helo']) {
  check(`"${word}" restarts`, RESTART_GREETING_RE.test(word), true);
}

// ── The two exceptions ───────────────────────────────────────
check('"start" does NOT restart (re-subscribe keyword)', RESTART_GREETING_RE.test('start'), false);
check('"START" does NOT restart (case-insensitive)', RESTART_GREETING_RE.test('START'), false);
check('"menu" does NOT restart (current clinic\'s menu)', RESTART_GREETING_RE.test('menu'), false);

// ── Not greetings at all ─────────────────────────────────────
for (const word of ['hidden', 'high', 'history', 'smile', 'hi there', '1', 'yes']) {
  check(`"${word}" is not a restart`, RESTART_GREETING_RE.test(word), false);
}

// ── In the clinic-search state, none of these are search text ─
for (const word of ['hi', 'start', 'menu', 'main menu', 'hello']) {
  check(`"${word}" is not treated as a clinic name`, GREETING_RE.test(word), true);
}
check('a real clinic name is search text', GREETING_RE.test('smile'), false);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
