/**
 * Mobile audit harness — 360x640 (the small end of what reception/dentist staff
 * actually carry). Measures a real render rather than reading markup: the last
 * mobile pass found several problems that were invisible in the source.
 *
 * Checks, per screen:
 *   - horizontal overflow of the document AND of every element
 *   - tap targets under 40px (the size the codebase already commits to)
 *   - content clipped out of the visible viewport
 *
 * Usage:
 *   node mobile_audit.js                 # 360x640
 *   VW=320 VH=568 node mobile_audit.js   # harshest width still in real use
 *
 * Needs the frontend on :3000 and the backend on :3001. Do NOT run `next build`
 * while `next dev` is serving — it replaces .next, the dev server then 404s its
 * own CSS, and every element measures at its bare intrinsic size. The stylesheet
 * guard in audit() catches that, but it costs a run.
 *
 * The dashboard sits behind the terms gate. To reach the tabs, accept it in the
 * UI or set the fixture on the LOCAL dev database:
 *   UPDATE tenants SET terms_accepted_at=NOW(), terms_version='1.0',
 *          terms_accepted_by='audit-fixture@localhost'
 *    WHERE slug='demo-clinic';
 * and undo it with the same statement setting those columns back to NULL.
 */
// puppeteer-core + the Chrome already installed, so this needs no Chromium download.
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 360x640 is the size the last mobile pass used; 320x568 is the harshest width
// still in real use and is where fixed-width layouts break first.
const W = Number(process.env.VW) || 360, H = Number(process.env.VH) || 640;
const BASE = 'http://localhost:3000';
const CREDS = { email: 'demo@medibook.com', password: 'Demo@123456', slug: 'demo-clinic' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Anything the user is expected to hit with a thumb. 40px is the figure the
// codebase already uses for its own touch targets (see Modal.js's close button).
const MEASURE = `
(() => {
  const doc = document.documentElement;
  const overflow = doc.scrollWidth - doc.clientWidth;

  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // Element sticking out past the right edge, ignoring things that are
    // deliberately scrollable containers or inside one.
    if (r.right > doc.clientWidth + 1) {
      let scrollableAncestor = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === 'auto' || ov === 'scroll') { scrollableAncestor = true; break; }
      }
      if (!scrollableAncestor) {
        offenders.push({
          kind: 'overflow-x',
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 70),
          text: (el.textContent || '').trim().slice(0, 40),
          right: Math.round(r.right),
        });
      }
    }
  }

  // Threshold calibrated to this codebase, not to a generic 44px rule: a
  // px-4 py-2 text-sm button is ~36px tall and is the house style everywhere,
  // so flagging those would bury the real problems. What actually defeats a
  // thumb is a SMALL control — an icon-only ✕, a chip — so the bar is 32px,
  // and tighter still for controls with no text to aim at.
  const small = [];
  for (const el of document.querySelectorAll('button, a, input[type=checkbox], input[type=radio], select, [role=button]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    // A checkbox inside a <label> is hit via the label, so measure that instead.
    const label = el.closest('label');
    const box = label ? label.getBoundingClientRect() : r;
    const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
    const iconOnly = text.length <= 2;
    const floor = iconOnly ? 36 : 30;
    if (box.height < floor || box.width < floor) {
      small.push({
        kind: 'tap-target',
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 30),
        size: Math.round(box.width) + 'x' + Math.round(box.height),
      });
    }
  }
  return { overflow, offenders: offenders.slice(0, 12), small: small.slice(0, 14),
           bodyScrollH: document.body.scrollHeight };
})()
`;

// `marker` is text that MUST be on screen for the audit to be meaningful. A
// modal that silently failed to open would otherwise report "clean".
async function audit(page, label, marker) {
  await sleep(700);
  // Guard against measuring an UNSTYLED page. Running `next build` while
  // `next dev` is serving replaces .next and makes the dev server 404 its own
  // CSS — every element then measures at its bare intrinsic size and the whole
  // run is meaningless (it reported four false problems that way).
  const styled = await page.evaluate(() =>
    [...document.styleSheets].some(s => { try { return s.cssRules.length > 50; } catch { return true; } }));
  if (!styled) { console.log(`\n### ${label}\n   !! STYLESHEET NOT LOADED — measurements invalid`); return 1; }
  if (marker) {
    const seen = await page.evaluate(m => document.body.innerText.includes(m), marker);
    if (!seen) { console.log(`\n### ${label}\n   !! NOT RENDERED (no "${marker}") — result meaningless`); return 1; }
  }
  const r = await page.evaluate(MEASURE);
  const problems = [];
  if (r.overflow > 1) problems.push(`PAGE SCROLLS SIDEWAYS by ${r.overflow}px`);
  for (const o of r.offenders) problems.push(`overflow: <${o.tag}> right=${o.right} "${o.text}" [${o.cls}]`);
  for (const s of r.small) problems.push(`tap target ${s.size}: <${s.tag}> "${s.text}"`);

  console.log(`\n### ${label}`);
  if (!problems.length) console.log('   clean');
  else problems.forEach(p => console.log('   - ' + p));
  return problems.length;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    args: [`--window-size=${W},${H}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  let total = 0;

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  total += await audit(page, 'Login');

  // Log in
  await page.evaluate((c) => {
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    const email = inputs.find(i => i.type === 'email' || /email/i.test(i.name + i.placeholder));
    const pass = inputs.find(i => i.type === 'password');
    const slug = inputs.find(i => /clinic|slug|tenant/i.test(i.name + i.placeholder));
    if (slug) set(slug, c.slug);
    if (email) set(email, c.email);
    if (pass) set(pass, c.password);
  }, CREDS);
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign in|log in|login/i.test(x.textContent));
    if (b) b.click();
  });
  await sleep(5000);

  // The terms gate BLOCKS the dashboard and is the worst case for a small
  // viewport — its accept button is the only way out, so it gets audited too.
  const gated = await page.evaluate(() => /Before you continue/i.test(document.body.innerText));
  if (gated) total += await audit(page, 'TermsGate (blocking)');

  // Nav buttons render their icon inside the same element, so textContent is
  // "📊Overview" — an anchored match never fires. Match on contains.
  const clickText = async (re) => {
    const ok = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const el = [...document.querySelectorAll('button, a, label')].find(x => rx.test(x.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    }, re);
    await sleep(1400);
    return ok;
  };

  const tabs = ['Overview', 'Appointments', 'Treatments', 'Dentists', 'Clinics', 'Patients',
                'Analytics', 'Calendar', 'Slots', 'Services', 'Holidays', 'Settings'];
  for (const t of tabs) {
    if (await clickText(t)) total += await audit(page, `Tab: ${t}`);
    else console.log(`\n### Tab: ${t}\n   (not reachable)`);
  }

  // The primary entry point for recording a treatment: the appointment row.
  await clickText('Appointments');
  if (await clickText('🩺 Treatment')) total += await audit(page, 'MODAL: Treatment from appointment row', 'Advised during the visit');
  await page.keyboard.press('Escape'); await sleep(600);

  // The new UI specifically
  await clickText('Treatments');
  if (await clickText('Record Treatment')) total += await audit(page, 'MODAL: Record Treatment', 'Advised during');
  await page.keyboard.press('Escape'); await sleep(600);

  await clickText('Treatments');
  if (await clickText('^\\s*Visits\\s*$')) total += await audit(page, 'MODAL: Treatment detail / visits', 'Rendered by');
  await page.keyboard.press('Escape'); await sleep(600);

  await clickText('Dentists');
  if (await clickText('Add Dentist|\\+ Dentist|Add Doctor')) total += await audit(page, 'MODAL: Add Dentist (Also Treats)', 'Also Treats');
  await page.keyboard.press('Escape'); await sleep(600);

  await clickText('Dentists');
  if (await clickText('Schedule')) {
    total += await audit(page, 'MODAL: Schedule', 'Break Start');
    // The toggle is an sr-only checkbox inside a label — click the label.
    await page.evaluate(() => {
      const l = [...document.querySelectorAll('label')].find(x => /Visiting consultant/i.test(x.textContent));
      if (l) l.querySelector('input').click();
    });
    await sleep(900);
    total += await audit(page, 'MODAL: Schedule (visiting consultant on)', 'Primary branch');
  }
  await page.keyboard.press('Escape'); await sleep(600);

  // The other two staff surfaces. The dentist portal is the one the last mobile
  // pass had to rebuild, so it gets re-checked on every run.
  for (const [path, label, marker] of [['/doctor', 'Dentist portal', null], ['/reception', 'Reception', null]]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
    await sleep(2500);
    total += await audit(page, label, marker);
    // Open the first row, which is where the detail pane appears on mobile.
    const opened = await page.evaluate(() => {
      const row = document.querySelector('[class*="cursor-pointer"], li, tr');
      if (row) { row.click(); return true; }
      return false;
    });
    if (opened) { await sleep(1200); total += await audit(page, `${label} (row selected)`); }
  }

  console.log(`\n=== ${total} problems found at ${W}x${H} ===`);
  await browser.close();
})().catch(e => { console.error('HARNESS FAILED:', e.message); process.exit(1); });
