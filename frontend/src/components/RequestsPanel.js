'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';

/**
 * Patients the bot could not finish serving.
 *
 * An Indian practice does not turn people away because the grid is full — the
 * receptionist finds them a time. These are the patients who met a bot instead
 * of a person and would otherwise have been lost silently: a day with nothing
 * free, or someone who asked to be rung back.
 *
 * Self-fetching, like ClinicQRCard: it belongs on the landing tab but has
 * nothing to do with the stats payload, and threading it through the dashboard's
 * state would couple two unrelated things.
 */
export default function RequestsPanel() {
  const [requests, setRequests] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const fetchRequests = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/requests?status=open&limit=20');
      setRequests(data.requests || []);
    } catch {
      setRequests([]); // a failure here must not break the landing tab
    }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  async function clear(id) {
    setBusyId(id);
    try {
      await api.patch(`/admin/requests/${id}`, { status: 'handled' });
      setRequests(rs => rs.filter(r => r.id !== id));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update that request');
    } finally { setBusyId(null); }
  }

  // Nothing waiting is the normal state — an empty card every day is noise.
  if (!requests || !requests.length) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden border-l-4 border-amber-400">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-800">
          Waiting for a call
          <span className="ml-2 text-xs font-normal text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
            {requests.length}
          </span>
        </h2>
        <button onClick={fetchRequests} className="text-xs text-blue-500 hover:text-blue-700 px-2 py-2 -my-2">
          ↻
        </button>
      </div>
      <div className="divide-y divide-gray-50">
        {requests.map(r => (
          <div key={r.id} className="px-4 md:px-5 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">
                {r.patient_name || r.known_patient_name || 'New patient'}
                <span className="ml-2 text-xs font-normal text-gray-500">{r.phone}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {r.kind === 'callback' ? 'Asked to be called back' : 'Wanted a time we could not offer'}
                {r.doctor_name ? ` · Dr. ${r.doctor_name}` : ''}
                {r.department_name ? ` · ${r.department_name}` : ''}
                {r.preferred_date ? ` · wanted ${r.preferred_date}` : ''}
              </div>
              {r.note && <div className="text-xs text-gray-400 mt-0.5 truncate">{r.note}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* tel: rather than a copy button — the receptionist is holding a
                  phone and the next action is always to ring. */}
              <a href={`tel:${r.phone}`}
                className="px-3 py-2 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 transition">
                Call
              </a>
              <button onClick={() => clear(r.id)} disabled={busyId === r.id}
                className="px-3 py-2 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition">
                {busyId === r.id ? '…' : 'Done'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
