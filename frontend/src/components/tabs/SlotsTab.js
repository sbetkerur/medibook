'use client';
import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { todayIST } from '@/lib/dateIST';
import toast from 'react-hot-toast';

// isAdmin: PATCH /admin/slots/:id is adminOnly server-side (blocking a slot
// removes it from the WhatsApp booking flow), so a non-admin's click could only
// ever return 403. The grid itself stays readable by every role.
export default function SlotsTab({ doctors, isAdmin }) {
  const [selDoctor, setSelDoctor] = useState('');
  // IST, not device-local — the product timezone is Asia/Kolkata.
  const [selDate, setSelDate] = useState(todayIST());
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // Bumped after a block/unblock to re-run the fetch effect below.
  const [reloadKey, setReloadKey] = useState(0);

  // Range availability — block/unblock several days at once (a conference, a
  // short leave not worth recording permanently) instead of clicking every
  // slot on every day by hand. Defaults to the day currently in view.
  const [rangeStart, setRangeStart] = useState(todayIST());
  const [rangeEnd, setRangeEnd] = useState(todayIST());
  const [rangeReason, setRangeReason] = useState('');
  const [rangeBusy, setRangeBusy] = useState(false);

  useEffect(() => {
    if (!selDoctor || !selDate) { setSlots([]); return; }
    // Ignore a response whose doctor/date is no longer selected: picking A then
    // quickly B let A's slower reply land last, rendering A's grid under B's
    // name — and toggleSlot then PATCHed A's slot ids.
    let cancelled = false;
    setSlotsLoading(true);
    api.get(`/admin/slots?doctor_id=${selDoctor}&date=${selDate}`)
      .then(({ data }) => { if (!cancelled) setSlots(data.slots || []); })
      .catch(() => { if (!cancelled) toast.error('Failed to load slots'); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [selDoctor, selDate, reloadKey]);

  async function toggleSlot(slot) {
    if (slot.status === 'booked') return toast.error('Cannot block a booked slot');
    const action = slot.status === 'blocked' ? 'unblock' : 'block';
    try {
      await api.patch(`/admin/slots/${slot.id}`, { action });
      toast.success(`Slot ${action}ed`);
      setReloadKey(k => k + 1);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  }

  async function applyRange(action) {
    if (!selDoctor) return toast.error('Select a doctor first');
    if (!rangeStart || !rangeEnd) return toast.error('Pick both dates');
    if (rangeEnd < rangeStart) return toast.error('End date must be on or after start date');
    setRangeBusy(true);
    try {
      const { data } = await api.post('/admin/slots/range', {
        doctor_id: selDoctor, start_date: rangeStart, end_date: rangeEnd,
        action, reason: rangeReason || null,
      });
      const count = action === 'block' ? data.blocked : data.unblocked;
      toast.success(`${count} slot${count === 1 ? '' : 's'} ${action}ed, ${rangeStart} to ${rangeEnd}`);
      // The visible day's grid is only refetched when it falls inside the
      // range that just changed — refreshing unconditionally would refetch a
      // date the operator wasn't even looking at.
      if (selDate >= rangeStart && selDate <= rangeEnd) setReloadKey(k => k + 1);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    } finally { setRangeBusy(false); }
  }

  const slotStatusColor = (s) => ({
    available: 'bg-green-100 text-green-700 border-green-200',
    booked: 'bg-blue-100 text-blue-700 border-blue-200',
    blocked: 'bg-red-100 text-red-700 border-red-200',
    expired: 'bg-gray-100 text-gray-500 border-gray-200',
  }[s] || 'bg-gray-100 text-gray-500 border-gray-200');

  return (
    <div className="space-y-4">
      {/* Full width below sm: a select is as wide as its longest option, so a
          long dentist name overflowed a 320px screen. */}
      <div className="flex gap-3 flex-wrap">
        <select value={selDoctor} onChange={e => setSelDoctor(e.target.value)}
          className="w-full sm:w-auto min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">Select Doctor</option>
          {(doctors || []).map(d => <option key={d.id} value={d.id}>Dr. {d.name}</option>)}
        </select>
        <input type="date" value={selDate} onChange={e => setSelDate(e.target.value)}
          className="w-full sm:w-auto min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>

      {/* Manual availability over a range of dates. The grid below already
          lets an admin block/unblock ONE slot at a time by clicking it, and
          the doctor's Schedule modal changes the recurring week — neither
          covers "closed Thu–Sat for a conference" without opening three days
          and tapping every slot on each. adminOnly to match both of those:
          POST /admin/slots/range is adminOnly server-side. */}
      {isAdmin && selDoctor && (
        <div className="bg-white rounded-xl shadow-sm p-4 md:p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Block or unblock a range of dates</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">From</label>
              <input type="date" value={rangeStart} max={rangeEnd || undefined}
                onChange={e => setRangeStart(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">To</label>
              <input type="date" value={rangeEnd} min={rangeStart || undefined}
                onChange={e => setRangeEnd(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs font-medium text-gray-700 mb-1">Reason <span className="text-gray-400 font-normal">(optional)</span></label>
              <input value={rangeReason} onChange={e => setRangeReason(e.target.value)}
                placeholder="e.g. Conference, personal leave"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => applyRange('block')} disabled={rangeBusy}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition whitespace-nowrap">
                {rangeBusy ? 'Working…' : 'Block range'}
              </button>
              <button type="button" onClick={() => applyRange('unblock')} disabled={rangeBusy}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition whitespace-nowrap">
                {rangeBusy ? 'Working…' : 'Unblock range'}
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Block only touches currently AVAILABLE slots; unblock only touches ones BLOCKED this way — a booked
            appointment is never affected either direction, and slots must already be generated for these dates.
          </p>
        </div>
      )}

      {!selDoctor ? (
        <div className="bg-white rounded-xl p-8 text-center text-gray-400">Select a doctor to view slots</div>
      ) : slotsLoading ? (
        <div className="bg-white rounded-xl p-8 text-center text-gray-400">Loading...</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 md:px-5 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-gray-800">{slots.length} slots on {selDate}</h3>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 inline-block"></span>Available</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block"></span>Booked</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block"></span>Blocked</span>
            </div>
          </div>
          <div className="p-3 md:p-4 grid grid-cols-3 sm:grid-cols-5 md:grid-cols-8 gap-2">
            {slots.map(slot => (
              <div key={slot.id}
                onClick={() => isAdmin && (slot.status === 'available' || slot.status === 'blocked') && toggleSlot(slot)}
                className={`p-2 min-h-[44px] rounded-lg border text-center text-xs font-medium transition-all flex flex-col items-center justify-center ${slotStatusColor(slot.status)} ${
                  !isAdmin || slot.status === 'booked' || slot.status === 'expired'
                    ? 'opacity-60 cursor-not-allowed'
                    : 'cursor-pointer hover:opacity-80 active:scale-95'
                }`}
                title={slot.patient_name ? `Booked: ${slot.patient_name} (${slot.booking_id})` : slot.status}>
                <div>{slot.start_time?.slice(0, 5)}</div>
                {slot.patient_name && <div className="truncate text-xs mt-0.5 opacity-75 w-full">{slot.patient_name.split(' ')[0]}</div>}
              </div>
            ))}
            {!slots.length && <div className="col-span-full py-6 text-center text-gray-400">No slots generated for this date</div>}
          </div>
        </div>
      )}
    </div>
  );
}
