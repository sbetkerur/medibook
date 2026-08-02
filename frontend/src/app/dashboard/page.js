'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import api, { clearSessionTimers, resetSessionTimers } from '@/lib/api';
import { todayIST } from '@/lib/dateIST';
import ErrorBoundary from '@/components/ErrorBoundary';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';
import Modal from '@/components/ui/Modal';
import ConfirmModal from '@/components/ui/ConfirmModal';
import Badge from '@/components/ui/Badge';
import OverviewTab from '@/components/tabs/OverviewTab';
import AppointmentsTab from '@/components/tabs/AppointmentsTab';
import SlotsTab from '@/components/tabs/SlotsTab';
import DoctorsTab from '@/components/tabs/DoctorsTab';
import PatientsTab from '@/components/tabs/PatientsTab';
import HospitalsTab from '@/components/tabs/HospitalsTab';
import FeedbackTab from '@/components/tabs/FeedbackTab';
import AnalyticsTab from '@/components/tabs/AnalyticsTab';
import ServicesTab from '@/components/tabs/ServicesTab';
import HolidaysTab from '@/components/tabs/HolidaysTab';
import StaffTab from '@/components/tabs/StaffTab';
import SettingsTab from '@/components/tabs/SettingsTab';
import CalendarTab from '@/components/tabs/CalendarTab';
import LeavesTab from '@/components/tabs/LeavesTab';
import AuditTab from '@/components/tabs/AuditTab';
import TestBotTab from '@/components/tabs/TestBotTab';

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

// Modal, ConfirmModal imported from @/components/ui

const NAV = [
  { id: 'overview', label: 'Overview', icon: '📊' },
  { id: 'appointments', label: 'Appointments', icon: '📅' },
  { id: 'doctors', label: 'Dentists', icon: '🦷' },
  { id: 'hospitals', label: 'Clinics', icon: '🏥' },
  { id: 'patients', label: 'Patients', icon: '👥' },
  { id: 'feedback', label: 'Feedback', icon: '⭐' },
  { id: 'analytics', label: 'Analytics', icon: '📈' },
  { id: 'calendar', label: 'Calendar', icon: '📆' },
  { id: 'slots', label: 'Slots', icon: '🕐' },
  { id: 'staff', label: 'Staff', icon: '👤' },
  { id: 'leaves', label: 'Dentist Leaves', icon: '🏖️' },
  { id: 'services', label: 'Services', icon: '💊' },
  { id: 'holidays', label: 'Holidays', icon: '🗓️' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'test', label: 'Bot Tester', icon: '🤖' },
  { id: 'audit', label: 'Audit Logs', icon: '📋' },
];

// StatCard, Badge, SlotsTab imported from @/components/ui and @/components/tabs

