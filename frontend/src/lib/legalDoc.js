import fs from 'fs';
import path from 'path';

/**
 * Loads a legal document for publication at /terms, /privacy or /dpa.
 *
 * Server-only — uses `fs`, so it must never be imported into a Client
 * Component. The documents are read at build time and the pages are static.
 *
 * Two jobs beyond reading the file:
 *
 * 1. Strip <!-- INTERNAL --> blocks. The markdown carries draft banners,
 *    placeholder checklists and ⚠️ verification warnings that are notes to
 *    ourselves. Publishing "backups are written unencrypted" on a page a
 *    prospective customer reads would be its own kind of disclosure.
 *
 * 2. Refuse to publish an unfinished contract. If {{PLACEHOLDER}} tokens
 *    survive the strip, the document still says {{ENTITY}} where the company
 *    name belongs. A contract naming no party binds nobody, and one displayed
 *    with visible template tokens is worse than an honest "not ready" page —
 *    so `ready` comes back false and the route renders a holding notice.
 */

const DOCS = {
  terms: { file: 'TERMS_OF_SERVICE.md', title: 'Terms of Service' },
  privacy: { file: 'PRIVACY_POLICY.md', title: 'Privacy Policy' },
  dpa: { file: 'DATA_PROCESSING_AGREEMENT.md', title: 'Data Processing Agreement' },
};

const INTERNAL_BLOCK = /<!--\s*INTERNAL\s*-->[\s\S]*?<!--\s*\/INTERNAL\s*-->/g;
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/g;

export function getLegalDoc(slug) {
  const meta = DOCS[slug];
  if (!meta) return null;

  const filePath = path.join(process.cwd(), 'src', 'content', 'legal', meta.file);

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Missing file is a deployment fault, not a user-facing one. Report it as
    // not-ready rather than crashing the build or the route.
    return { ...meta, slug, ready: false, reason: 'missing', content: '', placeholders: [] };
  }

  const content = raw.replace(INTERNAL_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();

  const placeholders = [...new Set(content.match(PLACEHOLDER) || [])];

  return {
    ...meta,
    slug,
    content,
    placeholders,
    ready: placeholders.length === 0,
    reason: placeholders.length ? 'placeholders' : null,
  };
}

