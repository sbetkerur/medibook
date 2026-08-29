'use strict';

const { tenantQuery, pool, query, validateSchemaName } = require('../../db');
const { format, addDays, parseISO } = require('date-fns');
const { toZonedTime } = require('../../utils/dateTz');
const logger = require('../../utils/logger');

const IST = 'Asia/Kolkata';
const wa = require('../whatsapp');
const { SLOT_LOOKAHEAD_DAYS, CRON_LOOKAHEAD_DAYS } = require('../../utils/errors');
const { offerRequest } = require('./requestFlow');
const { nextFreeVisitNumber } = require('../../utils/treatmentPlan');
const {
  STATES,
  fuzzyFind,
  parseChoiceNumber,
  maskPhone,
  sendConfirmButtons,
  clinicPhoneLine,
  getPatient,
  getPatients,
  updateSession,
  logMessage,
  notifyAdminWhatsApp,
  reminder24hApplies,
  isReadOnlyDemo,
  READ_ONLY_DEMO_MESSAGE,
} = require('./utils');

/**
 * The "I don't know what I need" option, offered ahead of the named treatments.
 *
 * A sentinel rather than a real department row: it deliberately matches NO
 * department, so it lists every dentist at the branch instead of narrowing to
 * one specialty.
 *
 * It passes no department to the booking, which means
 * insertAppointmentWithRetry falls back to the chosen dentist's PRIMARY
 * department — so the receipt reads "General Dentistry" for a consultation with
 * a general dentist. That is the honest label for a visit where nothing has been
 * diagnosed yet; the actual treatment is recorded on the treatment plan the
 * dentist writes afterwards, and that plan's own sittings carry it explicitly.
 *
 * The name has to survive BOTH interactive shapes: a list row title caps at 24
 * characters and a reply-button title at 20, and whatsapp.js slices to fit
 * rather than let Meta reject the whole message. '🩺 Consultation / Not sure'
 * was 26 UTF-16 units (the emoji is a surrogate pair, so it costs two), which
 * rendered as "🩺 Consultation / Not su" in a list and "🩺 Consultation / No" on
 * a button — the latter reading as if "No" were the option. Keep this under 20.
 */
const GENERAL_CONSULT = { id: 'general_consult', name: '🩺 Not sure yet' };

/**
 * Header + footer for a step of the booking flow. Both cap at 60 characters
 * (whatsapp.js). The header carries the question so the body can carry only
 * information — that separation is what stops every message looking the same.
 *
 * This used to read "Step N of 5", which was a promise the flow did not keep:
 * after step 4 came the name, the date of birth and the reason for the visit,
 * all unnumbered, before the confirmation billed itself as step 5. Counting
 * honestly would advertise "1 of 8", and the total differs anyway between a new
 * patient and a returning one who only picks a profile. A number that is either
 * wrong or discouraging is worse than no number on a flow this short.
 */
const STEP = (header) => ({ header, footer: 'Reply Menu to start over' });
const BRANCH_STEP = { header: 'Which branch?', footer: 'Reply Menu to start over' };

/**
 * One WhatsApp list row for a dentist. Specialisation leads because a treatment
 * can list a specialist and a general dentist side by side now that dentists
 * belong to several departments — "Endodontist" vs "General Dentist" is the
 * distinction the patient is actually choosing on. WhatsApp truncates row
 * descriptions at 72 chars, so trim rather than let it cut mid-word server-side.
 */
function doctorListRow(d, showFees = true) {
  return {
    id: d.id,
    title: fitPersonName(d.name),
    // The complete name, which sendChoice moves into the description whenever
    // the title above had to shorten it.
    fullTitle: `Dr. ${d.name}`,
    description: [d.specialization, d.qualification,
      showFees && d.consultation_fee ? '₹' + d.consultation_fee : '']
      .filter(Boolean).join(' • '),
  };
}

// Meta's caps on interactive titles, mirrored from whatsapp.js, which slices to
// them rather than let Meta reject the whole message. A reply button is cut FOUR
// characters earlier than a list row — and emoji cost two units each, being
// surrogate pairs, which is why these compare .length and not visible glyphs.
const BUTTON_TITLE_MAX = 20;
const LIST_ROW_TITLE_MAX = 24;
const LIST_ROW_DESC_MAX = 72;

/**
 * A dentist's name fitted to a list-row title.
 *
 * Cutting a long name at the character limit is the one truncation that can make
 * a picker unusable rather than merely ugly: "Dr. Padmanabhan Venkatesh" and
 * "Dr. Padmanabhan Krishnan" both end up "Dr. Padmanabhan…", and the patient
 * cannot tell which dentist is which. Abbreviating the GIVEN names instead keeps
 * the surname — the part that distinguishes them, and how a long name gets
 * written on a clinic board anyway. The full name still reaches the patient:
 * sendChoice puts it in the row description.
 */
function fitPersonName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Dr.';
  const full = `Dr. ${parts.join(' ')}`;
  if (full.length <= LIST_ROW_TITLE_MAX) return full;

  // "Padmanabhan Venkatesh" → "P. Venkatesh"
  if (parts.length > 1) {
    const initials = parts.slice(0, -1).map(p => `${p[0].toUpperCase()}.`).join(' ');
    const abbreviated = `Dr. ${initials} ${parts[parts.length - 1]}`;
    if (abbreviated.length <= LIST_ROW_TITLE_MAX) return abbreviated;
  }
  // One name that overruns on its own — nothing left to abbreviate.
  return `${full.slice(0, LIST_ROW_TITLE_MAX - 1)}…`;
}

/**
 * Any other label fitted to a list-row title, cut at a word boundary.
 *
 * "Oral and Maxillofacial Surgery" reads far better as "Oral and Maxillofacial…"
 * than as the mid-word "Oral and Maxillofacial S" a blind slice produces. The
 * boundary is only honoured in the last few characters, though: "Restorative and
 * Cosmetic Dentistry" breaks at 15, and "Restorative and…" both ends on a
 * conjunction and throws away the word that distinguishes it from plain
 * restorative work — a mid-word "Restorative and Cosmeti…" carries more. As with
 * names, the full text survives in the description.
 */
