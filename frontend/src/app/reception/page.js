'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { todayIST, todayISTDisplay } from '@/lib/dateIST';
import toast from 'react-hot-toast';

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});

export default function ReceptionPage() {
  const router = useRouter();
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clinicName, setClinicName] = useState('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState(0);
  const [markingId, setMarkingId] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    const u = localStorage.getItem('user');
    if (u) {
      try {
        const parsed = JSON.parse(u);
        setClinicName(parsed.tenant || '');
      } catch (_) {}
    }
    fetchAppointments();
  }, []);

  useEffect(() => {
    const clockInterval = setInterval(() => {
      setCurrentTime(new Date());
      setSecondsSinceUpdate(prev => prev + 1);
    }, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  useEffect(() => {
    const refreshInterval = setInterval(() => {
      fetchAppointments();
    }, 30000);
    return () => clearInterval(refreshInterval);
  }, []);

  const fetchAppointments = useCallback(async () => {
    try {
      // IST, not device-local: a display set to another timezone must still
      // show the IST day's queue.
      const today = todayIST();
      const { data } = await api.get(`/admin/appointments?date=${today}&limit=100`);
      const sorted = (data.appointments || []).sort((a, b) => {
        const timeA = a.appointment_time || '';
        const timeB = b.appointment_time || '';
        return timeA.localeCompare(timeB);
      });
      setAppointments(sorted);
      setLastUpdated(new Date());
      setSecondsSinceUpdate(0);
    } catch {
      toast.error('Failed to refresh appointments');
    } finally {
      setLoading(false);
    }
  }, []);

  async function markComplete(id) {
    setMarkingId(id);
    try {
      await api.patch(`/admin/appointments/${id}`, { status: 'completed' });
      setAppointments(prev =>
        prev.map(a => a.id === id ? { ...a, status: 'completed' } : a)
      );
      toast.success('Marked as completed');
    } catch {
      toast.error('Failed to update status');
    } finally {
      setMarkingId(null);
    }
  }

  function statusBadge(status) {
    const classes = {
      confirmed: 'bg-green-500 text-white',
      completed: 'bg-blue-500 text-white',
      no_show: 'bg-gray-400 text-white',
      cancelled: 'bg-red-500 text-white',
    };
    return classes[status] || 'bg-gray-400 text-white';
  }

  const today = todayISTDisplay();

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 px-4 sm:px-8 py-4 sm:py-5 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-3xl font-bold text-white break-words">
            Today&apos;s Queue
            {clinicName && <span className="text-blue-400"> — {clinicName}</span>}
          </h1>
          <p className="text-gray-400 text-sm sm:text-lg mt-1">{today}</p>
        </div>
        {/* Full width once wrapped so the clock and the dashboard link sit on one
            phone row instead of stacking into two near-empty lines. */}
        <div className="w-full sm:w-auto flex flex-wrap items-center gap-4 sm:gap-8">
          <div className="text-left sm:text-right">
            <div className="text-2xl sm:text-4xl font-mono font-bold text-blue-400">
              {IST_CLOCK.format(currentTime)}
            </div>
            <div className="text-xs sm:text-sm text-gray-400 mt-1">
              Last updated {secondsSinceUpdate}s ago
              {/* Padded to a ~44px tap target on touch; negative margin keeps it
                  on the same text line, and sm: restores the plain inline link. */}
              <button
                onClick={fetchAppointments}
                className="ml-2 inline-block px-2 py-3 -my-2 sm:px-0 sm:py-0 sm:my-0 text-blue-400 hover:text-blue-300 underline"
              >
                Refresh
              </button>
            </div>
          </div>
          <a
            href="/dashboard"
            className="ml-auto sm:ml-0 inline-flex items-center min-h-[44px] sm:min-h-0 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition"
          >
            &larr; Back to Dashboard
          </a>
        </div>
      </header>

      {/* Stats bar */}
      <div className="bg-gray-800 px-4 sm:px-8 py-3 flex flex-wrap gap-x-6 gap-y-2 sm:gap-x-8 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-green-500 inline-block"></span>
          <span className="text-gray-300 text-sm sm:text-lg">
            Confirmed: <strong className="text-white">{appointments.filter(a => a.status === 'confirmed').length}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-blue-500 inline-block"></span>
          <span className="text-gray-300 text-sm sm:text-lg">
            Completed: <strong className="text-white">{appointments.filter(a => a.status === 'completed').length}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-red-500 inline-block"></span>
          <span className="text-gray-300 text-sm sm:text-lg">
            Cancelled: <strong className="text-white">{appointments.filter(a => a.status === 'cancelled').length}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-gray-400 inline-block"></span>
          <span className="text-gray-300 text-sm sm:text-lg">
            No Show: <strong className="text-white">{appointments.filter(a => a.status === 'no_show').length}</strong>
          </span>
        </div>
        {/* ml-auto only once the bar fits on one line — when the stats wrap on a
            phone it would strand Total alone on the far right of its own row. */}
        <div className="sm:ml-auto text-gray-300 text-sm sm:text-lg">
          Total: <strong className="text-white">{appointments.length}</strong>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 sm:px-8 py-4 sm:py-6">
        {loading ? (
          <div className="text-center text-gray-400 text-lg sm:text-2xl py-24">Loading queue...</div>
        ) : appointments.length === 0 ? (
          <div className="text-center text-gray-400 text-lg sm:text-2xl py-24">No appointments scheduled for today.</div>
        ) : (
          <>
          {/* Phone queue cards. The wall-display table below is min-w-[640px] by
              design, so it is hidden rather than shrunk on small screens. */}
          <div className="md:hidden space-y-3">
            {appointments.map((appt, index) => (
              <div
                key={`mob-${appt.id}`}
                className={`bg-gray-800 border border-gray-700 rounded-xl p-4 ${appt.status === 'completed' ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-lg font-bold text-gray-400 shrink-0">{index + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-semibold text-white break-words">{appt.patient_name || '—'}</div>
                    <div className="text-sm text-gray-300 break-words">Dr. {appt.doctor_name}</div>
                  </div>
                  <span className="text-base font-mono text-yellow-400 shrink-0">
                    {appt.appointment_time ? String(appt.appointment_time).slice(0, 5) : '—'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${statusBadge(appt.status)}`}>
                    {(appt.status || '').replace('_', ' ')}
                  </span>
                  {appt.status === 'confirmed' && (
                    <button
                      onClick={() => markComplete(appt.id)}
                      disabled={markingId === appt.id}
                      className="min-h-[44px] px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                    >
                      {markingId === appt.id ? 'Updating...' : 'Mark Complete'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b-2 border-gray-600">
                <th className="text-left px-4 py-4 text-gray-400 text-xl font-semibold uppercase tracking-wide w-16">Token</th>
                <th className="text-left px-4 py-4 text-gray-400 text-xl font-semibold uppercase tracking-wide">Patient Name</th>
                <th className="text-left px-4 py-4 text-gray-400 text-xl font-semibold uppercase tracking-wide">Doctor</th>
                <th className="text-left px-4 py-4 text-gray-400 text-xl font-semibold uppercase tracking-wide w-36">Time</th>
                <th className="text-left px-4 py-4 text-gray-400 text-xl font-semibold uppercase tracking-wide w-40">Status</th>
                <th className="text-left px-4 py-4 text-gray-400 text-xl font-semibold uppercase tracking-wide w-44">Action</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((appt, index) => (
                <tr
                  key={appt.id}
                  className={`border-b border-gray-700 ${appt.status === 'completed' ? 'opacity-60' : ''} hover:bg-gray-800 transition`}
                >
                  <td className="px-4 py-5 text-xl font-bold text-gray-400">{index + 1}</td>
                  <td className="px-4 py-5 text-xl font-semibold text-white">{appt.patient_name || '—'}</td>
                  <td className="px-4 py-5 text-xl text-gray-200">Dr. {appt.doctor_name}</td>
                  <td className="px-4 py-5 text-xl font-mono text-yellow-400">
                    {appt.appointment_time ? String(appt.appointment_time).slice(0, 5) : '—'}
                  </td>
                  <td className="px-4 py-5">
                    <span className={`px-3 py-1.5 rounded-full text-base font-semibold capitalize ${statusBadge(appt.status)}`}>
                      {(appt.status || '').replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-5">
                    {appt.status === 'confirmed' && (
                      <button
                        onClick={() => markComplete(appt.id)}
                        disabled={markingId === appt.id}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-base font-medium transition disabled:opacity-50"
                      >
                        {markingId === appt.id ? 'Updating...' : 'Mark Complete'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
