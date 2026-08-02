'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import { todayIST } from '@/lib/dateIST';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

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
      await api.post(`/admin/doctors/${leavesDoctor.id}/leaves`, { dates: [leaveDate], reason: leaveReason || null });
      toast.success('Leave added');
      setLeaveDate('');
      setLeaveReason('');
      fetchLeaves(leavesDoctor.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add leave');
    } finally { setLeaveSaving(false); }
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
                  ⚠️ Adding a leave blocks all available slots on that day. Already-booked appointments are not affected.
                </p>
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
    </div>
  );
}
