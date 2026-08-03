# Legal documents have moved

The Terms of Service, Privacy Policy and Data Processing Agreement now live at:

    frontend/src/content/legal/

They were moved there because the frontend serves them at `/terms`, `/privacy`
and `/dpa`, and the frontend Dockerfile builds with `frontend/` as its context
(`rootDirectory = /frontend` in Railway, `COPY . .` in the Dockerfile). A copy
at the repository root would not exist inside the build and the pages would 404
in production while working locally.

Edit them there. There is deliberately no second copy — two copies of a contract
that can drift is worse than an inconvenient path.

## Internal vs published content

Each document wraps internal-only content in HTML comments:

```html
<!-- INTERNAL -->
Draft notices, {{placeholders}} lists, ⚠️ verification warnings
<!-- /INTERNAL -->
```

`frontend/src/lib/legalDoc.js` strips those blocks before rendering, so the
public pages never show them. Keep new internal notes inside those markers.

## Before publishing

1. Fill every `{{PLACEHOLDER}}` — entity name and type, address, jurisdiction
   city and state, Grievance Officer, support and security emails.
2. Resolve the ⚠️ warnings in the DPA's Annexure A (backup encryption, and
   `BACKUP_DIR` being set in production) — or amend the wording to match what
   the system actually does.
3. Have an Indian advocate review all three.
4. Remove the `<!-- INTERNAL -->` draft banner from each document.

The pages refuse to render a document that still contains `{{` placeholders,
so an unfinished contract cannot go live by accident. See `legalDoc.js`.
