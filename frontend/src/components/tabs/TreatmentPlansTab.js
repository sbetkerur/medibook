'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import api, { downloadFile } from '@/lib/api';
import { format, parseISO, addDays } from 'date-fns';
import toast from 'react-hot-toast';
import Modal from '@/components/ui/Modal';
import RecordTreatmentModal from '@/components/RecordTreatmentModal';

// Multi-visit treatments. A dentist advises a course ("root canal, 3 visits"),
// the visits are rendered by them or by a specialist in the same clinic, and
// each one is an ordinary appointment linked back to the plan.
//
// Self-contained: fetches its own plans, dentists and recent appointments.

// Pre-fills the date picker when booking a visit — matches the old auto-book
// default so the common case (routine follow-up) still needs no typing.
const DEFAULT_VISIT_GAP_DAYS = 7;

const STATUS_STYLES = {
  proposed:    'bg-amber-100 text-amber-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed:   'bg-green-100 text-green-700',
  declined:    'bg-gray-100 text-gray-600',
  cancelled:   'bg-red-100 text-red-700',
};

function StatusPill({ status }) {
  return (
    <span className={`whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'}`}>
      {status?.replace('_', ' ')}
    </span>
  );
}

function VisitDots({ done, booked, total }) {
  // done → filled, booked-not-done → outlined, neither → empty. Reads at a
  // glance in a list, which a numeric "1/3" does not.
  return (
    <span className="inline-flex items-center gap-1" title={`${done} done, ${booked} booked of ${total}`}>
      {Array.from({ length: Math.min(total, 12) }, (_, i) => (
        <span key={i} className={`w-2.5 h-2.5 rounded-full border ${
          i < done ? 'bg-green-500 border-green-500'
            : i < booked ? 'bg-white border-blue-500'
            : 'bg-gray-100 border-gray-200'}`} />
      ))}
      {total > 12 && <span className="text-[10px] text-gray-400">+{total - 12}</span>}
    </span>
  );
}

