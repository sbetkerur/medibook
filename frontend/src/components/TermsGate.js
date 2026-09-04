'use client';
/**
 * Terms of Service + DPA acceptance gate.
 *
 * Tenants are provisioned by the super admin, not by self-signup, so there is
 * no registration form to put a checkbox on. The contract is therefore formed
 * at first admin login instead: this blocks the dashboard until an admin
 * accepts, and the backend records tenant, version, timestamp, IP and actor as
 * the evidence trail (see backend/src/config/terms.js).
 *
 * Deliberate choices:
 *  - Only ADMINS see the blocking prompt. Reception and dentist accounts keep
 *    working while terms are outstanding — blocking them would take the whole
 *    practice offline until the owner happened to log in, which punishes staff
 *    for something only the owner can resolve.
 *  - Not dismissable for admins. A gate you can close is not evidence of
 *    assent, and the liability cap is only worth what the acceptance record
 *    can prove.
 *  - The checkbox starts UNTICKED. A pre-ticked box is not consent under the
 *    DPDP Act and would undermine the record this whole flow exists to create.
 */
import { useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';

export default function TermsGate({ version, canAccept, onAccepted }) {
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  // Only used by the non-admin advisory banner; admins cannot dismiss the gate.
  const [dismissed, setDismissed] = useState(false);

  async function accept() {
    if (!checked || saving) return;
    setSaving(true);
    try {
      // Send the version the user actually read. The server rejects a stale
      // one with 409 rather than silently recording the current version.
      await api.post('/admin/terms/accept', { version });
      toast.success('Thank you — agreement recorded.');
      onAccepted?.();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        toast.error('These terms have been updated. Reloading the latest version.');
        setTimeout(() => window.location.reload(), 1500);
        return;
      }
      toast.error(err?.response?.data?.error || 'Could not record acceptance. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // Non-admins: inform, don't block. They can keep working — and can dismiss.
  // Without a dismiss this sits fixed over the bottom of the viewport for the
  // whole session, covering table rows and action buttons on a phone, for a
  // message about something they are not permitted to act on.
  if (!canAccept) {
    if (dismissed) return null;
    return (
      <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto flex max-w-2xl items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 shadow-lg">
        <p className="flex-1 text-sm text-amber-900">
          <strong>Action needed from your clinic administrator.</strong> Updated
          terms are awaiting acceptance. You can continue working as normal.
        </p>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 rounded px-2 text-lg leading-none text-amber-700 hover:bg-amber-100"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      {/* Height and scrolling matter more here than in an ordinary modal: this
          gate is blocking and the button below is the only way past it.
          - `dvh` with a `vh` fallback, matching the shells in dashboard/doctor.
            Bare `90vh` is 90% of the address-bar-COLLAPSED viewport, so on a
            phone the card can be taller than what is actually visible.
          - flex-col with the BODY as the only scroller (as components/ui/Modal.js
            does), so the footer stays pinned. Scrolling the whole card instead
            would put the button physically below the screen edge, where no
            amount of scrolling inside the card can reach it. */}
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl supports-[max-height:90dvh]:max-h-[90dvh]">
        <div className="shrink-0 border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Before you continue
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Please review and accept our agreement. Version {version}.
          </p>
        </div>

        {/* The only scroller. min-h-0 is required: a flex child defaults to
            min-height:auto, which refuses to shrink below its content and would
            push the footer off-screen despite the max-height on the card. */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm text-gray-700">
          <p>
            To use MediBook we need your agreement to our terms. In short:
          </p>

          <ul className="space-y-2 pl-5">
            <li className="list-disc">
              <strong>Your patients&rsquo; data stays yours.</strong> You decide
              what is recorded. We process it only to run the service for you,
              and never sell it, use it for advertising, or use it to train AI
              models.
            </li>
            <li className="list-disc">
              <strong>You are responsible for patient consent.</strong> Under
              the DPDP Act your clinic is the Data Fiduciary — you must obtain
              consent before messaging patients and give them the notice the law
              requires.
            </li>
            <li className="list-disc">
              <strong>Billing.</strong> Starter is ₹799/month. Professional is
              ₹1,799/month <em>per branch</em>, GST-inclusive — we issue a tax
              invoice for every charge.
            </li>
            <li className="list-disc">
              <strong>If you leave</strong>, you can export everything for 30
              days, after which we delete it.
            </li>
            <li className="list-disc">
              <strong>Not for emergencies.</strong> MediBook is a scheduling
              tool, not a medical device or clinical decision support.
            </li>
          </ul>

          <p className="text-gray-500">
            This summary is for convenience — the linked documents are what
            actually apply.
          </p>

          <label className="flex cursor-pointer items-start gap-3 rounded border border-gray-200 bg-gray-50 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
              disabled={saving}
            />
            <span>
              I agree to the{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer"
                 className="text-blue-600 underline">Terms of Service</a>{' '}
              and{' '}
              <a href="/dpa" target="_blank" rel="noopener noreferrer"
                 className="text-blue-600 underline">Data Processing Agreement</a>,
              and confirm I am authorised to accept them on behalf of this
              clinic. I have read the{' '}
              <a href="/privacy" target="_blank" rel="noopener noreferrer"
                 className="text-blue-600 underline">Privacy Policy</a>.
            </span>
          </label>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t bg-gray-50 px-6 py-4">
          <button
            onClick={accept}
            disabled={!checked || saving}
            className="rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {saving ? 'Recording…' : 'Agree and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
