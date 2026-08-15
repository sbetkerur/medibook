'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { todayIST, todayISTDisplay } from '@/lib/dateIST';
import toast from 'react-hot-toast';

export default function DoctorPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [doctors, setDoctors] = useState([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState('');
  const [appointments, setAppointments] = useState([]);
  const [selectedAppt, setSelectedAppt] = useState(null);
  const [notes, setNotes] = useState('');
  const [loadingAppts, setLoadingAppts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);

  // Product timezone is IST — a device set to another timezone (e.g. a UTC
  // kiosk) must still show the IST day's schedule.
  const today = todayIST();
  const todayDisplay = todayISTDisplay();

  useEffect(() => {
    const token = localStorage.getItem('token');
    const u = localStorage.getItem('user');
    if (!token || !u) { router.push('/login'); return; }
    let parsed;
    try { parsed = JSON.parse(u); } catch { router.push('/login'); return; }
    if (!['doctor', 'admin', 'staff'].includes(parsed.role)) {
      router.push('/login');
      return;
    }
    setUser(parsed);
    fetchDoctors();
  }, []);

  const fetchDoctors = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/doctors');
      setDoctors(data.doctors || []);
    } catch {
      toast.error('Failed to load doctors');
    }
  }, []);

  const fetchAppointments = useCallback(async (doctorId) => {
    setLoadingAppts(true);
    try {
      const url = doctorId
        ? `/admin/appointments?date=${today}&limit=100&doctor_id=${doctorId}`
        : `/admin/appointments?date=${today}&limit=100`;
      const { data } = await api.get(url);
      const sorted = (data.appointments || []).sort((a, b) =>
        (a.appointment_time || '').localeCompare(b.appointment_time || '')
      );
      setAppointments(sorted);
      setSelectedAppt(null);
    } catch {
      toast.error('Failed to load appointments');
    } finally {
      setLoadingAppts(false);
    }
  }, [today]);

  useEffect(() => {
    if (doctors.length > 0) {
      fetchAppointments(selectedDoctorId || null);
    }
  }, [doctors]);

  function handleDoctorChange(e) {
    const id = e.target.value;
    setSelectedDoctorId(id);
    fetchAppointments(id || null);
  }

  // On mobile the two panels stack, so the detail view sits BELOW a list capped
  // at 45vh — tapping a patient changed content that was entirely off-screen and
  // read as "nothing happened". Bring it into view. Desktop is side-by-side and
  // already visible, so this is scoped to the stacked breakpoint.
  const detailRef = useRef(null);
  function selectAppointment(appt) {
    setSelectedAppt(appt);
    setNotes(appt.notes || '');
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      // Defer until the detail panel has rendered with the new appointment.
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  async function saveNotes() {
    if (!selectedAppt) return;
    // Capture the target id/value up front: if the receptionist selects a
    // different patient while this request is in flight, `selectedAppt` in
    // the closure below would resolve to whoever is selected when the
    // response arrives, not who the request was actually for.
    const apptId = selectedAppt.id;
    const notesToSave = notes;
    setSaving(true);
    try {
      await api.patch(`/admin/appointments/${apptId}`, { notes: notesToSave });
      setAppointments(prev =>
        prev.map(a => a.id === apptId ? { ...a, notes: notesToSave } : a)
      );
      setSelectedAppt(prev => (prev?.id === apptId ? { ...prev, notes: notesToSave } : prev));
      toast.success('Notes saved');
    } catch {
      toast.error('Failed to save notes');
    } finally {
      setSaving(false);
    }
  }

  async function markComplete() {
    if (!selectedAppt) return;
    const apptId = selectedAppt.id;
    setCompleting(true);
    try {
      await api.patch(`/admin/appointments/${apptId}`, { status: 'completed' });
      setAppointments(prev =>
        prev.map(a => a.id === apptId ? { ...a, status: 'completed' } : a)
      );
      setSelectedAppt(prev => (prev?.id === apptId ? { ...prev, status: 'completed' } : prev));
      toast.success('Appointment marked as completed');
    } catch {
      toast.error('Failed to update status');
    } finally {
      setCompleting(false);
    }
  }

  function statusBadge(status) {
    const classes = {
      confirmed: 'bg-green-100 text-green-700',
      completed: 'bg-blue-100 text-blue-700',
      no_show: 'bg-gray-100 text-gray-600',
      cancelled: 'bg-red-100 text-red-600',
    };
    return classes[status] || 'bg-gray-100 text-gray-600';
  }

  const selectedDoctor = doctors.find(d => d.id === selectedDoctorId);
  const headerName = selectedDoctor ? `Dr. ${selectedDoctor.name}` : (user?.name || 'Doctor');

  // 100vh on a mobile browser excludes the collapsing address bar, and both
  // panels below are their own scrollers — so the overflow was unreachable
  // rather than merely off-screen. Prefer 100dvh, falling back to 100vh.
  return (
    <div className="flex flex-col md:flex-row h-screen supports-[height:100dvh]:h-[100dvh] bg-gray-50">
      {/* Left Column */}
      {/* Two mobile-specific rules here, both learned from rendering this at
          360x640 rather than from reading it:

          1. The cap is only applied once an appointment is SELECTED. With
             nothing selected the pane below is an empty "Select an
             appointment" placeholder, so capping the list at 45dvh showed a
             dentist 2 of 8 appointments — the second one sliced in half —
             while 55% of the screen sat empty. Unselected, the list takes the
             height; selected, it yields so the detail is readable.
          2. dvh, not vh. The PARENT is already clamped to 100dvh (the visible
             viewport), so a child sized against the larger address-bar-collapsed
             viewport claims a bigger share than intended — on a phone losing
             ~12% to the bar, 45vh is really ~51% of what is actually visible.

          Unselected uses `flex-1 min-h-0` rather than simply dropping the cap.
          Dropping it made the pane's height content-driven, which left its
          inner `flex-1 overflow-auto` list unbounded and therefore inert — the
          8th appointment sat below the fold and was only reachable because the
          BODY happened to scroll. That works by accident: this shell is not
          `overflow-hidden` today, but dashboard's is, and the moment anyone
          matched them here those rows would become unreachable. `min-h-0` is
          the required half — a flex child will not shrink below its content
          without it, so the scroller never gets a bounded height.

          All of it collapses on desktop (`md:flex-none`, `md:shrink-0`,
          `md:max-h-none`), where the panes sit side by side full-height. */}
      <div className={`w-full md:w-96 md:shrink-0 md:flex-none md:max-h-none bg-white border-b md:border-b-0 md:border-r border-gray-200 flex flex-col ${
        selectedAppt
          ? 'shrink-0 max-h-[45vh] supports-[max-height:45dvh]:max-h-[45dvh]'
          : 'flex-1 min-h-0'
      }`}>
        <div className="p-5 border-b border-gray-100">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h1 className="text-lg font-bold text-gray-900 min-w-0 truncate">{headerName}</h1>
            {/* Bare inline text at 58x16 — the only way back out of the portal
                on a phone, so it gets a thumb-sized row. Negative margins keep
                the header's height unchanged. */}
            <a href="/dashboard" className="shrink-0 inline-flex items-center px-2 py-3 -my-2 -mr-2 sm:p-0 sm:m-0 text-xs text-blue-500 hover:underline">Dashboard</a>
          </div>
          <p className="text-sm text-gray-500">Today&apos;s Schedule — {todayDisplay}</p>

          <div className="mt-3">
            <select
              value={selectedDoctorId}
              onChange={handleDoctorChange}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Doctors</option>
              {doctors.map(d => (
                <option key={d.id} value={d.id}>Dr. {d.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loadingAppts ? (
            <div className="p-5 text-center text-gray-400">Loading...</div>
          ) : appointments.length === 0 ? (
            <div className="p-5 text-center text-gray-400">No appointments today.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {appointments.map((appt, idx) => (
                <button
                  key={appt.id}
                  onClick={() => selectAppointment(appt)}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition ${selectedAppt?.id === appt.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-gray-400 w-6">{idx + 1}.</span>
                        <span className="font-medium text-gray-900 text-sm truncate">{appt.patient_name || '—'}</span>
                      </div>
                      <div className="ml-8 mt-0.5">
                        <span className="text-xs text-gray-500">
                          {appt.appointment_time ? String(appt.appointment_time).slice(0, 5) : '—'}
                          {appt.doctor_name && ` · Dr. ${appt.doctor_name}`}
                        </span>
                      </div>
                    </div>
                    <span className={`ml-2 flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(appt.status)}`}>
                      {(appt.status || '').replace('_', ' ')}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-gray-100 text-xs text-gray-400 text-center">
          {appointments.length} appointment{appointments.length !== 1 ? 's' : ''} today
        </div>
      </div>

      {/* Right Column.
          Hidden on mobile until something is selected: with nothing chosen it
          renders only a "Select an appointment" placeholder, and on a phone
          (flex-col) it still claimed half the column — squeezing the list to
          ~133px, about 1.5 rows of 8. Desktop is unaffected: the panes sit
          side by side there and the placeholder is useful signposting. */}
      <div ref={detailRef} className={`flex-1 overflow-auto ${selectedAppt ? '' : 'hidden md:block'}`}>
        {!selectedAppt ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-400">
              <div className="text-5xl mb-4">👨‍⚕️</div>
              <p className="text-lg font-medium">Select an appointment</p>
              {/* The panels stack on mobile, so "left panel" is only true at md+. */}
              <p className="text-sm mt-1">
                <span className="md:hidden">Tap a patient above to view details</span>
                <span className="hidden md:inline">Click a patient from the left panel to view details</span>
              </p>
            </div>
          </div>
        ) : (
          <div className="p-4 sm:p-8 max-w-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
              {/* min-w-0 + break-words: a flex item defaults to min-width:auto, so
                  a long patient name would push past the panel instead of wrapping. */}
              <div className="min-w-0">
                <h2 className="text-2xl font-bold text-gray-900 break-words">{selectedAppt.patient_name || '—'}</h2>
                <p className="text-gray-500 mt-1 break-words">Booking: <span className="font-mono font-semibold text-gray-700">{selectedAppt.booking_id}</span></p>
              </div>
              <span className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-semibold capitalize ${statusBadge(selectedAppt.status)}`}>
                {(selectedAppt.status || '').replace('_', ' ')}
              </span>
            </div>

            {/* Patient Details */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Patient Details</h3>
              {/* One column below sm: at 320px a two-column split leaves ~118px per
                  cell, which a phone number or a department name overflows. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="min-w-0">
                  <span className="text-gray-500">Phone</span>
                  <p className="font-medium text-gray-900 mt-0.5 break-words">{selectedAppt.patient_phone || '—'}</p>
                </div>
                <div>
                  <span className="text-gray-500">Gender</span>
                  <p className="font-medium text-gray-900 capitalize mt-0.5">{selectedAppt.gender || '—'}</p>
                </div>
                <div>
                  <span className="text-gray-500">Date of Birth</span>
                  <p className="font-medium text-gray-900 mt-0.5">
                    {selectedAppt.date_of_birth
                      ? String(selectedAppt.date_of_birth).slice(0, 10)
                      : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Visit Count</span>
                  <p className="font-medium text-gray-900 mt-0.5">{selectedAppt.visit_count ?? '—'}</p>
                </div>
              </div>
            </div>

            {/* Appointment Details */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Appointment Details</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="min-w-0">
                  <span className="text-gray-500">Doctor</span>
                  <p className="font-medium text-gray-900 mt-0.5 break-words">Dr. {selectedAppt.doctor_name}</p>
                </div>
                <div className="min-w-0">
                  <span className="text-gray-500">Department</span>
                  <p className="font-medium text-gray-900 mt-0.5 break-words">{selectedAppt.department_name || '—'}</p>
                </div>
                <div>
                  <span className="text-gray-500">Time</span>
                  <p className="font-medium text-gray-900 mt-0.5">
                    {selectedAppt.appointment_time ? String(selectedAppt.appointment_time).slice(0, 5) : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Visit Type</span>
                  <p className="font-medium text-gray-900 capitalize mt-0.5">
                    {(selectedAppt.visit_type || 'in_person').replace('_', ' ')}
                  </p>
                </div>
                {selectedAppt.hospital_name && (
                  <div className="min-w-0">
                    <span className="text-gray-500">Hospital</span>
                    <p className="font-medium text-gray-900 mt-0.5 break-words">{selectedAppt.hospital_name}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Notes */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Clinical Notes</h3>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={5}
                placeholder="Enter clinical notes, diagnosis, prescription..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <button
                onClick={saveNotes}
                disabled={saving}
                className="mt-3 w-full sm:w-auto px-4 py-3 sm:py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Notes'}
              </button>
            </div>

            {/* Actions */}
            {selectedAppt.status === 'confirmed' && (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Actions</h3>
                <button
                  onClick={markComplete}
                  disabled={completing}
                  className="w-full sm:w-auto px-6 py-3 sm:py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition disabled:opacity-50"
                >
                  {completing ? 'Updating...' : 'Mark as Completed'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