export default function TreatmentPlansTab({ isAdmin, setConfirmModal, pendingBookPlanId, clearPendingBookPlanId }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('outstanding');


  const [detail, setDetail] = useState(null);        // { treatment_plan, visits }
  // openDetail fires 3 parallel requests; opening plan B while A is in flight
  // must not let A's slower response paint over B's modal.
  const detailReqRef = useRef(0);
  const [showCreate, setShowCreate] = useState(false);
  // "Book visit N" used to fire straight off with no picker — it took whatever
  // slot was first free at least N days out and told the operator afterwards.
  // That is what let a misread tap book a date/time nobody chose. Now it opens
  // a date/slot picker (visitBooking = the plan being scheduled) and defaults
  // the date field to DEFAULT_VISIT_GAP_DAYS out, matching the old default,
  // but nothing is booked until the operator picks an actual slot.
  const [visitBooking, setVisitBooking] = useState(null); // plan, or null when closed
  const [visitForm, setVisitForm] = useState({ appointment_date: '', slot_id: '' });
  const [visitSlots, setVisitSlots] = useState([]);
  const [visitSlotsLoading, setVisitSlotsLoading] = useState(false);
  // Money and lab work for the plan currently open in the detail modal.
  const [payments, setPayments] = useState([]);
  // Consent capture. Held here rather than in a modal: it is one field and a
  // button, and a dentist recording it at the chair should not have to open
  // anything.
  const [consentNote, setConsentNote] = useState('');
  const [savingConsent, setSavingConsent] = useState(false);
  const [labWorks, setLabWorks] = useState([]);
  const [payingPlan, setPayingPlan] = useState(null);
  const [labPlan, setLabPlan] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', method: 'cash', note: '' });
  const [labForm, setLabForm] = useState({ item: '', lab_name: '', expected_date: '', cost: '' });
  const [busy, setBusy] = useState(false);
  const [bookingPlanId, setBookingPlanId] = useState(null);
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // Set only once a fetch has actually landed — read from the pending-plan
  // effect below instead of `loading` directly, because on the very first
  // mount both effects fire in the SAME commit: `loading` is still its
  // initial `false` when the second effect runs, one render before
  // fetchPlans's `setLoading(true)` takes visible effect. Gating on that
  // stale `false` would read as "finished loading, plan not found" before the
  // request had even gone out, and clear pendingBookPlanId immediately. A ref
  // is read live regardless of that timing.
  const hasFetchedOnceRef = useRef(false);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    try {
      const q = filter === 'outstanding' ? '?outstanding=true&limit=100'
        : filter === 'all' ? '?limit=100'
        : `?status=${filter}&limit=100`;
      const { data } = await api.get(`/admin/treatment-plans${q}`);
      setPlans(data.treatment_plans || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load treatment plans');
    } finally {
      setLoading(false);
      hasFetchedOnceRef.current = true;
    }
  }, [filter]);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  // Landed here from the Appointments tab: a visit was just marked completed
  // and the desk agreed to book its next sitting now. Open the SAME picker
  // "Book visit N" uses — rather than a second "book the next visit"
  // implementation living in dashboard/page.js — as soon as this tab's own
  // plans list (fetched above, under the default 'outstanding' filter) has
  // loaded and the plan is in it.
  useEffect(() => {
    if (!pendingBookPlanId || loading || !hasFetchedOnceRef.current) return;
    const plan = plans.find(p => p.id === pendingBookPlanId);
    if (plan) {
      openBookVisit(plan);
    } else {
      // Loaded and genuinely not there — e.g. it stopped qualifying as
      // outstanding between the prompt and landing here. Don't leave the
      // pending id hanging forever waiting for a plan that will never appear.
      toast.error('That treatment could not be found — it may already be fully booked.');
    }
    clearPendingBookPlanId?.();
  }, [pendingBookPlanId, loading, plans, clearPendingBookPlanId]);

  // (No doctors fetch here. This tab rendered nothing from it — the dentist
  // picker lives in RecordTreatmentModal, which fetches its own — so every
  // visit to the Treatments tab spent an authenticated round trip, and a slice
  // of the tenant's rate-limit budget, on a list nothing read.)

  async function openDetail(id) {
    // Cleared on the way IN as well as on close. consentNote was only reset
    // after a successful POST, so a note typed for one plan and abandoned
    // (interrupted mid-sentence, modal closed) stayed mounted and pre-filled the
    // amber consent box for the NEXT plan opened. Pressing "Record consent"
    // there writes one patient's explanation into another patient's audited
    // consent record — the one record whose whole value is being an accurate
    // account of what was explained to whom.
    setConsentNote('');
    const reqId = ++detailReqRef.current;
    try {
      // One round-trip each for money and lab work rather than folding them
      // into the plan payload: the list view needs neither, and it keeps the
      // detail modal's refresh after a payment to a single call.
      const [planRes, payRes, labRes] = await Promise.all([
        api.get(`/admin/treatment-plans/${id}`),
        api.get(`/admin/treatment-plans/${id}/payments`).catch(() => ({ data: {} })),
        api.get('/admin/lab-works').catch(() => ({ data: {} })),
      ]);
      // Another plan was opened while these were in flight — its requests own
      // the modal now. Applying this plan's payments/lab-work/consent record
      // under the other patient's title is a clinical + money data mismatch.
      if (reqId !== detailReqRef.current) return;
      setDetail(planRes.data);
      setPayments(payRes.data.payments || []);
      setLabWorks((labRes.data.lab_works || []).filter(lw => lw.treatment_plan_id === id));
    } catch (err) {
      if (reqId === detailReqRef.current) toast.error(err.response?.data?.error || 'Failed to load plan');
    }
  }

  async function savePayment(e) {
    e.preventDefault();
    const amount = Number(payForm.amount);
    if (!Number.isInteger(amount) || amount <= 0) return toast.error('Enter a whole rupee amount');
    setBusy(true);
    try {
      await api.post(`/admin/treatment-plans/${payingPlan.id}/payments`, {
        amount, method: payForm.method, note: payForm.note || null,
      });
      toast.success('Payment recorded');
      setPayingPlan(null);
      setPayForm({ amount: '', method: 'cash', note: '' });
      openDetail(payingPlan.id);
      fetchPlans();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to record payment');
    } finally { setBusy(false); }
  }

  async function removePayment(planId, paymentId) {
    setConfirmModal({
      title: 'Delete this payment?',
      message: 'The amount collected against this treatment will go down. This is recorded in the audit log.',
      danger: true,
      onConfirm: async () => {
        // ConfirmModal never closes itself. Left up, the successful DELETE
        // looked like nothing had happened, and a second Confirm fired another
        // DELETE for an id that no longer exists — surfacing "Failed to delete"
        // right after the money HAD come off, so the operator could not tell
        // which. This is the audited, adminOnly operation that reduces recorded
        // revenue; ambiguity about whether it ran is the one thing it can't have.
        setConfirmModal(null);
        try {
          await api.delete(`/admin/treatment-plans/${planId}/payments/${paymentId}`);
          toast.success('Payment deleted');
          openDetail(planId);
          fetchPlans();
        } catch (err) { toast.error(err.response?.data?.error || 'Failed to delete'); }
      },
    });
  }

  async function saveLabWork(e) {
    e.preventDefault();
    if (!labForm.item.trim()) return toast.error('What went to the lab?');
    setBusy(true);
    try {
      await api.post(`/admin/treatment-plans/${labPlan.id}/lab-works`, {
        item: labForm.item.trim(),
        lab_name: labForm.lab_name || null,
        expected_date: labForm.expected_date || null,
        cost: Number(labForm.cost) || 0,
      });
      toast.success('Lab work added');
      setLabPlan(null);
      setLabForm({ item: '', lab_name: '', expected_date: '', cost: '' });
      openDetail(labPlan.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add lab work');
    } finally { setBusy(false); }
  }

  async function updateLabStatus(id, status) {
    try {
      await api.patch(`/admin/lab-works/${id}`, { status });
      setLabWorks(prev => prev.map(lw => lw.id === id ? { ...lw, status } : lw));
      toast.success(`Marked ${status}`);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to update'); }
  }

  // Opens the date/slot picker rather than booking immediately. The plan's
  // dentist and branch are fixed by the treatment; only when and which slot
  // are the operator's to choose.
  function openBookVisit(plan) {
    if (!plan.treating_doctor_id) {
      toast.error('This treatment has no treating dentist assigned — set one before booking a visit.');
      return;
    }
    setVisitForm({
      appointment_date: format(addDays(new Date(), DEFAULT_VISIT_GAP_DAYS), 'yyyy-MM-dd'),
      slot_id: '',
    });
    setVisitBooking(plan);
  }

  // Loads the dentist's open slots once a date is picked, same pattern as the
  // walk-in modal on the main dashboard — a real slot gets locked; free-typing
  // a time the bot has no idea is taken would double-book it.
  useEffect(() => {
    const doctorId = visitBooking?.treating_doctor_id;
    const date = visitForm.appointment_date;
    if (!doctorId || !date) { setVisitSlots([]); return; }
    let cancelled = false;
    setVisitSlotsLoading(true);
    api.get(`/admin/slots?doctor_id=${doctorId}&date=${date}`)
      .then(({ data }) => {
        if (cancelled) return;
        const hospitalId = visitBooking?.hospital_id;
        setVisitSlots((data.slots || []).filter(s =>
          s.status === 'available' && (!hospitalId || !s.hospital_id || s.hospital_id === hospitalId)));
      })
      .catch(() => { if (!cancelled) setVisitSlots([]); })
      .finally(() => { if (!cancelled) setVisitSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [visitBooking, visitForm.appointment_date]);

  // The only mutating action here that had neither a busy flag nor a disabled
  // button. Two clicks sent two POSTs, and because the backend re-counts under
  // the plan lock the second one booked the NEXT visit — an extra appointment,
  // an extra locked slot and an extra quota decrement, from a button the
  // operator pressed once as far as they were concerned.
  // Keyed on the plan id rather than the shared `busy` flag. `busy` is also
  // used by the payment and lab-work forms in the detail modal, so booking a
  // visit on one card disabled and relabelled ("Booking…") the button on EVERY
  // other plan's card at the same time. The modal forms can keep sharing it —
  // only one of them is on screen at a time.
  async function submitVisitBooking() {
    const plan = visitBooking;
    if (!plan || !visitForm.slot_id || bookingPlanId) return;
    setBookingPlanId(plan.id);
    try {
      const { data } = await api.post(`/admin/treatment-plans/${plan.id}/visits`, {
        slot_id: visitForm.slot_id,
      });
      toast.success(`Visit ${data.visit_number} booked — ${data.date} at ${String(data.time).slice(0, 5)}`);
      setVisitBooking(null);
      fetchPlans();
      if (detail?.treatment_plan?.id === plan.id) openDetail(plan.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to book the visit');
    } finally { setBookingPlanId(null); }
  }

  function changeStatus(plan, status, label) {
    setConfirmModal({
      title: `${label} treatment?`,
      message: `${label} "${plan.title}" for ${plan.patient_name}? Visits already booked are not cancelled automatically.`,
      danger: true,
      onConfirm: async () => {
        // Dismiss first — setDetail(null) below closes the plan detail, so a
        // dialog left up floats over an unrelated screen, and a second Confirm
        // re-PATCHes a plan derivePlanStatus will refuse to move.
        setConfirmModal(null);
        try {
          await api.patch(`/admin/treatment-plans/${plan.id}`, { status });
          toast.success(`Treatment ${status}`);
          fetchPlans();
          setDetail(null);
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to update');
        }
      },
    });
  }

  const fmt = d => { try { return format(parseISO(d), 'd MMM yyyy'); } catch { return d; } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Treatments</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Multi-visit courses — what was advised, who renders it, and what is still unbooked.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Record Treatment
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[
          ['outstanding', 'Needs booking'],
          ['in_progress', 'In progress'],
          ['proposed', 'Advised'],
          ['completed', 'Completed'],
          ['all', 'All'],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === id ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-gray-400 py-10 text-center">Loading…</div>
      ) : plans.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center">
          <div className="text-3xl mb-2">🦷</div>
          <p className="text-sm text-gray-500">
            {filter === 'outstanding'
              ? 'Nothing advised and waiting to be booked.'
              : 'No treatments here yet.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {plans.map(p => (
            <div key={p.id} className="bg-white rounded-xl border border-gray-100 p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900 text-sm break-words">{p.title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {p.patient_name}
                    {p.patient_phone && <span className="text-gray-400"> · {p.patient_phone}</span>}
                    {p.tooth_ref && <> · tooth {p.tooth_ref}</>}
                  </p>
                </div>
                <StatusPill status={p.status} />
              </div>

              <div className="text-xs text-gray-500 space-y-0.5">
                {p.treating_doctor_name && (
                  <div>👨‍⚕️ Dr. {p.treating_doctor_name}
                    {p.treating_doctor_specialization && <span className="text-gray-400"> · {p.treating_doctor_specialization}</span>}
                    {p.advised_by_name && p.advised_by_name !== p.treating_doctor_name && (
                      <span className="text-gray-400"> (referred by Dr. {p.advised_by_name})</span>
                    )}
                  </div>
                )}
                {p.hospital_name && <div>🏥 {p.hospital_name}</div>}
                {p.next_visit_date && <div>📅 Next visit {fmt(p.next_visit_date)}</div>}
                {p.estimated_cost > 0 && (
                  <div>
                    💰 ₹{p.estimated_cost.toLocaleString('en-IN')} estimated
                    {p.balance_due > 0
                      ? <span className="text-amber-700 font-medium"> · ₹{p.balance_due.toLocaleString('en-IN')} due</span>
                      : <span className="text-green-600"> · paid</span>}
                  </div>
                )}
                {p.open_lab_items > 0 && (
                  <div>
                    🔬 {p.open_lab_items} item{p.open_lab_items === 1 ? '' : 's'} at the lab
                    {p.next_lab_expected && <span className={p.next_lab_expected < todayISO ? 'text-red-500 font-medium' : ''}>
                      {' '}· {p.next_lab_expected < todayISO ? 'overdue' : `due ${fmt(p.next_lab_expected)}`}
                    </span>}
                  </div>
                )}
              </div>

              {/* Started, nothing booked, and nothing has happened in a month —
                  a different conversation from a fresh recommendation, and
                  usually one with money outstanding and a tooth left open. */}
              {p.stalled && (
                <div className="text-xs bg-red-50 text-red-700 rounded-lg px-2.5 py-1.5">
                  ⚠️ Stalled — last sitting {p.days_since_last_visit} days ago, nothing booked
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  <VisitDots done={p.visitsDone} booked={p.visitsBooked} total={p.total_visits} />
                  <span className="text-xs text-gray-500">
                    {p.visitsDone}/{p.total_visits} done
                    {p.visitsUnbooked > 0 && <span className="text-amber-600 font-medium"> · {p.visitsUnbooked} to book</span>}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => openDetail(p.id)}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                    Visits
                  </button>
                  {p.canBookNext && ['proposed', 'in_progress'].includes(p.status) && (
                    <button onClick={() => openBookVisit(p)} disabled={bookingPlanId != null}
                      className="px-2.5 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                      {bookingPlanId === p.id ? 'Booking…' : `Book visit ${p.nextVisitNumber}`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── PLAN DETAIL ── */}
      {detail && (
        <Modal title={detail.treatment_plan.title} onClose={() => { setDetail(null); setConsentNote(''); }} wide>
          <div className="space-y-4">
            {/* Stacks on a phone: a patient name or phone in a ~126px half-width
                cell overflowed the dialog. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div><span className="text-gray-500 text-xs">Patient</span>
                <p className="font-medium">{detail.treatment_plan.patient_name}</p>
                {detail.treatment_plan.patient_phone && (
                  <p className="text-xs text-gray-400">{detail.treatment_plan.patient_phone}</p>
                )}
              </div>
              <div><span className="text-gray-500 text-xs">Status</span><p><StatusPill status={detail.treatment_plan.status} /></p></div>
              <div><span className="text-gray-500 text-xs">Rendered by</span>
                <p className="font-medium">{detail.treatment_plan.treating_doctor_name ? `Dr. ${detail.treatment_plan.treating_doctor_name}` : '—'}</p></div>
              <div><span className="text-gray-500 text-xs">Advised by</span>
                <p className="font-medium">{detail.treatment_plan.advised_by_name ? `Dr. ${detail.treatment_plan.advised_by_name}` : '—'}</p></div>
              <div><span className="text-gray-500 text-xs">Visits</span>
                <p className="font-medium">{detail.treatment_plan.visitsDone} done · {detail.treatment_plan.visitsBooked} booked · {detail.treatment_plan.total_visits} planned</p></div>
              <div><span className="text-gray-500 text-xs">Estimate</span>
                <p className="font-medium">{detail.treatment_plan.estimated_cost > 0 ? `₹${detail.treatment_plan.estimated_cost.toLocaleString('en-IN')}` : '—'}</p></div>
            </div>

            {/* The printable quotation for the patient. Streams from the server —
                cost, paid, balance and visits so far — and says on its face that
                it is not a tax invoice. */}
            <button
              onClick={async () => {
                try {
                  await downloadFile(
                    `/admin/treatment-plans/${detail.treatment_plan.id}/estimate.pdf`,
                    `estimate-${detail.treatment_plan.id}.pdf`,
                  );
                } catch {
                  toast.error('Could not generate the estimate PDF');
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition">
              🖨 Print estimate
            </button>

            {detail.treatment_plan.notes && (
              <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap break-words">
                {detail.treatment_plan.notes}
              </div>
            )}

            {/* ── CONSENT ── */}
            {/* Extractions and surgery need one, and it is what protects the
                dentist. Records the FACT of consent — who took it, when, and
                what was explained — not a signature, which is a different and
                much larger thing. */}
            <div className={`border rounded-lg p-3 ${detail.treatment_plan.consent_taken_at ? 'border-gray-100' : 'border-amber-200 bg-amber-50'}`}>
              <h4 className="text-xs font-medium text-gray-500 mb-2">Consent</h4>
              {detail.treatment_plan.consent_taken_at ? (
                <div className="text-sm text-gray-700">
                  <span className="text-green-700 font-medium">Recorded</span>
                  <span className="text-gray-400 text-xs ml-2">
                    {(() => { try { return format(parseISO(detail.treatment_plan.consent_taken_at), 'd MMM yyyy, HH:mm'); } catch { return ''; } })()}
                  </span>
                  {detail.treatment_plan.consent_note && (
                    <p className="mt-1 text-xs text-gray-600 whitespace-pre-wrap break-words">
                      {detail.treatment_plan.consent_note}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-amber-800">
                    Not recorded. Note what was explained and who agreed.
                  </p>
                  <textarea
                    value={consentNote}
                    onChange={e => setConsentNote(e.target.value)}
                    rows={2}
                    maxLength={2000}
                    placeholder="e.g. Explained risk of nerve damage and alternatives; patient agreed."
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={async () => {
                      setSavingConsent(true);
                      try {
                        await api.post(`/admin/treatment-plans/${detail.treatment_plan.id}/consent`,
                          { note: consentNote.trim() || null });
                        toast.success('Consent recorded');
                        setConsentNote('');
                        openDetail(detail.treatment_plan.id);
                      } catch (err) {
                        toast.error(err.response?.data?.error || 'Could not record consent');
                      } finally { setSavingConsent(false); }
                    }}
                    disabled={savingConsent}
                    className="px-3 py-2 text-xs rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                    {savingConsent ? 'Recording…' : 'Record consent'}
                  </button>
                </div>
              )}
            </div>

            {/* ── MONEY ── */}
            {/* The first question an owner asks about a part-finished course. */}
            <div className="border border-gray-100 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className="text-xs font-medium text-gray-500">Payments</h4>
                <button onClick={() => setPayingPlan(detail.treatment_plan)}
                  className="px-3 py-2 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700">
                  + Record payment
                </button>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span className="text-green-700 font-medium">
                  ₹{Number(detail.treatment_plan.amount_paid || 0).toLocaleString('en-IN')} collected
                </span>
                {detail.treatment_plan.estimated_cost > 0 && (
                  <span className={detail.treatment_plan.balance_due > 0 ? 'text-amber-700 font-medium' : 'text-gray-400'}>
                    ₹{Number(detail.treatment_plan.balance_due || 0).toLocaleString('en-IN')} balance
                  </span>
                )}
                {detail.treatment_plan.overpaid && (
                  <span className="text-blue-600 text-xs">collected above the estimate — check the quote</span>
                )}
              </div>
              {payments.length > 0 && (
                <div className="mt-2 space-y-1">
                  {payments.map(pay => (
                    <div key={pay.id} className="flex items-center justify-between gap-2 text-xs text-gray-500">
                      <span>
                        ₹{Number(pay.amount).toLocaleString('en-IN')} · {pay.method?.replace('_', ' ')}
                        {pay.collected_at ? ` · ${fmt(String(pay.collected_at).slice(0, 10))}` : ''}
                      </span>
                      {isAdmin && (
                        <button onClick={() => removePayment(detail.treatment_plan.id, pay.id)}
                          aria-label="Delete payment"
                          className="shrink-0 w-9 h-9 flex items-center justify-center text-red-400 hover:text-red-600 md:w-auto md:h-auto md:px-1">✕</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── LAB WORK ── */}
            {/* A sitting that depends on a crown cannot be booked on slot
                availability alone — the patient arrives to find it isn't in. */}
            <div className="border border-gray-100 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className="text-xs font-medium text-gray-500">Lab work</h4>
                <button onClick={() => setLabPlan(detail.treatment_plan)}
                  className="px-3 py-2 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                  + Add
                </button>
              </div>
              {labWorks.length === 0 ? (
                <p className="text-xs text-gray-400">Nothing at the lab for this treatment.</p>
              ) : (
                <div className="space-y-1.5">
                  {labWorks.map(lw => (
                    <div key={lw.id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium">{lw.item}</span>
                        {lw.lab_name && <span className="text-gray-400"> · {lw.lab_name}</span>}
                        <p className="text-xs text-gray-400">
                          {lw.expected_date ? `Expected ${fmt(lw.expected_date)}` : 'No date set'}
                          {lw.expected_date && ['pending', 'sent'].includes(lw.status)
                            && lw.expected_date < todayISO && <span className="text-red-500 font-medium"> · overdue</span>}
                        </p>
                      </div>
                      <select value={lw.status}
                        onChange={e => updateLabStatus(lw.id, e.target.value)}
                        aria-label={`Status for ${lw.item}`}
                        className="shrink-0 border border-gray-200 rounded px-2 py-1.5 text-xs bg-white">
                        {['pending', 'sent', 'received', 'fitted', 'cancelled'].map(st => (
                          <option key={st} value={st}>{st}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-xs font-medium text-gray-500 mb-2">Visits</h4>
              {detail.visits.length === 0 ? (
                <p className="text-sm text-gray-400">No visits booked yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {detail.visits.map(v => (
                    <div key={v.id} className="flex items-center justify-between gap-2 border border-gray-100 rounded-lg px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium">Visit {v.visit_number ?? '—'}</span>
                        <span className="text-gray-500"> · {fmt(v.appointment_date)} at {String(v.appointment_time).slice(0, 5)}</span>
                        <p className="text-xs text-gray-400 truncate">Dr. {v.doctor_name} · {v.booking_id}</p>
                      </div>
                      <StatusPill status={v.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isAdmin && ['proposed', 'in_progress'].includes(detail.treatment_plan.status) && (
              <div className="flex flex-wrap gap-2 pt-3 border-t border-gray-100">
                {detail.treatment_plan.status === 'proposed' && (
                  <button onClick={() => changeStatus(detail.treatment_plan, 'declined', 'Decline')}
                    className="px-3 py-2 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                    Patient declined
                  </button>
                )}
                <button onClick={() => changeStatus(detail.treatment_plan, 'cancelled', 'Cancel')}
                  className="px-3 py-2 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50">
                  Cancel treatment
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── RECORD TREATMENT ── */}
      {/* Shared with the Appointments tab, which is the primary entry point —
          the treatment gets recorded on the visit it was advised in, not by
          finding that visit again from here. This standalone entry stays for
          treatments being entered after the fact. */}
      {showCreate && (
        <RecordTreatmentModal
          appointment={null}
          onClose={() => setShowCreate(false)}
          onSaved={fetchPlans}
        />
      )}

      {/* ── BOOK VISIT: date + real slot, not a blind auto-pick ── */}
      {visitBooking && (
        <Modal title={`Book visit ${visitBooking.nextVisitNumber} — ${visitBooking.title}`} onClose={() => setVisitBooking(null)}>
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              {visitBooking.patient_name}
              {visitBooking.treating_doctor_name && <> with Dr. {visitBooking.treating_doctor_name}</>}
              {visitBooking.hospital_name && <> · {visitBooking.hospital_name}</>}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Date *</label>
              <input type="date" value={visitForm.appointment_date}
                onChange={e => setVisitForm(f => ({ ...f, appointment_date: e.target.value, slot_id: '' }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Time *</label>
              {/* Slot picker, not a free-text time: selecting a real slot sends
                  slot_id, which is what makes the backend lock it against the bot. */}
              <select value={visitForm.slot_id}
                onChange={e => setVisitForm(f => ({ ...f, slot_id: e.target.value }))}
                disabled={!visitForm.appointment_date || visitSlotsLoading}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                required>
                <option value="">
                  {!visitForm.appointment_date ? '— Pick a date first —'
                    : visitSlotsLoading ? 'Loading slots…'
                    : visitSlots.length ? '— Select an open slot —'
                    : 'No open slots for this date'}
                </option>
                {visitSlots.map(s => (
                  <option key={s.id} value={s.id}>
                    {String(s.start_time).slice(0, 5)}{s.end_time ? ` – ${String(s.end_time).slice(0, 5)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {visitForm.appointment_date && !visitSlotsLoading && !visitSlots.length && (
              <p className="text-xs text-amber-600">
                No open slots for Dr. {visitBooking.treating_doctor_name} on this date — the dentist may
                be on leave, the clinic closed, or slots not yet generated. Try another date.
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setVisitBooking(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600">
                Cancel
              </button>
              <button type="button" onClick={submitVisitBooking}
                disabled={!visitForm.slot_id || bookingPlanId != null}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {bookingPlanId === visitBooking.id ? 'Booking…' : 'Book this slot'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── RECORD PAYMENT ── */}
      {payingPlan && (
        <Modal title={`Payment — ${payingPlan.title}`} onClose={() => setPayingPlan(null)}>
          <form onSubmit={savePayment} className="space-y-3">
            {payingPlan.estimated_cost > 0 && (
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                Estimate ₹{Number(payingPlan.estimated_cost).toLocaleString('en-IN')} ·
                collected ₹{Number(payingPlan.amount_paid || 0).toLocaleString('en-IN')} ·
                balance ₹{Number(payingPlan.balance_due || 0).toLocaleString('en-IN')}
              </p>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Amount ₹ <span className="text-red-400">*</span>
              </label>
              <input type="number" min="1" required autoFocus inputMode="numeric"
                value={payForm.amount}
                onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base" />
              {payingPlan.balance_due > 0 && (
                <button type="button"
                  onClick={() => setPayForm(f => ({ ...f, amount: String(payingPlan.balance_due) }))}
                  className="mt-1 text-xs text-blue-600 hover:underline py-1">
                  Pay the full balance (₹{Number(payingPlan.balance_due).toLocaleString('en-IN')})
                </button>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
              <div className="flex flex-wrap gap-2">
                {['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'].map(m => (
                  <button key={m} type="button" onClick={() => setPayForm(f => ({ ...f, method: m }))}
                    className={`px-3 h-10 rounded-lg text-xs font-medium border capitalize transition-colors ${
                      payForm.method === m ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                    {m.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Note</label>
              <input value={payForm.note} maxLength={200}
                onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))}
                placeholder="Receipt no., who paid…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setPayingPlan(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600">Cancel</button>
              <button type="submit" disabled={busy}
                className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {busy ? 'Saving…' : 'Record payment'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── ADD LAB WORK ── */}
      {labPlan && (
        <Modal title={`Lab work — ${labPlan.title}`} onClose={() => setLabPlan(null)}>
          <form onSubmit={saveLabWork} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Item <span className="text-red-400">*</span>
              </label>
              <input value={labForm.item} required autoFocus maxLength={255}
                onChange={e => setLabForm(f => ({ ...f, item: e.target.value }))}
                placeholder="e.g. PFM crown, 36"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Lab</label>
              <input value={labForm.lab_name} maxLength={255}
                onChange={e => setLabForm(f => ({ ...f, lab_name: e.target.value }))}
                placeholder="Which lab it went to"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Expected back</label>
                <input type="date" value={labForm.expected_date}
                  onChange={e => setLabForm(f => ({ ...f, expected_date: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Lab cost ₹</label>
                <input type="number" min="0" value={labForm.cost}
                  onChange={e => setLabForm(f => ({ ...f, cost: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setLabPlan(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600">Cancel</button>
              <button type="submit" disabled={busy}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {busy ? 'Saving…' : 'Add'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
