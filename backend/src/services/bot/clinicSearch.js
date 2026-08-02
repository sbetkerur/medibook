'use strict';
/**
 * Clinic search for the shared-WhatsApp-number entry point.
 *
 * All tenants share one phone number, so a patient's first message has to be
 * resolved to a clinic. Listing every onboarded tenant is not an option — the
 * list grows without bound, leaks the customer roster to anyone who messages
 * the number, and blows past WhatsApp's 10-row list limit. Instead the patient
 * searches, and only MATCHES are ever shown.
 *
 * "Dental" and "clinic" are ignored on both sides of the comparison: nearly
 * every tenant is a "… Dental Clinic", so those words carry no signal. Typing
 * them must neither help nor hurt — "smile", "Smile Dental" and
 * "smile clinic" all have to find "Smile Dental Clinic".
 */
const { levenshtein } = require('./utils');

const IGNORED_WORDS = new Set(['dental', 'dentals', 'clinic', 'clinics']);

// Below this, a query is not evidence of intent — "ab" is a fragment of many
// clinic names, and answering it with a shortlist is close to answering with
// the full tenant list.
const MIN_QUERY_LEN = 3;
// Levenshtein is O(m*n); cap the input so a long message can't burn CPU.
const MAX_QUERY_LEN = 60;
// More matches than this and we ask the patient to narrow down instead of
// pasting a wall of clinics.
const MAX_SHORTLIST = 8;

function tokenize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Tokens worth matching on. A clinic literally named "Dental Clinic" would
 * normalize to nothing and become unsearchable, so when every token is an
 * ignored word we keep them all.
 */
function significantTokens(value) {
  const all = tokenize(value);
  const kept = all.filter(t => !IGNORED_WORDS.has(t));
  return kept.length ? kept : all;
}

function normalize(value) {
  return significantTokens(value).join(' ');
}

/**
 * True when the patient typed only ignored words ("clinic", "dental clinic").
 * Such a query matches every tenant, so the caller must re-prompt rather than
 * treat the whole roster as a search result.
 */
function isQueryTooGeneric(input) {
  const all = tokenize(input);
  return all.length > 0 && all.every(t => IGNORED_WORDS.has(t));
}

/**
 * Find the clinics matching a patient's free-text query.
 *
 * Returns ALL matches in the strongest tier that produced any — never a single
 * best guess across tiers, and never ordered by anything the caller could
 * mistake for confidence. A one-element result is safe to auto-select; two or
 * more must be disambiguated by asking (same rule as `fuzzyFind`: ambiguity is
 * never resolved by list order).
 */
function searchTenants(tenants, input, nameField = 'name') {
  const items = Array.isArray(tenants) ? tenants : [];
  const query = normalize(input);
  if (query.length < MIN_QUERY_LEN || query.length > MAX_QUERY_LEN) return [];
  if (isQueryTooGeneric(input)) return [];

  const queryTokens = significantTokens(input);
  const queryJoined = queryTokens.join('');
  const indexed = items.map(item => {
    const tokens = significantTokens(item[nameField]);
    return { item, tokens, normalized: tokens.join(' '), joined: tokens.join('') };
  });
  const pick = list => list.map(e => e.item);

  // 1. Exact name (ignoring the noise words). Unambiguous by intent.
  const exact = indexed.filter(e => e.normalized === query);
  if (exact.length) return pick(exact);

  // 2. Every query word is the start of some word in the name. Covers the
  //    common cases: "smile" → "Smile Dental", "sunrise dent" → "Sunrise
  //    Dentistry", and word-order differences.
  const prefixed = indexed.filter(e =>
    queryTokens.every(qt => e.tokens.some(nt => nt.startsWith(qt) || qt.startsWith(nt)))
  );
  if (prefixed.length) return pick(prefixed);

  // 3. Substring, spaces collapsed so "smiledental" still finds "Smile Dental".
  const substring = indexed.filter(e =>
    e.normalized.includes(query) || e.joined.includes(queryJoined)
  );
  if (substring.length) return pick(substring);

  // 4. Typo tolerance, last. Compared against the whole name AND each word, so
  //    "sunrize" still reaches "Sunrise Dentistry". Every name within the best
  //    distance is kept, so a near-tie surfaces as a choice, not a silent guess.
  let best = Infinity;
  const scored = [];
  for (const e of indexed) {
    let dist = Infinity;
    for (const candidate of [e.normalized, ...e.tokens]) {
      const target = candidate.slice(0, MAX_QUERY_LEN);
      if (!target) continue;
      const d = levenshtein(query, target);
      if (d <= Math.max(2, Math.floor(target.length * 0.4)) && d < dist) dist = d;
    }
    if (dist === Infinity) continue;
    scored.push({ e, dist });
    if (dist < best) best = dist;
  }
  return pick(scored.filter(s => s.dist === best).map(s => s.e));
}

/**
 * A row title for a WhatsApp list, which Meta truncates at 24 characters.
 * "Apollo Dental Clinic Koramangala" and "… Indiranagar" both survive that cut
 * only by their last visible letters, so for over-long names we drop the words
 * that carry no information anyway — leaving "Apollo Koramangala".
 */
const ROW_TITLE_MAX = 24;
function shortLabel(name) {
  const full = String(name == null ? '' : name).trim();
  if (full.length <= ROW_TITLE_MAX) return full;
  // Rebuild from the original words so the clinic's own casing survives.
  const kept = full.split(/\s+/)
    .filter(w => !IGNORED_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')))
    .join(' ');
  // Stripping can leave a stub ("The") that identifies nothing — in that case a
  // truncated full name is the more useful label.
  return kept.length >= 5 ? kept : full;
}

module.exports = {
  IGNORED_WORDS,
  shortLabel,
  MIN_QUERY_LEN,
  MAX_SHORTLIST,
  tokenize,
  normalize,
  isQueryTooGeneric,
  searchTenants,
};
