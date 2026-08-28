'use client';
/**
 * Shown at the top of the dashboard when the tenant is read-only
 * (tenants.read_only — set for the shareable demo clinic). Every /api/admin
 * write 403s server-side; this just tells the viewer why a button they press
 * reports "read-only demo" instead of doing something.
 *
 * Deliberately not dismissable: the whole point of the demo login is that it
 * gets passed around, and each new viewer needs to know the state they are in.
 */
export default function ReadOnlyBanner({ show }) {
  if (!show) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <span aria-hidden className="mt-0.5 shrink-0 font-semibold">Demo</span>
      <p className="flex-1">
        You&rsquo;re exploring a <strong>read-only demo clinic</strong>. Look around freely —
        booking, edits and settings are disabled here.{' '}
        <a href="/signup" className="font-medium underline hover:no-underline">
          Create your own account
        </a>{' '}
        to use them for real.
      </p>
    </div>
  );
}
