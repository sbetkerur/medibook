'use client';
import { useCallback, useEffect, useState } from 'react';
import api, { getApiError, downloadFile } from '@/lib/api';
import toast from 'react-hot-toast';
import { useBilling, startCardFlow } from '@/components/BillingBanner';

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const paise = (p) => inr(Math.round((Number(p) || 0) / 100));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 shadow-sm">
      {title && <h2 className="font-semibold text-gray-800">{title}</h2>}
      {subtitle && <p className="text-xs text-gray-500 mt-0.5 mb-3">{subtitle}</p>}
      {children}
    </div>
  );
}

function UsageBar({ label, used, limit }) {
  const unlimited = limit == null;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const over = !unlimited && used >= limit;
  return (
    <div className="mb-2">
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">{label}</span>
        <span className={over ? 'text-red-600 font-medium' : 'text-gray-800'}>
          {used}{unlimited ? '' : ` / ${limit}`}{unlimited ? ' · unlimited' : ''}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full ${over ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function BillingPanel() {
  const { data, refresh } = useBilling();
  const [busy, setBusy] = useState('');
  const [invoices, setInvoices] = useState(null);
  const [profile, setProfile] = useState({ legal_name: '', billing_address: '', gstin: '', place_of_supply: '', billing_email: '' });
  const [profileDirty, setProfileDirty] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [delPassword, setDelPassword] = useState('');
  const [delConfirm, setDelConfirm] = useState('');

  const loadInvoices = useCallback(async () => {
    try {
      const r = await api.get('/admin/billing/invoices');
      setInvoices(r.data.invoices || []);
    } catch { setInvoices([]); }
  }, []);

  useEffect(() => {
    if (data && !data.managed_by_medibook) loadInvoices();
    if (data?.profile) {
      setProfile({
        legal_name: data.profile.legal_name || '',
        billing_address: data.profile.billing_address || '',
        gstin: data.profile.gstin || '',
        place_of_supply: data.profile.place_of_supply || '',
        billing_email: data.profile.billing_email || '',
      });
    }
  }, [data, loadInvoices]);

  if (!data) return null;

  if (data.managed_by_medibook) {
    return (
      <Card title="Billing">
        <p className="text-sm text-gray-600">
          Billing for this clinic is managed by MediBook. Contact us for any changes.
        </p>
      </Card>
    );
  }

  const b = data.billing || {};
  const run = (key, fn) => async () => { setBusy(key); try { await fn(); } finally { setBusy(''); } };

  const addCard = run('card', () => startCardFlow(refresh));

  const changePlan = (plan) => run('plan-' + plan, async () => {
    try {
      const r = await api.post('/admin/billing/change-plan', { plan });
      toast.success(r.data.applied === 'cycle_end'
        ? 'Plan change scheduled for your next billing date.'
        : 'Plan changed.');
      await refresh();
    } catch (err) { toast.error(getApiError(err, 'Could not change the plan')); }
  });

  const doCancel = run('cancel', async () => {
    try {
      await api.post('/admin/billing/cancel', { reason: cancelReason || undefined });
      toast.success('Subscription will end at the close of this billing cycle.');
      setShowCancel(false); setCancelReason('');
      await refresh();
    } catch (err) { toast.error(getApiError(err, 'Could not cancel')); }
  });

  const undoCancel = run('undo', async () => {
    try {
      await api.post('/admin/billing/cancel/undo');
      toast.success('Your subscription will continue.');
      await refresh();
    } catch (err) { toast.error(getApiError(err, 'Could not undo')); }
  });

  const saveProfile = run('profile', async () => {
    try {
      await api.put('/admin/billing/profile', profile);
      toast.success('Billing details saved.');
      setProfileDirty(false);
      await refresh();
    } catch (err) { toast.error(getApiError(err, 'Could not save billing details')); }
  });

  const requestDeletion = run('delete', async () => {
    try {
      const r = await api.post('/admin/account/deletion', { password: delPassword, confirm: delConfirm });
      toast.success(`Clinic scheduled for deletion on ${fmtDate(r.data.scheduled_for)}.`);
      setShowDelete(false); setDelPassword(''); setDelConfirm('');
      await refresh();
    } catch (err) { toast.error(getApiError(err, 'Could not submit the request')); }
  });

  const cancelDeletion = run('undelete', async () => {
    try {
      await api.post('/admin/account/deletion/cancel');
      toast.success('Deletion request cancelled.');
      await refresh();
    } catch (err) { toast.error(getApiError(err, 'Could not cancel the request')); }
  });

  const statusLabel =
    data.paywalled ? 'Payment due'
    : data.trialing ? `Free trial · ${Math.max(0, data.trial_days_left ?? 0)} day${data.trial_days_left === 1 ? '' : 's'} left`
    : b.cancel_at_period_end ? 'Ending at cycle close'
    : b.subscription_status || '—';

  const otherPlan = data.plan?.id === 'professional' ? 'starter' : 'professional';
  const otherPlanRow = (data.plans || []).find((p) => p.id === otherPlan);
  const isUpgrade = otherPlan === 'professional';

  return (
    <div className="space-y-4">
      {/* ── Subscription ─────────────────────────────── */}
      <Card title="Billing" subtitle="Your subscription, plan and payment method.">
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-gray-500">Plan</dt>
          <dd className="text-gray-900 font-medium">
            {data.plan?.name || data.plan?.id}
            {b.quantity > 1 ? ` · ${b.quantity} branches` : ''}
            {data.plan?.price_monthly ? ` · ${inr(data.plan.price_monthly * (b.quantity || 1))}/mo + GST` : ''}
          </dd>
          <dt className="text-gray-500">Status</dt>
          <dd className="text-gray-900">{statusLabel}</dd>
          {data.trialing && (<><dt className="text-gray-500">Trial ends</dt><dd className="text-gray-900">{fmtDate(data.trial_end || b.trial_end)}</dd></>)}
          {!data.trialing && b.current_period_end && (
            <><dt className="text-gray-500">{b.cancel_at_period_end ? 'Ends on' : 'Next charge'}</dt>
              <dd className="text-gray-900">{fmtDate(b.current_period_end)}</dd></>
          )}
          {b.pending_plan_id && (
            <><dt className="text-gray-500">Scheduled change</dt>
              <dd className="text-gray-900">→ {b.pending_plan_id} on {fmtDate(b.plan_change_at)}</dd></>
          )}
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={addCard} disabled={!!busy}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-2">
            {busy === 'card' ? 'Opening…' : b.has_subscription ? 'Update card' : 'Add card'}
          </button>

          {otherPlanRow && !b.pending_plan_id && (
            <button onClick={changePlan(otherPlan)} disabled={!!busy}
              className="rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 text-sm font-medium px-4 py-2">
              {busy === 'plan-' + otherPlan ? 'Working…'
                : `${isUpgrade ? 'Upgrade to' : 'Switch to'} ${otherPlanRow.name} (${inr(otherPlanRow.price_monthly)}/mo${isUpgrade ? '/branch' : ''})`}
            </button>
          )}

          {b.has_subscription && !b.cancel_at_period_end && !data.deletion && (
            <button onClick={() => setShowCancel(true)} disabled={!!busy}
              className="rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-500 text-sm px-4 py-2">
              Cancel subscription
            </button>
          )}
          {b.cancel_at_period_end && !b.canceled_at && (
            <button onClick={undoCancel} disabled={!!busy}
              className="rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-sm font-medium px-4 py-2">
              {busy === 'undo' ? 'Working…' : 'Keep my subscription'}
            </button>
          )}
        </div>

        {showCancel && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm text-gray-700 mb-2">
              Your subscription stays active until <strong>{fmtDate(b.current_period_end)}</strong>. You can undo this any time before then.
            </p>
            <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason (optional — helps us improve)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2" />
            <div className="flex gap-2">
              <button onClick={doCancel} disabled={busy === 'cancel'}
                className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-1.5">
                {busy === 'cancel' ? 'Cancelling…' : 'Confirm cancellation'}
              </button>
              <button onClick={() => setShowCancel(false)} className="text-sm text-gray-500 px-3">Keep it</button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Usage ────────────────────────────────────── */}
      {data.usage && (
        <Card title="Usage" subtitle="What your current plan allows.">
          <UsageBar label="Dentists" used={data.usage.doctors?.used} limit={data.usage.doctors?.limit} />
          <UsageBar label="Branches" used={data.usage.branches?.used} limit={data.usage.branches?.limit} />
        </Card>
      )}

      {/* ── GST / billing details ────────────────────── */}
      <Card title="Billing details for invoices" subtitle="Add your GSTIN to receive a GST tax invoice you can claim input credit against.">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-gray-500">Registered name</span>
            <input value={profile.legal_name} onChange={(e) => { setProfile({ ...profile, legal_name: e.target.value }); setProfileDirty(true); }}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-gray-500">GSTIN</span>
            <input value={profile.gstin} onChange={(e) => { setProfile({ ...profile, gstin: e.target.value.toUpperCase() }); setProfileDirty(true); }}
              placeholder="29ABCDE1234F1Z5" maxLength={15}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono" />
          </label>
          <label className="text-sm">
            <span className="text-gray-500">Place of supply (state code)</span>
            <input value={profile.place_of_supply} onChange={(e) => { setProfile({ ...profile, place_of_supply: e.target.value.replace(/\D/g, '').slice(0, 2) }); setProfileDirty(true); }}
              placeholder="29" maxLength={2}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-gray-500">Billing email (optional)</span>
            <input value={profile.billing_email} onChange={(e) => { setProfile({ ...profile, billing_email: e.target.value }); setProfileDirty(true); }}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-gray-500">Billing address</span>
            <textarea value={profile.billing_address} onChange={(e) => { setProfile({ ...profile, billing_address: e.target.value }); setProfileDirty(true); }}
              rows={2} className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
        </div>
        <button onClick={saveProfile} disabled={!profileDirty || busy === 'profile'}
          className="mt-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2">
          {busy === 'profile' ? 'Saving…' : 'Save billing details'}
        </button>
      </Card>

      {/* ── Invoices ─────────────────────────────────── */}
      <Card title="Invoices" subtitle="GST tax invoices for every charge.">
        {invoices == null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-gray-500">No invoices yet — the first one is raised on your first charge.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {invoices.map((inv) => (
              <div key={inv.id} className="py-2.5 flex items-center justify-between text-sm">
                <div>
                  <div className="text-gray-800 font-medium">{inv.invoice_number}</div>
                  <div className="text-xs text-gray-400">{fmtDate(inv.issued_at)} · {paise(inv.total_paise)} incl. GST</div>
                </div>
                <button onClick={() => downloadFile(`/admin/billing/invoices/${inv.id}`, `${inv.invoice_number.replace(/[^\w.-]+/g, '-')}.pdf`)}
                  className="text-blue-600 hover:underline text-sm">Download PDF</button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Danger zone ──────────────────────────────── */}
      <Card title="Close this clinic" subtitle="Permanently deletes every patient, appointment and record after a grace period.">
        {data.deletion ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-800">
              Scheduled for permanent deletion on <strong>{fmtDate(data.deletion.scheduled_for)}</strong>.
            </p>
            <button onClick={cancelDeletion} disabled={busy === 'undelete'}
              className="mt-2 rounded-lg bg-white border border-red-300 hover:bg-red-100 text-red-700 text-sm font-medium px-4 py-1.5">
              {busy === 'undelete' ? 'Working…' : 'Cancel deletion request'}
            </button>
          </div>
        ) : !showDelete ? (
          <button onClick={() => setShowDelete(true)}
            className="rounded-lg border border-red-300 hover:bg-red-50 text-red-600 text-sm font-medium px-4 py-2">
            Request account deletion
          </button>
        ) : (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
            <p className="text-sm text-red-800">
              This schedules permanent deletion. Nothing changes for the next 14 days and you can cancel any time in that window.
              After that, all data is erased and cannot be recovered except from backups (kept ≤30 days).
            </p>
            <input type="password" value={delPassword} onChange={(e) => setDelPassword(e.target.value)}
              placeholder="Your password" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)}
              placeholder="Type DELETE to confirm" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button onClick={requestDeletion} disabled={busy === 'delete' || delConfirm !== 'DELETE' || !delPassword}
                className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5">
                {busy === 'delete' ? 'Submitting…' : 'Schedule deletion'}
              </button>
              <button onClick={() => { setShowDelete(false); setDelPassword(''); setDelConfirm(''); }}
                className="text-sm text-gray-500 px-3">Keep my account</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
