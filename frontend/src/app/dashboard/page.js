'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import api, { clearSessionTimers, resetSessionTimers } from '@/lib/api';
import { todayIST } from '@/lib/dateIST';
import ErrorBoundary from '@/components/ErrorBoundary';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import Modal from '@/components/ui/Modal';
import ConfirmModal from '@/components/ui/ConfirmModal';
import StatCard from '@/components/ui/StatCard';
import Badge from '@/components/ui/Badge';
import SlotsTab from '@/components/tabs/SlotsTab';

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
  const [tabLoading, setTabLoading] = useState(false);
  const [statsLastUpdated, setStatsLastUpdated] = useState(null);
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filterDate, setFilterDate] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [patientSearch, setPatientSearch] = useState('');
  const [botPhone, setBotPhone] = useState('917795676142');
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

  // Staff management state
  const [staff, setStaff] = useState([]);
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const [staffForm, setStaffForm] = useState({ name: '', email: '', password: '', role: 'staff' });
  const [staffSaving, setStaffSaving] = useState(false);

  // Settings state
  const [settings, setSettings] = useState(null);
  const [settingsForm, setSettingsForm] = useState({
    notify_phone: '',
    name: '', notification_prefs: {}
  });
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Notifications state
  const [notifications, setNotifications] = useState([]);
  const [notifCount, setNotifCount] = useState(0);
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);
  // Keys (appointment id + booking_id) of notifications already shown, so SSE
  // and the 30s poll never double-insert or re-count the same booking.
  const notifSeenKeys = useRef(new Set());

  // Calendar state
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [calendarAppts, setCalendarAppts] = useState([]);
  const [selectedCalDay, setSelectedCalDay] = useState(null);
  const [calDayAppts, setCalDayAppts] = useState([]);

  // Analytics summary state
  const [analyticsSummary, setAnalyticsSummary] = useState(null);

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState(null); // {title, message, onConfirm, danger}

  // Onboarding state
  const [onboarding, setOnboarding] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Doctor leaves state
  const [leavesDoctor, setLeavesDoctor] = useState(null);
  const [leaves, setLeaves] = useState([]);
  const [leavesLoading, setLeavesLoading] = useState(false);
  const [leaveDate, setLeaveDate] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [leavesDoctorList, setLeavesDoctorList] = useState([]);

  // Medical history edit state
  const [medHistory, setMedHistory] = useState({ blood_type: '', allergies: '', conditions: '', medications: '', notes: '' });
  const [medHistoryEditing, setMedHistoryEditing] = useState(false);
  const [medHistorySaving, setMedHistorySaving] = useState(false);

  // Feedback state
  const [feedback, setFeedback] = useState([]);
  const [feedbackPage, setFeedbackPage] = useState(1);
  const [feedbackHasMore, setFeedbackHasMore] = useState(false);
  const [feedbackAvgRating, setFeedbackAvgRating] = useState(null);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackDistribution, setFeedbackDistribution] = useState([]);

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

  // Change password state
  const [changePwdForm, setChangePwdForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [changingPwd, setChangingPwd] = useState(false);

  // Cancel appointment state
  const [cancellingAppt, setCancellingAppt] = useState(null); // appointment object
  const [cancelReason, setCancelReason] = useState('');
  const [apptTotal, setApptTotal] = useState(0);
  const [patientTotal, setPatientTotal] = useState(0);

  // Walk-in appointment state
  const [showWalkinModal, setShowWalkinModal] = useState(false);
  const [walkinForm, setWalkinForm] = useState({
    patient_phone: '', patient_name: '', doctor_id: '', hospital_id: '',
    appointment_date: '', appointment_time: '', visit_type: 'in_person', notes: '',
  });
  const [walkinSaving, setWalkinSaving] = useState(false);

  // Bot session reset state
  const [botResetting, setBotResetting] = useState(false);

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFrom, setAuditFrom] = useState('');
  const [auditTo, setAuditTo] = useState('');
  const [auditAction, setAuditAction] = useState('');

  // Bulk appointment update state
  const [selectedApptIds, setSelectedApptIds] = useState(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);

  // Send WhatsApp message state
  const [showWaMessageModal, setShowWaMessageModal] = useState(false);
  const [waMessagePhone, setWaMessagePhone] = useState('');
  const [waMessageText, setWaMessageText] = useState('');
  const [waSending, setWaSending] = useState(false);

  // Services (treatment catalog) state — A1
  const [services, setServices] = useState([]);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [editingService, setEditingService] = useState(null);
  const [serviceForm, setServiceForm] = useState({ name: '', description: '', category: '', duration_minutes: '30', price: '', hospital_id: '' });
  const [serviceSaving, setServiceSaving] = useState(false);

  // Holidays state — A4
  const [holidays, setHolidays] = useState([]);
  const [holidayForm, setHolidayForm] = useState({ hospital_id: '', holiday_date: '', name: '' });
  const [holidaySaving, setHolidaySaving] = useState(false);

  // Revenue analytics state — A6
  const [revenueData, setRevenueData] = useState(null);
  const [revenueMonths, setRevenueMonths] = useState(6);

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
              notifSeenKeys.current.add(key);
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

  const fetchAnalytics = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/analytics');
      setAnalytics(data);
    } catch { toast.error('Failed to load analytics'); }
  }, []);

  const fetchStaff = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/staff');
      setStaff(data.staff || []);
    } catch { toast.error('Failed to load staff'); }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/settings');
      setSettings(data);
      setSettingsForm({
        name: data.clinic_name || '',
        // PATCH /settings merges these keys into the TOP level of tenants.settings,
        // so read them back from there (settings.notification_prefs never exists).
        notification_prefs: {
          email_on_booking: data.settings?.email_on_booking,
          reminder_24h_enabled: data.settings?.reminder_24h_enabled,
          reminder_2h_enabled: data.settings?.reminder_2h_enabled,
        },
        notify_phone: data.notify_phone || '',
      });
    } catch { toast.error('Failed to load settings'); }
  }, []);

  const fetchAnalyticsSummary = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/analytics/summary');
      setAnalyticsSummary(data);
    } catch { /* silent */ }
  }, []);

  const fetchFeedback = useCallback(async (page = 1) => {
    try {
      const { data } = await api.get(`/admin/feedback?page=${page}&limit=25`);
      setFeedback(data.feedback || []);
      setFeedbackPage(page);
      setFeedbackHasMore(data.has_more || false);
      setFeedbackAvgRating(data.avg_rating);
      setFeedbackTotal(data.total || 0);
      setFeedbackDistribution(data.distribution || []);
    } catch { toast.error('Failed to load feedback'); }
  }, []);

  const fetchAuditLogs = useCallback(async (page = 1) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (auditFrom) params.set('from', auditFrom);
      if (auditTo) params.set('to', auditTo);
      if (auditAction) params.set('action', auditAction);
      const { data } = await api.get(`/admin/audit-logs?${params}`);
      setAuditLogs(data.logs || []);
      setAuditPage(page);
      setAuditHasMore(data.has_more || false);
      setAuditTotal(data.total || 0);
    } catch { toast.error('Failed to load audit logs'); }
  }, [auditFrom, auditTo, auditAction]);

  const fetchServices = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/services');
      setServices(data.services || []);
    } catch { toast.error('Failed to load services'); }
  }, []);

  const fetchHolidays = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/holidays');
      setHolidays(data.holidays || []);
    } catch { toast.error('Failed to load holidays'); }
  }, []);

  const fetchRevenue = useCallback(async (months) => {
    try {
      const m = months || revenueMonths;
      const { data } = await api.get(`/admin/analytics/revenue?months=${m}`);
      setRevenueData(data);
    } catch { /* silent — revenue section shows no-data state */ }
  }, [revenueMonths]);

  const fetchOnboarding = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/onboarding/status');
      setOnboarding(data);
      if (!data.all_done && !data.onboarding_completed) setShowOnboarding(true);
    } catch { /* silent */ }
  }, []);

  const fetchLeaves = useCallback(async (doctorId) => {
    if (!doctorId) return;
    setLeavesLoading(true);
    try {
      const { data } = await api.get(`/admin/doctors/${doctorId}/leaves`);
      setLeaves(data.leaves || []);
    } catch { toast.error('Failed to load leaves'); }
    finally { setLeavesLoading(false); }
  }, []);

  const fetchCalendarAppts = useCallback(async (year, month) => {
    try {
      const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${new Date(year, month + 1, 0).getDate()}`;
      // The backend caps `limit` at 100 and sorts DESC — a busy month can exceed
      // that, silently dropping the earliest days. Page through until has_more
      // is false (safety cap of 10 pages = 1000 appointments).
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const { data } = await api.get(
          `/admin/appointments?from=${startDate}&to=${endDate}&limit=100&page=${page}&status=confirmed,completed`
        );
        all.push(...(data.appointments || []));
        if (!data.has_more) break;
      }
      // Group by date
      const byDate = {};
      all.forEach(a => {
        const d = a.appointment_date;
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(a);
      });
      setCalendarAppts(byDate);
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
          if (n.id) notifSeenKeys.current.add(n.id);
          if (n.booking_id) notifSeenKeys.current.add(n.booking_id);
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

  async function changePassword(e) {
    e.preventDefault();
    if (changePwdForm.new_password !== changePwdForm.confirm_password) {
      return toast.error('New passwords do not match');
    }
    setChangingPwd(true);
    try {
      await api.post('/auth/change-password', {
        current_password: changePwdForm.current_password,
        new_password: changePwdForm.new_password,
      });
      toast.success('Password changed successfully');
      setChangePwdForm({ current_password: '', new_password: '', confirm_password: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    } finally { setChangingPwd(false); }
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
      }
      if (docsData.status === 'fulfilled') setPatientDocuments(docsData.value.data.documents || []);
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
    try {
      await api.patch(`/admin/slots/${slot.id}`, { status: newStatus });
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
        else if (tab === 'feedback') await fetchFeedback(1);
        else if (tab === 'analytics') { await fetchAnalytics(); await fetchAnalyticsSummary(); await fetchRevenue(); }
        else if (tab === 'services') { await fetchServices(); if (!hospitals.length) await fetchHospitals(); }
        else if (tab === 'holidays') { await fetchHolidays(); if (!hospitals.length) await fetchHospitals(); }
        else if (tab === 'hospitals') {
          const data = await fetchHospitals();
          if (data) await fetchAllHospitalDepts(data);
        }
        else if (tab === 'staff') await fetchStaff();
        else if (tab === 'slots') { if (!doctors.length) await fetchDoctors(); }
        else if (tab === 'leaves') { const { data } = await api.get('/admin/doctors'); setLeavesDoctorList(data.doctors || []); }
        else if (tab === 'settings') await fetchSettings();
        else if (tab === 'audit') await fetchAuditLogs(1);
        else if (tab === 'calendar') {
          const now = calendarDate;
          await fetchCalendarAppts(now.getFullYear(), now.getMonth());
        }
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
      await api.post('/admin/appointments', walkinForm);
      toast.success('Walk-in appointment created!');
      setShowWalkinModal(false);
      setWalkinForm({ patient_phone: '', patient_name: '', doctor_id: '', hospital_id: '', appointment_date: '', appointment_time: '', visit_type: 'in_person', notes: '' });
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

  async function resetBotSession() {
    if (!botPhone) return toast.error('Enter a phone number first');
    setBotResetting(true);
    try {
      await api.delete(`/admin/bot-sessions/${botPhone}`);
      toast.success(`Session reset for ${botPhone}`);
      setBotResponse(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'No active session found');
    } finally { setBotResetting(false); }
  }

  async function bulkUpdateAppointments(status) {
    if (selectedApptIds.size === 0) return toast.error('No appointments selected');
    setBulkUpdating(true);
    try {
      const { data } = await api.patch('/admin/appointments/bulk', {
        ids: [...selectedApptIds],
        status,
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

  async function saveService(e) {
    e.preventDefault();
    if (!serviceForm.name.trim()) return toast.error('Service name is required');
    setServiceSaving(true);
    try {
      const payload = { ...serviceForm, duration_minutes: Number(serviceForm.duration_minutes) || 30, price: Number(serviceForm.price) || 0 };
      if (editingService) {
        await api.patch(`/admin/services/${editingService.id}`, payload);
        toast.success('Service updated');
      } else {
        await api.post('/admin/services', payload);
        toast.success('Service added');
      }
      setShowServiceModal(false);
      setEditingService(null);
      setServiceForm({ name: '', description: '', category: '', duration_minutes: '30', price: '', hospital_id: '' });
      fetchServices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save service');
    } finally { setServiceSaving(false); }
  }

  function openEditService(svc) {
    setEditingService(svc);
    setServiceForm({ name: svc.name || '', description: svc.description || '', category: svc.category || '', duration_minutes: String(svc.duration_minutes || 30), price: String(svc.price || ''), hospital_id: svc.hospital_id || '' });
    setShowServiceModal(true);
  }

  function deleteService(svc) {
    setConfirmModal({
      title: `Remove "${svc.name}"?`,
      message: 'This service will be deactivated and hidden from bookings.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/services/${svc.id}`);
          toast.success('Service removed');
          fetchServices();
        } catch (err) { toast.error(err.response?.data?.error || 'Failed to remove'); }
      },
    });
  }

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
      if (w) setTimeout(() => URL.revokeObjectURL(url), 5000);
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

  // Staff handlers
  async function saveStaff(e) {
    e.preventDefault();
    if (!staffForm.name || !staffForm.email) return toast.error('Name and email required');
    if (!editingStaff && !staffForm.password) return toast.error('Password required for new staff');
    setStaffSaving(true);
    try {
      if (editingStaff) {
        const payload = { name: staffForm.name, role: staffForm.role };
        if (staffForm.password) payload.password = staffForm.password;
        await api.patch(`/admin/staff/${editingStaff.id}`, payload);
        toast.success('Staff updated');
      } else {
        await api.post('/admin/staff', staffForm);
        toast.success('Staff member added');
      }
      setShowStaffModal(false);
      setStaffForm({ name: '', email: '', password: '', role: 'staff' });
      setEditingStaff(null);
      fetchStaff();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save staff');
    } finally { setStaffSaving(false); }
  }

  function deactivateStaff(member) {
    setConfirmModal({
      title: `Deactivate ${member.name}?`,
      message: 'They will lose access to the dashboard immediately.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/staff/${member.id}`);
          toast.success('Staff member deactivated');
          fetchStaff();
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to deactivate');
        }
      },
    });
  }

  // Settings save
  async function saveSettings(e) {
    e.preventDefault();
    setSettingsSaving(true);
    try {
      const payload = {};
      if (settingsForm.name) payload.name = settingsForm.name;
      payload.notify_phone = settingsForm.notify_phone || '';
      await api.patch('/admin/settings', payload);
      toast.success('Settings saved!');
      fetchSettings();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save settings');
    } finally { setSettingsSaving(false); }
  }

  // Calendar helpers
  function getCalendarDays(year, month) {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(d);
    return days;
  }

  function formatCalDate(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
            <div className="space-y-6">
              {loading ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
                  {[1,2,3,4,5].map(i => (
                    <div key={i} className="bg-white rounded-xl p-5 border-l-4 border-gray-200 shadow-sm animate-pulse">
                      <div className="flex items-center justify-between">
                        <div className="space-y-2">
                          <div className="h-3 w-20 bg-gray-200 rounded" />
                          <div className="h-8 w-12 bg-gray-200 rounded" />
                        </div>
                        <div className="h-8 w-8 bg-gray-200 rounded-full" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400">
                    {statsLastUpdated ? `Updated ${statsLastUpdated.toLocaleTimeString()}` : ''}
                    {statsRefreshing && <span className="ml-2 text-blue-500 animate-pulse">↻ Refreshing...</span>}
                  </span>
                  <button onClick={() => fetchStats(true)} disabled={statsRefreshing}
                    className="text-xs text-blue-500 hover:text-blue-700 disabled:opacity-50 transition">
                    ↻ Refresh
                  </button>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
                  <StatCard label="Today" value={stats?.today_appointments} icon="📅" color="border-blue-500" />
                  <StatCard label="Upcoming" value={stats?.upcoming_appointments} icon="🗓" color="border-green-500" />
                  <StatCard label="Patients" value={stats?.total_patients} icon="👥" color="border-purple-500" />
                  <StatCard label="Open Slots" value={stats?.available_slots} icon="⏰" color="border-orange-500" />
                  <StatCard
                    label="Revenue (30d)"
                    value={analyticsSummary ? `₹${Number(analyticsSummary.revenue_30d || 0).toLocaleString('en-IN')}` : '—'}
                    icon="💰"
                    color="border-yellow-500"
                    sub={analyticsSummary ? `${analyticsSummary.no_show_rate || 0}% no-show` : undefined}
                  />
                </div>
                </>
              )}

              {/* Today's schedule skeleton */}
              {loading && (
                <div className="bg-white rounded-xl shadow-sm overflow-hidden animate-pulse">
                  <div className="px-5 py-4 border-b border-gray-100">
                    <div className="h-4 w-32 bg-gray-200 rounded" />
                  </div>
                  <div className="divide-y divide-gray-50">
                    {[1,2,3].map(i => (
                      <div key={i} className="px-5 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="h-4 w-10 bg-gray-200 rounded" />
                          <div className="space-y-1.5">
                            <div className="h-3 w-28 bg-gray-200 rounded" />
                            <div className="h-2.5 w-20 bg-gray-100 rounded" />
                          </div>
                        </div>
                        <div className="h-5 w-16 bg-gray-200 rounded-full" />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Today's schedule */}
              {!loading && stats?.todays_schedule?.length > 0 && (
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
                  <button onClick={() => setTab('doctors')} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition">Manage Dentists</button>
                  <button onClick={() => setTab('test')} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition">Test WhatsApp Bot</button>
                  <button onClick={async () => {
                    // Fetch fresh rows instead of racing the appointments tab's
                    // state via setTimeout — the old approach exported whatever
                    // stale (usually empty) list was in memory.
                    setTab('appointments');
                    try {
                      const { data } = await api.get('/admin/appointments?limit=100&page=1');
                      exportCSV(data.appointments || []);
                    } catch { toast.error('Failed to export'); }
                  }} className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">Export CSV</button>
                </div>
              </div>
            </div>
          )}

          {/* ── APPOINTMENTS ── */}
          {tab === 'appointments' && !tabLoading && (
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
                <span className="text-sm text-gray-400 ml-auto">{apptTotal > 0 ? `${apptTotal} total` : `${appointments.length} records`}</span>
                {isAdmin && (<>
                <button onClick={() => { setShowWaMessageModal(true); setWaMessagePhone(''); setWaMessageText(''); }}
                  className="px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition flex items-center gap-1.5">
                  📤 Message Patient
                </button>
                <button onClick={() => { if (!hospitals.length) fetchHospitals(); if (!doctors.length) fetchDoctors(); setWalkinForm({ patient_phone: '', patient_name: '', doctor_id: '', hospital_id: '', appointment_date: '', appointment_time: '', visit_type: 'in_person', notes: '' }); setShowWalkinModal(true); }}
                  className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-1.5">
                  + Walk-in
                </button>
                </>)}
              </div>

              {isAdmin && selectedApptIds.size > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium text-blue-700">{selectedApptIds.size} selected</span>
                  <button onClick={() => bulkUpdateAppointments('completed')} disabled={bulkUpdating}
                    className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
                    ✅ Mark Completed
                  </button>
                  <button onClick={() => bulkUpdateAppointments('no_show')} disabled={bulkUpdating}
                    className="px-3 py-1.5 bg-gray-600 text-white text-xs font-medium rounded-lg hover:bg-gray-700 disabled:opacity-50 transition">
                    🚫 Mark No-Show
                  </button>
                  <button onClick={() => bulkUpdateAppointments('cancelled')} disabled={bulkUpdating}
                    className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition">
                    ✕ Cancel All
                  </button>
                  <button onClick={() => setSelectedApptIds(new Set())}
                    className="px-3 py-1.5 border border-gray-300 text-gray-600 text-xs rounded-lg hover:bg-gray-50 transition ml-auto">
                    Clear selection
                  </button>
                </div>
              )}

              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                {/* Mobile appointment cards */}
                <div className="md:hidden divide-y divide-gray-100">
                  {appointments.map(a => (
                    <div key={`mob-${a.id}`} className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 truncate">{a.patient_name}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <a href={`https://wa.me/${a.patient_phone}`} target="_blank" rel="noreferrer"
                              className="text-xs text-green-600 hover:underline">{a.patient_phone}</a>
                            {isAdmin && (
                            <button onClick={() => { setShowWaMessageModal(true); setWaMessagePhone(a.patient_phone || ''); setWaMessageText(''); }}
                              className="text-xs text-green-500 hover:text-green-700">📤</button>
                            )}
                          </div>
                        </div>
                        <Badge status={a.status} />
                      </div>
                      <div className="text-xs text-gray-500 space-y-0.5">
                        <div>🦷 Dr. {a.doctor_name}</div>
                        <div>📅 {(() => { try { return format(parseISO(a.appointment_date), 'd MMM yy'); } catch { return a.appointment_date; } })()} at {a.appointment_time?.slice(0, 5)}</div>
                        <div className="font-mono text-blue-600">{a.booking_id} · <span className="capitalize">{a.visit_type?.replace('_', ' ')}</span></div>
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {a.status === 'confirmed' && (<>
                          <button onClick={() => updateApptStatus(a.id, 'completed')}
                            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-100 transition">
                            ✅ Done
                          </button>
                          <button onClick={() => updateApptStatus(a.id, 'no_show')}
                            className="px-3 py-1.5 text-xs bg-gray-50 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                            🚫 No Show
                          </button>
                          <button onClick={() => { setCancellingAppt(a); setCancelReason(''); }}
                            className="px-3 py-1.5 text-xs bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition">
                            ✕ Cancel
                          </button>
                        </>)}
                        <button onClick={() => printReceipt(a.id)}
                          className="px-3 py-1.5 text-xs bg-purple-50 text-purple-600 border border-purple-200 rounded-lg hover:bg-purple-100 transition">
                          🖨️ Receipt
                        </button>
                        <button onClick={() => { setEditingNotesId(a.id); setNotesText(a.notes || ''); }}
                          className={`px-3 py-1.5 text-xs border rounded-lg transition ${a.notes ? 'bg-yellow-50 text-yellow-700 border-yellow-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                          📝 {a.notes ? 'Notes' : 'Add Note'}
                        </button>
                      </div>
                    </div>
                  ))}
                  {!appointments.length && (
                    <div className="px-4 py-12 text-center text-gray-400">
                      No appointments found{filterDate || filterStatus ? ' for selected filters' : ''}
                    </div>
                  )}
                </div>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-3 w-8">
                          {isAdmin && (
                          <input type="checkbox"
                            checked={appointments.length > 0 && appointments.every(a => selectedApptIds.has(a.id))}
                            onChange={e => {
                              if (e.target.checked) setSelectedApptIds(new Set(appointments.map(a => a.id)));
                              else setSelectedApptIds(new Set());
                            }}
                            className="rounded border-gray-300 text-blue-600" />
                          )}
                        </th>
                        {['Booking ID', 'Patient', 'Doctor', 'Date', 'Time', 'Type', 'Status', 'Actions'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {appointments.map(a => (
                        <tr key={a.id} className={`hover:bg-gray-50 transition-colors ${selectedApptIds.has(a.id) ? 'bg-blue-50' : ''}`}>
                          <td className="px-3 py-3">
                            {isAdmin && (
                            <input type="checkbox" checked={selectedApptIds.has(a.id)}
                              onChange={e => {
                                const next = new Set(selectedApptIds);
                                if (e.target.checked) next.add(a.id); else next.delete(a.id);
                                setSelectedApptIds(next);
                              }}
                              className="rounded border-gray-300 text-blue-600" />
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs font-medium text-blue-600">{a.booking_id}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900 text-sm">{a.patient_name}</div>
                            <div className="flex items-center gap-1.5">
                              <a href={`https://wa.me/${a.patient_phone}`} target="_blank" rel="noreferrer"
                                className="text-xs text-green-600 hover:underline">{a.patient_phone}</a>
                              {isAdmin && (
                              <button onClick={() => { setShowWaMessageModal(true); setWaMessagePhone(a.patient_phone || ''); setWaMessageText(''); }}
                                title="Send WhatsApp message"
                                className="text-xs text-green-500 hover:text-green-700">📤</button>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-700 text-sm">Dr. {a.doctor_name}</td>
                          <td className="px-4 py-3 text-gray-600 text-sm">
                            {(() => { try { return format(parseISO(a.appointment_date), 'd MMM yy'); } catch { return a.appointment_date; } })()}
                          </td>
                          <td className="px-4 py-3 text-gray-600 text-sm">{a.appointment_time?.slice(0, 5)}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 capitalize">{a.visit_type?.replace('_', ' ')}</td>
                          <td className="px-4 py-3"><Badge status={a.status} /></td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {a.status === 'confirmed' && (<>
                                <button onClick={() => updateApptStatus(a.id, 'completed')}
                                  className="px-2 py-1 text-xs bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-100 transition whitespace-nowrap">
                                  ✅ Done
                                </button>
                                <button onClick={() => updateApptStatus(a.id, 'no_show')}
                                  className="px-2 py-1 text-xs bg-gray-50 text-gray-500 border border-gray-200 rounded hover:bg-gray-100 transition whitespace-nowrap">
                                  🚫 No Show
                                </button>
                                <button onClick={() => { setCancellingAppt(a); setCancelReason(''); }}
                                  className="px-2 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition whitespace-nowrap">
                                  ✕ Cancel
                                </button>
                              </>)}
                              <button onClick={() => printReceipt(a.id)} title="Print receipt"
                                className="px-2 py-1 text-xs bg-purple-50 text-purple-600 border border-purple-200 rounded hover:bg-purple-100 transition whitespace-nowrap">
                                🖨️ Receipt
                              </button>
                              <button onClick={() => { setEditingNotesId(a.id); setNotesText(a.notes || ''); }} title="Edit clinical notes"
                                className={`px-2 py-1 text-xs border rounded hover:bg-gray-100 transition whitespace-nowrap ${a.notes ? 'bg-yellow-50 text-yellow-700 border-yellow-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                                📝 {a.notes ? 'Notes' : 'Add Note'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!appointments.length && (
                        <tr>
                          <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                            No appointments found{filterDate || filterStatus ? ' for selected filters' : ''}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              {(apptPage > 1 || apptHasMore) && (
                <div className="flex items-center justify-between mt-2">
                  <button onClick={() => { const p = apptPage - 1; setApptPage(p); fetchAppointments(p); }}
                    disabled={apptPage === 1}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                    ← Previous
                  </button>
                  <span className="text-sm text-gray-500">Page {apptPage}</span>
                  <button onClick={() => { const p = apptPage + 1; setApptPage(p); fetchAppointments(p); }}
                    disabled={!apptHasMore}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── DOCTORS ── */}
          {tab === 'doctors' && !tabLoading && (
            <div className="space-y-4">
              {/* Plan quota warning */}
              {settings && settings.plan_limits && settings.usage && settings.usage.active_doctors >= settings.plan_limits.max_doctors && (
                <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex items-center gap-3">
                  <span className="text-xl">⚠️</span>
                  <div>
                    <p className="text-sm font-medium text-amber-800">Dentist limit reached ({settings.usage.active_doctors}/{settings.plan_limits.max_doctors})</p>
                    <p className="text-xs text-amber-600">Upgrade your plan to add more dentists.</p>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <p className="text-sm text-gray-500">{doctors.length} dentist{doctors.length !== 1 ? 's' : ''}</p>
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
                {isAdmin && (
                <div className="flex items-center gap-2">
                  <label className={`px-3 py-2 text-sm border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition whitespace-nowrap ${importingDoctors ? 'opacity-50 pointer-events-none' : ''}`}>
                    {importingDoctors ? '⏳ Importing...' : '📤 Import CSV'}
                    <input type="file" accept=".csv" className="hidden" onChange={importDoctorsCSV} disabled={importingDoctors} />
                  </label>
                  <button onClick={openAddDoctor}
                    className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
                    + Add Doctor
                  </button>
                </div>
                )}
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
                      {isAdmin && (
                      <button onClick={() => openEditDoctor(d)}
                        className="px-3 py-2 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition">
                        ✏️ Edit
                      </button>
                      )}
                      {isAdmin && (
                      <button onClick={() => openSchedule(d)}
                        className="px-3 py-2 text-xs font-medium border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 transition">
                        📅 Schedule
                      </button>
                      )}
                      <button onClick={() => openSlotsViewer(d)}
                        className="px-3 py-2 text-xs font-medium border border-green-200 text-green-600 rounded-lg hover:bg-green-50 transition">
                        ⏰ View Slots
                      </button>
                      {isAdmin && (
                      <button onClick={() => toggleDoctorStatus(d)}
                        className={`px-3 py-2 text-xs font-medium border rounded-lg transition ${d.is_active ? 'border-red-200 text-red-500 hover:bg-red-50' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                        {d.is_active ? '🚫 Deactivate' : '✅ Activate'}
                      </button>
                      )}
                    </div>
                  </div>
                ))}
                {!doctors.length && (
                  <div className="col-span-3 text-center py-16">
                    <div className="text-4xl mb-3">🦷</div>
                    <p className="text-gray-500 font-medium">No dentists yet</p>
                    <p className="text-gray-400 text-sm mt-1">Click "Add Dentist" to get started</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── PATIENTS ── */}
          {tab === 'patients' && !tabLoading && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Search by name, phone or email..."
                  value={patientSearch}
                  onChange={e => setPatientSearch(e.target.value)}
                  className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {isAdmin && (
                <label className={`px-3 py-1.5 text-sm border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition whitespace-nowrap ${importingPatients ? 'opacity-50 pointer-events-none' : ''}`}>
                  {importingPatients ? '⏳ Importing...' : '📤 Import CSV'}
                  <input type="file" accept=".csv" className="hidden" onChange={importPatientsCSV} disabled={importingPatients} />
                </label>
                )}
              </div>
              {patientTotal > 0 && (
                <p className="text-sm text-gray-400">{patientTotal} patient{patientTotal !== 1 ? 's' : ''} total</p>
              )}
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                {/* Mobile patient cards */}
                <div className="md:hidden divide-y divide-gray-100">
                  {patients.map(p => (
                    <div key={`mob-${p.id}`} className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 cursor-pointer truncate" onClick={() => openPatientHistory(p)}>
                            {p.name || '—'}
                          </div>
                          <a href={`https://wa.me/${p.phone}`} target="_blank" rel="noreferrer"
                            className="text-xs text-green-600 hover:underline">+{p.phone}</a>
                        </div>
                        <div className="text-xs text-gray-400 text-right shrink-0">
                          <div className="capitalize">{p.gender || '—'}</div>
                          <div>{p.visit_count} visits</div>
                        </div>
                      </div>
                      {isAdmin && (
                      <div className="flex gap-2 mt-3">
                        <button onClick={e => { e.stopPropagation(); openEditPatient(p); }}
                          className="px-3 py-2 text-xs text-blue-600 border border-blue-200 bg-blue-50 rounded-lg hover:bg-blue-100 transition">
                          ✏️ Edit
                        </button>
                        <button onClick={e => { e.stopPropagation(); deletePatient(p); }}
                          className="px-3 py-2 text-xs text-red-500 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 transition">
                          🗑 Delete
                        </button>
                      </div>
                      )}
                    </div>
                  ))}
                  {!patients.length && (
                    <div className="px-4 py-12 text-center text-gray-400">No patients found</div>
                  )}
                </div>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Name', 'Phone', 'Gender', 'DOB', 'Visits', 'Since', ''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {patients.map(p => (
                      <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-900 hover:text-blue-600 cursor-pointer" onClick={() => openPatientHistory(p)}>{p.name || '—'}</td>
                        <td className="px-4 py-3">
                          <a href={`https://wa.me/${p.phone}`} target="_blank" rel="noreferrer"
                            className="text-green-600 hover:underline">+{p.phone}</a>
                        </td>
                        <td className="px-4 py-3 capitalize text-gray-600">{p.gender || '—'}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs">
                          {p.date_of_birth ? (() => { try { return format(parseISO(p.date_of_birth), 'd MMM yyyy'); } catch { return p.date_of_birth; } })() : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{p.visit_count}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {p.created_at ? (() => { try { return format(parseISO(p.created_at), 'd MMM yyyy'); } catch { return ''; } })() : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {isAdmin && (
                          <div className="flex gap-2">
                            <button onClick={e => { e.stopPropagation(); openEditPatient(p); }}
                              className="text-xs text-blue-600 hover:underline whitespace-nowrap">✏️ Edit</button>
                            <button onClick={e => { e.stopPropagation(); deletePatient(p); }}
                              className="text-xs text-red-500 hover:underline whitespace-nowrap">🗑</button>
                          </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!patients.length && (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">No patients found</td></tr>
                    )}
                  </tbody>
                </table>
                </div>
              </div>
              {(patientPage > 1 || patientHasMore) && (
                <div className="flex items-center justify-between mt-2">
                  <button onClick={() => { const p = patientPage - 1; setPatientPage(p); fetchPatients(p); }}
                    disabled={patientPage === 1}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                    ← Previous
                  </button>
                  <span className="text-sm text-gray-500">Page {patientPage}</span>
                  <button onClick={() => { const p = patientPage + 1; setPatientPage(p); fetchPatients(p); }}
                    disabled={!patientHasMore}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── HOSPITALS ── */}
          {tab === 'hospitals' && !tabLoading && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{hospitals.length} hospital{hospitals.length !== 1 ? 's' : ''}</p>
                {isAdmin && (
                <button onClick={() => { setEditingHospital(null); setHospitalForm({ name: '', address: '', city: '', phone: '' }); setShowHospitalModal(true); }}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
                  + Add Hospital
                </button>
                )}
              </div>

              {hospitals.length === 0 ? (
                <div className="text-center py-16 bg-white rounded-xl shadow-sm">
                  <div className="text-5xl mb-3">🏥</div>
                  <p className="text-gray-500 font-medium">No hospitals yet</p>
                  <p className="text-gray-400 text-sm mt-1">Add your first hospital to get started</p>
                  {isAdmin && (
                  <button onClick={() => setShowHospitalModal(true)}
                    className="mt-4 px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
                    + Add Hospital
                  </button>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {hospitals.map(h => {
                    const depts = deptsByHospital[h.id] || [];
                    return (
                      <div key={h.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                        <div className="px-5 py-4 flex items-start justify-between border-b border-gray-50">
                          <div>
                            <h3 className="font-semibold text-gray-900 text-base">{h.name}</h3>
                            <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-500">
                              {h.city && <span>📍 {h.city}</span>}
                              {h.address && <span>{h.address}</span>}
                              {h.phone && <span>📞 {h.phone}</span>}
                            </div>
                          </div>
                          {isAdmin && (
                          <div className="flex items-center gap-2 shrink-0 ml-3">
                            <button onClick={() => openEditHospital(h)}
                              className="px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                              ✏️ Edit
                            </button>
                            <button
                              onClick={() => { setDeptHospital(h); setDeptForm({ name: '', description: '' }); setEditingDept(null); setShowDeptModal(true); }}
                              className="px-3 py-1.5 text-xs font-medium bg-green-50 text-green-600 border border-green-200 rounded-lg hover:bg-green-100 transition">
                              + Dept
                            </button>
                            <button onClick={() => deleteHospital(h)}
                              className="px-3 py-1.5 text-xs font-medium bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition">
                              🗑
                            </button>
                          </div>
                          )}
                        </div>
                        <div className="px-5 py-3">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                            Departments ({depts.length})
                          </p>
                          {depts.length === 0 ? (
                            <p className="text-sm text-gray-400 italic">No departments yet — add one to start booking</p>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {depts.map(d => (
                                <div key={d.id}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 text-sm rounded-lg border border-blue-100 group">
                                  <span>{d.name}</span>
                                  {d.description && <span className="text-blue-400 ml-1 text-xs">— {d.description}</span>}
                                  {isAdmin && (<>
                                  <button onClick={() => openEditDept(d, h)}
                                    className="ml-1 text-blue-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition text-xs">✏️</button>
                                  <button onClick={() => deleteDept(d, h)}
                                    className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition text-xs">✕</button>
                                  </>)}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── FEEDBACK ── */}
          {tab === 'feedback' && !tabLoading && (
            <div className="space-y-4">
              {/* Summary row */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white rounded-xl p-5 border-l-4 border-yellow-400 shadow-sm col-span-2 lg:col-span-1">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Avg Rating</p>
                  <p className="text-3xl font-bold text-gray-900 mt-1">
                    {feedbackAvgRating ? `${feedbackAvgRating} ⭐` : '—'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{feedbackTotal} total reviews</p>
                </div>
                {/* Star distribution */}
                <div className="bg-white rounded-xl p-5 shadow-sm col-span-2 lg:col-span-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Rating Distribution</p>
                  <div className="space-y-1.5">
                    {[5,4,3,2,1].map(star => {
                      const found = feedbackDistribution.find(d => parseInt(d.rating) === star);
                      const count = found ? parseInt(found.count) : 0;
                      const pct = feedbackTotal > 0 ? Math.round((count / feedbackTotal) * 100) : 0;
                      return (
                        <div key={star} className="flex items-center gap-2 text-sm">
                          <span className="text-xs text-gray-500 w-4">{star}⭐</span>
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div className="bg-yellow-400 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-500 w-10 text-right">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Feedback list */}
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        {['Patient', 'Doctor', 'Date', 'Rating', 'Comment'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {feedback.map(f => (
                        <tr key={f.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-900">{f.patient_name || '—'}</td>
                          <td className="px-4 py-3 text-gray-700">Dr. {f.doctor_name}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                            {f.appointment_date ? (() => { try { return format(parseISO(f.appointment_date), 'd MMM yy'); } catch { return f.appointment_date; } })() : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-yellow-500 font-medium">{'⭐'.repeat(f.rating)}</span>
                            <span className="text-gray-400 ml-1 text-xs">({f.rating}/5)</span>
                          </td>
                          <td className="px-4 py-3 text-gray-600 max-w-xs truncate" title={f.comment || ''}>
                            {f.comment || <span className="text-gray-300 italic">No comment</span>}
                          </td>
                        </tr>
                      ))}
                      {!feedback.length && (
                        <tr>
                          <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                            No feedback yet — it will appear here after patients rate their appointments
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {(feedbackPage > 1 || feedbackHasMore) && (
                <div className="flex items-center justify-between mt-2">
                  <button onClick={() => fetchFeedback(feedbackPage - 1)} disabled={feedbackPage === 1}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                    ← Previous
                  </button>
                  <span className="text-sm text-gray-500">Page {feedbackPage}</span>
                  <button onClick={() => fetchFeedback(feedbackPage + 1)} disabled={!feedbackHasMore}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── ANALYTICS ── */}
          {tab === 'analytics' && !tabLoading && (
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
                    {/* By Doctor — BarChart */}
                    <div className="bg-white rounded-xl p-5 shadow-sm">
                      <h3 className="font-semibold text-gray-800 mb-4">Top Dentists (30 days)</h3>
                      {analytics.by_doctor?.length > 0 ? (
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={analytics.by_doctor.slice(0, 6).map(d => ({ name: d.name.split(' ')[0], count: parseInt(d.count) }))} layout="vertical">
                            <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                            <Tooltip formatter={(v) => [v, 'Appointments']} />
                            <Bar dataKey="count" fill="#10b981" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <p className="text-gray-400 text-sm">No data yet</p>
                      )}
                    </div>
                  </div>
                  {/* Daily trend — Recharts LineChart */}
                  <div className="bg-white rounded-xl p-5 shadow-sm">
                    <h3 className="font-semibold text-gray-800 mb-4">Daily Appointments (30 days)</h3>
                    {analytics.by_day?.length > 0 ? (
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={analytics.by_day.map(d => ({ date: d.date?.slice(5), count: parseInt(d.count) }))}>
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={30} />
                          <Tooltip formatter={(v) => [v, 'Appointments']} />
                          <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-gray-400 text-sm py-8 text-center">No data yet — book appointments to see trends</p>
                    )}
                  </div>
                  {/* By Department */}
                  {analytics.by_department?.length > 0 && (
                    <div className="bg-white rounded-xl p-5 shadow-sm">
                      <h3 className="font-semibold text-gray-800 mb-4">By Department (30 days)</h3>
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={analytics.by_department.map(d => ({ name: d.name || 'Other', count: parseInt(d.count) }))}>
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={30} />
                          <Tooltip formatter={(v) => [v, 'Appointments']} />
                          <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center text-gray-400 py-12">Loading analytics...</div>
              )}

              {/* ── REVENUE SECTION (A6) ── */}
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-800">💰 Revenue Analytics</h3>
                  <select value={revenueMonths}
                    onChange={e => { const m = Number(e.target.value); setRevenueMonths(m); fetchRevenue(m); }}
                    className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {[3, 6, 12, 24].map(m => <option key={m} value={m}>Last {m} months</option>)}
                  </select>
                </div>
                {revenueData ? (
                  <div className="space-y-5">
                    {/* KPI cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                      <div className="bg-green-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-green-700">₹{(revenueData.total_revenue || 0).toLocaleString('en-IN')}</div>
                        <div className="text-xs text-green-600 mt-1">Total Revenue ({revenueMonths}m)</div>
                      </div>
                      <div className="bg-blue-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-blue-700">{revenueData.monthly?.length || 0}</div>
                        <div className="text-xs text-blue-600 mt-1">Active Months</div>
                      </div>
                      <div className="bg-purple-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-purple-700">
                          ₹{revenueData.monthly?.length ? Math.round((revenueData.total_revenue || 0) / revenueData.monthly.length).toLocaleString('en-IN') : 0}
                        </div>
                        <div className="text-xs text-purple-600 mt-1">Avg Monthly</div>
                      </div>
                    </div>
                    {/* Monthly revenue bar chart */}
                    {revenueData.monthly?.length > 0 && (
                      <div>
                        <h4 className="text-sm font-semibold text-gray-700 mb-3">Monthly Revenue (₹)</h4>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={revenueData.monthly.map(m => ({ month: m.month?.slice(0, 7), revenue: parseInt(m.revenue) || 0 }))}>
                            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={50} />
                            <Tooltip formatter={(v) => [`₹${v.toLocaleString('en-IN')}`, 'Revenue']} />
                            <Bar dataKey="revenue" fill="#22c55e" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                    {/* Top earning dentists */}
                    {revenueData.by_doctor?.length > 0 && (
                      <div>
                        <h4 className="text-sm font-semibold text-gray-700 mb-3">Top Earning Dentists</h4>
                        <div className="space-y-2">
                          {revenueData.by_doctor.slice(0, 5).map((d, i) => {
                            const maxRev = revenueData.by_doctor[0]?.revenue || 1;
                            const pct = Math.round((d.revenue / maxRev) * 100);
                            return (
                              <div key={d.name} className="flex items-center gap-3">
                                <span className="text-xs font-bold text-gray-400 w-4">#{i + 1}</span>
                                <span className="text-sm text-gray-700 w-28 truncate">Dr. {d.name}</span>
                                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                                </div>
                                <span className="text-sm font-semibold text-gray-800 w-24 text-right">₹{parseInt(d.revenue).toLocaleString('en-IN')}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {/* Revenue by treatment */}
                    {revenueData.by_treatment?.length > 0 && (
                      <div>
                        <h4 className="text-sm font-semibold text-gray-700 mb-3">Revenue by Treatment</h4>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                          {revenueData.by_treatment.slice(0, 6).map(t => (
                            <div key={t.treatment} className="bg-gray-50 rounded-lg p-3">
                              <div className="text-xs text-gray-500 truncate">{t.treatment}</div>
                              <div className="text-sm font-bold text-gray-800 mt-1">₹{parseInt(t.revenue).toLocaleString('en-IN')}</div>
                              <div className="text-xs text-gray-400">{t.count} appts</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center text-gray-400 py-8 text-sm">
                    Revenue data will appear here once you have completed appointments with consultation fees set.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── SERVICES (A1) ── */}
          {tab === 'services' && !tabLoading && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{services.length} treatment{services.length !== 1 ? 's' : ''} in catalog</p>
                {isAdmin && (
                <button onClick={() => { setEditingService(null); setServiceForm({ name: '', description: '', category: '', duration_minutes: '30', price: '', hospital_id: hospitals[0]?.id || '' }); setShowServiceModal(true); }}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition">
                  + Add Service
                </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {services.map(svc => (
                  <div key={svc.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 text-sm truncate">{svc.name}</h3>
                        {svc.category && <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{svc.category}</span>}
                      </div>
                      {isAdmin && (
                      <div className="flex gap-1 ml-2 shrink-0">
                        <button onClick={() => openEditService(svc)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition">✏️</button>
                        <button onClick={() => deleteService(svc)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition">🗑️</button>
                      </div>
                      )}
                    </div>
                    {svc.description && <p className="text-xs text-gray-500 mb-3 line-clamp-2">{svc.description}</p>}
                    <div className="flex items-center gap-3 text-xs text-gray-600">
                      <span className="bg-gray-100 px-2 py-1 rounded">⏱ {svc.duration_minutes} min</span>
                      {svc.price > 0 && <span className="bg-green-50 text-green-700 px-2 py-1 rounded font-semibold">₹{svc.price.toLocaleString('en-IN')}</span>}
                      {svc.hospital_name && <span className="text-gray-400 truncate">{svc.hospital_name}</span>}
                    </div>
                  </div>
                ))}
                {!services.length && (
                  <div className="col-span-3 text-center py-16 bg-white rounded-xl shadow-sm">
                    <div className="text-4xl mb-3">💊</div>
                    <p className="text-gray-500 font-medium">No services yet</p>
                    <p className="text-gray-400 text-sm mt-1">Add treatments like Root Canal, Cleaning, Braces consultation, etc.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── HOLIDAYS (A4) ── */}
          {tab === 'holidays' && !tabLoading && (
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
          )}

          {/* ── STAFF ── */}
          {tab === 'staff' && !tabLoading && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{staff.length} team member{staff.length !== 1 ? 's' : ''}</p>
                {isAdmin && (
                <button onClick={() => { setEditingStaff(null); setStaffForm({ name: '', email: '', password: '', role: 'staff' }); setShowStaffModal(true); }}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition">
                  + Add Staff
                </button>
                )}
              </div>
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Name', 'Email', 'Role', 'Status', 'Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {staff.map(m => (
                      <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-900">{m.name}</td>
                        <td className="px-4 py-3 text-gray-600 text-sm">{m.email}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${m.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {m.role}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${m.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-500'}`}>
                            {m.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {isAdmin && (
                          <div className="flex gap-2">
                            <button onClick={() => { setEditingStaff(m); setStaffForm({ name: m.name, email: m.email, password: '', role: m.role }); setShowStaffModal(true); }}
                              className="px-2 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-gray-50 transition">
                              ✏️ Edit
                            </button>
                            {m.is_active && (
                              <button onClick={() => deactivateStaff(m)}
                                className="px-2 py-1 text-xs border border-red-200 text-red-500 rounded hover:bg-red-50 transition">
                                🚫 Deactivate
                              </button>
                            )}
                          </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!staff.length && (
                      <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No staff members yet. Add one to get started.</td></tr>
                    )}
                  </tbody>
                </table>
                </div>
              </div>
            </div>
          )}

          {/* ── SETTINGS ── */}
          {tab === 'settings' && !tabLoading && (
            <div className="max-w-2xl space-y-6">
              <div className="bg-white rounded-xl p-6 shadow-sm">
                <h2 className="font-semibold text-gray-800 mb-5">Clinic Settings</h2>
                {settings === null ? (
                  <div className="text-gray-400 py-8 text-center">Loading settings...</div>
                ) : (
                  <form onSubmit={saveSettings} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Clinic Name</label>
                      <input value={settingsForm.name}
                        onChange={e => setSettingsForm(f => ({ ...f, name: e.target.value }))}
                        placeholder="Demo Clinic Hyderabad"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div className="pt-3 border-t border-gray-100">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">WhatsApp Integration</h3>
                      <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                        📱 WhatsApp is configured globally via a shared phone number. Contact your platform administrator to update credentials.
                      </p>
                    </div>
                    <div className="pt-3 border-t border-gray-100">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Notifications</h3>
                      <div className="space-y-3">
                        <label className="flex items-center gap-3 cursor-pointer select-none">
                          <div className="relative">
                            <input type="checkbox" className="sr-only"
                              checked={settingsForm.notification_prefs?.email_on_booking !== false}
                              onChange={e => setSettingsForm(f => ({ ...f, notification_prefs: { ...f.notification_prefs, email_on_booking: e.target.checked } }))} />
                            <div className={`w-10 h-5 rounded-full transition-colors ${settingsForm.notification_prefs?.email_on_booking !== false ? 'bg-blue-500' : 'bg-gray-300'}`} />
                            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settingsForm.notification_prefs?.email_on_booking !== false ? 'translate-x-5' : ''}`} />
                          </div>
                          <span className="text-sm text-gray-700">Email notification on new booking</span>
                        </label>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            SMS notification number
                            <span className="text-gray-400 font-normal ml-1">(optional — requires Twilio)</span>
                          </label>
                          <input
                            type="tel"
                            value={settingsForm.notify_phone}
                            onChange={e => setSettingsForm(f => ({ ...f, notify_phone: e.target.value }))}
                            placeholder="e.g. 917795676142"
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <p className="text-xs text-gray-400 mt-1">An SMS will be sent to this number each time an appointment is booked via the WhatsApp bot.</p>
                        </div>
                      </div>
                    </div>
                    <div className="pt-4">
                      {isAdmin ? (
                        <button type="submit" disabled={settingsSaving}
                          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
                          {settingsSaving ? 'Saving...' : '💾 Save Settings'}
                        </button>
                      ) : (
                        <p className="text-xs text-gray-400">Only clinic admins can change these settings.</p>
                      )}
                    </div>
                  </form>
                )}
              </div>
              {settings && (
                <div className="space-y-3">
                  {/* Plan Usage */}
                  {settings.plan_limits && (
                    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                        Plan Usage — <span className="text-blue-600 normal-case font-medium">{settings.plan_limits.name}</span>
                        {settings.plan_limits.price_monthly > 0 && (
                          <span className="text-gray-400 font-normal ml-1">(₹{settings.plan_limits.price_monthly}/mo)</span>
                        )}
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Dentists */}
                        <div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-600">Dentists</span>
                            <span className="font-medium text-gray-900">
                              {settings.usage?.active_doctors ?? '—'} / {settings.plan_limits.max_doctors === 999 ? '∞' : settings.plan_limits.max_doctors}
                            </span>
                          </div>
                          {settings.usage?.active_doctors != null && settings.plan_limits.max_doctors !== 999 && (
                            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  settings.usage.active_doctors / settings.plan_limits.max_doctors >= 0.9 ? 'bg-red-500' :
                                  settings.usage.active_doctors / settings.plan_limits.max_doctors >= 0.7 ? 'bg-yellow-500' : 'bg-green-500'
                                }`}
                                style={{ width: `${Math.min(100, Math.round(settings.usage.active_doctors / settings.plan_limits.max_doctors * 100))}%` }}
                              />
                            </div>
                          )}
                        </div>
                        {/* Appointments this month */}
                        <div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-600">Appts this month</span>
                            <span className="font-medium text-gray-900">
                              {settings.usage?.appointments_this_month ?? '—'} / {settings.plan_limits.max_appointments_per_month === 99999 ? '∞' : settings.plan_limits.max_appointments_per_month}
                            </span>
                          </div>
                          {settings.usage?.appointments_this_month != null && settings.plan_limits.max_appointments_per_month !== 99999 && (
                            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  settings.usage.appointments_this_month / settings.plan_limits.max_appointments_per_month >= 0.9 ? 'bg-red-500' :
                                  settings.usage.appointments_this_month / settings.plan_limits.max_appointments_per_month >= 0.7 ? 'bg-yellow-500' : 'bg-blue-500'
                                }`}
                                style={{ width: `${Math.min(100, Math.round(settings.usage.appointments_this_month / settings.plan_limits.max_appointments_per_month * 100))}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Account info */}
                  <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 text-xs text-gray-500 space-y-1.5">
                    <p><strong className="text-gray-700">Tenant slug:</strong> {settings.slug}</p>
                    <p><strong className="text-gray-700">Plan:</strong> {settings.plan}</p>
                    <p><strong className="text-gray-700">Owner:</strong> {settings.owner_email}</p>
                    <p><strong className="text-gray-700">Status:</strong> {settings.status}</p>
                  </div>
                </div>
              )}

              {/* Change Password */}
              <div className="bg-white rounded-xl p-6 shadow-sm">
                <h2 className="font-semibold text-gray-800 mb-1">Change Password</h2>
                <p className="text-xs text-gray-400 mb-5">Update your account password. Must be 8+ chars with uppercase, lowercase and a digit.</p>
                <form onSubmit={changePassword} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Current Password</label>
                    <input type="password" value={changePwdForm.current_password}
                      onChange={e => setChangePwdForm(f => ({ ...f, current_password: e.target.value }))}
                      placeholder="Enter current password"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">New Password</label>
                      <input type="password" value={changePwdForm.new_password}
                        onChange={e => setChangePwdForm(f => ({ ...f, new_password: e.target.value }))}
                        placeholder="New password"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Confirm New Password</label>
                      <input type="password" value={changePwdForm.confirm_password}
                        onChange={e => setChangePwdForm(f => ({ ...f, confirm_password: e.target.value }))}
                        placeholder="Confirm new password"
                        className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          changePwdForm.confirm_password && changePwdForm.new_password !== changePwdForm.confirm_password
                            ? 'border-red-300 bg-red-50' : 'border-gray-300'
                        }`} required />
                    </div>
                  </div>
                  {changePwdForm.confirm_password && changePwdForm.new_password !== changePwdForm.confirm_password && (
                    <p className="text-xs text-red-500">Passwords do not match</p>
                  )}
                  <div className="pt-2">
                    <button type="submit" disabled={changingPwd || (changePwdForm.confirm_password && changePwdForm.new_password !== changePwdForm.confirm_password)}
                      className="px-6 py-2.5 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-900 disabled:opacity-50 transition">
                      {changingPwd ? 'Changing...' : '🔒 Change Password'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ── CALENDAR ── */}
          {tab === 'calendar' && !tabLoading && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => {
                    const d = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
                    setCalendarDate(d); setSelectedCalDay(null);
                    fetchCalendarAppts(d.getFullYear(), d.getMonth());
                  }}
                  className="p-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-gray-600">← Prev</button>
                <h2 className="font-semibold text-gray-800 text-base min-w-[160px] text-center">
                  {calendarDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
                </h2>
                <button
                  onClick={() => {
                    const d = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
                    setCalendarDate(d); setSelectedCalDay(null);
                    fetchCalendarAppts(d.getFullYear(), d.getMonth());
                  }}
                  className="p-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-gray-600">Next →</button>
                <button
                  onClick={() => {
                    const d = new Date();
                    const first = new Date(d.getFullYear(), d.getMonth(), 1);
                    setCalendarDate(first); setSelectedCalDay(null);
                    fetchCalendarAppts(first.getFullYear(), first.getMonth());
                  }}
                  className="px-3 py-1.5 text-sm border border-blue-300 text-blue-600 rounded-lg hover:bg-blue-50 transition">
                  Today
                </button>
              </div>
              <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
                <div className="flex-1 min-w-0 bg-white rounded-xl shadow-sm overflow-hidden">
                  <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                      <div key={d} className="py-2 text-center text-xs font-semibold text-gray-400 uppercase">{d}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7">
                    {getCalendarDays(calendarDate.getFullYear(), calendarDate.getMonth()).map((day, i) => {
                      if (!day) return <div key={`e-${i}`} className="border-r border-b border-gray-100 min-h-[76px]" />;
                      const dateStr = formatCalDate(calendarDate.getFullYear(), calendarDate.getMonth(), day);
                      const dayAppts = calendarAppts[dateStr] || [];
                      const todayStr = todayIST();
                      const isToday = dateStr === todayStr;
                      const isSelected = selectedCalDay === dateStr;
                      return (
                        <div key={day}
                          onClick={() => { setSelectedCalDay(dateStr); setCalDayAppts(dayAppts); }}
                          className={`border-r border-b border-gray-100 min-h-[76px] p-2 cursor-pointer transition-colors
                            ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                          <div className={`text-sm font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full mx-auto
                            ${isToday ? 'bg-blue-600 text-white' : 'text-gray-700'}`}>
                            {day}
                          </div>
                          {dayAppts.length > 0 && (
                            <div className={`text-xs px-1 py-0.5 rounded text-center font-medium
                              ${dayAppts.length >= 5 ? 'bg-red-100 text-red-700' : dayAppts.length >= 3 ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                              {dayAppts.length} appt{dayAppts.length !== 1 ? 's' : ''}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                {selectedCalDay && (
                  <div className="w-full lg:w-72 lg:shrink-0 bg-white rounded-xl shadow-sm overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                      <h3 className="font-semibold text-gray-800 text-sm">
                        {(() => { try { return format(parseISO(selectedCalDay), 'EEEE, d MMMM'); } catch { return selectedCalDay; } })()}
                      </h3>
                      <p className="text-xs text-gray-400 mt-0.5">{calDayAppts.length} appointment{calDayAppts.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="divide-y divide-gray-50 max-h-[440px] overflow-y-auto">
                      {calDayAppts.length === 0 ? (
                        <div className="px-4 py-8 text-center text-gray-400 text-sm">No appointments this day</div>
                      ) : calDayAppts.map(a => (
                        <div key={a.id} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-semibold text-blue-600">{a.appointment_time?.slice(0, 5)}</span>
                            <Badge status={a.status} />
                          </div>
                          <div className="text-sm font-medium text-gray-900">{a.patient_name}</div>
                          <div className="text-xs text-gray-500">Dr. {a.doctor_name}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── DOCTOR LEAVES ── */}
          {tab === 'leaves' && !tabLoading && (
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
                        <div className="flex flex-wrap gap-3 items-end">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Leave Date *</label>
                            <input type="date" value={leaveDate}
                              onChange={e => setLeaveDate(e.target.value)}
                              min={todayIST()}
                              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                          </div>
                          <div className="flex-1 min-w-[160px]">
                            <label className="block text-xs font-medium text-gray-700 mb-1">Reason (optional)</label>
                            <input value={leaveReason}
                              onChange={e => setLeaveReason(e.target.value)}
                              placeholder="e.g. Medical conference, personal leave"
                              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                          </div>
                          <button onClick={addLeave} disabled={leaveSaving || !leaveDate}
                            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition whitespace-nowrap">
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
                        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
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
                              <div key={l.id} className="px-5 py-3 flex items-center justify-between">
                                <div>
                                  <div className="text-sm font-medium text-gray-900">
                                    {(() => { try { return format(parseISO(l.leave_date), 'EEEE, d MMMM yyyy'); } catch { return l.leave_date; } })()}
                                  </div>
                                  {l.reason && <div className="text-xs text-gray-400 mt-0.5">{l.reason}</div>}
                                </div>
                                {isAdmin && (
                                <button onClick={() => removeLeave(leavesDoctor.id, l.leave_date)}
                                  className="px-2 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 transition">
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
          )}

          {/* ── AUDIT LOGS ── */}
          {tab === 'audit' && isAdmin && !tabLoading && (
            <div className="space-y-4">
              {/* Filters */}
              <div className="bg-white rounded-xl p-4 shadow-sm flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
                  <input type="date" value={auditFrom} onChange={e => setAuditFrom(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
                  <input type="date" value={auditTo} onChange={e => setAuditTo(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Action</label>
                  <input value={auditAction} onChange={e => setAuditAction(e.target.value)}
                    placeholder="e.g. CREATE_DOCTOR"
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-44 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <button onClick={() => fetchAuditLogs(1)}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition">
                  Search
                </button>
                <span className="text-sm text-gray-400 ml-auto">{auditTotal} records</span>
              </div>

              {/* Table */}
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        {['Timestamp', 'Role', 'Action', 'Resource', 'Resource ID', 'IP'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {auditLogs.map(log => (
                        <tr key={log.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                            {log.created_at ? new Date(log.created_at).toLocaleString('en-IN') : '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${log.actor_role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                              {log.actor_role || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs font-medium text-gray-800">{log.action || '—'}</td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">{log.resource_type || '—'}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-gray-400 truncate max-w-[120px]">{log.resource_id || '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-400">{log.ip_address || '—'}</td>
                        </tr>
                      ))}
                      {!auditLogs.length && (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No audit log entries found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {(auditLogs.length > 0 || auditPage > 1) && (
                  <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-3">
                    <button disabled={auditPage <= 1}
                      onClick={() => fetchAuditLogs(auditPage - 1)}
                      className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                      ← Prev
                    </button>
                    <span className="text-sm text-gray-500">Page {auditPage}</span>
                    <button disabled={!auditHasMore}
                      onClick={() => fetchAuditLogs(auditPage + 1)}
                      className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
                      Next →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── SLOTS ── */}
          {tab === 'slots' && !tabLoading && (
            <SlotsTab doctors={doctors} />
          )}

          {/* ── BOT TESTER ── */}
          {tab === 'test' && !tabLoading && (
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
                    placeholder="917795676142" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
                  <input value={botMessage} onChange={e => setBotMessage(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && testBot()}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Hi" />
                </div>
                <div className="flex flex-wrap gap-2">
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
                {isAdmin && (
                <div className="pt-1 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-gray-400">If the bot gets stuck, reset the session to start fresh.</span>
                  <button onClick={resetBotSession} disabled={botResetting}
                    className="px-3 py-1.5 text-xs border border-orange-200 text-orange-600 rounded-lg hover:bg-orange-50 disabled:opacity-50 transition whitespace-nowrap">
                    {botResetting ? 'Resetting...' : '🔄 Reset Session'}
                  </button>
                </div>
                )}
              </div>

              {botResponse && (
                <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-700">
                      🤖 Bot replied ({botResponse.responses?.length || 0} message{botResponse.responses?.length !== 1 ? 's' : ''})
                    </span>
                    <span className="text-xs text-gray-400">{botResponse.tenant}</span>
                  </div>
                  {/* WhatsApp-style chat bubbles */}
                  <div className="p-4 space-y-3 bg-[#e5ddd5] min-h-[80px]">
                    {/* Outgoing user message */}
                    <div className="flex justify-end">
                      <div className="bg-[#dcf8c6] rounded-lg rounded-tr-none px-3 py-2 max-w-xs shadow-sm">
                        <p className="text-sm text-gray-800">{botResponse.message}</p>
                        <p className="text-xs text-gray-400 text-right mt-0.5">You</p>
                      </div>
                    </div>
                    {/* Bot responses */}
                    {botResponse.responses?.map((r, i) => (
                      <div key={i} className="flex justify-start">
                        <div className="bg-white rounded-lg rounded-tl-none px-3 py-2 max-w-sm shadow-sm">
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">{r.text}</p>
                          {r.buttons && (
                            <div className="mt-2 pt-2 border-t border-gray-100 flex flex-col gap-1.5">
                              {r.buttons.map((b, bi) => (
                                <button key={bi}
                                  onClick={() => { setBotMessage(String(b)); }}
                                  className="text-sm text-blue-600 py-1 border border-blue-200 rounded-lg hover:bg-blue-50 transition text-center">
                                  {b}
                                </button>
                              ))}
                            </div>
                          )}
                          {r.sections && r.sections.map((s, si) => (
                            <div key={si} className="mt-2 pt-2 border-t border-gray-100">
                              {s.title && <p className="text-xs font-semibold text-gray-500 mb-1.5">{s.title}</p>}
                              <div className="flex flex-col gap-1">
                                {s.rows?.map((row, ri) => (
                                  <button key={ri}
                                    onClick={() => setBotMessage(row.id || row.title)}
                                    className="text-left text-sm px-2 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 transition">
                                    <span className="font-medium text-gray-800">{row.title}</span>
                                    {row.description && <span className="text-xs text-gray-400 ml-1">· {row.description}</span>}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                          <p className="text-xs text-gray-400 text-right mt-1">MediBook Bot</p>
                        </div>
                      </div>
                    ))}
                    {!botResponse.responses?.length && (
                      <div className="text-center text-gray-500 text-sm py-4">Bot sent no response — check backend logs</div>
                    )}
                  </div>
                </div>
              )}
            </div>
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
                        <div className={`text-sm px-2.5 py-1.5 rounded-lg ${medHistory[key] ? 'text-gray-800 bg-gray-50' : 'text-gray-300 italic'}`}>
                          {medHistory[key] || 'Not recorded'}
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
          <button onClick={async () => { await saveSchedule(); await generateSlots(); }}
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
              <input type="time" value={walkinForm.appointment_time} onChange={e => setWalkinForm(f => ({ ...f, appointment_time: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
          </div>
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

    {/* ── ADD / EDIT SERVICE MODAL (A1) ── */}
    {showServiceModal && (
      <Modal title={editingService ? `Edit "${editingService.name}"` : 'Add Treatment Service'} onClose={() => { setShowServiceModal(false); setEditingService(null); }}>
        <form onSubmit={saveService} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Service Name <span className="text-red-400">*</span></label>
            <input value={serviceForm.name} onChange={e => setServiceForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Root Canal Treatment, Teeth Cleaning"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
            <select value={serviceForm.category} onChange={e => setServiceForm(f => ({ ...f, category: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Select category —</option>
              {['Preventive', 'Restorative', 'Cosmetic', 'Orthodontics', 'Surgery', 'Endodontics', 'Periodontics', 'Pediatric', 'Other'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
            <textarea value={serviceForm.description} onChange={e => setServiceForm(f => ({ ...f, description: e.target.value }))}
              rows={2} placeholder="Brief description of the treatment"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Duration (minutes)</label>
              <select value={serviceForm.duration_minutes} onChange={e => setServiceForm(f => ({ ...f, duration_minutes: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {[15, 20, 30, 45, 60, 90, 120].map(m => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Price (₹)</label>
              <input type="number" min="0" value={serviceForm.price}
                onChange={e => setServiceForm(f => ({ ...f, price: e.target.value }))}
                placeholder="0"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Branch (optional)</label>
            <select value={serviceForm.hospital_id} onChange={e => setServiceForm(f => ({ ...f, hospital_id: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— All Branches —</option>
              {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowServiceModal(false); setEditingService(null); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={serviceSaving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
              {serviceSaving ? 'Saving...' : editingService ? 'Update Service' : 'Add Service'}
            </button>
          </div>
        </form>
      </Modal>
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

    {/* ── ADD / EDIT STAFF MODAL ── */}
    {showStaffModal && (
      <Modal title={editingStaff ? `Edit ${editingStaff.name}` : 'Add Staff Member'} onClose={() => { setShowStaffModal(false); setEditingStaff(null); }}>
        <form onSubmit={saveStaff} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Full Name *</label>
            <input value={staffForm.name} onChange={e => setStaffForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Ravi Kumar"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Email *</label>
            <input type="email" value={staffForm.email}
              onChange={e => setStaffForm(f => ({ ...f, email: e.target.value }))}
              placeholder="ravi@clinic.com"
              disabled={!!editingStaff}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Password {editingStaff && <span className="text-gray-400 font-normal">(leave blank to keep existing)</span>}
            </label>
            <input type="password" value={staffForm.password}
              onChange={e => setStaffForm(f => ({ ...f, password: e.target.value }))}
              placeholder={editingStaff ? 'New password (optional)' : 'Set a password *'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Role</label>
            <select value={staffForm.role} onChange={e => setStaffForm(f => ({ ...f, role: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowStaffModal(false); setEditingStaff(null); }}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={staffSaving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
              {staffSaving ? 'Saving...' : editingStaff ? 'Update Staff' : 'Add Staff'}
            </button>
          </div>
        </form>
      </Modal>
    )}
    </>
  );
}