function fitTitle(text) {
  const s = String(text || '');
  if (s.length <= LIST_ROW_TITLE_MAX) return s;
  const cut = s.slice(0, LIST_ROW_TITLE_MAX - 1); // room for the ellipsis
  const space = cut.lastIndexOf(' ');
  const base = space >= LIST_ROW_TITLE_MAX - 6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s•,\-]+$/, '')}…`;
}

/**
 * Render a set of choices as buttons or as a list.
 *
 * Buttons need ≤3 options AND every label to fit in 20 characters. Every picker
 * here used to switch on the COUNT alone, so a short set of long names —
 * "Orthodontics & Braces", "Dr. Padmanabhan Venkatesh", a branch named after its
 * locality — rendered as buttons and was cut mid-word, when the list row it
 * would otherwise have used holds four more characters and carries a
 * description besides. The branch picker made this explicit with a
 * `.slice(0, 20)` on the label; the others simply let whatsapp.js do it.
 *
 * Falling through to the list is also the safer tap: a list reply carries the
 * row's real id, which every handler matches exactly, while a button reply
 * carries a synthetic `btn_N_<ts>` and leaves the handler to recognise the
 * TITLE — the very string that was truncated.
 *
 * No title slot is wider than 24 characters anywhere in the WhatsApp API, so a
 * label longer than that CANNOT be shown whole in the title. It is shown whole
 * in the DESCRIPTION instead — 72 characters, rendered under the title — and the
 * title carries a shortened form purely as the visual handle. Nothing a patient
 * needs to tell two rows apart is lost, which is the actual requirement; a name
 * cut to "Dr. Padmanabhan…" fails it, "Dr. P. Venkatesh" with the full name
 * beneath does not.
 *
 * `fullTitle` is the untruncated label when the caller has already shortened
 * `title` itself (doctorListRow does, to abbreviate given names rather than
 * chop surnames). It also decides the widget: buttons carry no description, so
 * they are only used when the FULL label fits a button — otherwise the row falls
 * to a list, where the description can hold what the title cannot.
 *
 * @param {Array<{id, title, fullTitle?, description?}>} items
 */
async function sendChoice(send, prompt, items, opts, { listLabel, sectionTitle }) {
  const fullOf = i => String(i.fullTitle || i.title);
  const fitsButtons = items.length <= 3
    && items.every(i => fullOf(i).length <= BUTTON_TITLE_MAX);
  if (fitsButtons) {
    // Every label fits whole, so the button shows the full text — never the
    // caller's pre-shortened one.
    return send.buttons(prompt, items.map(fullOf), opts);
  }
  return send.list(prompt, listLabel,
    [{ title: fitTitle(sectionTitle), rows: fitRows(items) }], opts);
}

/**
 * Choice items as WhatsApp list rows, each fitted to the 24-character title.
 *
 * Split out of sendChoice so a caller that must stay a list — the "pick one
 * from the list" re-prompt, whose own copy promises one — gets the same fitting
 * instead of hand-rolling rows that truncate.
 */
function fitRows(items) {
  return items.map(i => {
    const full = String(i.fullTitle || i.title);
    const title = fitTitle(String(i.title));
    // The full label leads the description whenever the title had to shorten
    // it — ahead of the caller's own detail, because identifying the row is what
    // the patient is doing here and the specialisation is context.
    const description = [title === full ? '' : full, i.description]
      .filter(Boolean).join(' • ').slice(0, LIST_ROW_DESC_MAX);
    return { id: i.id, title, ...(description ? { description } : {}) };
  });
}

/**
 * Does this clinic want its consultation fee quoted to patients?
 *
 * Indian clinics routinely waive the consultation when the patient takes the
 * treatment, and they negotiate. A firm number shown in WhatsApp and then not
 * charged at the desk is an argument the receptionist has to have, so the
 * clinic can switch it off. Defaults to TRUE — that is what every existing
 * clinic already shows, and silently hiding a price they had been quoting
 * would be its own surprise.
 */
async function showFeesEnabled(schema) {
  try {
    const r = await query(`SELECT settings FROM tenants WHERE schema_name=$1`, [schema]);
    return r.rows[0]?.settings?.show_consultation_fee !== false;
  } catch (err) {
    logger.warn('Fee-display setting lookup failed — showing fee', { error: err.message });
    return true;
  }
}

/**
 * Read and clear `global_bot_sessions.pending_hospital_id` in one statement, so
 * two messages racing through booking can't both consume the same preset.
 * Returns null on any failure — a branch preselection is a convenience, and it
 * must never be the reason a booking can't start.
 */
async function _takePendingHospital(phone) {
  try {
    const r = await query(
      `UPDATE global_bot_sessions SET pending_hospital_id = NULL
        WHERE phone = $1 AND pending_hospital_id IS NOT NULL
        RETURNING pending_hospital_id`,
      [phone]
    );
    return r.rows[0]?.pending_hospital_id || null;
  } catch (err) {
    logger.warn('Could not read pending branch', { phone: maskPhone(phone), error: err.message });
    return null;
  }
}

async function startBooking(phone, schema, tenant, send, ctx) {
  const hospitals = await tenantQuery(schema,
    `SELECT id, name, city FROM hospitals WHERE is_active=true ORDER BY name`);

  if (!hospitals.rows.length) {
    await send.text('No branches are open for online booking at the moment.\n\nPlease call us, or reply *Menu* to try again later.'
      + await clinicPhoneLine(schema));
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // A branch the patient has ALREADY chosen before booking began, so the branch
  // question can be skipped. It lives on the GLOBAL session because the
  // synthesised "Hi" that follows clinic selection resets this session's
  // context, so it could not have been parked here.
  //
  // Nothing writes it at present: an entry code identifies a CLINIC, and the
  // city picker that used to write it is gone. Kept because it is exactly the
  // hook a per-BRANCH QR code would need, and because the read is a no-op while
  // the column stays NULL.
  //
  // Consumed one-shot: cleared whether or not it still resolves, so a branch
  // that has since been deactivated can't wedge every future booking, and a
  // patient who books twice is asked normally the second time.
  const presetId = await _takePendingHospital(phone);
  if (presetId) {
    const preset = hospitals.rows.find(h => h.id === presetId);
    if (preset) {
      ctx.hospital_id = preset.id;
      ctx.hospital_name = preset.name;
      return showDepartments(phone, schema, tenant, send, ctx);
    }
  }

  if (hospitals.rows.length === 1) {
    ctx.hospital_id = hospitals.rows[0].id;
    ctx.hospital_name = hospitals.rows[0].name;
    return showDepartments(phone, schema, tenant, send, ctx);
  }

  // Multiple branches — show interactive list/buttons so the user taps, not types
  ctx._hospitals = hospitals.rows;

  const prompt = 'Which one is easiest for you to get to?';

  await sendChoice(send, prompt,
    hospitals.rows.map(h => ({ id: h.id, title: h.name, description: h.city || '' })),
    BRANCH_STEP, { listLabel: 'See branches', sectionTitle: 'Our Branches' });
  await updateSession(schema, phone, STATES.SELECT_HOSPITAL, ctx);
}

async function handleSelectHospital(phone, schema, tenant, send, ctx, choice, input) {
  let hospitalRows = ctx._hospitals;
  if (!hospitalRows || !hospitalRows.length) {
    const r = await tenantQuery(schema, `SELECT id, name, city FROM hospitals WHERE is_active=true ORDER BY name`);
    hospitalRows = r.rows;
    ctx._hospitals = hospitalRows;
  }

  // If the user tapped a stale main-menu button while already in SELECT_HOSPITAL,
  // re-send the branch picker rather than trying to match button titles as clinic names.
  if (/book appointment|my appointments|address & phone|check status/i.test(input)) {
    return _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows);
  }

  const numChoice = parseChoiceNumber(input);
  const words = (input || '').toLowerCase().split(/\s+/).filter(Boolean);

  const h =
    // 1. Exact UUID match from a list-reply
    hospitalRows.find(r => r.id === choice) ||
    // 2. Button-index match (btn_0, btn_1, btn_2 from buttons widget)
    (/^btn_(\d+)/i.test(choice)
      ? hospitalRows[parseInt(choice.match(/^btn_(\d+)/i)[1], 10)]
      : null) ||
    // 3. Numeric selection ("1", "2", …) — MUST come before name matching.
    //    Branch names commonly contain digits ("Smile Dental - Road No. 2"), so
    //    a substring check ran first turned "2" (meaning branch 2, as the
    //    numbered text fallback instructs) into a match on branch 1.
    (!isNaN(numChoice) && numChoice >= 1 && numChoice <= hospitalRows.length ? hospitalRows[numChoice - 1] : null) ||
    // 4. All typed words present in name ("smile banjara" → "Smile Dental -
    //    Banjara Hills") — but ONLY when exactly one branch matches. This used
    //    .find(), the one ambiguity-by-list-order bypass left in this chain:
    //    with "MediSmile — Jubilee Hills" and "MediSmile — Jubilee Hills
    //    Annexe" on the books, "medismile jubilee" is contained in both and the
    //    patient was silently booked at whichever sorted first, with the
    //    appointment, the confirmation address and the 24h reminder all naming
    //    a branch they never chose. fuzzyFind refuses exactly this (see
    //    tests/fuzzyFind.unit.test.js); rule 4 must too, and fall through to the
    //    re-prompt below.
    (words.length > 1 ? (() => {
      const matches = hospitalRows.filter(r => words.every(w => (r.name || '').toLowerCase().includes(w)));
      return matches.length === 1 ? matches[0] : null;
    })() : null) ||
    // 5. Exact / unique-substring / fuzzy match. fuzzyFind rather than a raw
    //    .includes(): the latter had no length floor, so a single character
    //    selected whichever branch happened to be first.
    fuzzyFind(hospitalRows, input);

  if (!h) {
    // Re-prompt rather than cancelling — user may have mistyped
    await send.text('I could not tell which branch you meant. Please pick one:');
    return _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows);
  }

  ctx.hospital_id = h.id;
  ctx.hospital_name = h.name;
  return showDepartments(phone, schema, tenant, send, ctx);
}

// Helper: render the branch picker (buttons or list depending on count)
async function _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows) {
  const prompt = 'Which one is easiest for you to get to?';
  await sendChoice(send, prompt,
    hospitalRows.map(h => ({ id: h.id, title: h.name, description: h.city || '' })),
    BRANCH_STEP, { listLabel: 'See branches', sectionTitle: 'Our Branches' });
  await updateSession(schema, phone, STATES.SELECT_HOSPITAL, ctx);
}

// Dental is always in-person — skip the visit type question and go straight to treatments.
async function showDepartments(phone, schema, tenant, send, ctx) {
  ctx.visit_type = 'in_person';
  ctx.visit_label = '🦷 In-Clinic Visit';

  // Via doctor_departments, not doctors.department_id: a dentist can render
  // several treatments (a GP who also does simple RCTs), and the join table is
  // the bookable set. The doctor's primary department is always in it.
  const depts = await tenantQuery(schema,
    `SELECT DISTINCT d.id, d.name FROM departments d
     JOIN doctor_departments dd ON dd.department_id=d.id
     JOIN doctors doc ON doc.id=dd.doctor_id
     WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
       AND doc.online_bookable=true
       AND doc.hospital_id=$1
     ORDER BY d.name`, [ctx.hospital_id]);

  if (!depts.rows.length) {
    await send.text('Nothing is set up for online booking yet.\n\nPlease call us to book. Reply *Menu* to go back.'
      + await clinicPhoneLine(schema, ctx.hospital_id));
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // Most patients arrive with a symptom, not a diagnosis: they book a
  // consultation with the clinic and the dentist decides what the treatment is.
  // Forcing a specialty first asks the patient a question only the dentist can
  // answer — and picking wrong lands them with the wrong dentist. So the first
  // option is always "not sure", which books any available dentist; the named
  // treatments stay for the patients who DO know (a returning braces case).
  const options = [GENERAL_CONSULT, ...depts.rows];
  ctx._depts = options;

  // Smart-intent shortcut: if detectIntent() recognised a treatment in the
  // user's free text (e.g. "book root canal"), skip the treatment picker and
  // jump straight to dentist selection for that department.
  if (ctx.department_hint) {
    const hinted = fuzzyFind(depts.rows, ctx.department_hint);
    delete ctx.department_hint; // one-shot — never reuse on later messages
    if (hinted) {
      return handleSelectDept(phone, schema, tenant, send, ctx, hinted.id, hinted.name);
    }
  }

  const prompt = 'Not sure what you need? Pick the first option — the dentist will advise at your visit.';
  await sendChoice(send, prompt,
    options.map(d => ({
      id: d.id,
      title: d.name,
      ...(d.id === GENERAL_CONSULT.id ? { description: 'Any available dentist' } : {}),
    })),
    STEP('What do you need?'), { listLabel: 'Choose', sectionTitle: 'Appointments' });
  await updateSession(schema, phone, STATES.SELECT_DEPARTMENT, ctx);
}

async function handleSelectDept(phone, schema, tenant, send, ctx, choice, input, buttonId) {
  let depts = ctx._depts || [];
  // Re-fetch from DB if cache is missing (e.g. session resumed after expiry).
  // Without this, a stale empty _depts leaves the user permanently stuck.
  if (!depts.length && ctx.hospital_id) {
    const r = await tenantQuery(schema,
      `SELECT DISTINCT d.id, d.name FROM departments d
       JOIN doctor_departments dd ON dd.department_id=d.id
       JOIN doctors doc ON doc.id=dd.doctor_id
       WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
         AND doc.online_bookable=true
         AND doc.hospital_id=$1
       ORDER BY d.name`, [ctx.hospital_id]);
    depts = [GENERAL_CONSULT, ...r.rows];
    ctx._depts = depts;
  }
  const deptNumChoice = parseChoiceNumber(input);
  // "not sure" / "any" / "consultation" typed freely resolves to the sentinel.
  // Checked before fuzzyFind, whose scoring over department NAMES would never
  // match these words — and whose one-match rule would otherwise reject them.
  //
  // Gated on !buttonId ("typed, not tapped"), matching the idiom in botEngine.
  // This was `!choice`, which is NEVER true: choice is `buttonId || lowerInput`
  // and the engine returns early when both are absent, so the whole synonym
  // list was dead and typing "any" or "checkup" fell through to the "I couldn't
  // tell which treatment you meant" re-prompt. Only "not sure" and
  // "consultation" appeared to work, by accidental substring match against
  // GENERAL_CONSULT's own name — which is also why the tests passed.
  const wantsGeneral = !buttonId && /^(not sure|not sure yet|dont know|don'?t know|any|anyone|any doctor|any dentist|consult|consultation|general|checkup|check up)$/i
    .test(input.trim());
  const dept = (wantsGeneral ? GENERAL_CONSULT : null)
    || depts.find(d => d.id === choice) || fuzzyFind(depts, input)
    || (deptNumChoice >= 1 && deptNumChoice <= depts.length ? depts[deptNumChoice - 1] : null);
  if (!dept) {
    // Same reasoning as dentist selection: an unrecognised or ambiguous reply
    // should re-ask, not discard the booking.
    if (depts.length) {
      // Stays a list — its own copy promises one — but through fitRows, or a
      // long treatment name is cut in exactly the re-prompt that exists because
      // the patient could not identify one.
      await send.list(
        `I could not tell which treatment you meant. Please pick one from the list:`,
        'View Treatments',
        [{ title: 'Treatments', rows: fitRows(depts.map(d => ({ id: d.id, title: d.name }))) }]
      );
      await updateSession(schema, phone, STATES.SELECT_DEPARTMENT, ctx);
      return;
    }
    await send.buttons('Booking cancelled — nothing has been reserved.\n\nWhat would you like to do?',
      ['🗓 Book Appointment', '🗓 My Appointments', '📍 Address & Phone']);
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  const isGeneralConsult = dept.id === GENERAL_CONSULT.id;

  // On the "not sure" path, ask what brings them in BEFORE showing dentists.
  // Collected after the slot — as it was for every path — the answer arrived
  // too late to affect anything: the dentist, day and time were already chosen,
  // so it could only ever be a note. Asked here it can still route a patient in
  // pain, and it puts any multi-visit warning in front of them before they
  // commit to a time. Named treatments skip this: choosing "Root Canal" has
  // already answered the question.
  if (isGeneralConsult && !ctx.chief_complaint) {
    ctx._complaint_first = true;
    ctx._pending_dept_id = dept.id;
    ctx._pending_dept_name = dept.name;
    return askChiefComplaint(phone, schema, send, ctx);
  }
  // Nothing is diagnosed yet on a consultation, so no department is recorded —
  // the dentist's plan supplies it later. See GENERAL_CONSULT.
  ctx.department_id = isGeneralConsult ? null : dept.id;
  ctx.department_name = isGeneralConsult ? 'Consultation' : dept.name;

  // A consultation is with the clinic, so every dentist at the branch is
  // offered. Otherwise: every dentist who renders this treatment, not just
  // those whose PRIMARY department it is — the general dentist offering root
  // canals has to appear alongside the endodontist. Specialists first (the
  // doctor whose primary department this is leads the list), then by name.
  const doctors = isGeneralConsult
    ? await tenantQuery(schema,
        // General dentists first, then by fee, then by name. Alphabetical put
        // the ₹700 endodontist at the top of the list for a patient who had
        // just said they did NOT know what they needed — the one person least
        // able to judge whether a specialist is warranted. A consultation
        // should default to the generalist; specialists stay one tap away.
        `SELECT d.id, d.name, d.qualification, d.consultation_fee, d.specialization,
                false AS is_primary
         FROM doctors d
         LEFT JOIN departments dep ON dep.id = d.department_id
         WHERE d.hospital_id=$1 AND d.is_active=true AND d.online_bookable=true
         ORDER BY (COALESCE(d.specialization,'') ILIKE '%general%'
                   OR COALESCE(dep.name,'') ILIKE 'general%') DESC,
                  d.consultation_fee ASC NULLS LAST,
                  d.name`,
        [ctx.hospital_id])
    : await tenantQuery(schema,
        `SELECT d.id, d.name, d.qualification, d.consultation_fee, d.specialization,
                (d.department_id = $1) AS is_primary
         FROM doctors d
         JOIN doctor_departments dd ON dd.doctor_id=d.id AND dd.department_id=$1
         WHERE d.hospital_id=$2 AND d.is_active=true AND d.online_bookable=true
         ORDER BY is_primary DESC, d.name`,
        [dept.id, ctx.hospital_id]);

  if (!doctors.rows.length) {
    await send.text(`No dentists are taking ${dept.name} bookings at the moment.\n\nReply *Menu* to choose another treatment.`);
    return;
  }

  ctx._doctors = doctors.rows;

  // "Not sure yet" already skipped the treatment question because only the
  // dentist can name one — asking the patient to then pick a NAME from a list
  // is the same question in disguise. Auto-assign the branch's default
  // generalist (the query above already orders general dentists first, by
  // fee, then name — this is the same doctor who used to lead the list) and
  // go straight to their available dates. proceedWithDoctor's own "nothing
  // free" fallback still offers the rest of doctors.rows by name if the
  // default generalist has no open slots.
  if (isGeneralConsult) {
    return proceedWithDoctor(phone, schema, tenant, send, ctx, doctors.rows[0], doctors.rows);
  }

  // Treatment-specific advisory note
  const treatmentNotes = {
    'Root Canal Treatment':    'ℹ️ Root canal treatment typically requires *2–3 visits*. Please plan accordingly.',
    'Dental Implants':         'ℹ️ Implant treatment is a *multi-stage process* spanning several months.',
    'Orthodontics & Braces':   'ℹ️ This is an initial *braces/aligner consultation*. Treatment duration is assessed at first visit.',
    'Oral Surgery':            'ℹ️ Please avoid eating or drinking *4 hours before* oral surgery procedures.',
    'Cosmetic Dentistry':      'ℹ️ Cosmetic procedures may require *multiple visits* for best results.',
    'Pediatric Dentistry':     'ℹ️ A parent or guardian must be present for patients under 18.',
  };
  const note = treatmentNotes[dept.name];
  if (note) await send.text(note);

  // The heading already says "dentist" — repeating it in the body ("Select
  // Dentist / Available General Dentistry dentists:") said the same word three
  // times. The body now carries information the header cannot.
  //
  // isGeneralConsult is always false here — that path returns above.
  const doctorPrompt = `Everyone below treats ${dept.name.toLowerCase()}.`;
  const feesOn = await showFeesEnabled(schema);
  await sendChoice(send, doctorPrompt, doctors.rows.map(d => doctorListRow(d, feesOn)),
    STEP('Choose a dentist'),
    { listLabel: 'See dentists', sectionTitle: `${dept.name} Dentists` });
  await updateSession(schema, phone, STATES.SELECT_DOCTOR, ctx);
}

async function handleSelectDoctor(phone, schema, tenant, send, ctx, choice, input) {
  const doctors = ctx._doctors || [];
  const cleanInput = input.toLowerCase().replace(/^dr\.?\s*/i, '').trim();
  const docNumChoice = parseChoiceNumber(input);
  const doc = doctors.find(d => d.id === choice) || fuzzyFind(doctors, cleanInput)
    || (docNumChoice >= 1 && docNumChoice <= doctors.length ? doctors[docNumChoice - 1] : null);
  if (!doc) {
    // fuzzyFind deliberately returns null when input is too short or matches
    // more than one dentist, rather than guessing by list order. Re-prompt —
    // throwing the patient back to the main menu made an ambiguous reply cost
    // them the whole booking flow.
    if (doctors.length) {
      const feesOn = await showFeesEnabled(schema);
      await send.list(
        `I could not tell which dentist you meant. Please pick one from the list:`,
        'View Dentists',
        [{ title: 'Dentists', rows: doctors.map(d => doctorListRow(d, feesOn)) }]
      );
      await updateSession(schema, phone, STATES.SELECT_DOCTOR, ctx);
      return;
    }
    await send.buttons('Booking cancelled — nothing has been reserved.\n\nWhat would you like to do?',
      ['🗓 Book Appointment', '🗓 My Appointments', '📍 Address & Phone']);
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  return proceedWithDoctor(phone, schema, tenant, send, ctx, doc, doctors);
}

// Shared by handleSelectDoctor (patient picked a name) and the "Not sure yet"
// auto-assign path in handleSelectDept (patient never saw a dentist list) —
// both end up here once a doctor has been decided, one way or the other.
async function proceedWithDoctor(phone, schema, tenant, send, ctx, doc, doctors) {
  ctx.doctor_id = doc.id;
  ctx.doctor_name = doc.name;

  // Single query for all available dates (avoids N+1 per-day COUNT loops).
  // Use IST "today" — servers run in UTC so new Date() can be a day behind IST
  // for the 5.5 hours after IST midnight, which would exclude today's slots.
  const nowInIST = toZonedTime(new Date(), IST);
  const todayStr = format(nowInIST, 'yyyy-MM-dd');

  // Scoped to the BRANCH the patient chose, not just the dentist. A visiting
  // consultant is at one branch on Tuesdays and another on Thursdays, and
  // slotGenerator stamps each slot with the branch that weekday belongs to
  // (`doctor_hospitals`), so a doctor-only filter offered a patient who picked
  // Banjara Hills the dentist's Jubilee Hills days — and the confirmation,
  // the appointment row and the reminder all then named the wrong address.
  //
  // The holiday check is correlated on the SLOT's own hospital_id for the same
  // reason: keyed on the session's branch, a holiday at Banjara Hills hid the
  // doctor's Jubilee Hills days, the exact inversion of the per-branch rule
  // isBlockedDay() implements in the generator.
  const findDates = async (windowDays) => tenantQuery(schema, `
    SELECT slot_date::text AS date, COUNT(*) AS slots
    FROM time_slots
    WHERE doctor_id = $1
      AND hospital_id = $4
      AND slot_date BETWEEN $2 AND $3
      AND status = 'available'
      AND (
        slot_date > $2
        OR start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
      )
      AND NOT EXISTS (
        SELECT 1 FROM doctor_leaves dl
        WHERE dl.doctor_id = $1 AND dl.leave_date = slot_date
      )
      AND NOT EXISTS (
        SELECT 1 FROM clinic_holidays ch
        WHERE ch.holiday_date = slot_date
          AND (ch.hospital_id IS NULL OR ch.hospital_id = time_slots.hospital_id)
      )
    GROUP BY slot_date
    ORDER BY slot_date
    LIMIT 7
  `, [doc.id, todayStr, format(addDays(nowInIST, windowDays), 'yyyy-MM-dd'), ctx.hospital_id]);

  // The usual two-week window first. If it comes back empty, look across the
  // whole generated horizon before giving up: visiting specialists attend
  // fortnightly or monthly, so their next clinic is routinely further out than
  // two weeks. The slots already exist (the cron generates CRON_LOOKAHEAD_DAYS
  // ahead) — a patient booking a treatment sitting with a visiting endodontist
  // was simply told "contact the clinic", which is what the whole self-booking
  // flow exists to avoid, and there is no alternative dentist to offer them.
  let datesResult = await findDates(SLOT_LOOKAHEAD_DAYS);
  let beyondUsualWindow = false;
  if (!datesResult.rows.length) {
    datesResult = await findDates(CRON_LOOKAHEAD_DAYS);
    beyondUsualWindow = datesResult.rows.length > 0;
  }

  const dates = datesResult.rows.map(r => ({
    date: r.date,
    label: r.date === todayStr ? `Today (${format(nowInIST, 'd MMM')})` : format(parseISO(r.date), 'EEE, d MMM'),
    slots: parseInt(r.slots),
  }));

  // Say so, rather than letting a date three weeks out look like an oversight.
  if (beyondUsualWindow) {
    await send.text(
      `Dr. ${doc.name} has nothing free in the next ${SLOT_LOOKAHEAD_DAYS} days.\n\n` +
      `The next day they are in is *${dates[0].label.replace(/^Today \(|\)$/g, '')}*.`
    );
  }

  if (!dates.length) {
    // Offer other dentists in the same department so the user doesn't have to
    // restart the entire booking flow just to try a different doctor.
    const otherDoctors = doctors.filter(d => d.id !== doc.id);
    if (otherDoctors.length > 0) {
      const feesOn = await showFeesEnabled(schema);
      // CRON_LOOKAHEAD_DAYS, not SLOT_LOOKAHEAD_DAYS: reaching here means the
      // widened search found nothing either, so quoting the two-week figure
      // would understate how far ahead we actually looked.
      await send.text(`Dr. ${doc.name} has nothing free in the next ${CRON_LOOKAHEAD_DAYS} days. These dentists also do ${ctx.department_name}:`);
      await sendChoice(send, 'Who would you like to see?',
        otherDoctors.map(d => doctorListRow(d, feesOn)), STEP('Choose a dentist'),
        { listLabel: 'See dentists', sectionTitle: `${ctx.department_name} Dentists` });
      await updateSession(schema, phone, STATES.SELECT_DOCTOR, { ...ctx, _doctors: otherDoctors });
    } else {
      // No other doctors in this department — guide user back to menu
      const deptLabel = ctx.department_name || 'this specialty';
      await send.text(
        `Dr. ${doc.name} has nothing free in the next ${CRON_LOOKAHEAD_DAYS} days, and no one else is taking ${deptLabel} bookings just now.`
        + await clinicPhoneLine(schema, ctx.hospital_id)
      );
      // The grid is a guide, not the diary — an Indian clinic would have found
      // this patient a time on the phone. Keep the context so the receptionist
      // rings back knowing which dentist and treatment they wanted.
      ctx.request_note = `Wanted Dr. ${doc.name} for ${deptLabel} — nothing free in ${CRON_LOOKAHEAD_DAYS} days`;
      await updateSession(schema, phone, STATES.IDLE, ctx);
      await offerRequest(send, 'That is a long wait.');
      return;
    }
    return;
  }

  // Cache BEFORE the date_hint shortcut below. handleSelectDate fails closed
  // when _dates is empty (it will not accept a date that was never offered), so
  // calling it with an unpopulated cache made it reject the date this function
  // had just computed — and it returns without updateSession, so the session
  // stayed in select_doctor with date_hint still stored. Every subsequent
  // dentist tap re-entered the same dead end with no list to pick from.
  ctx._dates = dates; // cache for numeric fallback selection

  // Smart-intent shortcut: if detectIntent() recognised a date in the user's
  // free text ("tomorrow", "friday", …) and that date has open slots, skip the
  // date picker and show the time slots directly.
  if (ctx.date_hint) {
    const hintedDate = dates.find(d => d.date === ctx.date_hint);
    delete ctx.date_hint; // one-shot — never reuse on later messages
    if (hintedDate) {
      return handleSelectDate(phone, schema, tenant, send, ctx, hintedDate.date);
    }
    // Hint did not match an offered date — fall through to the picker below.
    // The session write there also persists the date_hint deletion, so the
    // patient is not stuck repeating a hint that can never resolve.
  }

  const sections = [{
    title: 'Available Dates',
    // "12 slots available" on every row is noise — the number only matters when
    // it is small enough to create urgency.
    rows: dates.map(d => ({
      id: d.date,
      title: d.label,
      ...(d.slots <= 3 ? { description: `Only ${d.slots} left` } : {}),
    })),
  }];
  await send.list(`Dr. ${doc.name} is free on these days.`, 'Pick a day', sections,
    STEP('When suits you?'));
  await updateSession(schema, phone, STATES.SELECT_DATE, ctx);
}

// Re-render the offered dates after an answer we could not resolve.
//
// Unrecognised input at this step used to send "❌ Booking cancelled." and wipe
// the context — so typing "tomorrow" at the date list cost the patient the whole
// booking. handleSelectDept and handleSelectDoctor already made the opposite
// call ("should re-ask, not discard the booking"); this matches them.
async function _repromptDates(phone, schema, send, ctx, lead) {
  const cachedDates = ctx._dates || [];
  if (cachedDates.length) {
    await send.list(
      `${lead}\n\nPlease pick a date from the list:`,
      'Choose Date',
      [{ title: 'Available Dates', rows: cachedDates.map(d => ({
        id: d.date, title: d.label, description: `${d.slots} slots available`,
      })) }]
    );
  } else {
    // No cache to re-offer (session resumed after expiry, or a context write was
    // lost). Still don't cancel — "Menu" restarts the picker from the top.
    await send.text(`${lead}\n\nI have lost track of the dates I offered. Reply *Menu* to start again.`);
  }
  await updateSession(schema, phone, STATES.SELECT_DATE, ctx);
}

async function handleSelectDate(phone, schema, tenant, send, ctx, choice) {
  const cachedDates = ctx._dates || [];
  let resolvedDate = choice;
  // Accept numeric input ("1", "2") when list fell back to text
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
    const n = parseChoiceNumber(resolvedDate);
    if (n >= 1 && n <= cachedDates.length) {
      resolvedDate = cachedDates[n - 1].date;
    } else {
      return _repromptDates(phone, schema, send, ctx,
        `I could not tell which date you meant.`);
    }
  }
  // Only accept dates from the offered list. The list query excludes doctor
  // leaves and clinic holidays, so a typed arbitrary date skipped those checks
  // entirely and could book a slot on a day the clinic is closed.
  //
  // This check does NOT cover a stale list row tapped after a holiday was
  // declared — the row was legitimately offered, so it is in `_dates` and passes
  // here. Sessions have no TTL and the cleanup cron only purges non-idle ones
  // after 7 days, so that list can be a week old. The re-check on the slot query
  // below (and again on completeBooking's lock) is what closes that hole.
  //
  // Fail CLOSED when the cache is missing (session resumed after expiry, or a
  // context write was lost): `cachedDates.length && ...` used to let any
  // well-formed YYYY-MM-DD through in exactly the situation where we have no
  // idea whether that date is open.
  if (!cachedDates.length || !cachedDates.some(d => d.date === resolvedDate)) {
    return _repromptDates(phone, schema, send, ctx, 'That date is not available.');
  }
  ctx.appointment_date = resolvedDate;

  // Past-slot guard must be a single AND-ed same-day test. The old form
  //   (slot_date > today OR start_time > now::time)
  // is true for ANY past date whose start_time happens to be later in the day
  // than the current clock time, so past slots were offered and then rejected
  // by completeBooking's lock with a misleading "someone just booked that slot".
  //
  // SLOT_DAY_OPEN_SQL re-checks leaves and holidays against the date the patient
  // actually chose. The date list this came from was filtered when it was BUILT;
  // a holiday declared since then does not retroactively edit the cached rows.
  // hospital_id: same visiting-consultant reason as findDates above — the slots
  // offered must be the ones at the branch the patient picked.
  const { SLOT_DAY_OPEN_SQL } = require('../bookingCore');
  const slots = await tenantQuery(schema,
    `SELECT id, start_time, end_time FROM time_slots
     WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
       AND hospital_id=$3
       AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
       AND ${SLOT_DAY_OPEN_SQL}
     ORDER BY start_time`,
    [ctx.doctor_id, resolvedDate, ctx.hospital_id]);

  if (!slots.rows.length) {
    // Auto-suggest next available dates instead of dead-ending
    const nextDateR = await tenantQuery(schema, `
      SELECT slot_date::text AS date, COUNT(*) AS slots
      FROM time_slots
      WHERE doctor_id = $1
        AND hospital_id = $3
        AND slot_date > $2
        AND status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM doctor_leaves dl WHERE dl.doctor_id = $1 AND dl.leave_date = slot_date
        )
        AND NOT EXISTS (
          SELECT 1 FROM clinic_holidays ch WHERE ch.holiday_date = slot_date
            AND (ch.hospital_id IS NULL OR ch.hospital_id = time_slots.hospital_id)
        )
      GROUP BY slot_date
      ORDER BY slot_date
      LIMIT 3
    `, [ctx.doctor_id, resolvedDate, ctx.hospital_id]);

    if (nextDateR.rows.length) {
      const suggestions = nextDateR.rows.map(r => {
        let label = r.date;
        try { label = format(parseISO(r.date), 'EEE, d MMM'); } catch {}
        return `• ${label} (${r.slots} slots)`;
      }).join('\n');
      await send.text(`Nothing left on that date.\n\nDr. ${ctx.doctor_name} is next free on:\n${suggestions}`);
      ctx.request_preferred_date = ctx.appointment_date || null;
      ctx.request_note = `Wanted ${ctx.appointment_date || 'that date'} with Dr. ${ctx.doctor_name}`;
      await updateSession(schema, phone, STATES.IDLE, ctx);
      await offerRequest(send, 'If none of those suit you, we can still help.');
      return;
    } else {
      await send.text('Nothing left on that date. Please pick another.\n\nReply *Menu* to start over.');
    }
    return;
  }

  // WhatsApp list messages are capped at 10 rows per section.
  // Slice here so we never hit the API limit; store only the shown slots in
  // _slots so that numeric text-fallback replies ("1", "2", …) resolve correctly.
  const visibleSlots = slots.rows.slice(0, 10);
  ctx._slots = visibleSlots;

  let dateLabel = resolvedDate;
  try { dateLabel = format(parseISO(resolvedDate), 'EEE, d MMM'); } catch {}

  const sections = [{
    title: `Slots on ${dateLabel}`.slice(0, 24),
    rows: visibleSlots.map(s => ({
      id: s.id,
      title: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`,
    })),
  }];
  // The dentist's name is a nicety here, not a guarantee: the slot picker is
  // also reached by paths that never set it (a resumed session, reschedule),
  // and "with Dr. undefined" is worse than not naming them at all.
  const withDoctor = ctx.doctor_name ? ` with Dr. ${ctx.doctor_name}` : '';
  await send.list(`${dateLabel}${withDoctor}.`, 'Pick a time', sections,
    STEP('What time?'));
  await updateSession(schema, phone, STATES.SELECT_SLOT, ctx);
}

