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

  const slotStatusColor = (s) => ({
    available: 'bg-green-100 text-green-700 border-green-200',
    booked: 'bg-blue-100 text-blue-700 border-blue-200',
    blocked: 'bg-red-100 text-red-700 border-red-200',
    expired: 'bg-gray-100 text-gray-500 border-gray-200',
  }[s] || 'bg-gray-100 text-gray-500 border-gray-200');

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <select value={selDoctor} onChange={e => setSelDoctor(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">Select Doctor</option>
          {(doctors || []).map(d => <option key={d.id} value={d.id}>Dr. {d.name}</option>)}
        </select>
        <input type="date" value={selDate} onChange={e => setSelDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>

      {!selDoctor ? (
        <div className="bg-white rounded-xl p-8 text-center text-gray-400">Select a doctor to view slots</div>
      ) : slotsLoading ? (
        <div className="bg-white rounded-xl p-8 text-center text-gray-400">Loading...</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="font-semibold text-gray-800">{slots.length} slots on {selDate}</h3>
            <div className="flex gap-3 text-xs text-gray-500">
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
            {!slots.length && <div className="col-span-8 py-6 text-center text-gray-400">No slots generated for this date</div>}
          </div>
        </div>
      )}
    </div>
  );
}
