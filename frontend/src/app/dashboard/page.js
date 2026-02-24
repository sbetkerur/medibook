'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_SCHEDULE = DAYS.map((_, i) => ({
  day_of_week: i,
  is_working: i >= 1 && i <= 6,
  start_time: '09:00',
  end_time: '17:00',
  has_lunch: false,
  lunch_start_time: '13:00',
  lunch_end_time: '14:00',
}));

function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === ref.current) onClose(); }} ref={ref}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide === 'xl' ? 'max-w-4xl' : wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[90vh] flex flex-col`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-6">{children}</div>
      </div>
    </div>
  );
}

const NAV = [
  { id: 'overview', label: 'Overview', icon: '📊' },
  { id: 'appointments', label: 'Appointments', icon: '📅' },
  { id: 'doctors', label: 'Doctors', icon: '👨‍⚕️' },
  { id: 'patients', label: 'Patients', icon: '👥' },
  { id: 'analytics', label: 'Analytics', icon: '📈' },
  { id: 'test', label: 'Bot Tester', icon: '🤖' },
];

function StatCard({ label, value, icon, color = 'border-blue-500', sub }) {
  return (
    <div className={`bg-white rounded-xl p-5 border-l-4 ${color} shadow-sm`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{value ?? '—'}</p>
          {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
        </div>
        <span className="text-2xl">{icon}</span>
      </div>
    </div>
  );
}

function Badge({ status }) {
  const map = {
    confirmed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
    completed: 'bg-blue-100 text-blue-700',
    no_show: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${map[status] || 'bg-gray-100 text-gray-600'}`}>
      {status?.replace('_', ' ')}
    </span>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [patients, setPatients] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterDate, setFilterDate] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [patientSearch, setPatientSearch] = useState('');
  const [botPhone, setBotPhone] = useState('919999999999');
  const [botMessage, setBotMessage] = useState('Hi');
  const [botResponse, setBotResponse] = useState(null);
  const [botLoading, setBotLoading] = useState(false);

  // Doctor management state
  const [hospitals, setHospitals] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [showDoctorModal, setShowDoctorModal] = useState(false);
  const [editingDoctor, setEditingDoctor] = useState(null);
  const [doctorForm, setDoctorForm] = useState({
    name: '', specialization: '', qualification: '',
    hospital_id: '', department_id: '', consultation_fee: '', slot_duration_minutes: '30',
  });
  const [doctorSaving, setDoctorSaving] = useState(false);

  // Schedule state
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedulingDoctor, setSchedulingDoctor] = useState(null);
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [generatingSlots, setGeneratingSlots] = useState(false);

  // Slot viewer state
  const [showSlotsModal, setShowSlotsModal] = useState(false);
  const [slotsDoctor, setSlotsDoctor] = useState(null);
  const [slotsDate, setSlotsDate] = useState('');
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  // Inactive doctor toggle
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const u = localStorage.getItem('user');
    if (!token) { router.push('/login'); return; }
    setUser(u ? JSON.parse(u) : {});
    fetchStats();
  }, []);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/dashboard');
      setStats(data);
    } catch { toast.error('Failed to load dashboard stats'); }
    finally { setLoading(false); }
  }, []);

  const fetchAppointments = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (filterDate) params.set('date', filterDate);
      if (filterStatus) params.set('status', filterStatus);
      const { data } = await api.get(`/admin/appointments?${params}`);
      setAppointments(data.appointments || []);
    } catch { toast.error('Failed to load appointments'); }
  }, [filterDate, filterStatus]);

  const fetchDoctors = useCallback(async () => {
    try {
      const url = showInactive ? '/admin/doctors?include_inactive=true' : '/admin/doctors';
      const { data } = await api.get(url);
      setDoctors(data.doctors || []);
    } catch { toast.error('Failed to load doctors'); }
  }, [showInactive]);

  const fetchPatients = useCallback(async () => {
    try {
      const params = patientSearch ? `?search=${encodeURIComponent(patientSearch)}` : '';
      const { data } = await api.get(`/admin/patients${params}`);
      setPatients(data.patients || []);
    } catch { toast.error('Failed to load patients'); }
  }, [patientSearch]);

  const fetchAnalytics = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/analytics');
      setAnalytics(data);
    } catch { toast.error('Failed to load analytics'); }
  }, []);

  const fetchHospitals = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/hospitals');
      setHospitals(data.hospitals || []);
    } catch { /* silent */ }
  }, []);

  const fetchDepartments = useCallback(async (hospital_id) => {
    try {
      const url = hospital_id ? `/admin/departments?hospital_id=${hospital_id}` : '/admin/departments';
      const { data } = await api.get(url);
      setDepartments(data.departments || []);
    } catch { /* silent */ }
  }, []);

  function openAddDoctor() {
    setEditingDoctor(null);
    setDoctorForm({ name: '', specialization: '', qualification: '', hospital_id: '', department_id: '', consultation_fee: '', slot_duration_minutes: '30' });
    fetchHospitals();
    setShowDoctorModal(true);
  }

  function openEditDoctor(doc) {
    setEditingDoctor(doc);
    setDoctorForm({
      name: doc.name || '',
      specialization: doc.specialization || '',
      qualification: doc.qualification || '',
      hospital_id: doc.hospital_id || '',
      department_id: doc.department_id || '',
      consultation_fee: doc.consultation_fee ?? '',
      slot_duration_minutes: doc.slot_duration_minutes ?? '30',
    });
    fetchHospitals();
    if (doc.hospital_id) fetchDepartments(doc.hospital_id);
    setShowDoctorModal(true);
  }

  async function saveDoctor(e) {
    e.preventDefault();
    if (!doctorForm.name.trim()) return toast.error('Doctor name is required');
    if (!doctorForm.hospital_id) return toast.error('Please select a hospital');
    setDoctorSaving(true);
    try {
      const payload = {
        ...doctorForm,
        consultation_fee: Number(doctorForm.consultation_fee) || 0,
        slot_duration_minutes: Number(doctorForm.slot_duration_minutes) || 30,
        department_id: doctorForm.department_id || null,
      };
      if (editingDoctor) {
        await api.patch(`/admin/doctors/${editingDoctor.id}`, payload);
        toast.success('Doctor updated successfully');
      } else {
        await api.post('/admin/doctors', payload);
        toast.success('Doctor added successfully');
      }
      setShowDoctorModal(false);
      fetchDoctors();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save doctor');
    } finally { setDoctorSaving(false); }
  }

  async function openSchedule(doc) {
    setSchedulingDoctor(doc);
    setSchedule(DEFAULT_SCHEDULE.map(d => ({ ...d })));
    try {
      const { data } = await api.get(`/admin/doctors/${doc.id}/schedule`);
      if (data.schedule?.length) {
        setSchedule(DEFAULT_SCHEDULE.map(def => {
          const saved = data.schedule.find(s => s.day_of_week === def.day_of_week);
          if (!saved) return def;
          return {
            day_of_week: def.day_of_week,
            is_working: saved.is_working,
            start_time: saved.start_time?.slice(0, 5) || def.start_time,
            end_time: saved.end_time?.slice(0, 5) || def.end_time,
            has_lunch: !!(saved.lunch_start_time && saved.lunch_end_time),
            lunch_start_time: saved.lunch_start_time?.slice(0, 5) || '13:00',
            lunch_end_time: saved.lunch_end_time?.slice(0, 5) || '14:00',
          };
        }));
      }
    } catch { /* use defaults */ }
    setShowScheduleModal(true);
  }

  async function saveSchedule() {
    setScheduleSaving(true);
    try {
      const schedules = schedule.map(d => ({
        day_of_week: d.day_of_week,
        is_working: d.is_working,
        start_time: d.start_time,
        end_time: d.end_time,
        lunch_start_time: d.is_working && d.has_lunch ? d.lunch_start_time : null,
        lunch_end_time:   d.is_working && d.has_lunch ? d.lunch_end_time   : null,
      }));
      await api.post(`/admin/doctors/${schedulingDoctor.id}/schedule`, { schedules });
      toast.success('Schedule saved');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save schedule');
      setScheduleSaving(false);
      return;
    }
    setScheduleSaving(false);
  }

  async function generateSlots() {
    setGeneratingSlots(true);
    try {
      const { data } = await api.post('/admin/slots/generate', { doctor_id: schedulingDoctor.id, days: 7 });
      toast.success(`${data.generated} slots generated for 7 days`);
      fetchDoctors();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate slots');
    } finally { setGeneratingSlots(false); }
  }

  function updateScheduleDay(index, field, value) {
    setSchedule(prev => prev.map((d, i) => i === index ? { ...d, [field]: value } : d));
  }

  async function openSlotsViewer(doc) {
    setSlotsDoctor(doc);
    const today = format(new Date(), 'yyyy-MM-dd');
    setSlotsDate(today);
    setSlots([]);
    setShowSlotsModal(true);
    setSlotsLoading(true);
    try {
      const { data } = await api.get(`/admin/slots?doctor_id=${doc.id}&date=${today}`);
      setSlots(data.slots || []);
    } catch { toast.error('Failed to load slots'); }
    finally { setSlotsLoading(false); }
  }

  async function fetchSlots(docId, date) {
    if (!docId || !date) return;
    setSlotsLoading(true);
    try {
      const { data } = await api.get(`/admin/slots?doctor_id=${docId}&date=${date}`);
      setSlots(data.slots || []);
    } catch { toast.error('Failed to load slots'); }
    finally { setSlotsLoading(false); }
  }

  async function toggleSlotStatus(slot) {
    const newStatus = slot.status === 'available' ? 'blocked' : 'available';
    try {
      await api.patch(`/admin/slots/${slot.id}`, { status: newStatus });
      setSlots(prev => prev.map(s => s.id === slot.id ? { ...s, status: newStatus } : s));
      toast.success(`Slot ${newStatus === 'blocked' ? 'blocked' : 'unblocked'}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update slot');
    }
  }

  async function toggleDoctorStatus(doc) {
    const isDeactivating = doc.is_active;
    if (!window.confirm(
      isDeactivating
        ? `Deactivate Dr. ${doc.name}? They will no longer appear in the booking bot.`
        : `Reactivate Dr. ${doc.name}?`
    )) return;
    try {
      await api.patch(`/admin/doctors/${doc.id}`, { is_active: !doc.is_active });
      toast.success(`Dr. ${doc.name} ${isDeactivating ? 'deactivated' : 'reactivated'}`);
      fetchDoctors();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update doctor status');
    }
  }

  useEffect(() => {
    if (tab === 'appointments') fetchAppointments();
    if (tab === 'doctors') fetchDoctors();
    if (tab === 'patients') fetchPatients();
    if (tab === 'analytics') fetchAnalytics();
  }, [tab]);

  useEffect(() => {
    if (tab === 'appointments') fetchAppointments();
  }, [filterDate, filterStatus]);

  useEffect(() => {
    if (tab === 'doctors') fetchDoctors();
  }, [showInactive]);

  useEffect(() => {
    if (tab === 'patients') {
      const t = setTimeout(fetchPatients, 400);
      return () => clearTimeout(t);
    }
  }, [patientSearch]);

  async function exportCSV() {
    if (!appointments.length) { toast.error('No data to export'); return; }
    const h = ['Booking ID', 'Patient', 'Phone', 'Doctor', 'Department', 'Date', 'Time', 'Type', 'Status'];
    const rows = appointments.map(a => [
      a.booking_id, a.patient_name, a.patient_phone,
      `Dr. ${a.doctor_name}`, a.department_name || '',
      a.appointment_date, a.appointment_time?.slice(0, 5),
      a.visit_type || 'in_person', a.status
    ]);
    const csv = [h, ...rows].map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `appointments_${format(new Date(), 'yyyyMMdd')}.csv`;
    link.click();
    toast.success('CSV exported!');
  }

  async function testBot() {
    setBotLoading(true);
    setBotResponse(null);
    try {
      const { data } = await api.post('/webhook/test', { phone: botPhone, message: botMessage });
      setBotResponse(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bot test failed');
    } finally { setBotLoading(false); }
  }

  function logout() {
    localStorage.clear();
    router.push('/login');
  }

  return (
    <>
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-5 border-b border-gray-100">
          <div className="text-xl font-bold text-blue-600">🏥 MediBook</div>
          <div className="text-xs text-gray-400 mt-1 truncate">{user?.tenant || 'Admin Portal'}</div>
        </div>
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map(item => (
            <button key={item.id} onClick={() => setTab(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                tab === item.id ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'
              }`}>
              <span className="text-base">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-100">
          <div className="px-3 py-2 text-xs text-gray-400 truncate">{user?.email}</div>
          <button onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-500 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors">
            <span>🚪</span> Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0">
          <h1 className="text-lg font-semibold text-gray-900">
            {NAV.find(n => n.id === tab)?.icon} {NAV.find(n => n.id === tab)?.label}
          </h1>
          <div className="flex items-center gap-3">
            {tab === 'appointments' && (
              <button onClick={exportCSV}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">
                📥 Export CSV
              </button>
            )}
            <button onClick={fetchStats}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">
              🔄 Refresh
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">

          {/* ── OVERVIEW ── */}
          {tab === 'overview' && (
            <div className="space-y-6">
              {loading ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[1,2,3,4].map(i => (
                    <div key={i} className="bg-white rounded-xl p-5 h-24 animate-pulse bg-gray-100" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard label="Today" value={stats?.today_appointments} icon="📅" color="border-blue-500" />
                  <StatCard label="Upcoming" value={stats?.upcoming_appointments} icon="🗓" color="border-green-500" />
                  <StatCard label="Patients" value={stats?.total_patients} icon="👥" color="border-purple-500" />
                  <StatCard label="Open Slots" value={stats?.available_slots} icon="⏰" color="border-orange-500" />
                </div>
              )}

              {/* Today's schedule */}
              {stats?.todays_schedule?.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100">
                    <h2 className="font-semibold text-gray-800">Today's Schedule</h2>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {stats.todays_schedule.map((a, i) => (
                      <div key={i} className="px-5 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="text-sm font-medium text-blue-600 w-12">{a.appointment_time?.slice(0,5)}</div>
                          <div>
                            <div className="text-sm font-medium text-gray-900">{a.patient_name}</div>
                            <div className="text-xs text-gray-500">Dr. {a.doctor_name}</div>
                          </div>
                        </div>
                        <Badge status={a.status} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="font-semibold text-gray-800 mb-3">Quick Actions</h3>
                <div className="flex flex-wrap gap-3">
                  <button onClick={() => setTab('appointments')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition">View All Appointments</button>
                  <button onClick={() => setTab('doctors')} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition">Manage Doctors</button>
                  <button onClick={() => setTab('test')} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition">Test WhatsApp Bot</button>
                  <button onClick={() => { setTab('appointments'); setTimeout(exportCSV, 500); }} className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">Export CSV</button>
                </div>
              </div>
            </div>
          )}

          {/* ── APPOINTMENTS ── */}
          {tab === 'appointments' && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3 items-center">
                <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">All Status</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="no_show">No Show</option>
                </select>
                {(filterDate || filterStatus) && (
                  <button onClick={() => { setFilterDate(''); setFilterStatus(''); }}
                    className="text-sm text-blue-600 hover:underline">Clear filters</button>
                )}
                <span className="text-sm text-gray-400 ml-auto">{appointments.length} records</span>
              </div>

              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        {['Booking ID', 'Patient', 'Doctor', 'Date', 'Time', 'Type', 'Status'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {appointments.map(a => (
                        <tr key={a.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs font-medium text-blue-600">{a.booking_id}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900 text-sm">{a.patient_name}</div>
                            <a href={`https://wa.me/${a.patient_phone}`} target="_blank" rel="noreferrer"
                              className="text-xs text-green-600 hover:underline">{a.patient_phone}</a>
                          </td>
                          <td className="px-4 py-3 text-gray-700 text-sm">Dr. {a.doctor_name}</td>
                          <td className="px-4 py-3 text-gray-600 text-sm">
                            {(() => { try { return format(parseISO(a.appointment_date), 'd MMM yy'); } catch { return a.appointment_date; } })()}
                          </td>
                          <td className="px-4 py-3 text-gray-600 text-sm">{a.appointment_time?.slice(0, 5)}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 capitalize">{a.visit_type?.replace('_', ' ')}</td>
                          <td className="px-4 py-3"><Badge status={a.status} /></td>
                        </tr>
                      ))}
                      {!appointments.length && (
                        <tr>
                          <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                            No appointments found{filterDate || filterStatus ? ' for selected filters' : ''}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── DOCTORS ── */}
          {tab === 'doctors' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <p className="text-sm text-gray-500">{doctors.length} doctor{doctors.length !== 1 ? 's' : ''}</p>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" checked={showInactive}
                        onChange={e => setShowInactive(e.target.checked)} />
                      <div className={`w-8 h-4 rounded-full transition-colors ${showInactive ? 'bg-blue-500' : 'bg-gray-300'}`} />
                      <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${showInactive ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-sm text-gray-500">Show inactive</span>
                  </label>
                </div>
                <button onClick={openAddDoctor}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
                  + Add Doctor
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {doctors.map(d => (
                  <div key={d.id} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 hover:border-blue-200 transition flex flex-col">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-xl shrink-0">👨‍⚕️</div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">Dr. {d.name}</h3>
                        <p className="text-sm text-blue-600 truncate">{d.specialization}</p>
                        <p className="text-xs text-gray-400 truncate">{d.qualification}</p>
                        <p className="text-xs text-gray-500 mt-1 truncate">🏥 {d.hospital_name}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-sm">
                      <span className="text-green-600 font-medium">{d.consultation_fee > 0 ? `₹${d.consultation_fee}` : 'Free'}</span>
                      <div className="text-right text-xs text-gray-500">
                        <div>{d.total_appointments} appts</div>
                        <div>{d.available_slots} open slots</div>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-gray-400">{d.slot_duration_minutes}min slots · {d.department_name || 'No dept'}</div>
                    {!d.is_active && (
                      <p className="mt-2 text-xs text-red-400 font-medium">⚠️ Inactive — hidden from bot</p>
                    )}
                    <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
                      <button onClick={() => openEditDoctor(d)}
                        className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition">
                        ✏️ Edit
                      </button>
                      <button onClick={() => openSchedule(d)}
                        className="px-3 py-1.5 text-xs font-medium border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 transition">
                        📅 Schedule
                      </button>
                      <button onClick={() => openSlotsViewer(d)}
                        className="px-3 py-1.5 text-xs font-medium border border-green-200 text-green-600 rounded-lg hover:bg-green-50 transition">
                        ⏰ View Slots
                      </button>
                      <button onClick={() => toggleDoctorStatus(d)}
                        className={`px-3 py-1.5 text-xs font-medium border rounded-lg transition ${d.is_active ? 'border-red-200 text-red-500 hover:bg-red-50' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                        {d.is_active ? '🚫 Deactivate' : '✅ Activate'}
                      </button>
                    </div>
                  </div>
                ))}
                {!doctors.length && (
                  <div className="col-span-3 text-center py-16">
                    <div className="text-4xl mb-3">👨‍⚕️</div>
                    <p className="text-gray-500 font-medium">No doctors yet</p>
                    <p className="text-gray-400 text-sm mt-1">Click "Add Doctor" to get started</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── PATIENTS ── */}
          {tab === 'patients' && (
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Search by name, phone or email..."
                value={patientSearch}
                onChange={e => setPatientSearch(e.target.value)}
                className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Name', 'Phone', 'Gender', 'DOB', 'Visits', 'Since'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {patients.map(p => (
                      <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-900">{p.name || '—'}</td>
                        <td className="px-4 py-3">
                          <a href={`https://wa.me/${p.phone}`} target="_blank" rel="noreferrer"
                            className="text-green-600 hover:underline">+{p.phone}</a>
                        </td>
                        <td className="px-4 py-3 capitalize text-gray-600">{p.gender || '—'}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs">
                          {p.date_of_birth ? format(parseISO(p.date_of_birth), 'd MMM yyyy') : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{p.visit_count}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {p.created_at ? format(parseISO(p.created_at), 'd MMM yyyy') : '—'}
                        </td>
                      </tr>
                    ))}
                    {!patients.length && (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No patients found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── ANALYTICS ── */}
          {tab === 'analytics' && (
            <div className="space-y-4">
              {analytics ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* By Status */}
                    <div className="bg-white rounded-xl p-5 shadow-sm">
                      <h3 className="font-semibold text-gray-800 mb-4">Appointments by Status (30 days)</h3>
                      <div className="space-y-3">
                        {analytics.by_status?.map(s => {
                          const colors = { confirmed:'bg-green-500', cancelled:'bg-red-400', completed:'bg-blue-500', no_show:'bg-gray-400' };
                          const total = analytics.by_status.reduce((sum, x) => sum + parseInt(x.count), 0);
                          const pct = total ? Math.round(parseInt(s.count) / total * 100) : 0;
                          return (
                            <div key={s.status}>
                              <div className="flex justify-between text-sm mb-1">
                                <span className="capitalize text-gray-700">{s.status?.replace('_',' ')}</span>
                                <span className="font-medium">{s.count} ({pct}%)</span>
                              </div>
                              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full ${colors[s.status] || 'bg-gray-400'} rounded-full`} style={{ width: pct + '%' }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* By Doctor */}
                    <div className="bg-white rounded-xl p-5 shadow-sm">
                      <h3 className="font-semibold text-gray-800 mb-4">Top Doctors (30 days)</h3>
                      <div className="space-y-3">
                        {analytics.by_doctor?.slice(0, 6).map((d, i) => (
                          <div key={i} className="flex justify-between items-center text-sm">
                            <span className="text-gray-700 truncate">Dr. {d.name}</span>
                            <div className="text-right ml-3">
                              <span className="font-semibold text-gray-900">{d.count}</span>
                              {d.revenue && <span className="text-xs text-green-600 ml-2">₹{d.revenue}</span>}
                            </div>
                          </div>
                        ))}
                        {!analytics.by_doctor?.length && <p className="text-gray-400 text-sm">No data yet</p>}
                      </div>
                    </div>
                  </div>
                  {/* Daily trend */}
                  <div className="bg-white rounded-xl p-5 shadow-sm">
                    <h3 className="font-semibold text-gray-800 mb-4">Daily Appointments (30 days)</h3>
                    <div className="flex items-end gap-1 h-24">
                      {analytics.by_day?.map((d, i) => {
                        const max = Math.max(...analytics.by_day.map(x => parseInt(x.count)));
                        const h = max > 0 ? Math.max(4, (parseInt(d.count) / max) * 96) : 4;
                        return (
                          <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: ${d.count}`}>
                            <div className="w-full bg-blue-500 rounded-sm" style={{ height: h + '%' }} />
                          </div>
                        );
                      })}
                      {!analytics.by_day?.length && <p className="text-gray-400 text-sm">No data yet</p>}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center text-gray-400 py-12">Loading analytics...</div>
              )}
            </div>
          )}

          {/* ── BOT TESTER ── */}
          {tab === 'test' && (
            <div className="max-w-2xl space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
                <strong>🤖 WhatsApp Bot Tester</strong><br/>
                Test the bot without a real WhatsApp connection. Messages are intercepted locally.
              </div>

              <div className="bg-white rounded-xl p-5 shadow-sm space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                  <input value={botPhone} onChange={e => setBotPhone(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="919999999999" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
                  <input value={botMessage} onChange={e => setBotMessage(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && testBot()}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Hi" />
                </div>
                <div className="flex gap-2">
                  <button onClick={testBot} disabled={botLoading}
                    className="px-5 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
                    {botLoading ? 'Sending...' : '📨 Send Message'}
                  </button>
                  <div className="flex gap-2 flex-wrap">
                    {['Hi', 'Book', 'My Appointments', 'Status'].map(m => (
                      <button key={m} onClick={() => { setBotMessage(m); }}
                        className="px-3 py-2 border border-gray-200 text-gray-600 rounded-lg text-xs hover:bg-gray-50 transition">
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {botResponse && (
                <div className="bg-white rounded-xl p-5 shadow-sm">
                  <h3 className="font-semibold text-gray-800 mb-3">
                    Bot Response ({botResponse.responses?.length || 0} messages)
                  </h3>
                  <div className="space-y-3">
                    {botResponse.responses?.map((r, i) => (
                      <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                        <div className="text-xs font-medium text-gray-400 uppercase mb-2">{r.type}</div>
                        <div className="text-sm text-gray-800 whitespace-pre-wrap">{r.text}</div>
                        {r.buttons && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {r.buttons.map((b, bi) => (
                              <button key={bi} onClick={() => { setBotMessage(String(b)); }}
                                className="px-3 py-1 bg-blue-600 text-white text-xs rounded-full hover:bg-blue-700 transition">
                                {b}
                              </button>
                            ))}
                          </div>
                        )}
                        {r.sections && r.sections.map((s, si) => (
                          <div key={si} className="mt-2">
                            <div className="text-xs font-medium text-gray-500 mb-1">{s.title}</div>
                            <div className="flex flex-wrap gap-1">
                              {s.rows?.map((row, ri) => (
                                <button key={ri} onClick={() => setBotMessage(row.id || row.title)}
                                  className="px-2 py-1 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300 transition">
                                  {row.title}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                    {!botResponse.responses?.length && (
                      <p className="text-gray-400 text-sm">No response from bot (check backend logs)</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
    {/* ── ADD / EDIT DOCTOR MODAL ── */}
    {showDoctorModal && (
      <Modal title={editingDoctor ? `Edit Dr. ${editingDoctor.name}` : 'Add New Doctor'} onClose={() => setShowDoctorModal(false)}>
        <p className="text-xs text-gray-400 -mt-1 mb-1">Fields marked <span className="text-red-400">*</span> are required. All others are optional.</p>
        <form onSubmit={saveDoctor} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Full Name <span className="text-red-400">*</span>
              </label>
              <input value={doctorForm.name} onChange={e => setDoctorForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Priya Sharma"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Specialization <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input value={doctorForm.specialization} onChange={e => setDoctorForm(f => ({ ...f, specialization: e.target.value }))}
                placeholder="e.g. Cardiologist"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Qualification <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input value={doctorForm.qualification} onChange={e => setDoctorForm(f => ({ ...f, qualification: e.target.value }))}
                placeholder="e.g. MBBS, MD"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Hospital <span className="text-red-400">*</span>
              </label>
              <select value={doctorForm.hospital_id}
                onChange={e => {
                  const hid = e.target.value;
                  setDoctorForm(f => ({ ...f, hospital_id: hid, department_id: '' }));
                  if (hid) fetchDepartments(hid);
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required>
                <option value="">Select hospital...</option>
                {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Department <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <select value={doctorForm.department_id}
                onChange={e => setDoctorForm(f => ({ ...f, department_id: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={!doctorForm.hospital_id}>
                <option value="">— None —</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Consultation Fee (₹) <span className="text-gray-400 font-normal">(optional, default 0)</span>
              </label>
              <input type="number" min="0" value={doctorForm.consultation_fee}
                onChange={e => setDoctorForm(f => ({ ...f, consultation_fee: e.target.value }))}
                placeholder="Leave blank for free / 0"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Slot Duration</label>
              <select value={doctorForm.slot_duration_minutes}
                onChange={e => setDoctorForm(f => ({ ...f, slot_duration_minutes: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {[10, 15, 20, 30, 45, 60].map(m => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowDoctorModal(false)}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={doctorSaving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
              {doctorSaving ? 'Saving...' : editingDoctor ? 'Update Doctor' : 'Add Doctor'}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* ── SLOT VIEWER MODAL ── */}
    {showSlotsModal && slotsDoctor && (
      <Modal title={`Slots — Dr. ${slotsDoctor.name}`} onClose={() => setShowSlotsModal(false)} wide>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700">Date</label>
            <input type="date" value={slotsDate}
              onChange={e => { setSlotsDate(e.target.value); fetchSlots(slotsDoctor.id, e.target.value); }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {slotsLoading ? (
            <div className="text-center text-gray-400 py-10">Loading slots...</div>
          ) : slots.length ? (
            <>
              <p className="text-xs text-gray-500">
                Click <span className="text-green-600 font-medium">available</span> to block.
                Click <span className="text-orange-500 font-medium">blocked</span> to unblock.
                <span className="text-blue-600 font-medium"> Booked</span> slots cannot be changed.
              </p>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {slots.map(slot => {
                  const style = {
                    available: 'bg-green-100 text-green-700 border-green-200 hover:bg-green-200 cursor-pointer',
                    booked:    'bg-blue-100 text-blue-700 border-blue-200 cursor-not-allowed opacity-70',
                    blocked:   'bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-200 cursor-pointer',
                    expired:   'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-50',
                  };
                  const clickable = slot.status === 'available' || slot.status === 'blocked';
                  return (
                    <button key={slot.id}
                      onClick={() => clickable && toggleSlotStatus(slot)}
                      className={`border rounded-lg px-2 py-2 text-xs font-medium text-center transition ${style[slot.status] || style.expired}`}>
                      <div>{slot.start_time?.slice(0, 5)}</div>
                      <div className="opacity-70 capitalize mt-0.5">{slot.status}</div>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-3 text-xs pt-1">
                {[
                  ['bg-green-100 text-green-700', 'Available'],
                  ['bg-blue-100 text-blue-700',   'Booked'],
                  ['bg-orange-100 text-orange-700','Blocked'],
                  ['bg-gray-100 text-gray-400',   'Expired'],
                ].map(([c, l]) => (
                  <span key={l} className={`px-2 py-1 rounded ${c}`}>{l}</span>
                ))}
              </div>
            </>
          ) : (
            <div className="text-center text-gray-400 py-10">
              <div className="text-3xl mb-2">📭</div>
              <p className="font-medium text-gray-500">No slots for this date</p>
              <p className="text-sm mt-1">Use the <strong>Schedule</strong> button on the doctor card to set working hours and generate slots.</p>
            </div>
          )}
        </div>
      </Modal>
    )}

    {/* ── SCHEDULE MODAL ── */}
    {showScheduleModal && schedulingDoctor && (
      <Modal title={`Schedule — Dr. ${schedulingDoctor.name}`} onClose={() => setShowScheduleModal(false)} wide="xl">
        <div className="space-y-2 mb-6">
          <p className="text-xs text-gray-500 mb-3">
            Set working hours for each day. Toggle <strong>Lunch</strong> to block a break window — no slots will be generated during that time. After saving, click <strong>Save &amp; Generate Slots</strong> to create bookable slots for the next 7 days.
          </p>
          {/* Header row */}
          <div className="hidden sm:grid grid-cols-[90px_60px_1fr_1fr_70px_1fr_1fr] gap-2 px-2 text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
            <span>Day</span><span>On</span><span>Start</span><span>End</span><span>Lunch</span><span>Break Start</span><span>Break End</span>
          </div>
          {schedule.map((day, i) => (
            <div key={day.day_of_week}
              className={`grid grid-cols-[90px_60px_1fr_1fr_70px_1fr_1fr] gap-2 items-center px-2 py-2 rounded-lg transition-colors ${day.is_working ? 'bg-blue-50' : 'bg-gray-50'}`}>
              {/* Day name */}
              <span className="text-sm font-medium text-gray-700">{DAYS[day.day_of_week]}</span>

              {/* Working toggle */}
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input type="checkbox" className="sr-only"
                    checked={day.is_working}
                    onChange={e => updateScheduleDay(i, 'is_working', e.target.checked)} />
                  <div className={`w-9 h-5 rounded-full transition-colors ${day.is_working ? 'bg-blue-500' : 'bg-gray-300'}`} />
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.is_working ? 'translate-x-4' : ''}`} />
                </div>
              </label>

              {/* Start / End times */}
              <input type="time" value={day.start_time}
                disabled={!day.is_working}
                onChange={e => updateScheduleDay(i, 'start_time', e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-30 disabled:bg-gray-100 w-full" />
              <input type="time" value={day.end_time}
                disabled={!day.is_working}
                onChange={e => updateScheduleDay(i, 'end_time', e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-30 disabled:bg-gray-100 w-full" />

              {/* Lunch toggle */}
              <label className={`flex items-center gap-1 cursor-pointer ${!day.is_working ? 'opacity-30 pointer-events-none' : ''}`}>
                <div className="relative">
                  <input type="checkbox" className="sr-only"
                    checked={day.has_lunch}
                    disabled={!day.is_working}
                    onChange={e => updateScheduleDay(i, 'has_lunch', e.target.checked)} />
                  <div className={`w-9 h-5 rounded-full transition-colors ${day.has_lunch && day.is_working ? 'bg-orange-400' : 'bg-gray-300'}`} />
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.has_lunch && day.is_working ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-gray-500">🍽</span>
              </label>

              {/* Lunch start / end */}
              <input type="time" value={day.lunch_start_time}
                disabled={!day.is_working || !day.has_lunch}
                onChange={e => updateScheduleDay(i, 'lunch_start_time', e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-30 disabled:bg-gray-100 w-full" />
              <input type="time" value={day.lunch_end_time}
                disabled={!day.is_working || !day.has_lunch}
                onChange={e => updateScheduleDay(i, 'lunch_end_time', e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-30 disabled:bg-gray-100 w-full" />
            </div>
          ))}
        </div>
        <div className="border-t border-gray-100 pt-4 flex flex-col sm:flex-row gap-3">
          <button onClick={() => setShowScheduleModal(false)}
            className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
            Close
          </button>
          <button onClick={saveSchedule} disabled={scheduleSaving}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
            {scheduleSaving ? 'Saving...' : '💾 Save Schedule'}
          </button>
          <button onClick={async () => { await saveSchedule(); await generateSlots(); }}
            disabled={scheduleSaving || generatingSlots}
            className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
            {generatingSlots ? 'Generating...' : '⚡ Save & Generate Slots'}
          </button>
        </div>
      </Modal>
    )}
    </>
  );
}