async function handleSelectSlot(phone, schema, tenant, send, ctx, choice, input) {
  const slots = ctx._slots || [];
  const num = parseChoiceNumber(input);
  const slot = slots.find(s => s.id === choice)                             // list reply (ID)
    || slots.find(s => s.start_time.slice(0, 5) === choice || s.start_time.slice(0, 5) === input) // time match (typed or button title)
    || (!isNaN(num) && num >= 1 && num <= slots.length ? slots[num - 1] : null); // typed number
  if (!slot) {
    // Re-ask, don't discard. "10 am" or "morning" typed at the time list used to
    // send "❌ Booking cancelled." and wipe the context — six steps of work lost
    // to one unrecognised word, unlike every other picker in this flow.
    let dateLabel = ctx.appointment_date;
    try { dateLabel = format(parseISO(ctx.appointment_date), 'EEE, d MMM'); } catch {}
    if (slots.length) {
      await send.list(
        `I could not tell which time you meant. Please pick one on ${dateLabel}:`,
        'Choose Time',
        [{ title: `Slots on ${dateLabel}`.slice(0, 24), rows: slots.map(s => ({
          id: s.id, title: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`,
        })) }]
      );
    } else {
      // Nothing cached to re-offer (session resumed after expiry, or a lost
      // context write) — still not a reason to throw the booking away.
      await send.text(`I have lost track of the times I offered. Reply *Menu* to pick a slot again.`);
    }
    await updateSession(schema, phone, STATES.SELECT_SLOT, ctx);
    return;
  }

  ctx.slot_id = slot.id;
  ctx.appointment_time = slot.start_time;

  const patients = await getPatients(schema, phone);
  if (patients.length === 0) {
    // No profiles yet — collect new patient details
    await send.text('Nearly there — what name should the appointment be under?');
    await updateSession(schema, phone, STATES.COLLECT_NAME, ctx);
    return;
  }

  // One or more profiles — let the user pick or add a new person
  ctx._patients = patients;
  if (patients.length === 1) {
    await send.buttons(
      'Who is this appointment for?',
      [`👤 ${patients[0].name}`, '➕ Add new person'],
      STEP('Who is it for?')
    );
  } else {
    const sections = [{
      title: 'Family Members',
      rows: [
        ...patients.map(p => ({ id: p.id, title: p.name, description: p.gender || '' })),
        { id: 'new_patient', title: '➕ Add new person', description: 'Book for someone else' },
      ],
    }];
    await send.list('Who is this appointment for?', 'Choose', sections, STEP('Who is it for?'));
  }
  await updateSession(schema, phone, STATES.SELECT_PATIENT, ctx);
}

async function handleSelectPatient(phone, schema, send, ctx, choice, input) {
  const patients = ctx._patients || [];

  // "Add new person" — via list reply ID, button title, or typed text
  if (
    choice === 'new_patient' ||
    /^➕|^add new|^new person|^new$/i.test(input) ||
    /^btn_1/i.test(choice)
  ) {
    await send.text('And their full name?');
    await updateSession(schema, phone, STATES.COLLECT_NAME, ctx);
    return;
  }

  // Match by patient ID (list reply) or by name.
  // Strict digits only: parseInt('3c1b…') === 3, so a stale list-reply UUID used
  // to resolve to an arbitrary person in this list.
  const typedName = input.replace(/^👤\s*/, '').trim();
  const numChoice = parseChoiceNumber(typedName);
  const selected =
    patients.find(p => p.id === choice) ||
    patients.find(p => (p.name || '').toLowerCase() === typedName.toLowerCase()) ||
    (!isNaN(numChoice) && numChoice >= 1 && numChoice <= patients.length ? patients[numChoice - 1] : null) ||
    // fuzzyFind, not a raw .includes(): family profiles routinely share a
    // surname, and "nita" matches both "Sunita" and "Anita". Booking the wrong
    // family member is worse than asking again, so ambiguity must return null.
    fuzzyFind(patients, typedName);

  if (!selected) {
    await send.text('Please pick someone from the list, or tap *Add new person*.');
    return;
  }

  ctx.patient_id = selected.id;
  ctx.patient_name = selected.name;
  return askChiefComplaint(phone, schema, send, ctx);
}

async function askChiefComplaint(phone, schema, send, ctx) {
  // On the "not sure" path this was already asked BEFORE the dentist, so asking
  // again after the name would be the second time — and worse, the patient's
  // next word ("Confirm") would be captured as their reason for visiting.
  // Every caller routes through here, so the guard belongs here.
  if (ctx.chief_complaint) {
    return showConfirmation(phone, schema, send, ctx, updateSession);
  }
  // Unspaced slashes, matching complaintMap below verbatim: a spaced label
  // runs over the 20-UTF-16-unit button cap and gets silently truncated by
  // Meta. '🔍 Checkup/Follow-up' lands at exactly 20 — closing the spaces
  // makes the label the patient taps identical to the value the clinic reads
  // back.
  await send.buttons(
    'In your own words — it helps the dentist prepare.',
    ['🚨 Pain/Emergency', '🔍 Checkup/Follow-up', '✨ Cosmetic/Other'],
    { header: 'What brings you in?' }
  );
  await updateSession(schema, phone, STATES.COLLECT_CHIEF_COMPLAINT, ctx);
}

async function handleChiefComplaint(phone, schema, send, ctx, choice, input, updateSessionFn, tenant) {
  const complaintMap = { btn_0: '🚨 Pain/Emergency', btn_1: '🔍 Checkup/Follow-up', btn_2: '✨ Cosmetic/Other' };
  const matchedKey = Object.keys(complaintMap).find(k =>
    (choice || '').startsWith(k + '_') || choice === k
  );
  ctx.chief_complaint = matchedKey ? complaintMap[matchedKey] : (input || null);

  // Asked BEFORE the dentist when the patient said "not sure" (see
  // showDepartments): at that point the answer can still change who they see.
  // Asked after the slot on every other path, where it is only a note for the
  // dentist. `_complaint_first` says which of the two we are in.
  if (ctx._complaint_first) {
    delete ctx._complaint_first;
    return handleSelectDept(phone, schema, tenant, send, ctx, ctx._pending_dept_id, ctx._pending_dept_name);
  }
  return showConfirmation(phone, schema, send, ctx, updateSessionFn);
}

async function showConfirmation(phone, schema, send, ctx, updateSessionFn) {
  let dateLabel = ctx.appointment_date;
  try { dateLabel = format(parseISO(ctx.appointment_date), 'EEEE, d MMMM yyyy'); } catch {}
  const time = ctx.appointment_time?.slice(0, 5);

  // Fetch consultation fee if we have a doctor ID and the clinic quotes it.
  let feeText = '';
  if (ctx.doctor_id && ctx.hospital_name && await showFeesEnabled(schema)) {
    try {
      const feeR = await tenantQuery(schema,
        `SELECT consultation_fee FROM doctors WHERE id=$1`, [ctx.doctor_id]);
      const fee = feeR.rows[0]?.consultation_fee;
      // Just "Fee": on the consultation path the line above already reads
      // "Consultation · <name>", and "Consultation ₹300" under it said it twice.
      // "payable at the clinic" is doing real work — it stops the number
      // reading as a prepayment, and leaves room for the waiver or discount the
      // desk will actually apply.
      if (fee > 0) feeText = `\nFee ₹${fee}, payable at the clinic`;
    } catch (_) {}
  }

  // Eight lines each opening with a different emoji read as clutter, not care.
  // The shape below leads with WHEN and WHO — the two things a patient checks —
  // then the supporting detail in one quiet block. One glyph, used once.
  // Quoted and attributed. "I think I need a root canal" typed by a patient is
  // what they SAID, not something the clinic has assessed — and when they turn
  // up with something else, an unattributed line is the one pointed at.
  const complaintLine = ctx.chief_complaint ? `\nYou told us: _${ctx.chief_complaint}_` : '';
  const summary =
    `*${dateLabel}*\n` +
    `*${time}* with Dr. ${ctx.doctor_name}\n\n` +
    `${ctx.hospital_name}\n` +
    `${ctx.department_name} · ${ctx.patient_name}` +
    feeText +
    complaintLine;

  // sendConfirmButtons binds btn_0/btn_1 to THIS message: a stale "✅ Confirm"
  // tap from an abandoned earlier booking must not book this one (botEngine's
  // CONFIRM_BOOKING branch checks the binding).
  await sendConfirmButtons(send, ctx, summary, ['✅ Confirm', '❌ Cancel'],
    { header: 'Check and confirm', footer: 'Nothing is booked until you confirm' });
  await updateSessionFn(schema, phone, STATES.CONFIRM_BOOKING, ctx);
}

async function completeBooking(phone, schema, tenant, send, ctx) {
  const { LIMITS } = require('../../utils/errors');
  const { insertAppointmentWithRetry, checkMonthlyQuota, SLOT_DAY_OPEN_SQL } = require('../bookingCore');

  // Whole-tenant read-only guard (the shareable demo clinic) — checked before
  // any query, including the patient upsert further down. See isReadOnlyDemo
  // in bot/utils.js for why this can't live at the HTTP layer alone.
  if (isReadOnlyDemo(tenant)) {
    await send.text(READ_ONLY_DEMO_MESSAGE);
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // Guard: validate schema name before using it in a raw SET LOCAL command.
  // tenantQuery/tenantTransaction enforce this internally; since completeBooking
  // uses pool.connect() directly for a custom transaction, we must check here too.
  if (!schema || !/^tenant_[a-z0-9_]+$/.test(schema)) {
    logger.error(`completeBooking: invalid schema name "${schema}", aborting booking`);
    await send.text('Something went wrong at our end and nothing was booked.\n\nReply *Menu* to try again.');
    return;
  }

  // Phone rate limit: max N confirmed bookings per hour (prevents bot flooding)
  try {
    const recentR = await tenantQuery(schema,
      `SELECT COUNT(*) FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       WHERE p.phone=$1 AND a.status='confirmed' AND a.created_at >= NOW() - INTERVAL '1 hour'`,
      [phone]);
    if (parseInt(recentR.rows[0].count) >= LIMITS.MAX_BOOKINGS_PER_HOUR) {
      await send.text(`That is ${LIMITS.MAX_BOOKINGS_PER_HOUR} bookings in an hour — please give it a little while before making another.\n\nIf you need something urgently, call us.`
        + await clinicPhoneLine(schema, ctx.hospital_id));
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  } catch (_) {} // rate limit check is non-fatal

  // Standing cap: max N appointments open at once per phone, WhatsApp only.
  // The rate limit above stops a burst; this stops the same abuse spread out
  // slowly enough to dodge it — one booking every 20 minutes still reaches
  // dozens of held slots by end of day. Counts every CONFIRMED appointment
  // under this phone regardless of date (a past one the desk hasn't marked
  // completed yet is still "open" from the clinic's point of view), across
  // every patient profile sharing the number — family booking shares a phone,
  // and the slots it holds are what this exists to protect.
  try {
    const openR = await tenantQuery(schema,
      `SELECT COUNT(*) FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       WHERE p.phone=$1 AND a.status='confirmed'`,
      [phone]);
    if (parseInt(openR.rows[0].count) >= LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE) {
      await send.text(
        `You already have ${LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE} appointments booked under this number — nothing new was booked.\n\n` +
        `Reply *My Appointments* to reschedule or cancel one first, or call us if this is urgent.`
        + await clinicPhoneLine(schema, ctx.hospital_id));
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  } catch (_) {} // open-appointment cap check is non-fatal, same as the rate limit above

  // Plan quota: block bookings once the clinic's monthly allowance is used up
  const quota = await checkMonthlyQuota(tenant);
  if (!quota.allowed) {
    logger.warn('Monthly appointment quota reached — booking blocked', {
      tenant: tenant.slug, used: quota.used, limit: quota.limit,
    });
    await send.text(
      '*Online booking is paused*\n\n' +
      'We are not taking more bookings through WhatsApp at the moment. ' +
      'Please call us and we will book you in.\n\n' +
      'Reply *Menu* to go back.'
      + await clinicPhoneLine(schema, ctx.hospital_id)
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // This is the one place outside db/index.js that interpolates a schema name
  // into SQL, so it has to run the same check tenantQuery/tenantTransaction do.
  // superadmin.js INSERTs the tenants row BEFORE createTenantSchema validates
  // it, so a malformed schema_name can exist in `tenants` and reach here.
  validateSchemaName(schema);

  // Single transaction: patient upsert + slot lock + appointment insert (that
  // order is load-bearing — see the lock-ordering note inside).
  const client = await pool.connect();
  let bookingId;
  let patientId = ctx.patient_id;

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}", public`);

    // Patient row FIRST, slot SECOND — and it must stay that order.
    //
    // The admin walk-in route (POST /appointments) has always taken the patient
    // row before the slot. This function used to take them the other way round,
    // so a bot booking and a walk-in racing on the same patient + same slot each
    // held the lock the other was waiting on: Postgres aborted one with 40P01
    // and the patient saw "Something went wrong with your booking". Both paths
    // now go patients → time_slots → appointments; the appointments-last leg was
    // already consistent everywhere.
    //
    // Nothing leaks if the slot lock below then fails: this INSERT/UPDATE is in
    // the same transaction, and every failure path from here on ROLLBACKs before
    // returning, so the patient row and the visit_count bump are undone together.
    // (`patientId` is left pointing at a row that no longer exists after such a
    // rollback — every one of those paths returns immediately and never uses it.)
    //
    // Insert new patient or increment visit count for existing one.
    // Phone is no longer unique (family booking) so we use a plain INSERT for new profiles.
    if (!patientId) {
      const pr = await client.query(
        `INSERT INTO patients (phone, name, date_of_birth, gender, visit_count)
         VALUES ($1,$2,$3,$4,1)
         RETURNING id`,
        [phone, ctx.patient_name, ctx.patient_dob || null, ctx.patient_gender || null]);
      patientId = pr.rows[0].id;
    } else {
      await client.query(
        `UPDATE patients SET visit_count=visit_count+1, updated_at=NOW() WHERE id=$1`, [patientId]);
    }

    // A treatment sitting: re-check the course under the plan's row lock BEFORE
    // touching the slot. Locks go plan → slot everywhere (POST
    // /treatment-plans/:id/visits does the same); a receptionist booking the
    // same sitting from the dashboard while the patient confirms on WhatsApp
    // would deadlock against the opposite order.
    //
    // The session context was written when the patient tapped *Treatment* —
    // possibly days ago on an abandoned flow — and the clinic may have booked
    // this sitting at the desk since. The session is not the authority on how
    // many sittings remain; this count is.
    let planVisitNumber = null;
    if (ctx.treatment_plan_id) {
      const lockedPlan = await client.query(
        `SELECT id, status, total_visits FROM treatment_plans WHERE id=$1 FOR UPDATE`,
        [ctx.treatment_plan_id]);
      const counts = await client.query(`
        SELECT visit_number FROM appointments
        WHERE treatment_plan_id = $1 AND status <> 'cancelled'
      `, [ctx.treatment_plan_id]);
      const live = lockedPlan.rows[0];
      const usedVisitNumbers = counts.rows.map(r => r.visit_number);
      const booked = usedVisitNumbers.length;
      if (!live || !['proposed', 'in_progress'].includes(live.status) || booked >= live.total_visits) {
        const err = new Error('PLAN_NOT_BOOKABLE');
        err.code = 'PLAN_NOT_BOOKABLE';
        throw err;
      }
      // Fill the gap left by a cancelled sitting rather than booked+1, or a
      // rebooking after a mid-course cancellation collides with the visit
      // number a later sitting already holds (idx_appt_plan_visit_no) and the
      // patient can never get past this screen. Mirrors routes/treatmentPlans.js.
      planVisitNumber = nextFreeVisitNumber(usedVisitNumbers, booked);
    }

    // Atomic slot lock. The time predicate re-checks that the slot hasn't
    // passed — a patient can sit on the confirm screen for hours (4h session
    // window) and previously could confirm a slot whose start time had gone by.
    //
    // SLOT_DAY_OPEN_SQL is the last line of defence for a day the clinic closed
    // mid-flow: the date list, the slot list and this confirm screen can all
    // predate the holiday/leave being declared. Failing here costs the patient a
    // re-pick; not failing here books them into a locked clinic.
    const slotUpdate = await client.query(
      `UPDATE time_slots SET status='booked'
       WHERE id=$1 AND status='available'
         AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
         AND ${SLOT_DAY_OPEN_SQL}
       RETURNING id, hospital_id`,
      [ctx.slot_id]);

    if (!slotUpdate.rows.length) {
      // Idempotency check — before we tell the patient "someone else booked
      // it", check whether it was actually THEM. If a prior run of this exact
      // job already committed (transaction succeeded but the process died or
      // the session-reset write failed before the job could be marked done),
      // BullMQ retries with the same stale CONFIRM_BOOKING context and lands
      // back here. The slot is correctly no longer 'available' — but it's our
      // own earlier commit, not a stranger's. Look for a confirmed appointment
      // on this exact slot for this exact phone (must run BEFORE the ROLLBACK
      // below, since search_path is only set for the life of this transaction).
      const existing = await client.query(
        `SELECT a.booking_id FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.slot_id = $1 AND a.status = 'confirmed' AND p.phone = $2
         ORDER BY a.created_at DESC LIMIT 1`,
        [ctx.slot_id, phone]
      );
      // Why the lock failed changes what we should say. A holiday/leave declared
      // while the patient sat on the confirm screen is not a race — telling them
      // "someone just booked that slot" sends them back to pick another time on
      // a day that no longer has any. Checked after the idempotency lookup: an
      // already-committed booking stands regardless of a later closure.
      const dayClosed = existing.rows.length ? { rows: [] } : await client.query(
        `SELECT 1 FROM time_slots WHERE id=$1 AND NOT (${SLOT_DAY_OPEN_SQL}) LIMIT 1`,
        [ctx.slot_id]);
      await client.query('ROLLBACK');
      if (existing.rows.length) {
        await send.text(
          `*Already booked*\n\n` +
          `This appointment is confirmed — there is nothing more to do.\n\n` +
          `Booking ID *${existing.rows[0].booking_id}*\n\n` +
          `Reply *My* to see the details.`
        );
        await updateSession(schema, phone, STATES.IDLE, {});
        return;
      }
      await send.text(dayClosed.rows.length
        ? '*That day has just been closed*\n\n' +
          'The clinic is no longer open then. Please pick another day.\n\n' +
          'Reply *Menu* to go back.'
        : '*Someone just took that time*\n\n' +
          'It went while you were deciding. Please choose another.\n\n' +
          'Reply *Menu* to go back.'
      );
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }

    // Insert with booking-ID collision retry (shared with walk-in/follow-up routes)
    ({ bookingId } = await insertAppointmentWithRetry(client, {
      patientId,
      doctorId: ctx.doctor_id,
      // The branch comes from the LOCKED SLOT, not the session. For a visiting
      // consultant the two can disagree — the slot carries the branch that
      // weekday belongs to (doctor_hospitals), while ctx holds whichever branch
      // the patient picked several steps earlier. The slot is the row the
      // dentist's calendar was actually generated from, so it wins; the session
      // value is only the fallback for a slot predating the hospital_id column.
      hospitalId: slotUpdate.rows[0].hospital_id || ctx.hospital_id,
      slotId: ctx.slot_id,
      appointmentDate: ctx.appointment_date,
      appointmentTime: ctx.appointment_time,
      visitType: ctx.visit_type || 'in_person',
      notes: ctx.chief_complaint
        || (ctx.treatment_plan_title ? `${ctx.treatment_plan_title} — visit ${planVisitNumber}` : null),
      // The treatment the patient actually picked. Can't be re-derived from the
      // doctor any more — a dentist belongs to several departments.
      departmentId: ctx.department_id || null,
      treatmentPlanId: ctx.treatment_plan_id || null,
      visitNumber: planVisitNumber,
    }));

    // First sitting booked ⇒ the course has started. Same derivation the admin
    // routes use, so a plan can't end up in a status the dashboard disagrees with.
    if (ctx.treatment_plan_id) {
      const { derivePlanStatus } = require('../../utils/treatmentPlan');
      const after = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_visits,
               COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS booked_visits
        FROM appointments WHERE treatment_plan_id = $1
      `, [ctx.treatment_plan_id]);
      const planR = await client.query(
        `SELECT status, total_visits FROM treatment_plans WHERE id=$1`, [ctx.treatment_plan_id]);
      const next = derivePlanStatus(planR.rows[0].status, {
        totalVisits: planR.rows[0].total_visits,
        completedVisits: after.rows[0].completed_visits,
        bookedVisits: after.rows[0].booked_visits,
      });
      if (next !== planR.rows[0].status) {
        await client.query(`UPDATE treatment_plans SET status=$1, updated_at=NOW() WHERE id=$2`,
          [next, ctx.treatment_plan_id]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Not a fault — the sitting was booked or the course closed while this
    // patient was mid-flow. Saying "something went wrong" would send them
    // round again for an appointment they already have.
    if (err.code === 'PLAN_NOT_BOOKABLE') {
      logger.info('Treatment sitting no longer bookable', { plan: ctx.treatment_plan_id });
      await send.text(
        'Every sitting for this treatment is already in the diary.\n\n' +
        'Reply *My* to see them.'
      );
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    logger.error('Booking transaction failed', { error: err.message });
    await send.text(
      '*Something went wrong at our end*\n\n' +
      'Nothing was booked, so no time has been held for you.\n\n' +
      'Reply *Menu* to try again — and please call us if it happens twice.'
      + await clinicPhoneLine(schema, ctx.hospital_id)
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  } finally {
    client.release();
  }

  // Reset the session to IDLE as the very next statement after commit — this
  // shrinks the window in which a crash (or a failed write here) could leave
  // the session stuck in CONFIRM_BOOKING with stale context, which would make
  // a BullMQ retry re-enter completeBooking for an already-booked slot (see
  // the idempotency check above, which exists precisely to handle that case
  // if this write is ever missed). Wrapped in try/catch so a failure here
  // never prevents the confirmation message below from reaching the patient —
  // the booking itself already committed successfully.
  try {
    await updateSession(schema, phone, STATES.IDLE, {});
  } catch (err) {
    logger.warn('Post-booking session reset failed — will be retried on the patient\'s next message', { phone, error: err.message });
  }

  let dateLabel = ctx.appointment_date;
  try { dateLabel = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}

  // "We'll remind you the day before" is a promise the 24h cron has to keep —
  // it never fires for a same-day appointment, and a clinic can turn 24h
  // reminders off entirely (see reminder24hApplies). Only said when true.
  const willRemind = await reminder24hApplies(schema, ctx.appointment_date);

  // Send confirmation and post-transaction side-effects in parallel.
  const confirmationText =
    // This is the message a patient scrolls back to — and screenshots. It leads
    // with the appointment itself, not with a celebration, and the boilerplate
    // ("arrive 10 minutes early, bring your X-rays, tell us about medications,
    // don't eat beforehand") is cut to the one line that is actually true for
    // every visit. Generic advice repeated in full to everyone is what makes a
    // clinic's messages feel automated; the reminder 24h before is where a
    // per-treatment checklist already belongs (see the department checklist in
    // jobs/reminders.js).
    `✅ *Booked*\n\n` +
    `*${dateLabel}*\n` +
    `*${(ctx.appointment_time || '').slice(0, 5)}* with Dr. ${ctx.doctor_name}\n\n` +
    `At ${ctx.hospital_name}\n` +
    `Booking ID *${bookingId}*\n\n` +
    `Please arrive 10 minutes early, and bring any previous X-rays or a list of your medicines.\n\n` +
    (willRemind ? `We'll remind you the day before. ` : '') +
    `Reply *Menu* to reschedule or cancel.`;

  await Promise.allSettled([
    // Enhancement 12: try approved WhatsApp template first (works outside 24h session window);
    // fall back to regular session message if template is not approved yet.
    (async () => {
      // Shared phone — use global META_* env vars (null → fallback)
      try {
        const waMessageId = await wa.sendBookingConfirmationTemplate(phone, {
          bookingId, doctorName: ctx.doctor_name, hospitalName: ctx.hospital_name,
          date: dateLabel, time: (ctx.appointment_time || '').slice(0, 5),
        }, null, null);
        // Log the template send too. This path bypasses the `send.*` helpers in
        // botEngine, which are what normally write to wa_messages — so on the
        // happy path the clinic's message history was missing exactly the
        // message patients ask about most. Carry Meta's id so its delivery
        // receipts have a row to attach to.
        await logMessage(schema, phone, 'out', 'template', confirmationText, waMessageId);
      } catch {
        // Template not approved or Meta error — fall back to session text message
        // (send.text logs to wa_messages itself).
        await send.text(confirmationText);
      }
    })(),
    (async () => {
      // Tell the clinic. WhatsApp is the only channel — the email and SMS
      // fan-outs that used to sit here are gone with services/email.js and
      // services/sms.js. notifyAdminWhatsApp already fans out to every admin
      // with a notify_phone, so it is called ONCE; it used to be called inside
      // a per-admin loop, which sent each admin N copies (N admins → N²).
      try {
        let dateLabel3 = ctx.appointment_date;
        try { dateLabel3 = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}
        try {
          await notifyAdminWhatsApp(schema, tenant,
            `🆕 *New Appointment Booked*\n\n` +
            `Booking: *${bookingId}*\n` +
            `Patient: ${ctx.patient_name || phone} · ${phone}\n` +
            `Dr. ${ctx.doctor_name}\n` +
            `📅 ${dateLabel3} at ${(ctx.appointment_time || '').slice(0, 5)}\n` +
            `🦷 ${ctx.hospital_name}\n` +
            `Type: ${ctx.visit_type === 'video' ? 'Video Consultation' : 'In-Clinic'}`,
            { senders: send._senders }
          );
        } catch (waErr) {
          logger.warn('Admin WhatsApp booking alert failed', { error: waErr.message });
        }
      } catch (err) {
        logger.warn('Admin booking alert failed', { error: err.message });
      }
    })(),
  ]);

  // Session was already reset to IDLE immediately after commit, above.
  // Masked — logs/combined.log is persistent in production, and the booking id
  // is the identifier anyone reading this line actually needs.
  logger.info(`✅ Booking confirmed: ${bookingId}`, { phone: maskPhone(phone), tenant: tenant.name });
  try { require('../../utils/metrics').increment('appointments_booked_total'); } catch (_) {}

  // Publish SSE event so dashboard updates in real-time without polling
  try {
    const { publish } = require('../../routes/events');
    publish(tenant.id, {
      type: 'new_booking',
      payload: {
        bookingId,
        patientName: ctx.patient_name,
        doctorName: ctx.doctor_name,
        hospitalName: ctx.hospital_name,
        date: ctx.appointment_date,
        time: (ctx.appointment_time || '').slice(0, 5),
      },
    }).catch(() => {});
  } catch (_) {}
}

module.exports = {
  startBooking,
  handleSelectHospital,
  handleSelectDept,
  handleSelectDoctor,
  handleSelectDate,
  handleSelectSlot,
  handleSelectPatient,
  askChiefComplaint,
  handleChiefComplaint,
  showConfirmation,
  completeBooking,
  // Label fitting — exported for tests/labelFit.unit.test.js. The caps they
  // enforce are Meta's and silent: over-length titles are sliced, never
  // rejected, so nothing else would catch a regression.
  fitPersonName,
  fitTitle,
  fitRows,
};