// Builds a wa.me deep link from a stored phone number. Numbers are stored
// inconsistently (with/without a leading '+', occasional spaces/dashes from
// CSV imports) — wa.me only accepts digits, so strip everything else once
// here instead of re-deriving it at every call site.
function waLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}`;
}

export default function Dashboard() {
  const router = useRouter();
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [patients, setPatients] = useState([]);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [statsLastUpdated, setStatsLastUpdated] = useState(null);
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filterDate, setFilterDate] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [patientSearch, setPatientSearch] = useState('');

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

  // Hospital & department management state
  const [showHospitalModal, setShowHospitalModal] = useState(false);
  const [hospitalForm, setHospitalForm] = useState({ name: '', address: '', city: '', phone: '' });
  const [hospitalSaving, setHospitalSaving] = useState(false);
  const [showDeptModal, setShowDeptModal] = useState(false);
  const [deptHospital, setDeptHospital] = useState(null);
  const [deptForm, setDeptForm] = useState({ name: '', description: '' });
  const [deptSaving, setDeptSaving] = useState(false);
  const [deptsByHospital, setDeptsByHospital] = useState({});

  // Pagination state
  const [apptPage, setApptPage] = useState(1);
  const [patientPage, setPatientPage] = useState(1);
  const [apptHasMore, setApptHasMore] = useState(false);
  const [patientHasMore, setPatientHasMore] = useState(false);

  // Patient history modal state
  const [showPatientHistory, setShowPatientHistory] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientHistory, setPatientHistory] = useState([]);
  const [patientHistoryLoading, setPatientHistoryLoading] = useState(false);

  // Patient documents state (Enhancement 6)
  const [patientDocuments, setPatientDocuments] = useState([]);
  const [docUploading, setDocUploading] = useState(false);

  // Settings state (`settings` is shared with DoctorsTab; the editable form
  // and save state live inside SettingsTab)
  const [settings, setSettings] = useState(null);

  // Notifications state
  const [notifications, setNotifications] = useState([]);
  const [notifCount, setNotifCount] = useState(0);
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);
  // Keys (appointment id + booking_id) of notifications already shown, so SSE
  // and the 30s poll never double-insert or re-count the same booking.
  const notifSeenKeys = useRef(new Set());
  // Companion insertion-order array so the Set above can be capped cheaply —
  // a reception desk left open all day would otherwise grow this without
  // bound. When it exceeds NOTIF_SEEN_CAP, the oldest keys are evicted.
  const notifSeenOrder = useRef([]);
  const NOTIF_SEEN_CAP = 500;
  const addSeenKey = (key) => {
    if (!key || notifSeenKeys.current.has(key)) return;
    notifSeenKeys.current.add(key);
    notifSeenOrder.current.push(key);
    if (notifSeenOrder.current.length > NOTIF_SEEN_CAP) {
      const evicted = notifSeenOrder.current.splice(0, notifSeenOrder.current.length - NOTIF_SEEN_CAP);
      evicted.forEach(k => notifSeenKeys.current.delete(k));
    }
  };

  // Analytics summary state
  const [analyticsSummary, setAnalyticsSummary] = useState(null);

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState(null); // {title, message, onConfirm, danger}

  // Onboarding state
  const [onboarding, setOnboarding] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Medical history edit state
  const [medHistory, setMedHistory] = useState({ blood_type: '', allergies: '', conditions: '', medications: '', notes: '' });
  // True when the medical-history fetch failed, so the UI can say "unavailable"
  // rather than render empty fields as "Not recorded".
  const [medHistoryFailed, setMedHistoryFailed] = useState(false);
  const [medHistoryEditing, setMedHistoryEditing] = useState(false);
  const [medHistorySaving, setMedHistorySaving] = useState(false);

  // Hospital edit state
  const [editingHospital, setEditingHospital] = useState(null);

  // Department edit state
  const [editingDept, setEditingDept] = useState(null);

  // Patient edit state
  const [showPatientEditModal, setShowPatientEditModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);
  const [patientEditForm, setPatientEditForm] = useState({ name: '', email: '', gender: '', date_of_birth: '' });
  const [patientEditSaving, setPatientEditSaving] = useState(false);
  const [importingPatients, setImportingPatients] = useState(false);
  const [importingDoctors, setImportingDoctors] = useState(false);

  // Cancel appointment state
  const [cancellingAppt, setCancellingAppt] = useState(null); // appointment object
  const [cancelReason, setCancelReason] = useState('');
  // Bulk cancellation reuses the same reason prompt — the backend requires a
  // reason for bulk cancels too, and the bulk path never collected one.
  const [bulkCancelling, setBulkCancelling] = useState(false);
  const [apptTotal, setApptTotal] = useState(0);
  const [patientTotal, setPatientTotal] = useState(0);

  // Walk-in appointment state
  const [showWalkinModal, setShowWalkinModal] = useState(false);
  // Available slots for the walk-in modal. Without a slot_id the backend does
  // not lock anything (routes/appointments.js only locks `if (slot_id)`), so a
  // walk-in booked at 10:30 left that slot 'available' and the WhatsApp bot
  // happily offered the same 10:30 to a patient — two bookings, one chair.
  const [walkinSlots, setWalkinSlots] = useState([]);
  const [walkinSlotsLoading, setWalkinSlotsLoading] = useState(false);
  const [walkinForm, setWalkinForm] = useState({
    patient_phone: '', patient_name: '', doctor_id: '', hospital_id: '',
    appointment_date: '', appointment_time: '', slot_id: '', visit_type: 'in_person', notes: '',
  });
  const [walkinSaving, setWalkinSaving] = useState(false);

  // Load the doctor's open slots once both doctor and date are chosen, so the
  // receptionist books a real slot that gets locked rather than free-typing a
  // time the bot has no idea is taken.
  useEffect(() => {
    const { doctor_id, appointment_date } = walkinForm;
    // Clear any previously picked slot — it belongs to the old doctor/date and
    // would otherwise still be submitted after the selector visually resets.
    setWalkinForm(f => (f.slot_id ? { ...f, slot_id: '', appointment_time: '' } : f));
    if (!showWalkinModal || !doctor_id || !appointment_date) { setWalkinSlots([]); return; }
    let cancelled = false;
    setWalkinSlotsLoading(true);
    api.get(`/admin/slots?doctor_id=${doctor_id}&date=${appointment_date}`)
      .then(({ data }) => {
        if (cancelled) return;
        setWalkinSlots((data.slots || []).filter(s => s.status === 'available'));
      })
      .catch(() => { if (!cancelled) setWalkinSlots([]); })
      .finally(() => { if (!cancelled) setWalkinSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [showWalkinModal, walkinForm.doctor_id, walkinForm.appointment_date]);


  // Bulk appointment update state
  const [selectedApptIds, setSelectedApptIds] = useState(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);

  // Send WhatsApp message state
  const [showWaMessageModal, setShowWaMessageModal] = useState(false);
  const [waMessagePhone, setWaMessagePhone] = useState('');
  const [waMessageText, setWaMessageText] = useState('');
  const [waSending, setWaSending] = useState(false);

  // Appointment notes inline editing — A5
  const [editingNotesId, setEditingNotesId] = useState(null);
  const [notesText, setNotesText] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);

  // Role gate: the backend enforces adminOnly on staff CRUD, settings PATCH,
  // walk-ins, bulk updates, imports, WhatsApp sends, audit logs, etc. Staff
  // users must not see UI that can only 403.
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    const token = localStorage.getItem('token');
    const u = localStorage.getItem('user');
    if (!token) { router.push('/login'); return; }
    try { setUser(u ? JSON.parse(u) : {}); } catch { setUser({}); }
    fetchStats();
    fetchAnalyticsSummary();
    fetchOnboarding();

    // Session timeout warning: fires 5 minutes before JWT expires
    const onSessionWarning = (e) => {
      toast(`Your session expires in ${e.detail?.minutesLeft || 5} minutes. Save your work.`, {
        icon: '⏳',
        duration: 10000,
        style: { background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b' },
      });
    };
    window.addEventListener('medibook:session-warning', onSessionWarning);

    // ── SSE real-time dashboard updates ──────────────────────────
    // The EventSource URL embeds the access token (EventSource can't set headers).
    // Tokens expire after 1h, so we must reconnect with the fresh token whenever
    // the api interceptor rotates it — otherwise the browser retries forever with
    // the stale token and real-time updates silently stop.
    let es = null;
    const connectSSE = () => {
      if (es) es.close();
      const currentToken = localStorage.getItem('token');
      if (!currentToken) return;
      es = new EventSource(`/api/proxy/api/admin/events?token=${encodeURIComponent(currentToken)}`);
      es.onmessage = (e) => {
        try {
          const { type, payload } = JSON.parse(e.data);
          if (type === 'new_booking') {
            toast.success(`New booking: ${payload?.patientName || 'Patient'} → Dr. ${payload?.doctorName || ''}`, {
              duration: 5000, icon: '📅',
            });
            // Silently refresh stats so counters update
            fetchStats(true);
            // Normalize to the same shape as /admin/notifications/recent so the
            // dropdown (which renders patient_name / doctor_name / booking_id)
            // displays SSE-delivered bookings correctly.
            const key = payload?.bookingId || `sse-${Date.now()}`;
            if (!notifSeenKeys.current.has(key)) {
              addSeenKey(key);
              setNotifications(prev => [
                {
                  id: key,
                  booking_id: payload?.bookingId,
                  patient_name: payload?.patientName,
                  doctor_name: payload?.doctorName,
                  appointment_date: payload?.date,
                  appointment_time: payload?.time,
                  created_at: new Date().toISOString(),
                },
                ...prev.slice(0, 19),
              ]);
              setNotifCount(c => c + 1);
            }
          }
        } catch (_) {}
      };
      es.onerror = () => {}; // silent reconnect handled by browser
    };
    connectSSE();
    const onTokenRefreshed = () => connectSSE();
    window.addEventListener('medibook:token-refreshed', onTokenRefreshed);

    // ── Keyboard shortcuts ────────────────────────────────────────
    let gPressed = false;
    let gTimer = null;
    const onKeyDownG = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'g') { gPressed = true; clearTimeout(gTimer); gTimer = setTimeout(() => { gPressed = false; }, 1000); return; }
      if (gPressed) {
        const navMap = { o: 'overview', a: 'appointments', d: 'doctors', p: 'patients', n: 'analytics', s: 'settings', t: 'test', l: 'audit' };
        // Audit logs are admin-only on the backend — read the role fresh from
        // localStorage (this closure was created before `user` state resolved).
        if (navMap[e.key] === 'audit') {
          let role = null;
          try { role = JSON.parse(localStorage.getItem('user') || '{}').role; } catch (_) {}
          if (role !== 'admin') { gPressed = false; return; }
        }
        if (navMap[e.key]) { setTab(navMap[e.key]); gPressed = false; }
      }
      if (e.key === '?') {
        toast('Shortcuts: g+o Overview · g+a Appointments · g+d Doctors · g+p Patients · g+n Analytics · g+s Settings', {
          duration: 5000, icon: '⌨️',
        });
      }
    };
    window.addEventListener('keydown', onKeyDownG);

    return () => {
      window.removeEventListener('medibook:session-warning', onSessionWarning);
      window.removeEventListener('medibook:token-refreshed', onTokenRefreshed);
      window.removeEventListener('keydown', onKeyDownG);
      clearTimeout(gTimer);
      clearSessionTimers();
      if (es) es.close();
    };
  }, []);

  const fetchStats = useCallback(async (silent = false) => {
    if (silent) setStatsRefreshing(true);
    else setLoading(true);
    try {
      const { data } = await api.get('/admin/dashboard');
      setStats(data);
      setStatsLastUpdated(new Date());
    } catch (err) {
      if (!silent) toast.error('Failed to load dashboard stats');
    } finally {
      setLoading(false);
      setStatsRefreshing(false);
    }
  }, []);

  const fetchAppointments = useCallback(async (page = apptPage) => {
    try {
      const params = new URLSearchParams({ limit: '25', page: String(page) });
      if (filterDate) params.set('date', filterDate);
      if (filterStatus) params.set('status', filterStatus);
      const { data } = await api.get(`/admin/appointments?${params}`);
      const rows = data.appointments || [];
      setAppointments(rows);
      setApptHasMore(data.has_more ?? rows.length === 25);
      if (data.total != null) setApptTotal(data.total);
    } catch { toast.error('Failed to load appointments'); }
  }, [filterDate, filterStatus, apptPage]);

  const fetchDoctors = useCallback(async () => {
    try {
      const url = showInactive ? '/admin/doctors?include_inactive=true' : '/admin/doctors';
      const { data } = await api.get(url);
      setDoctors(data.doctors || []);
    } catch { toast.error('Failed to load doctors'); }
  }, [showInactive]);

  const fetchPatients = useCallback(async (page = patientPage) => {
    try {
      const params = new URLSearchParams({ limit: '25', page: String(page) });
      if (patientSearch) params.set('search', patientSearch);
      const { data } = await api.get(`/admin/patients?${params}`);
      const rows = data.patients || [];
      setPatients(rows);
      setPatientHasMore(data.has_more ?? rows.length === 25);
      if (data.total != null) setPatientTotal(data.total);
    } catch { toast.error('Failed to load patients'); }
  }, [patientSearch, patientPage]);

  async function importPatientsCSV(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportingPatients(true);
    try {
      const text = await file.text();
      const { data } = await api.post('/admin/patients/import', { csv_data: text });
      toast.success(`Imported ${data.imported} patients${data.skipped ? `, ${data.skipped} skipped` : ''}`);
      if (data.errors?.length) {
        console.warn('Import warnings:', data.errors);
        toast.error(`${data.errors.length} rows had issues — check console`, { duration: 5000 });
      }
      fetchPatients();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally {
      setImportingPatients(false);
      e.target.value = '';
    }
  }

  async function importDoctorsCSV(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportingDoctors(true);
    try {
      const text = await file.text();
      const { data } = await api.post('/admin/doctors/import', { csv_data: text });
      toast.success(`Imported ${data.imported} doctors${data.skipped ? `, ${data.skipped} skipped` : ''}`);
      if (data.errors?.length) {
        console.warn('Import warnings:', data.errors);
      }
      fetchDoctors();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally {
      setImportingDoctors(false);
      e.target.value = '';
    }
  }

  // `settings` is shared (read by DoctorsTab), so it stays here and is passed to
  // SettingsTab, which derives its editable form from it.
  const fetchSettings = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/settings');
      setSettings(data);
    } catch { toast.error('Failed to load settings'); }
  }, []);

  const fetchAnalyticsSummary = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/analytics/summary');
      setAnalyticsSummary(data);
    } catch { /* silent */ }
  }, []);

  const fetchOnboarding = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/onboarding/status');
      setOnboarding(data);
      if (!data.all_done && !data.onboarding_completed) setShowOnboarding(true);
    } catch { /* silent */ }
  }, []);

  const pollNotifications = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/notifications/recent');
      const newOnes = data.notifications || [];
      // Dedup against everything already shown (SSE entries are keyed by
      // booking_id; polled entries carry the appointment UUID) via the seen-set
      // ref, so StrictMode double-invoked updaters can't double-count.
      const incoming = newOnes.filter(
        n => !notifSeenKeys.current.has(n.id) && !notifSeenKeys.current.has(n.booking_id)
      );
      if (incoming.length > 0) {
        incoming.forEach(n => {
          if (n.id) addSeenKey(n.id);
          if (n.booking_id) addSeenKey(n.booking_id);
        });
        toast(`🔔 ${incoming.length} new booking${incoming.length > 1 ? 's' : ''}!`, { icon: '📅' });
        setNotifications(prev => [...incoming, ...prev].slice(0, 20));
        // Count only genuinely new bookings, so "Clear" stays cleared for
        // bookings the admin has already seen.
        setNotifCount(c => c + incoming.length);
      }
    } catch { /* silent */ }
  }, []);

  // Notification polling — every 30s
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const interval = setInterval(pollNotifications, 30000);
    return () => clearInterval(interval);
  }, [pollNotifications]);

  const fetchHospitals = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/hospitals');
      setHospitals(data.hospitals || []);
      return data.hospitals || [];
    } catch { /* silent */ return []; }
  }, []);

  const fetchDepartments = useCallback(async (hospital_id) => {
    try {
      const url = hospital_id ? `/admin/departments?hospital_id=${hospital_id}` : '/admin/departments';
      const { data } = await api.get(url);
      setDepartments(data.departments || []);
    } catch { /* silent */ }
  }, []);

  async function fetchDeptsForHospital(hospitalId) {
    try {
      const { data } = await api.get(`/admin/departments?hospital_id=${hospitalId}`);
      setDeptsByHospital(prev => ({ ...prev, [hospitalId]: data.departments || [] }));
    } catch { /* silent */ }
  }

  async function fetchAllHospitalDepts(hospList) {
    for (const h of hospList) {
      await fetchDeptsForHospital(h.id);
    }
  }

  async function saveHospital(e) {
    e.preventDefault();
    if (!hospitalForm.name.trim()) return toast.error('Hospital name is required');
    setHospitalSaving(true);
    try {
      if (editingHospital) {
        await api.patch(`/admin/hospitals/${editingHospital.id}`, hospitalForm);
        toast.success('Hospital updated');
      } else {
        await api.post('/admin/hospitals', hospitalForm);
        toast.success('Hospital created');
      }
      setShowHospitalModal(false);
      setHospitalForm({ name: '', address: '', city: '', phone: '' });
      setEditingHospital(null);
      const { data } = await api.get('/admin/hospitals');
      setHospitals(data.hospitals || []);
      fetchAllHospitalDepts(data.hospitals || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save hospital');
    } finally { setHospitalSaving(false); }
  }

  function openEditHospital(h) {
    setEditingHospital(h);
    setHospitalForm({ name: h.name || '', address: h.address || '', city: h.city || '', phone: h.phone || '' });
    setShowHospitalModal(true);
  }

  function deleteHospital(h) {
    setConfirmModal({
      title: `Deactivate ${h.name}?`,
      message: 'This hospital will no longer appear in the booking bot.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/hospitals/${h.id}`);
          toast.success('Hospital deactivated');
          const { data } = await api.get('/admin/hospitals');
          setHospitals(data.hospitals || []);
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to deactivate');
        }
      },
    });
  }

  async function saveDepartment(e) {
    e.preventDefault();
    if (!deptForm.name.trim()) return toast.error('Department name is required');
    setDeptSaving(true);
    try {
      if (editingDept) {
        await api.patch(`/admin/departments/${editingDept.id}`, deptForm);
        toast.success('Department updated');
      } else {
        await api.post('/admin/departments', { ...deptForm, hospital_id: deptHospital.id });
        toast.success('Department added');
      }
      setShowDeptModal(false);
      setDeptForm({ name: '', description: '' });
      setEditingDept(null);
      fetchDeptsForHospital(deptHospital.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save department');
    } finally { setDeptSaving(false); }
  }

  function openEditDept(dept, hospital) {
    setEditingDept(dept);
    setDeptHospital(hospital);
    setDeptForm({ name: dept.name || '', description: dept.description || '' });
    setShowDeptModal(true);
  }

  function deleteDept(dept, hospital) {
    setConfirmModal({
      title: `Remove "${dept.name}"?`,
      message: 'This department will be deactivated and hidden from the booking bot.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/departments/${dept.id}`);
          toast.success('Department removed');
          fetchDeptsForHospital(hospital.id);
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to remove department');
        }
      },
    });
  }

  function openEditPatient(patient) {
    setEditingPatient(patient);
    setPatientEditForm({
      name: patient.name || '',
      email: patient.email || '',
      gender: patient.gender || '',
      date_of_birth: patient.date_of_birth ? patient.date_of_birth.slice(0, 10) : '',
    });
    setShowPatientEditModal(true);
  }

  async function savePatient(e) {
    e.preventDefault();
    if (!patientEditForm.name.trim()) return toast.error('Name is required');
    setPatientEditSaving(true);
    try {
      const payload = {};
      if (patientEditForm.name) payload.name = patientEditForm.name;
      if (patientEditForm.email) payload.email = patientEditForm.email;
      if (patientEditForm.gender) payload.gender = patientEditForm.gender;
      if (patientEditForm.date_of_birth) payload.date_of_birth = patientEditForm.date_of_birth;
      await api.patch(`/admin/patients/${editingPatient.id}`, payload);
      toast.success('Patient updated');
      setShowPatientEditModal(false);
      setEditingPatient(null);
      fetchPatients();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update patient');
    } finally { setPatientEditSaving(false); }
  }

  async function openPatientHistory(patient) {
    setSelectedPatient(patient);
    setPatientHistory([]);
    setPatientDocuments([]);
    setPatientHistoryLoading(true);
    setMedHistoryEditing(false);
    setShowPatientHistory(true);
    try {
      const [histData, medData, docsData] = await Promise.allSettled([
        api.get(`/admin/patients/${patient.id}/appointments`),
        api.get(`/admin/patients/${patient.id}/medical-history`),
        api.get(`/admin/patients/${patient.id}/documents`),
      ]);
      if (histData.status === 'fulfilled') setPatientHistory(histData.value.data.appointments || []);
      if (medData.status === 'fulfilled') {
        const mh = medData.value.data.patient?.medical_history || {};
        setMedHistory({ blood_type: mh.blood_type || '', allergies: mh.allergies || '', conditions: mh.conditions || '', medications: mh.medications || '', notes: mh.notes || '' });
        setMedHistoryFailed(false);
      } else {
        // A rejection here used to be dropped silently, leaving medHistory at
        // its reset '' values — so a failed load rendered "Not recorded" in the
        // Allergies row, indistinguishable from a patient who genuinely has
        // none. For a clinician that is a dangerous default; say so instead.
        setMedHistoryFailed(true);
        toast.error('Could not load medical history — do not rely on the fields below');
      }
      if (docsData.status === 'fulfilled') setPatientDocuments(docsData.value.data.documents || []);
      // Promise.allSettled never rejects, so the surrounding catch was dead code.
    } catch { toast.error('Failed to load history'); }
    finally { setPatientHistoryLoading(false); }
  }

  async function updateApptStatus(apptId, newStatus) {
    try {
      await api.patch(`/admin/appointments/${apptId}`, { status: newStatus });
      setAppointments(prev => prev.map(a => a.id === apptId ? { ...a, status: newStatus } : a));
      toast.success(`Marked as ${newStatus.replace('_', ' ')}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update status');
    }
  }

  async function confirmCancelAppointment() {
    if (!cancellingAppt) return;
    if (!cancelReason.trim()) { toast.error('Cancellation reason is required'); return; }
    try {
      await api.patch(`/admin/appointments/${cancellingAppt.id}`, {
        status: 'cancelled',
        cancellation_reason: cancelReason.trim(),
      });
      setAppointments(prev => prev.map(a =>
        a.id === cancellingAppt.id ? { ...a, status: 'cancelled' } : a
      ));
      toast.success('Appointment cancelled');
      setCancellingAppt(null);
      setCancelReason('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel appointment');
    }
  }

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
      // Report failure to the caller. "Save & Generate Slots" awaited this and
      // ignored the result, so a rejected save (e.g. end time before start
      // time) still generated slots — from the PREVIOUSLY saved hours — and
      // then reported "168 slots generated". The admin believed the new hours
      // were live while patients were booked into the old window.
      return false;
    }
    setScheduleSaving(false);
    return true;
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
    const today = todayIST();
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
    // Canonical payload shape shared with SlotsTab.js — see backend
    // routes/doctors.js PATCH /slots/:id, which checks `action` first.
    const action = newStatus === 'blocked' ? 'block' : 'unblock';
    try {
      await api.patch(`/admin/slots/${slot.id}`, { action });
      setSlots(prev => prev.map(s => s.id === slot.id ? { ...s, status: newStatus } : s));
      toast.success(`Slot ${newStatus === 'blocked' ? 'blocked' : 'unblocked'}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update slot');
    }
  }

  function toggleDoctorStatus(doc) {
    const isDeactivating = doc.is_active;
    setConfirmModal({
      title: isDeactivating ? `Deactivate Dr. ${doc.name}?` : `Reactivate Dr. ${doc.name}?`,
      message: isDeactivating
        ? 'They will no longer appear in the booking bot until reactivated.'
        : 'They will appear in the booking bot and accept appointments.',
      danger: isDeactivating,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.patch(`/admin/doctors/${doc.id}`, { is_active: !doc.is_active });
          toast.success(`Dr. ${doc.name} ${isDeactivating ? 'deactivated' : 'reactivated'}`);
          fetchDoctors();
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to update doctor status');
        }
      },
    });
  }

  useEffect(() => {
    if (tab === 'overview') return;
    setTabLoading(true);
    const load = async () => {
      try {
        if (tab === 'appointments') await fetchAppointments();
        else if (tab === 'doctors') await fetchDoctors();
        else if (tab === 'patients') await fetchPatients();
        else if (tab === 'analytics') await fetchAnalyticsSummary();
        else if (tab === 'services') { if (!hospitals.length) await fetchHospitals(); }
        else if (tab === 'holidays') { if (!hospitals.length) await fetchHospitals(); }
        else if (tab === 'hospitals') {
          const data = await fetchHospitals();
          if (data) await fetchAllHospitalDepts(data);
        }
        else if (tab === 'slots') { if (!doctors.length) await fetchDoctors(); }
        else if (tab === 'settings') await fetchSettings();
      } finally {
        setTabLoading(false);
      }
    };
    load();
  }, [tab]);

  // Auto-refresh: Overview stats every 60s, Appointments every 60s
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const statsInterval = setInterval(() => {
      if (tab === 'overview') fetchStats(true);
    }, 60000);
    const apptInterval = setInterval(() => {
      if (tab === 'appointments') fetchAppointments();
    }, 60000);
    return () => { clearInterval(statsInterval); clearInterval(apptInterval); };
  }, [tab, fetchStats, fetchAppointments]);

  useEffect(() => {
    if (tab === 'appointments') { setApptPage(1); fetchAppointments(1); }
  }, [filterDate, filterStatus]);

  // Drop selected appointments that are no longer on screen. Selection used to
  // survive pagination and filter changes, so ticking 5 rows on page 1 and
  // paging forward left the banner reading "5 selected" while the checkboxes
  // were all clear — and "Mark Completed" then acted on 5 appointments the
  // admin could no longer see. Pruning to the visible set keeps the intent
  // (a refresh on the same page preserves the ticks) without that trap.
  useEffect(() => {
    setSelectedApptIds(prev => {
      if (!prev.size) return prev;
      const visible = new Set(appointments.map(a => a.id));
      const next = new Set([...prev].filter(id => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [appointments]);

  useEffect(() => {
    if (tab === 'doctors') fetchDoctors();
  }, [showInactive]);

  useEffect(() => {
    if (tab === 'patients') {
      // Reset to page 1 on a new search — otherwise searching from page 2+
      // requests that page of the filtered results and shows a false
      // "No patients found".
      const t = setTimeout(() => { setPatientPage(1); fetchPatients(1); }, 400);
      return () => clearTimeout(t);
    }
  }, [patientSearch]);

  async function saveMedHistory() {
    if (!selectedPatient) return;
    setMedHistorySaving(true);
    try {
      await api.patch(`/admin/patients/${selectedPatient.id}/medical-history`, { medical_history: medHistory });
      toast.success('Medical history saved');
      setMedHistoryEditing(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setMedHistorySaving(false); }
  }

  async function saveWalkin(e) {
    e.preventDefault();
    setWalkinSaving(true);
    try {
      // '__manual__' is a UI sentinel for the unreserved path — never send it as
      // a slot id, or the backend's slot lookup fails with a confusing error.
      const { slot_id, ...rest } = walkinForm;
      await api.post('/admin/appointments',
        slot_id && slot_id !== '__manual__' ? { ...rest, slot_id } : rest);
      toast.success('Walk-in appointment created!');
      setShowWalkinModal(false);
      setWalkinForm({ patient_phone: '', patient_name: '', doctor_id: '', hospital_id: '', appointment_date: '', appointment_time: '', slot_id: '', visit_type: 'in_person', notes: '' });
      setWalkinSlots([]);
      fetchAppointments();
      fetchStats();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create appointment');
    } finally { setWalkinSaving(false); }
  }

  function deletePatient(patient) {
    setConfirmModal({
      title: 'Delete Patient Record',
      message: `This will permanently anonymise ${patient.name || 'this patient'}'s personal data (GDPR). Appointment history is preserved. This cannot be undone.`,
      danger: true,
      onConfirm: async () => {
        // ConfirmModal does not self-close, and every other handler dismisses it
        // first. Without this the dialog stayed up after a successful delete, so
        // clicking Confirm again fired a second DELETE for the same patient.
        setConfirmModal(null);
        try {
          await api.delete(`/admin/patients/${patient.id}`);
          toast.success('Patient record anonymised');
          fetchPatients();
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to delete patient');
        }
      },
    });
  }


  async function bulkUpdateAppointments(status, cancellationReason) {
    if (selectedApptIds.size === 0) return toast.error('No appointments selected');
    // The backend rejects bulk cancellation without a reason, and nothing in the
    // UI collected one — so "✕ Cancel All" could never succeed, it only ever
    // surfaced a validation error. The single-appointment path already prompts.
    if (status === 'cancelled' && !cancellationReason) {
      setCancelReason('');
      setBulkCancelling(true);
      return;
    }
    setBulkUpdating(true);
    try {
      const { data } = await api.patch('/admin/appointments/bulk', {
        ids: [...selectedApptIds],
        status,
        ...(cancellationReason ? { cancellation_reason: cancellationReason } : {}),
      });
      toast.success(`${data.updated} appointment${data.updated !== 1 ? 's' : ''} marked as ${status.replace('_', ' ')}`);
      setSelectedApptIds(new Set());
      fetchAppointments();
      fetchStats();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk update failed');
    } finally { setBulkUpdating(false); }
  }

  async function sendWaMessage(e) {
    e.preventDefault();
    if (!waMessagePhone || !waMessageText) return toast.error('Phone and message required');
    setWaSending(true);
    try {
      await api.post('/admin/messages/send', { phone: waMessagePhone, message: waMessageText });
      toast.success(`Message sent to ${waMessagePhone}`);
      setShowWaMessageModal(false);
      setWaMessagePhone('');
      setWaMessageText('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send message');
    } finally { setWaSending(false); }
  }

  async function saveApptNotes(apptId) {
    setNotesSaving(true);
    try {
      await api.patch(`/admin/appointments/${apptId}`, { notes: notesText });
      setAppointments(prev => prev.map(a => a.id === apptId ? { ...a, notes: notesText } : a));
      toast.success('Notes saved');
      setEditingNotesId(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save notes');
    } finally { setNotesSaving(false); }
  }

  async function printReceipt(apptId) {
    try {
      // Go through the api instance (not raw fetch) so an expired token is
      // auto-refreshed instead of surfacing "Receipt not available".
      const resp = await api.get(`/admin/appointments/${apptId}/receipt`, {
        responseType: 'text',
        transformResponse: [(d) => d],
      });
      const blob = new Blob([resp.data], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      if (w) {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return;
      }
      // window.open() runs after an await, so it is outside the user-gesture
      // task and browsers block it by default. Previously this did nothing at
      // all — no message, and the blob URL leaked. Fall back to a download,
      // which is not gesture-restricted.
      const a = document.createElement('a');
      a.href = url;
      a.download = `receipt-${apptId}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Popup blocked — receipt downloaded instead', { icon: '⬇️' });
    } catch { toast.error('Failed to load receipt'); }
  }

  // Excel/Sheets execute cells starting with = + - @ as formulas. Patient names
  // come from WhatsApp (attacker-controlled), so neutralize them with a leading
  // apostrophe before quoting.
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }

  async function exportCSV(rowsOverride) {
    const source = rowsOverride || appointments;
    if (!source.length) { toast.error('No data to export'); return; }
    const h = ['Booking ID', 'Patient', 'Phone', 'Doctor', 'Department', 'Date', 'Time', 'Type', 'Status'];
    const rows = source.map(a => [
      a.booking_id, a.patient_name, a.patient_phone,
      `Dr. ${a.doctor_name}`, a.department_name || '',
      a.appointment_date, a.appointment_time?.slice(0, 5),
      a.visit_type || 'in_person', a.status
    ]);
    const csv = [h, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `appointments_${format(new Date(), 'yyyyMMdd')}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    toast.success('CSV exported!');
  }


  async function logout() {
    try { await api.post('/auth/logout'); } catch (_) {}
    clearSessionTimers();
    localStorage.clear();
    delete api.defaults.headers.common.Authorization;
    router.push('/login');
  }

  function printAnalytics() {
    window.print();
  }

  return (
    <>
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed md:relative z-50 md:z-auto inset-y-0 left-0
        w-56 bg-white border-r border-gray-200 flex flex-col shrink-0
        transform transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <div className="text-xl font-bold text-blue-600">🏥 MediBook</div>
            <div className="text-xs text-gray-400 mt-1 truncate">{user?.tenant || 'Admin Portal'}</div>
          </div>
          <button className="md:hidden text-gray-400 hover:text-gray-600 p-1" onClick={() => setSidebarOpen(false)}>✕</button>
        </div>
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {/* Audit logs endpoint is admin-only (403 for staff) — hide the tab */}
          {NAV.filter(item => isAdmin || item.id !== 'audit').map(item => (
            <button key={item.id} onClick={() => { setTab(item.id); setSidebarOpen(false); }}
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
        <header className="bg-white border-b border-gray-200 px-4 md:px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <button className="md:hidden p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition shrink-0" onClick={() => setSidebarOpen(true)}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="text-lg font-semibold text-gray-900 truncate">
              {NAV.find(n => n.id === tab)?.icon} {NAV.find(n => n.id === tab)?.label}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {tab === 'analytics' && (
              <button onClick={printAnalytics}
                className="p-2 sm:px-3 sm:py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition" title="Print Report">
                🖨️<span className="hidden sm:inline"> Print Report</span>
              </button>
            )}
            {tab === 'appointments' && (
              <button onClick={() => exportCSV()}
                className="p-2 sm:px-3 sm:py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition" title="Export CSV">
                📥<span className="hidden sm:inline"> Export CSV</span>
              </button>
            )}
            {/* Notification Bell */}
            <div className="relative">
              <button onClick={() => setShowNotifDropdown(v => !v)}
                className="relative px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">
                🔔
                {notifCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold leading-none">
                    {notifCount > 9 ? '9+' : notifCount}
                  </span>
                )}
              </button>
              {showNotifDropdown && (
                <div className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-1rem)] sm:w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <span className="font-semibold text-sm text-gray-800">Recent Bookings</span>
                    <button onClick={() => { setShowNotifDropdown(false); setNotifCount(0); }}
                      className="text-xs text-blue-600 hover:underline">Clear</button>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                    {notifications.length === 0 ? (
                      <div className="px-4 py-6 text-center text-gray-400 text-sm">No new bookings</div>
                    ) : notifications.map((n, i) => (
                      <div key={n.id || i} className="px-4 py-3 hover:bg-gray-50">
                        <div className="text-sm font-medium text-gray-900">{n.patient_name || 'New Patient'}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          Dr. {n.doctor_name} · {n.appointment_date} {n.appointment_time?.slice(0, 5)}
                        </div>
                        <div className="text-xs text-blue-600 font-mono mt-0.5">{n.booking_id}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button onClick={() => fetchStats()}
              className="p-2 sm:px-3 sm:py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition" title="Refresh">
              🔄<span className="hidden sm:inline"> Refresh</span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-3 sm:p-6">

          {/* Tab loading skeleton */}
          {tabLoading && (
            <div className="space-y-4 animate-pulse">
              <div className="flex gap-3">
                <div className="h-9 w-32 bg-gray-200 rounded-lg" />
                <div className="h-9 w-40 bg-gray-200 rounded-lg" />
                <div className="ml-auto h-9 w-24 bg-gray-200 rounded-lg" />
              </div>
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="p-4 border-b border-gray-100">
                  <div className="h-4 w-48 bg-gray-200 rounded" />
                </div>
                {[1,2,3,4,5].map(i => (
                  <div key={i} className="px-4 py-3 border-b border-gray-50 flex items-center gap-4">
                    <div className="h-3 w-20 bg-gray-200 rounded" />
                    <div className="h-3 w-32 bg-gray-200 rounded" />
                    <div className="h-3 w-24 bg-gray-100 rounded" />
                    <div className="h-3 w-16 bg-gray-100 rounded ml-auto" />
                    <div className="h-5 w-16 bg-gray-200 rounded-full" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ONBOARDING BANNER ── */}
          {showOnboarding && onboarding && !onboarding.all_done && (
            <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-blue-900 text-sm">🎉 Welcome! Complete your setup</h3>
                  <p className="text-xs text-blue-600 mt-0.5">Finish these steps to activate your WhatsApp bot</p>
                </div>
                <button onClick={() => setShowOnboarding(false)} className="text-blue-400 hover:text-blue-600 text-lg">✕</button>
              </div>
              <div className="space-y-2">
                {onboarding.steps.map(step => (
                  <div key={step.id} className="flex items-center gap-2 text-sm">
                    <span className={step.done ? 'text-green-500' : 'text-gray-400'}>{step.done ? '✅' : '⬜'}</span>
                    <span className={step.done ? 'line-through text-gray-400' : 'text-blue-800'}>{step.label}</span>
                  </div>
                ))}
              </div>
              {onboarding.all_done && (
                <button onClick={async () => { await api.post('/admin/onboarding/complete'); setShowOnboarding(false); }}
                  className="mt-3 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
                  Mark setup complete ✓
                </button>
              )}
            </div>
          )}

          {/* ── TAB CONTENT (wrapped in ErrorBoundary so one broken tab doesn't crash the whole dashboard) ── */}
          <ErrorBoundary key={tab}>

          {/* ── OVERVIEW ── */}
          {tab === 'overview' && (
            <OverviewTab
              loading={loading}
              stats={stats}
              statsLastUpdated={statsLastUpdated}
              statsRefreshing={statsRefreshing}
              fetchStats={fetchStats}
              analyticsSummary={analyticsSummary}
              setTab={setTab}
              exportCSV={exportCSV}
            />
          )}

          {/* ── APPOINTMENTS ── */}
          {tab === 'appointments' && !tabLoading && (
            <AppointmentsTab
              appointments={appointments}
              isAdmin={isAdmin}
              filterDate={filterDate} setFilterDate={setFilterDate}
              filterStatus={filterStatus} setFilterStatus={setFilterStatus}
              apptTotal={apptTotal}
              apptPage={apptPage} setApptPage={setApptPage}
              apptHasMore={apptHasMore}
              fetchAppointments={fetchAppointments}
              selectedApptIds={selectedApptIds} setSelectedApptIds={setSelectedApptIds}
              bulkUpdating={bulkUpdating} bulkUpdateAppointments={bulkUpdateAppointments}
              updateApptStatus={updateApptStatus}
              printReceipt={printReceipt}
              waLink={waLink}
              onMessagePatient={(phone) => { setShowWaMessageModal(true); setWaMessagePhone(phone); setWaMessageText(''); }}
              onAddWalkin={() => {
                if (!hospitals.length) fetchHospitals();
                if (!doctors.length) fetchDoctors();
                setWalkinForm({ patient_phone: '', patient_name: '', doctor_id: '', hospital_id: '', appointment_date: '', appointment_time: '', slot_id: '', visit_type: 'in_person', notes: '' });
                setWalkinSlots([]);
                setShowWalkinModal(true);
              }}
              onEditNotes={(a) => { setEditingNotesId(a.id); setNotesText(a.notes || ''); }}
              onCancelAppt={(a) => { setCancellingAppt(a); setCancelReason(''); }}
            />
          )}

          {/* ── DOCTORS ── */}
          {tab === 'doctors' && !tabLoading && (
            <DoctorsTab
              doctors={doctors}
              settings={settings}
              isAdmin={isAdmin}
              showInactive={showInactive}
              setShowInactive={setShowInactive}
              importingDoctors={importingDoctors}
              importDoctorsCSV={importDoctorsCSV}
              openAddDoctor={openAddDoctor}
              openEditDoctor={openEditDoctor}
              openSchedule={openSchedule}
              openSlotsViewer={openSlotsViewer}
              toggleDoctorStatus={toggleDoctorStatus}
            />
          )}

          {/* ── PATIENTS ── */}
          {tab === 'patients' && !tabLoading && (
            <PatientsTab
              patients={patients}
              isAdmin={isAdmin}
              patientSearch={patientSearch}
              setPatientSearch={setPatientSearch}
              patientTotal={patientTotal}
              patientPage={patientPage}
              setPatientPage={setPatientPage}
              patientHasMore={patientHasMore}
              fetchPatients={fetchPatients}
              importingPatients={importingPatients}
              importPatientsCSV={importPatientsCSV}
              waLink={waLink}
              openPatientHistory={openPatientHistory}
              openEditPatient={openEditPatient}
              deletePatient={deletePatient}
            />
          )}

          {/* ── HOSPITALS ── */}
          {tab === 'hospitals' && !tabLoading && (
            <HospitalsTab
              hospitals={hospitals}
              isAdmin={isAdmin}
              deptsByHospital={deptsByHospital}
              setEditingHospital={setEditingHospital}
              setHospitalForm={setHospitalForm}
              setShowHospitalModal={setShowHospitalModal}
              openEditHospital={openEditHospital}
              deleteHospital={deleteHospital}
              setDeptHospital={setDeptHospital}
              setDeptForm={setDeptForm}
              setEditingDept={setEditingDept}
              setShowDeptModal={setShowDeptModal}
              openEditDept={openEditDept}
              deleteDept={deleteDept}
            />
          )}

          {/* ── FEEDBACK ── */}
          {tab === 'feedback' && !tabLoading && (
            <FeedbackTab />
          )}

          {/* ── ANALYTICS ── */}
          {tab === 'analytics' && !tabLoading && (
            <AnalyticsTab />
          )}

          {/* ── SERVICES (A1) ── */}
          {tab === 'services' && !tabLoading && (
            <ServicesTab
              hospitals={hospitals}
              isAdmin={isAdmin}
              setConfirmModal={setConfirmModal}
            />
          )}

          {/* ── HOLIDAYS (A4) ── */}
          {tab === 'holidays' && !tabLoading && (
            <HolidaysTab
              hospitals={hospitals}
              isAdmin={isAdmin}
              setConfirmModal={setConfirmModal}
            />
          )}

          {/* ── STAFF ── */}
          {tab === 'staff' && !tabLoading && (
            <StaffTab
              isAdmin={isAdmin}
              setConfirmModal={setConfirmModal}
            />
          )}

          {/* ── SETTINGS ── */}
          {tab === 'settings' && !tabLoading && (
            <SettingsTab
              settings={settings}
              fetchSettings={fetchSettings}
              isAdmin={isAdmin}
            />
          )}

          {/* ── CALENDAR ── */}
          {tab === 'calendar' && !tabLoading && (
            <CalendarTab />
          )}

          {/* ── DOCTOR LEAVES ── */}
          {tab === 'leaves' && !tabLoading && (
            <LeavesTab
              isAdmin={isAdmin}
              setConfirmModal={setConfirmModal}
            />
          )}

          {/* ── AUDIT LOGS ── */}
          {tab === 'audit' && isAdmin && !tabLoading && (
            <AuditTab />
          )}

          {/* ── SLOTS ── */}
          {tab === 'slots' && !tabLoading && (
            <SlotsTab doctors={doctors} />
          )}

          {/* ── BOT TESTER ── */}
          {tab === 'test' && !tabLoading && (
            <TestBotTab isAdmin={isAdmin} />
          )}

          </ErrorBoundary>
        </main>
      </div>
    </div>
    {/* ── ADD / EDIT DOCTOR MODAL ── */}
    {showDoctorModal && (
      <Modal title={editingDoctor ? `Edit Dr. ${editingDoctor.name}` : 'Add New Doctor'} onClose={() => setShowDoctorModal(false)}>
        <p className="text-xs text-gray-400 -mt-1 mb-1">Fields marked <span className="text-red-400">*</span> are required. All others are optional.</p>
        <form onSubmit={saveDoctor} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
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
            <div className="sm:col-span-2">
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
            <div className="sm:col-span-2">
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

    {/* ── ADD / EDIT HOSPITAL MODAL ── */}
    {showHospitalModal && (
      <Modal title={editingHospital ? 'Edit Hospital' : 'Add New Hospital'} onClose={() => { setShowHospitalModal(false); setEditingHospital(null); }}>
        <form onSubmit={saveHospital} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Hospital Name *</label>
            <input value={hospitalForm.name} onChange={e => setHospitalForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Apollo Clinic Hyderabad"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">City</label>
              <input value={hospitalForm.city} onChange={e => setHospitalForm(f => ({ ...f, city: e.target.value }))}
                placeholder="Hyderabad"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
              <input value={hospitalForm.phone} onChange={e => setHospitalForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="040-12345678"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Address</label>
            <input value={hospitalForm.address} onChange={e => setHospitalForm(f => ({ ...f, address: e.target.value }))}
              placeholder="Banjara Hills, Road No. 12"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowHospitalModal(false); setEditingHospital(null); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={hospitalSaving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
              {hospitalSaving ? 'Saving...' : editingHospital ? 'Save Changes' : 'Create Hospital'}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* ── ADD / EDIT DEPARTMENT MODAL ── */}
    {showDeptModal && deptHospital && (
      <Modal title={editingDept ? `Edit "${editingDept.name}"` : `Add Department — ${deptHospital.name}`} onClose={() => { setShowDeptModal(false); setEditingDept(null); }}>
        <form onSubmit={saveDepartment} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Department Name *</label>
            <input value={deptForm.name} onChange={e => setDeptForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Cardiology"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
            <input value={deptForm.description} onChange={e => setDeptForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of the department"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowDeptModal(false); setEditingDept(null); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={deptSaving}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
              {deptSaving ? 'Saving...' : editingDept ? 'Save Changes' : 'Add Department'}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* ── PATIENT HISTORY MODAL ── */}
    {showPatientHistory && selectedPatient && (
      <Modal title={`${selectedPatient.name || selectedPatient.phone} — Patient Record`} onClose={() => setShowPatientHistory(false)} wide="xl">
        <div className="space-y-5">
          {/* Patient info header */}
          <div className="flex flex-wrap gap-4 text-sm text-gray-600 pb-4 border-b border-gray-100">
            <span>📱 +{selectedPatient.phone}</span>
            {selectedPatient.gender && <span className="capitalize">👤 {selectedPatient.gender}</span>}
            {selectedPatient.date_of_birth && (
              <span>🎂 {(() => { try { return format(parseISO(selectedPatient.date_of_birth), 'd MMM yyyy'); } catch { return selectedPatient.date_of_birth; } })()}</span>
            )}
            <span>🗓 {selectedPatient.visit_count} total visits</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Medical History */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800">🩺 Medical History</h3>
                {!isAdmin ? null : !medHistoryEditing ? (
                  <button onClick={() => setMedHistoryEditing(true)}
                    className="text-xs text-blue-600 hover:underline">Edit</button>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => setMedHistoryEditing(false)}
                      className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    <button onClick={saveMedHistory} disabled={medHistorySaving}
                      className="text-xs text-blue-600 hover:underline disabled:opacity-50">
                      {medHistorySaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                )}
              </div>
              {patientHistoryLoading ? (
                <div className="text-center text-gray-300 py-6 text-sm">Loading...</div>
              ) : (
                <div className="space-y-2">
                  {[
                    { key: 'blood_type', label: 'Blood Type', placeholder: 'e.g. A+, O-' },
                    { key: 'allergies', label: 'Allergies', placeholder: 'e.g. Penicillin, Aspirin' },
                    { key: 'conditions', label: 'Chronic Conditions', placeholder: 'e.g. Diabetes, Hypertension' },
                    { key: 'medications', label: 'Current Medications', placeholder: 'e.g. Metformin 500mg' },
                    { key: 'notes', label: 'Notes', placeholder: 'Any other relevant info' },
                  ].map(({ key, label, placeholder }) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-gray-500 mb-0.5">{label}</label>
                      {medHistoryEditing ? (
                        <input value={medHistory[key] || ''}
                          onChange={e => setMedHistory(h => ({ ...h, [key]: e.target.value }))}
                          placeholder={placeholder}
                          className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      ) : (
                        <div className={`text-sm px-2.5 py-1.5 rounded-lg ${
                          medHistory[key] ? 'text-gray-800 bg-gray-50'
                            : medHistoryFailed ? 'text-amber-700 bg-amber-50 italic'
                            : 'text-gray-300 italic'}`}>
                          {medHistory[key] || (medHistoryFailed ? '⚠️ Unavailable — failed to load' : 'Not recorded')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Appointment History */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">📅 Appointment History</h3>
              {patientHistoryLoading ? (
                <div className="text-center text-gray-400 py-10">Loading history...</div>
              ) : patientHistory.length === 0 ? (
                <div className="text-center text-gray-400 py-10">
                  <div className="text-3xl mb-2">📭</div>
                  <p className="text-sm">No appointments yet</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {patientHistory.map(a => (
                    <div key={a.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <div className="text-sm font-medium text-gray-900">Dr. {a.doctor_name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {(() => { try { return format(parseISO(a.appointment_date), 'EEE, d MMM yyyy'); } catch { return a.appointment_date; } })()}
                          {' '}at {a.appointment_time?.slice(0, 5)}
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge status={a.status} />
                        <div className="text-xs text-gray-400 mt-1 font-mono">{a.booking_id}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Documents Section (Enhancement 6) */}
          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">📎 Documents & Prescriptions</h3>
              {isAdmin && (
              <label className={`cursor-pointer px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition ${docUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {docUploading ? 'Uploading...' : '+ Upload'}
                <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.docx"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file || !selectedPatient) return;
                    if (file.size > 10 * 1024 * 1024) { toast.error('File too large. Maximum 10 MB.'); return; }
                    setDocUploading(true);
                    try {
                      const base64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result.split(',')[1]);
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                      });
                      const { data } = await api.post(`/admin/patients/${selectedPatient.id}/documents`, {
                        file_name: file.name,
                        file_type: file.type,
                        file_size_bytes: file.size,
                        file_data: base64,
                      });
                      setPatientDocuments(prev => [data.document, ...prev]);
                      toast.success(`${file.name} uploaded`);
                    } catch (err) {
                      toast.error(err.response?.data?.error || 'Upload failed');
                    } finally {
                      setDocUploading(false);
                      e.target.value = '';
                    }
                  }} />
              </label>
              )}
            </div>
            {patientDocuments.length === 0 ? (
              <div className="text-center text-gray-400 py-6 text-sm">No documents uploaded yet</div>
            ) : (
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {patientDocuments.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg group">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xl flex-shrink-0">
                        {doc.file_type?.includes('pdf') ? '📄' : doc.file_type?.includes('image') ? '🖼️' : '📎'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</div>
                        <div className="text-xs text-gray-400">
                          {doc.file_size_bytes ? `${(doc.file_size_bytes / 1024).toFixed(0)} KB · ` : ''}
                          {doc.created_at ? (() => { try { return format(parseISO(doc.created_at), 'd MMM yyyy'); } catch { return ''; } })() : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={async () => {
                          try {
                            const { data } = await api.get(`/admin/patients/${selectedPatient.id}/documents/${doc.id}`);
                            const a = document.createElement('a');
                            a.href = `data:${doc.file_type || 'application/octet-stream'};base64,${data.document.file_data}`;
                            a.download = doc.file_name;
                            a.click();
                          } catch { toast.error('Download failed'); }
                        }}
                        className="text-xs text-blue-600 hover:underline px-2 py-1">Download</button>
                      {isAdmin && (
                      <button
                        onClick={async () => {
                          if (!window.confirm(`Delete "${doc.file_name}"?`)) return;
                          try {
                            await api.delete(`/admin/patients/${selectedPatient.id}/documents/${doc.id}`);
                            setPatientDocuments(prev => prev.filter(d => d.id !== doc.id));
                            toast.success('Document deleted');
                          } catch { toast.error('Delete failed'); }
                        }}
                        className="text-xs text-red-400 hover:text-red-600 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
            <div key={day.day_of_week}>
              {/* Mobile card layout */}
              <div className={`sm:hidden rounded-lg p-3 mb-1 ${day.is_working ? 'bg-blue-50' : 'bg-gray-50'}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-700">{DAYS[day.day_of_week]}</span>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-xs text-gray-400">{day.is_working ? 'Working' : 'Off'}</span>
                    <div className="relative">
                      <input type="checkbox" className="sr-only" checked={day.is_working} onChange={e => updateScheduleDay(i, 'is_working', e.target.checked)} />
                      <div className={`w-9 h-5 rounded-full transition-colors ${day.is_working ? 'bg-blue-500' : 'bg-gray-300'}`} />
                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.is_working ? 'translate-x-4' : ''}`} />
                    </div>
                  </label>
                </div>
                {day.is_working && (<>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <p className="text-xs text-gray-400 mb-1">Start</p>
                      <input type="time" value={day.start_time} onChange={e => updateScheduleDay(i, 'start_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 mb-1">End</p>
                      <input type="time" value={day.end_time} onChange={e => updateScheduleDay(i, 'end_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" checked={day.has_lunch} onChange={e => updateScheduleDay(i, 'has_lunch', e.target.checked)} />
                      <div className={`w-9 h-5 rounded-full transition-colors ${day.has_lunch ? 'bg-orange-400' : 'bg-gray-300'}`} />
                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.has_lunch ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-gray-500">🍽 Lunch break</span>
                  </label>
                  {day.has_lunch && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-xs text-gray-400 mb-1">Break Start</p>
                        <input type="time" value={day.lunch_start_time} onChange={e => updateScheduleDay(i, 'lunch_start_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 w-full" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-1">Break End</p>
                        <input type="time" value={day.lunch_end_time} onChange={e => updateScheduleDay(i, 'lunch_end_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 w-full" />
                      </div>
                    </div>
                  )}
                </>)}
              </div>
              {/* Desktop row layout */}
              <div className={`hidden sm:grid grid-cols-[90px_60px_1fr_1fr_70px_1fr_1fr] gap-2 items-center px-2 py-2 rounded-lg transition-colors ${day.is_working ? 'bg-blue-50' : 'bg-gray-50'}`}>
                <span className="text-sm font-medium text-gray-700">{DAYS[day.day_of_week]}</span>
                <label className="flex items-center cursor-pointer">
                  <div className="relative">
                    <input type="checkbox" className="sr-only"
                      checked={day.is_working}
                      onChange={e => updateScheduleDay(i, 'is_working', e.target.checked)} />
                    <div className={`w-9 h-5 rounded-full transition-colors ${day.is_working ? 'bg-blue-500' : 'bg-gray-300'}`} />
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.is_working ? 'translate-x-4' : ''}`} />
                  </div>
                </label>
                <input type="time" value={day.start_time}
                  disabled={!day.is_working}
                  onChange={e => updateScheduleDay(i, 'start_time', e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-30 disabled:bg-gray-100 w-full" />
                <input type="time" value={day.end_time}
                  disabled={!day.is_working}
                  onChange={e => updateScheduleDay(i, 'end_time', e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-30 disabled:bg-gray-100 w-full" />
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
                <input type="time" value={day.lunch_start_time}
                  disabled={!day.is_working || !day.has_lunch}
                  onChange={e => updateScheduleDay(i, 'lunch_start_time', e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-30 disabled:bg-gray-100 w-full" />
                <input type="time" value={day.lunch_end_time}
                  disabled={!day.is_working || !day.has_lunch}
                  onChange={e => updateScheduleDay(i, 'lunch_end_time', e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-30 disabled:bg-gray-100 w-full" />
              </div>
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
          <button onClick={async () => { if (await saveSchedule()) await generateSlots(); }}
            disabled={scheduleSaving || generatingSlots}
            className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
            {generatingSlots ? 'Generating...' : '⚡ Save & Generate Slots'}
          </button>
        </div>
      </Modal>
    )}

    {/* ── CANCEL APPOINTMENT MODAL ── */}
    {cancellingAppt && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
          <h3 className="text-base font-semibold text-gray-900 mb-1">Cancel Appointment</h3>
          <div className="text-sm text-gray-600 mb-4 bg-gray-50 rounded-lg p-3">
            <div><span className="font-medium">{cancellingAppt.patient_name}</span> · {cancellingAppt.patient_phone}</div>
            <div className="text-xs text-gray-500 mt-0.5">Dr. {cancellingAppt.doctor_name} · {cancellingAppt.appointment_date} {cancellingAppt.appointment_time?.slice(0,5)}</div>
          </div>
          <div className="mb-5">
            <label className="block text-xs font-medium text-gray-700 mb-1">Reason for cancellation <span className="text-red-500">*</span></label>
            <textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="e.g. Patient request, Doctor unavailable, Emergency..."
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"
              autoFocus
            />
          </div>
          <div className="flex gap-3">
            <button onClick={() => { setCancellingAppt(null); setCancelReason(''); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Keep Appointment
            </button>
            <button onClick={confirmCancelAppointment} disabled={!cancelReason.trim()}
              className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition">
              Confirm Cancel
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── BULK CANCEL REASON MODAL ── */}
    {bulkCancelling && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
          <h3 className="text-base font-semibold text-gray-900 mb-1">
            Cancel {selectedApptIds.size} appointment{selectedApptIds.size !== 1 ? 's' : ''}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            The reason is sent to each patient, so keep it something you are happy for them to read.
          </p>
          <div className="mb-5">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Reason for cancellation <span className="text-red-500">*</span>
            </label>
            <textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="e.g. Doctor unavailable, Clinic closed for emergency..."
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"
              autoFocus
            />
          </div>
          <div className="flex gap-3">
            <button onClick={() => { setBulkCancelling(false); setCancelReason(''); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Keep Appointments
            </button>
            <button
              onClick={() => {
                const reason = cancelReason.trim();
                setBulkCancelling(false);
                setCancelReason('');
                bulkUpdateAppointments('cancelled', reason);
              }}
              disabled={!cancelReason.trim() || bulkUpdating}
              className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition">
              Confirm Cancel
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── WALK-IN APPOINTMENT MODAL ── */}
    {showWalkinModal && (
      <Modal title="New Walk-in Appointment" onClose={() => setShowWalkinModal(false)}>
        <form onSubmit={saveWalkin} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Patient Phone *</label>
              <input value={walkinForm.patient_phone} onChange={e => setWalkinForm(f => ({ ...f, patient_phone: e.target.value }))}
                placeholder="917795676142"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Patient Name</label>
              <input value={walkinForm.patient_name} onChange={e => setWalkinForm(f => ({ ...f, patient_name: e.target.value }))}
                placeholder="Full name (optional)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Hospital *</label>
              <select value={walkinForm.hospital_id} onChange={e => setWalkinForm(f => ({ ...f, hospital_id: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required>
                <option value="">— Select —</option>
                {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Doctor *</label>
              <select value={walkinForm.doctor_id} onChange={e => setWalkinForm(f => ({ ...f, doctor_id: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required>
                <option value="">— Select —</option>
                {doctors.filter(d => !walkinForm.hospital_id || d.hospital_id === walkinForm.hospital_id).map(d => (
                  <option key={d.id} value={d.id}>Dr. {d.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Date *</label>
              <input type="date" value={walkinForm.appointment_date} onChange={e => setWalkinForm(f => ({ ...f, appointment_date: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Time *</label>
              {/* Slot picker, not a free-text time: selecting a real slot sends
                  slot_id, which is what makes the backend lock it against the bot. */}
              <select
                value={walkinForm.slot_id}
                onChange={e => {
                  const v = e.target.value;
                  const slot = walkinSlots.find(s => s.id === v);
                  setWalkinForm(f => ({
                    ...f,
                    slot_id: v,
                    appointment_time: slot ? String(slot.start_time).slice(0, 5) : '',
                  }));
                }}
                disabled={!walkinForm.doctor_id || !walkinForm.appointment_date || walkinSlotsLoading}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                required
              >
                <option value="">
                  {!walkinForm.doctor_id || !walkinForm.appointment_date
                    ? '— Pick doctor and date first —'
                    : walkinSlotsLoading ? 'Loading slots…'
                    : walkinSlots.length ? '— Select an open slot —'
                    : 'No open slots for this doctor/date'}
                </option>
                {walkinSlots.map(s => (
                  <option key={s.id} value={s.id}>
                    {String(s.start_time).slice(0, 5)}
                    {s.end_time ? ` – ${String(s.end_time).slice(0, 5)}` : ''}
                  </option>
                ))}
                {/* Escape hatch: a genuine walk-in can arrive outside the
                    schedule, or before slots have been generated. Requiring a
                    slot in every case would block the feature's actual purpose —
                    but this path reserves nothing, so it is opt-in and labelled. */}
                <option value="__manual__">Other time (slot NOT reserved)</option>
              </select>
            </div>
          </div>
          {walkinForm.slot_id === '__manual__' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Time (unreserved) *</label>
              <input type="time" value={walkinForm.appointment_time}
                onChange={e => setWalkinForm(f => ({ ...f, appointment_time: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" required />
              <p className="text-xs text-amber-600 mt-1">
                ⚠️ No slot is reserved for this time, so the WhatsApp bot can still offer it to
                another patient. Use a listed slot whenever one is available.
              </p>
            </div>
          )}
          {walkinForm.doctor_id && walkinForm.appointment_date && !walkinSlotsLoading && !walkinSlots.length && (
            <p className="text-xs text-amber-600">
              No open slots — the dentist may be on leave, the clinic closed, or slots not yet
              generated for this date. Generate slots from the Dentists tab, pick another date,
              or use &ldquo;Other time&rdquo; to book without reserving.
            </p>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Visit Type</label>
            <select value={walkinForm.visit_type} onChange={e => setWalkinForm(f => ({ ...f, visit_type: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="in_person">In-Person</option>
              <option value="video">Video Consultation</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={walkinForm.notes} onChange={e => setWalkinForm(f => ({ ...f, notes: e.target.value }))}
              rows={2} placeholder="Optional notes..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setShowWalkinModal(false)}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={walkinSaving}
              className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
              {walkinSaving ? 'Booking...' : 'Create Appointment'}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* ── EDIT PATIENT MODAL ── */}
    {showPatientEditModal && editingPatient && (
      <Modal title={`Edit Patient — ${editingPatient.name || editingPatient.phone}`} onClose={() => { setShowPatientEditModal(false); setEditingPatient(null); }}>
        <form onSubmit={savePatient} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Full Name *</label>
            <input value={patientEditForm.name} onChange={e => setPatientEditForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Patient full name"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={patientEditForm.email} onChange={e => setPatientEditForm(f => ({ ...f, email: e.target.value }))}
              placeholder="patient@email.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Gender</label>
              <select value={patientEditForm.gender} onChange={e => setPatientEditForm(f => ({ ...f, gender: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— Select —</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Date of Birth</label>
              <input type="date" value={patientEditForm.date_of_birth} onChange={e => setPatientEditForm(f => ({ ...f, date_of_birth: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <p className="text-xs text-gray-400">Phone number cannot be changed here as it is the patient's WhatsApp identity.</p>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowPatientEditModal(false); setEditingPatient(null); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={patientEditSaving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
              {patientEditSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* ── APPOINTMENT NOTES MODAL (A5) ── */}
    {editingNotesId && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
          <h3 className="text-base font-semibold text-gray-900 mb-1">Clinical Notes</h3>
          <p className="text-xs text-gray-400 mb-4">Add observations, treatment details, or follow-up instructions for this appointment.</p>
          <textarea
            value={notesText}
            onChange={e => setNotesText(e.target.value)}
            rows={5}
            placeholder="e.g. Patient presented with tooth sensitivity. Prescribed desensitizing toothpaste. Follow up in 2 weeks if pain persists..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            autoFocus
          />
          <div className="flex gap-3 mt-4">
            <button onClick={() => setEditingNotesId(null)}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button onClick={() => saveApptNotes(editingNotesId)} disabled={notesSaving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
              {notesSaving ? 'Saving...' : '💾 Save Notes'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── CONFIRM MODAL ── */}
    {confirmModal && (
      <ConfirmModal
        title={confirmModal.title}
        message={confirmModal.message}
        danger={confirmModal.danger}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal(null)}
      />
    )}

    {/* ── SEND WHATSAPP MESSAGE MODAL ── */}
    {showWaMessageModal && (
      <Modal title="Send WhatsApp Message" onClose={() => setShowWaMessageModal(false)}>
        <form onSubmit={sendWaMessage} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Phone Number <span className="text-red-400">*</span></label>
            <input value={waMessagePhone} onChange={e => setWaMessagePhone(e.target.value)}
              placeholder="917795676142"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            <p className="text-xs text-gray-400 mt-1">Include country code, no + or spaces (e.g. 917795676142)</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Message <span className="text-red-400">*</span></label>
            <textarea value={waMessageText} onChange={e => setWaMessageText(e.target.value)}
              rows={4} maxLength={1000}
              placeholder="Type your message here..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" required />
            <p className="text-xs text-gray-400 mt-1">{waMessageText.length}/1000 characters</p>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-700">
            ⚠️ Only send messages to patients who have previously contacted this WhatsApp number. Unsolicited messages may violate WhatsApp policy.
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowWaMessageModal(false)}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={waSending}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
              {waSending ? 'Sending...' : '📤 Send Message'}
            </button>
          </div>
        </form>
      </Modal>
    )}

    </>
  );
}
