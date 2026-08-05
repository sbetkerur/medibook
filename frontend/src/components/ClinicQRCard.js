'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import ConfirmModal from '@/components/ui/ConfirmModal';

/**
 * The clinic's QR code — the only way a patient reaches this clinic on WhatsApp.
 *
 * Every clinic on MediBook shares one WhatsApp number, so scanning is what tells
 * the bot which clinic the patient means. There is no name search and no browse-
 * by-location, which is the point: a clinic's patients are never shown another
 * clinic. The trade is that a clinic with its QR code sitting unprinted in this
 * tab is unreachable, so this panel leads the Settings tab and says so plainly.
 */
export default function ClinicQRCard({ isAdmin }) {
  const [qr, setQr] = useState(null);
  const [failed, setFailed] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);

  const fetchQr = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/clinic-qr');
      setQr(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { fetchQr(); }, [fetchQr]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(qr.link);
      toast.success('Link copied — paste it on your website or Google listing');
    } catch {
      // Clipboard is unavailable over plain http and in some in-app browsers.
      toast.error('Could not copy — select the link and copy it by hand');
    }
  }

  async function regenerate() {
    setConfirmRegen(false);
    setRegenerating(true);
    try {
      await api.post('/admin/clinic-qr/regenerate');
      await fetchQr();
      toast.success('New code issued — reprint anything already on display');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not issue a new code');
    } finally { setRegenerating(false); }
  }

  /**
   * Opens a print window containing just the card. A print-only overlay inside
   * the dashboard would need a global rule hiding every other element on the
   * page; a separate document keeps the concern here.
   *
   * The QR goes in as the PNG data URI already in hand rather than a fresh
   * request — the new window has no auth token, so anything it fetched from the
   * API would 401.
   */
  function printCard() {
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) return toast.error('Your browser blocked the print window — allow pop-ups for this site');
    const esc = s => String(s || '').replace(/[<>&"]/g, c => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(qr.clinic_name)} — WhatsApp booking</title>
<style>
  @page { margin: 14mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center;
         color: #111; margin: 0; padding: 24px; }
  .card { border: 2px solid #111; border-radius: 18px; padding: 32px 24px; max-width: 460px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { font-size: 14px; color: #555; margin: 0 0 22px; }
  img { width: 300px; height: 300px; }
  .steps { text-align: left; display: inline-block; margin: 20px auto 0; font-size: 14px; line-height: 1.7; }
  .code { margin-top: 18px; font-size: 12px; color: #666; letter-spacing: .09em; }
</style></head><body>
<div class="card">
  <h1>${esc(qr.clinic_name)}</h1>
  <p class="sub">Book your appointment on WhatsApp</p>
  <img src="${qr.png}" alt="WhatsApp booking QR code">
  <div class="steps">
    1. Open your phone camera<br>
    2. Point it at this code<br>
    3. Tap the WhatsApp link, then press send
  </div>
  <p class="code">No app to install &middot; Code ${esc(qr.code)}</p>
</div>
<script>
  // Print only once the QR image has decoded — Chrome will otherwise open the
  // dialog against an empty box and silently print a card with no code on it.
  var img = document.images[0];
  function go() { window.focus(); window.print(); }
  if (img.complete) go(); else { img.onload = go; img.onerror = go; }
<\/script>
</body></html>`);
    w.document.close();
  }

  if (failed) {
    return (
      <Shell>
        <div className="py-6 text-center">
          <p className="text-gray-500 mb-3 text-sm">QR code could not be loaded.</p>
          <button onClick={fetchQr}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  if (!qr) return <Shell><div className="text-gray-400 py-8 text-center text-sm">Loading QR code…</div></Shell>;

  // Two distinct not-ready states, because the fix is different for each and
  // only one of them is something the clinic can act on.
  if (!qr.configured) {
    return (
      <Shell>
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
          {qr.reason === 'no_public_number'
            ? 'The WhatsApp booking number has not been published yet. Your platform administrator needs to set it before your QR code can be generated.'
            : 'This clinic has no entry code yet, so patients cannot reach it on WhatsApp.'}
          {qr.reason !== 'no_public_number' && isAdmin && (
            <button onClick={() => setConfirmRegen(true)} disabled={regenerating}
              className="mt-3 block px-4 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 disabled:opacity-50 transition">
              {regenerating ? 'Issuing…' : 'Issue a code'}
            </button>
          )}
        </div>
        {confirmRegen && (
          <ConfirmModal title="Issue a code?" message="This gives your clinic a WhatsApp entry code and QR."
            onConfirm={regenerate} onCancel={() => setConfirmRegen(false)} />
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-col sm:flex-row gap-5">
        <div className="shrink-0 mx-auto sm:mx-0">
          {/* The PNG rather than the SVG: it is the same image the print card
              and any download use, so what staff see is what patients get. */}
          <img src={qr.png} alt={`WhatsApp booking QR code for ${qr.clinic_name}`}
            className="w-40 h-40 border border-gray-200 rounded-lg" />
          <p className="text-center text-[11px] tracking-widest text-gray-400 mt-1.5">{qr.code}</p>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-600">
            Patients scan this to book. It opens WhatsApp with your clinic already
            filled in — there is nothing for them to install, type or remember.
          </p>

          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Booking link
              <span className="text-gray-400 font-normal ml-1">(for your website, Google listing or Instagram bio)</span>
            </label>
            {/* break-all, not truncate: a receptionist copying this by hand when
                the clipboard is unavailable needs to see all of it. */}
            <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 break-all">
              {qr.link}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={printCard}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
              🖨 Print counter card
            </button>
            <button onClick={copyLink}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition">
              Copy link
            </button>
            <a href={qr.png} download={`${slugify(qr.clinic_name)}-whatsapp-qr.png`}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition">
              Download PNG
            </a>
          </div>

          {isAdmin && (
            <div className="mt-4 pt-3 border-t border-gray-100">
              <button onClick={() => setConfirmRegen(true)} disabled={regenerating}
                className="text-xs text-red-600 hover:text-red-700 hover:underline disabled:opacity-50">
                {regenerating ? 'Issuing new code…' : 'Issue a new code'}
              </button>
              <p className="text-xs text-gray-400 mt-1">
                Only if a code has been misused. Every card, poster and link already
                showing the old code stops working immediately.
              </p>
            </div>
          )}
        </div>
      </div>

      {confirmRegen && (
        <ConfirmModal
          title="Issue a new code?"
          message="Every QR code and link already printed or published stops working straight away, and patients using them will not be able to reach you until you replace them."
          danger
          onConfirm={regenerate}
          onCancel={() => setConfirmRegen(false)}
        />
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1">Your WhatsApp QR code</h2>
      <p className="text-xs text-gray-500 mb-4">How patients reach you. Print it for the front desk.</p>
      {children}
    </div>
  );
}

function slugify(name) {
  return String(name || 'clinic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clinic';
}
