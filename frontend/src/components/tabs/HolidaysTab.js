'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

// Self-contained. `hospitals` is shared (ensured loaded by the parent before
// this tab renders) and `setConfirmModal` drives the shared confirm dialog
// rendered at the page root.
export default function HolidaysTab({ hospitals, isAdmin, setConfirmModal }) {
  const [holidays, setHolidays] = useState([]);
  const [holidayForm, setHolidayForm] = useState({ hospital_id: '', holiday_date: '', name: '' });
  const [holidaySaving, setHolidaySaving] = useState(false);

  const fetchHolidays = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/holidays');
      setHolidays(data.holidays || []);
    } catch { toast.error('Failed to load holidays'); }
  }, []);

  useEffect(() => {
    fetchHolidays();
  }, [fetchHolidays]);

  async function addHoliday(e) {
    e.preventDefault();
    if (!holidayForm.holiday_date || !holidayForm.name.trim()) return toast.error('Date and name are required');
    setHolidaySaving(true);
    try {
      await api.post('/admin/holidays', holidayForm);
      toast.success('Holiday added');
      setHolidayForm(f => ({ ...f, holiday_date: '', name: '' }));
      fetchHolidays();
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to add holiday';
      toast.error(msg.includes('already') ? 'A holiday already exists on that date' : msg);
    } finally { setHolidaySaving(false); }
  }

  function deleteHoliday(holiday) {
    setConfirmModal({
      title: `Remove holiday "${holiday.name}"?`,
      message: `This will remove the closure on ${holiday.holiday_date} and allow new bookings on that day.`,
      danger: false,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/holidays/${holiday.id}`);
          toast.success('Holiday removed');
          fetchHolidays();
        } catch (err) { toast.error(err.response?.data?.error || 'Failed to remove'); }
      },
    });
  }

  return (
    <div className="space-y-4">
      {/* Add holiday form (holiday CRUD is admin-only server-side) */}
      {isAdmin && (
      <div className="bg-white rounded-xl p-5 shadow-sm">
        <h3 className="font-semibold text-gray-800 mb-4">Add Clinic Holiday / Closure</h3>
        <form onSubmit={addHoliday} className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Clinic Branch</label>
            <select value={holidayForm.hospital_id}
              onChange={e => setHolidayForm(f => ({ ...f, hospital_id: e.target.value }))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— All Branches —</option>
              {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Date <span className="text-red-400">*</span></label>
            <input type="date" value={holidayForm.holiday_date}
              onChange={e => setHolidayForm(f => ({ ...f, holiday_date: e.target.value }))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-gray-700 mb-1">Holiday Name <span className="text-red-400">*</span></label>
            <input value={holidayForm.name}
              onChange={e => setHolidayForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Diwali, Republic Day, Clinic Renovation"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <button type="submit" disabled={holidaySaving}
            className="px-4 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50 transition whitespace-nowrap">
            {holidaySaving ? 'Adding...' : '+ Add Holiday'}
          </button>
        </form>
        <p className="text-xs text-gray-400 mt-3">
          ⚠️ Holidays block new slot generation and hide available slots on that day. Already-confirmed appointments are not affected.
        </p>
      </div>
      )}

      {/* Holidays list */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-medium text-gray-800">Scheduled Holidays</h3>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{holidays.length} date{holidays.length !== 1 ? 's' : ''}</span>
        </div>
        {holidays.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="text-3xl mb-2">🗓️</div>
            <p className="text-gray-500 font-medium text-sm">No holidays scheduled</p>
            <p className="text-gray-400 text-xs mt-1">Add clinic closures to prevent bookings on those days</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Date', 'Holiday', 'Branch', 'Added'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                  <th className="px-4 py-3 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {holidays.map(h => (
                  <tr key={h.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                      {(() => { try { return format(parseISO(h.holiday_date), 'EEE, d MMM yyyy'); } catch { return h.holiday_date; } })()}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{h.name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{h.hospital_name || <span className="text-gray-400 italic">All branches</span>}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {h.created_at ? (() => { try { return format(parseISO(h.created_at), 'd MMM yy'); } catch { return '—'; } })() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin && (
                      <button onClick={() => deleteHoliday(h)}
                        className="px-2 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 transition">
                        Remove
                      </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
