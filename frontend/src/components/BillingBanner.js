'use client';
import { useState, useEffect, useCallback } from 'react';
import api, { getApiError } from '@/lib/api';
import toast from 'react-hot-toast';

const RZP_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadRazorpay() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.Razorpay) return resolve(window.Razorpay);
    let s = document.querySelector(`script[src="${RZP_SRC}"]`);
    if (!s) {
      s = document.createElement('script');
      s.src = RZP_SRC;
      s.async = true;
      document.body.appendChild(s);
    }
    s.addEventListener('load', () => resolve(window.Razorpay));
    s.addEventListener('error', () => reject(new Error('Could not load the payment window')));
  });
}

/**
 * Shared card flow for a self-serve clinic:
 *   1. POST /admin/billing/subscribe  → { subscription_id, key_id, prefill }
 *      (or 409 with those same fields when a subscription already exists)
 *   2. open Razorpay Checkout bound to that subscription
 *   3. POST /admin/billing/subscribe/confirm with the signed handshake
 * onDone() runs after a verified confirm so the caller can refresh.
 */
async function startCardFlow(onDone) {
  let sub;
  try {
    const { data } = await api.post('/admin/billing/subscribe');
    sub = data;
  } catch (err) {
    const d = err?.response?.data;
    if (err?.response?.status === 409 && d?.subscription_id && d?.key_id) {
      sub = d; // already has one — just open Checkout again
    } else {
      toast.error(getApiError(err, 'Could not start the subscription'));
      return;
    }
  }

  let Razorpay;
  try { Razorpay = await loadRazorpay(); }
  catch (e) { toast.error(e.message); return; }

  const rzp = new Razorpay({
    key: sub.key_id,
    subscription_id: sub.subscription_id,
    name: 'MediBook',
    description: 'Clinic subscription',
    prefill: sub.prefill || {},
    theme: { color: '#2563eb' },
    handler: async (resp) => {
      try {
        await api.post('/admin/billing/subscribe/confirm', {
          razorpay_payment_id: resp.razorpay_payment_id,
          razorpay_subscription_id: resp.razorpay_subscription_id,
          razorpay_signature: resp.razorpay_signature,
        });
        toast.success('Card added — you’re all set');
        onDone?.();
      } catch (err) {
        toast.error(getApiError(err, 'We could not confirm that. Contact support if it recurs.'));
      }
    },
  });
  rzp.on('payment.failed', () => toast.error('Card authorisation failed — please try again'));
  rzp.open();
}

export function useBilling() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/admin/billing');
      setData(res.data); setErr(false);
    } catch {
      setErr(true);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { data, err, refresh };
}

export { startCardFlow };

// ── Dashboard banner ────────────────────────────────────────
export default function BillingBanner() {
  const { data, refresh } = useBilling();
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const addCard = async () => {
    setBusy(true);
    await startCardFlow(refresh);
    setBusy(false);
  };

  if (data.review_pending) {
    return (
      <Bar tone="amber">
        <span>
          <strong>Your clinic is awaiting approval.</strong> Patients can’t reach your WhatsApp number yet —
          everything else works, so go ahead and finish your setup.
        </span>
      </Bar>
    );
  }

  if (data.paywalled) {
    return (
      <Bar tone="red">
        <span>
          <strong>Your free trial has ended.</strong> Add a card to keep taking bookings — your data and setup are safe.
        </span>
        <button onClick={addCard} disabled={busy}
          className="shrink-0 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-1.5">
          {busy ? 'Opening…' : 'Add card'}
        </button>
      </Bar>
    );
  }

  if (data.deletion) {
    const when = data.deletion.scheduled_for
      ? new Date(data.deletion.scheduled_for).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;
    return (
      <Bar tone="red">
        <span>
          <strong>This clinic is scheduled for permanent deletion{when ? ` on ${when}` : ''}.</strong>{' '}
          Cancel the request in <strong>Settings → Billing</strong> to keep your account.
        </span>
      </Bar>
    );
  }

  if (data.billing?.cancel_at_period_end && !data.billing?.canceled_at) {
    const when = data.billing.current_period_end
      ? new Date(data.billing.current_period_end).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;
    return (
      <Bar tone="amber">
        <span>
          Your subscription is set to end{when ? ` on ${when}` : ' at the end of this cycle'}. You can keep it in{' '}
          <strong>Settings → Billing</strong>.
        </span>
      </Bar>
    );
  }

  if (data.trialing && data.trial_days_left != null && data.trial_days_left >= 0 && data.trial_days_left <= 7) {
    return (
      <Bar tone="blue">
        <span>
          Free trial — <strong>{data.trial_days_left} day{data.trial_days_left === 1 ? '' : 's'} left</strong>.
          Add a card now and you won’t lose a day.
        </span>
        <button onClick={addCard} disabled={busy}
          className="shrink-0 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-1.5">
          {busy ? 'Opening…' : 'Add card'}
        </button>
      </Bar>
    );
  }

  return null;
}

function Bar({ tone, children }) {
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-800',
    blue: 'border-blue-200 bg-blue-50 text-blue-800',
  };
  return (
    <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

// The Settings-tab billing card lives in components/BillingPanel.js now (full
// plan/cancel/invoice/GST/deletion surface). This file keeps only the
// top-of-dashboard Bar + the useBilling/startCardFlow hooks it shares.
