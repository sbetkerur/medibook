'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import { todayIST } from '@/lib/dateIST';
import { format, parseISO, addDays } from 'date-fns';
import toast from 'react-hot-toast';
import Modal from '@/components/ui/Modal';

// Self-contained. Fetches its own doctor list (separate from the shared
// `doctors` state). `setConfirmModal` drives the shared confirm dialog rendered
// at the page root.
export default function LeavesTab({ isAdmin, setConfirmModal }) {
  const [leavesDoctor, setLeavesDoctor] = useState(null);
  const [leaves, setLeaves] = useState([]);
  const [leavesLoading, setLeavesLoading] = useState(false);
  const [leaveDate, setLeaveDate] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [leavesDoctorList, setLeavesDoctorList] = useState([]);

  // Confirmed appointments the leave just landed on — blocking only affects
  // AVAILABLE slots, so these still stand and the patient would show up to an
  // absent doctor unless the desk acts on them here. Populated straight from
  // POST /doctors/:id/leaves's response and cleared as each one is resolved.
  const [affectedAppointments, setAffectedAppointments] = useState([]);
  const [reschedulingAppt, setReschedulingAppt] = useState(null); // one row from affectedAppointments, or null
  const [rescheduleForm, setRescheduleForm] = useState({ date: '', slot_id: '' });
  const [rescheduleSlots, setRescheduleSlots] = useState([]);
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState(false);
  const [rescheduleSaving, setRescheduleSaving] = useState(false);
  const [cancellingAppt, setCancellingAppt] = useState(null); // one row, or null
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSaving, setCancelSaving] = useState(false);

  const fetchLeavesDoctorList = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/doctors');
      setLeavesDoctorList(data.doctors || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchLeavesDoctorList();
  }, [fetchLeavesDoctorList]);

  const fetchLeaves = useCallback(async (doctorId) => {
    if (!doctorId) return;
    setLeavesLoading(true);
    try {
      const { data } = await api.get(`/admin/doctors/${doctorId}/leaves`);
      setLeaves(data.leaves || []);
    } catch { toast.error('Failed to load leaves'); }
    finally { setLeavesLoading(false); }
  }, []);

  async function addLeave() {
    if (!leavesDoctor || !leaveDate) return toast.error('Select a doctor and date');
    setLeaveSaving(true);
    try {
      const { data } = await api.post(`/admin/doctors/${leavesDoctor.id}/leaves`, { dates: [leaveDate], reason: leaveReason || null });
      // affected_appointment_details used to come back and go straight in the
      // bin — the toast just said "Leave added" no matter how many confirmed
      // bookings the leave landed on. Surface them instead of the doctor's
      // scheduled-leaves list, so the desk actually sees who needs moving.
      const affected = data?.affected_appointment_details || [];
      if (affected.length) {
        // MERGE, not replace: a second leave added before the first one's
        // conflicts are resolved used to wipe them off screen — they were
        // still unresolved on the backend, just no longer visible anywhere.
        // Dedup by id in case the same appointment shows up twice (e.g. two
        // leave dates landing on the same multi-day booking window).
        setAffectedAppointments(prev => {
          const byId = new Map(prev.map(a => [a.id, a]));
          for (const a of affected) byId.set(a.id, a);
          return [...byId.values()];
        });
        toast(`Leave added — ${affected.length} booked appointment${affected.length === 1 ? '' : 's'} need${affected.length === 1 ? 's' : ''} rescheduling`, { icon: '⚠️' });
      } else {
        toast.success('Leave added');
      }
      setLeaveDate('');
      setLeaveReason('');
      fetchLeaves(leavesDoctor.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add leave');
    } finally { setLeaveSaving(false); }
  }

  // Opens the date/slot picker for one affected appointment. Defaults to the
  // SAME doctor (the leave's own doctor) and the day right after the
  // appointment's current (leave) date — nothing moves until the desk picks
  // an actual slot.
  function openReschedule(appt) {
    setRescheduleForm({
      date: format(addDays(parseISO(appt.appointment_date), 1), 'yyyy-MM-dd'),
      slot_id: '',
    });
    setReschedulingAppt(appt);
  }

  useEffect(() => {
    if (!reschedulingAppt || !rescheduleForm.date || !leavesDoctor) { setRescheduleSlots([]); return; }
    let cancelled = false;
    setRescheduleSlotsLoading(true);
    api.get(`/admin/slots?doctor_id=${leavesDoctor.id}&date=${rescheduleForm.date}`)
      .then(({ data }) => {
        if (cancelled) return;
        setRescheduleSlots((data.slots || []).filter(s => s.status === 'available'));
      })
      .catch(() => { if (!cancelled) setRescheduleSlots([]); })
      .finally(() => { if (!cancelled) setRescheduleSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [reschedulingAppt, rescheduleForm.date, leavesDoctor]);

  async function submitReschedule() {
    if (!reschedulingAppt || !rescheduleForm.slot_id) return;
    setRescheduleSaving(true);
    try {
      const { data } = await api.patch(`/admin/appointments/${reschedulingAppt.id}/reschedule`, {
        slot_id: rescheduleForm.slot_id,
        reason: `Dr. ${leavesDoctor.name} is on leave that day`,
      });
      toast.success(`Moved to ${data.date} at ${String(data.time).slice(0, 5)} — patient notified`);
      setAffectedAppointments(prev => prev.filter(a => a.id !== reschedulingAppt.id));
      setReschedulingAppt(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reschedule');
    } finally { setRescheduleSaving(false); }
  }

  async function submitCancel() {
    if (!cancellingAppt || !cancelReason.trim()) return;
    setCancelSaving(true);
    try {
      await api.patch(`/admin/appointments/${cancellingAppt.id}`, {
        status: 'cancelled',
        cancellation_reason: cancelReason.trim(),
      });
      toast.success('Appointment cancelled');
      setAffectedAppointments(prev => prev.filter(a => a.id !== cancellingAppt.id));
      setCancellingAppt(null);
      setCancelReason('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel');
    } finally { setCancelSaving(false); }
  }

  async function removeLeave(doctorId, leaveDate) {
    setConfirmModal({
      title: 'Remove Leave?',
      message: `Remove leave for ${leaveDate}? Available slots will be restored.`,
      danger: false,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/doctors/${doctorId}/leaves/${leaveDate}`);
          toast.success('Leave removed');
          fetchLeaves(doctorId);
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to remove leave');
        }
      },
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row gap-4 md:gap-6 md:items-start">
        {/* Doctor selector */}
        <div className="w-full md:w-56 md:shrink-0">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Select Doctor</label>
          <div className="space-y-1">
            {leavesDoctorList.length === 0 ? (
              <div className="text-sm text-gray-400 p-3 bg-white rounded-xl shadow-sm text-center">
                <div className="text-2xl mb-1">🦷</div>
                No dentists found
              </div>
            ) : leavesDoctorList.map(d => (
              <button key={d.id}
                /* Do NOT clear affectedAppointments on doctor switch: they are
                   still unresolved on the backend (the patient shows up to an
                   absent doctor), and this amber panel is the only surface for
                   them. addLeave deliberately MERGES for the same reason. The
                   Dismiss button and per-row Reschedule/Cancel (re-read by id)
                   are how the desk clears them. */
                onClick={() => { setLeavesDoctor(d); fetchLeaves(d.id); }}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-colors border ${
                  leavesDoctor?.id === d.id
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-white text-gray-700 hover:bg-gray-50 border-transparent'
                }`}>
                Dr. {d.name}
                <div className="text-xs font-normal text-gray-400 mt-0.5 truncate">{d.specialization || 'General'}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Leave management panel */}
        <div className="flex-1 min-w-0">
          {!leavesDoctor ? (
            <div className="text-center py-16 bg-white rounded-xl shadow-sm">
              <div className="text-5xl mb-3">🏖️</div>
              <p className="text-gray-500 font-medium">Select a doctor</p>
              <p className="text-gray-400 text-sm mt-1">Choose a doctor from the list to manage their leaves</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Add leave form (leave CRUD is admin-only server-side) */}
              {isAdmin && (
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="font-semibold text-gray-800 mb-4">Add Leave — Dr. {leavesDoctor.name}</h3>
                {/* Fields go full width below sm and only sit side by side once
                    there is room — a date input's intrinsic width is browser
                    dependent and can crowd the row on a narrow phone. */}
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="w-full sm:w-auto">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Leave Date *</label>
                    <input type="date" value={leaveDate}
                      onChange={e => setLeaveDate(e.target.value)}
                      min={todayIST()}
                      className="w-full sm:w-auto border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="w-full sm:flex-1 sm:w-auto sm:min-w-[160px]">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Reason (optional)</label>
                    <input value={leaveReason}
                      onChange={e => setLeaveReason(e.target.value)}
                      placeholder="e.g. Medical conference, personal leave"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <button onClick={addLeave} disabled={leaveSaving || !leaveDate}
                    className="w-full sm:w-auto px-4 py-2.5 sm:py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition whitespace-nowrap">
                    {leaveSaving ? 'Adding...' : '+ Add Leave'}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  ⚠️ Adding a leave blocks open slots on that day. Already-booked appointments still stand —
                  reschedule or cancel them below if the leave collides with any.
                </p>
              </div>
              )}

              {/* Confirmed appointments the leave just landed on. Blocking only
                  affects AVAILABLE slots, so these are still on the book and the
                  patient would show up to an absent doctor unless handled here. */}
              {affectedAppointments.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-5 py-3 border-b border-amber-100 flex items-center justify-between gap-2">
                    <h3 className="font-medium text-amber-800">
                      ⚠️ {affectedAppointments.length} booked appointment{affectedAppointments.length !== 1 ? 's' : ''} on the leave date{affectedAppointments.length !== 1 ? 's' : ''}
                    </h3>
                    <button onClick={() => setAffectedAppointments([])}
                      className="text-xs text-amber-700 hover:underline shrink-0">Dismiss</button>
                  </div>
                  <div className="divide-y divide-amber-100">
                    {affectedAppointments.map(a => (
                      <div key={a.id} className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{a.patient_name || a.patient_phone}</div>
                          <div className="text-xs text-gray-500">
                            {(() => { try { return format(parseISO(a.appointment_date), 'EEE, d MMM yyyy'); } catch { return a.appointment_date; } })()}
                            {' at '}{String(a.appointment_time || '').slice(0, 5)} · {a.booking_id}
                          </div>
                        </div>
                        {isAdmin && (
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => openReschedule(a)}
                            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                            Reschedule
                          </button>
                          <button onClick={() => { setCancellingAppt(a); setCancelReason(''); }}
                            className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition">
                            Cancel
                          </button>
                        </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Existing leaves */}
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="px-4 sm:px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
                  <h3 className="font-medium text-gray-800">Scheduled Leaves</h3>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    {leaves.length} date{leaves.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {leavesLoading ? (
                  <div className="px-5 py-10 text-center text-gray-400 text-sm">Loading leaves...</div>
                ) : leaves.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <div className="text-3xl mb-2">✅</div>
                    <p className="text-gray-500 font-medium text-sm">No leaves scheduled</p>
                    <p className="text-gray-400 text-xs mt-1">Dr. {leavesDoctor.name} is available on all working days</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {leaves.map(l => (
                      <div key={l.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">
                            {(() => { try { return format(parseISO(l.leave_date), 'EEEE, d MMMM yyyy'); } catch { return l.leave_date; } })()}
                          </div>
                          {l.reason && <div className="text-xs text-gray-400 mt-0.5 break-words">{l.reason}</div>}
                        </div>
                        {isAdmin && (
                        <button onClick={() => removeLeave(leavesDoctor.id, l.leave_date)}
                          className="px-3 py-2 sm:px-2 sm:py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 transition shrink-0">
                          Remove
                        </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── RESCHEDULE: date + real slot, not a blind auto-pick ── */}
      {reschedulingAppt && (
        <Modal title={`Reschedule — ${reschedulingAppt.patient_name || reschedulingAppt.patient_phone}`}
          onClose={() => setReschedulingAppt(null)}>
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Currently {(() => { try { return format(parseISO(reschedulingAppt.appointment_date), 'EEE, d MMM yyyy'); } catch { return reschedulingAppt.appointment_date; } })()}
              {' at '}{String(reschedulingAppt.appointment_time || '').slice(0, 5)} with Dr. {leavesDoctor.name} · {reschedulingAppt.booking_id}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">New date *</label>
              <input type="date" value={rescheduleForm.date}
                min={todayIST()}
                onChange={e => setRescheduleForm(f => ({ ...f, date: e.target.value, slot_id: '' }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">New time *</label>
              <select value={rescheduleForm.slot_id}
                onChange={e => setRescheduleForm(f => ({ ...f, slot_id: e.target.value }))}
                disabled={!rescheduleForm.date || rescheduleSlotsLoading}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                required>
                <option value="">
                  {!rescheduleForm.date ? '— Pick a date first —'
                    : rescheduleSlotsLoading ? 'Loading slots…'
                    : rescheduleSlots.length ? '— Select an open slot —'
                    : 'No open slots for this date'}
                </option>
                {rescheduleSlots.map(s => (
                  <option key={s.id} value={s.id}>
                    {String(s.start_time).slice(0, 5)}{s.end_time ? ` – ${String(s.end_time).slice(0, 5)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {rescheduleForm.date && !rescheduleSlotsLoading && !rescheduleSlots.length && (
              <p className="text-xs text-amber-600">
                No open slots for Dr. {leavesDoctor.name} on this date. Try another date.
              </p>
            )}
            <p className="text-xs text-gray-400">The patient is notified on WhatsApp once this is moved.</p>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setReschedulingAppt(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600">
                Cancel
              </button>
              <button type="button" onClick={submitReschedule}
                disabled={!rescheduleForm.slot_id || rescheduleSaving}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {rescheduleSaving ? 'Moving…' : 'Move appointment'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── CANCEL, as the alternative to rescheduling ── */}
      {cancellingAppt && (
        <Modal title={`Cancel — ${cancellingAppt.patient_name || cancellingAppt.patient_phone}`}
          onClose={() => setCancellingAppt(null)}>
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              {(() => { try { return format(parseISO(cancellingAppt.appointment_date), 'EEE, d MMM yyyy'); } catch { return cancellingAppt.appointment_date; } })()}
              {' at '}{String(cancellingAppt.appointment_time || '').slice(0, 5)} · {cancellingAppt.booking_id}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Reason *</label>
              <input value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                placeholder="e.g. Dentist on leave, patient could not be moved"
                autoFocus
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setCancellingAppt(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600">
                Back
              </button>
              <button type="button" onClick={submitCancel}
                disabled={!cancelReason.trim() || cancelSaving}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {cancelSaving ? 'Cancelling…' : 'Confirm cancel'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
