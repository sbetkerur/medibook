'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api, { getApiError } from '@/lib/api';
import BrandMark from '@/components/BrandMark';
import toast from 'react-hot-toast';

const QUICK_TREATMENTS = [
  'General Dentistry', 'Root Canal Treatment', 'Orthodontics & Braces',
  'Cosmetic Dentistry', 'Teeth Cleaning',
];
const DAYS = [
  ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6],
];
const STEPS = ['Welcome', 'Clinic', 'Treatments', 'Dentist', 'QR code'];

export default function OnboardingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // shared state
  const [hospitalId, setHospitalId] = useState(null);
  const [clinic, setClinic] = useState({ name: '', address: '', city: '', phone: '' });
  const [departments, setDepartments] = useState([]); // [{id,name}]
  const [newDept, setNewDept] = useState('');
  const [doctor, setDoctor] = useState({
    name: '', specialization: '', qualification: '',
    department_ids: [], consultation_fee: '', slot_duration_minutes: '30',
  });
  const [doctorId, setDoctorId] = useState(null);
  const [sched, setSched] = useState({
    days: [1, 2, 3, 4, 5], start: '10:00', end: '19:00', lunchOn: true, lunchStart: '14:00', lunchEnd: '15:00',
  });
  const [qr, setQr] = useState(null);

  // ── boot ────────────────────────────────────────────────
  useEffect(() => {
    if (!localStorage.getItem('token')) { router.push('/login'); return; }
    try { setUser(JSON.parse(localStorage.getItem('user') || '{}')); } catch {}
    (async () => {
      try {
        const [{ data: s }, { data: h }, { data: d }] = await Promise.all([
          api.get('/admin/settings').catch(() => ({ data: {} })),
          api.get('/admin/hospitals').catch(() => ({ data: { hospitals: [] } })),
          api.get('/admin/departments').catch(() => ({ data: { departments: [] } })),
        ]);
        const primary = (h.hospitals || [])[0] || null;
        if (primary) setHospitalId(primary.id);
        setClinic({
          name: s.clinic_name || '',
          address: primary?.address || s.hospital?.address || '',
          city: primary?.city || s.hospital?.city || '',
          phone: primary?.phone || s.hospital?.phone || '',
        });
        setDepartments((d.departments || []).map((x) => ({ id: x.id, name: x.name })));
      } finally { setReady(true); }
    })();
  }, [router]);

  const next = () => { setErr(''); setI((n) => Math.min(n + 1, STEPS.length - 1)); };
  const back = () => { setErr(''); setI((n) => Math.max(n - 1, 0)); };
  const skip = () => router.push('/dashboard');

  // ── step savers ─────────────────────────────────────────
  async function saveClinic() {
    setBusy(true); setErr('');
    try {
      if (hospitalId) {
        await api.patch(`/admin/hospitals/${hospitalId}`, {
          name: clinic.name || undefined, address: clinic.address, city: clinic.city, phone: clinic.phone,
        });
      } else {
        const { data } = await api.post('/admin/hospitals', {
          name: clinic.name || (user?.tenant || 'Main branch'),
          address: clinic.address, city: clinic.city, phone: clinic.phone,
        });
        setHospitalId(data.hospital.id);
      }
      if (clinic.name) await api.patch('/admin/settings', { name: clinic.name }).catch(() => {});
      next();
    } catch (e) { setErr(getApiError(e, 'Could not save clinic details')); }
    finally { setBusy(false); }
  }

  async function addDept(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    if (departments.some((d) => d.name.toLowerCase() === clean.toLowerCase())) { setNewDept(''); return; }
    if (!hospitalId) { setErr('Save your clinic details first.'); return; }
    setBusy(true); setErr('');
    try {
      const { data } = await api.post('/admin/departments', { name: clean, hospital_id: hospitalId });
      setDepartments((d) => [...d, { id: data.department.id, name: data.department.name }]);
      setNewDept('');
    } catch (e) { setErr(getApiError(e, 'Could not add treatment')); }
    finally { setBusy(false); }
  }

  function toggleDoctorDept(id) {
    setDoctor((d) => ({
      ...d,
      department_ids: d.department_ids.includes(id)
        ? d.department_ids.filter((x) => x !== id)
        : [...d.department_ids, id],
    }));
  }

  async function saveDentist() {
    setBusy(true); setErr('');
    try {
      if (!doctor.name.trim()) throw new Error('Enter the dentist’s name');
      if (!doctor.department_ids.length) throw new Error('Pick at least one treatment');
      if (!sched.days.length) throw new Error('Pick at least one working day');

      let id = doctorId;
      if (!id) {
        const { data } = await api.post('/admin/doctors', {
          name: doctor.name.trim(),
          specialization: doctor.specialization.trim() || undefined,
          qualification: doctor.qualification.trim() || undefined,
          hospital_id: hospitalId,
          department_ids: doctor.department_ids,
          consultation_fee: Number(doctor.consultation_fee) || 0,
          slot_duration_minutes: Number(doctor.slot_duration_minutes) || 30,
        });
        id = data.doctor.id;
        setDoctorId(id);
      }

      const schedules = sched.days.map((dow) => ({
        day_of_week: dow,
        start_time: sched.start,
        end_time: sched.end,
        is_working: true,
        hospital_id: hospitalId,
        ...(sched.lunchOn ? { lunch_start_time: sched.lunchStart, lunch_end_time: sched.lunchEnd } : {}),
      }));
      await api.post(`/admin/doctors/${id}/schedule`, { schedules });
      await api.post('/admin/slots/generate', { doctor_id: id, days: 14, clear: false }).catch(() => {});
      next();
    } catch (e) {
      setErr(e?.response ? getApiError(e, 'Could not save the dentist') : e.message);
    } finally { setBusy(false); }
  }

  const loadQr = useCallback(async () => {
    try { const { data } = await api.get('/admin/clinic-qr'); setQr(data); }
    catch { setQr({ configured: false }); }
  }, []);
  useEffect(() => { if (i === 4 && !qr) loadQr(); }, [i, qr, loadQr]);

  async function finish() {
    setBusy(true);
    try { await api.post('/admin/onboarding/complete'); } catch {}
    router.push('/dashboard');
  }

  async function copyQrLink() {
    try { await navigator.clipboard.writeText(qr.link); toast.success('Link copied'); }
    catch { toast.error('Could not copy — select the link and copy it by hand'); }
  }

  if (!ready) {
    return <Shell><p className="text-gray-400 text-sm text-center py-10">Loading…</p></Shell>;
  }

  const reviewing = user?.tenant_status === 'pending_review';
  const inputCls =
    'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent';

  return (
    <Shell>
      {/* progress */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
          <span>Step {i + 1} of {STEPS.length}</span>
          <button onClick={skip} className="hover:text-gray-600 underline">Skip for now</button>
        </div>
        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full bg-blue-600 transition-all" style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} />
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
      )}

      {/* ── Welcome ── */}
      {i === 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold text-gray-900">Welcome{user?.name ? `, ${user.name.split(' ')[0]}` : ''} 👋</h2>
          <p className="text-sm text-gray-600">
            Let’s get <strong>{user?.tenant || 'your clinic'}</strong> ready to take bookings on WhatsApp.
            It takes about 5 minutes — you can change anything later.
          </p>
          {reviewing && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              A MediBook admin is reviewing your clinic. You can finish setup now; patients can reach you
              as soon as it’s approved (usually within a few hours).
            </div>
          )}
          <Nav onNext={next} nextLabel="Get started" />
        </div>
      )}

      {/* ── Clinic details ── */}
      {i === 1 && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-gray-900">Your clinic</h2>
          <F label="Clinic name">
            <input className={inputCls} value={clinic.name} onChange={(e) => setClinic({ ...clinic, name: e.target.value })} />
          </F>
          <F label="Address">
            <input className={inputCls} value={clinic.address} onChange={(e) => setClinic({ ...clinic, address: e.target.value })} />
          </F>
          <div className="grid grid-cols-2 gap-4">
            <F label="City">
              <input className={inputCls} value={clinic.city} onChange={(e) => setClinic({ ...clinic, city: e.target.value })} />
            </F>
            <F label="Phone" hint="Shown to patients who need to call.">
              <input className={inputCls} value={clinic.phone} onChange={(e) => setClinic({ ...clinic, phone: e.target.value })} placeholder="+91 …" />
            </F>
          </div>
          <Nav onBack={back} onNext={saveClinic} busy={busy} />
        </div>
      )}

      {/* ── Treatments ── */}
      {i === 2 && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-gray-900">Treatments you offer</h2>
          <p className="text-sm text-gray-600">Patients pick one of these when booking. Add at least one.</p>

          <div className="flex flex-wrap gap-2">
            {QUICK_TREATMENTS.filter((t) => !departments.some((d) => d.name.toLowerCase() === t.toLowerCase())).map((t) => (
              <button key={t} onClick={() => addDept(t)} disabled={busy}
                className="text-xs rounded-full border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                + {t}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input className={inputCls} value={newDept} onChange={(e) => setNewDept(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDept(newDept); } }}
              placeholder="Add another treatment…" />
            <button onClick={() => addDept(newDept)} disabled={busy || !newDept.trim()}
              className="shrink-0 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4">
              Add
            </button>
          </div>

          {departments.length > 0 && (
            <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
              {departments.map((d) => (
                <li key={d.id} className="px-3 py-2 text-sm text-gray-800">{d.name}</li>
              ))}
            </ul>
          )}

          <Nav onBack={back} onNext={next} nextDisabled={departments.length === 0} />
        </div>
      )}

      {/* ── Dentist ── */}
      {i === 3 && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-gray-900">Add your first dentist</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <F label="Name">
              <input className={inputCls} value={doctor.name} onChange={(e) => setDoctor({ ...doctor, name: e.target.value })} placeholder="Dr. Asha Rao" />
            </F>
            <F label="Qualification" hint="Optional">
              <input className={inputCls} value={doctor.qualification} onChange={(e) => setDoctor({ ...doctor, qualification: e.target.value })} placeholder="BDS, MDS" />
            </F>
            <F label="Specialization" hint="Optional">
              <input className={inputCls} value={doctor.specialization} onChange={(e) => setDoctor({ ...doctor, specialization: e.target.value })} placeholder="Endodontist" />
            </F>
            <F label="Consultation fee (₹)" hint="Optional">
              <input type="number" min="0" className={inputCls} value={doctor.consultation_fee}
                onChange={(e) => setDoctor({ ...doctor, consultation_fee: e.target.value })} placeholder="300" />
            </F>
          </div>

          <F label="Treatments this dentist does" hint="First one selected is their main treatment.">
            <div className="flex flex-wrap gap-2">
              {departments.map((d) => {
                const on = doctor.department_ids.includes(d.id);
                return (
                  <button key={d.id} type="button" onClick={() => toggleDoctorDept(d.id)}
                    className={`text-xs rounded-full px-3 py-1.5 border transition ${
                      on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}>
                    {on ? '✓ ' : ''}{d.name}
                  </button>
                );
              })}
            </div>
          </F>

          <F label="Weekly schedule">
            <div className="flex flex-wrap gap-2 mb-3">
              {DAYS.map(([lbl, dow]) => {
                const on = sched.days.includes(dow);
                return (
                  <button key={dow} type="button"
                    onClick={() => setSched((s) => ({ ...s, days: on ? s.days.filter((x) => x !== dow) : [...s.days, dow] }))}
                    className={`text-xs w-11 py-1.5 rounded-lg border ${
                      on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}>
                    {lbl}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-600">Start
                <input type="time" className={`${inputCls} mt-1`} value={sched.start}
                  onChange={(e) => setSched({ ...sched, start: e.target.value })} />
              </label>
              <label className="text-xs text-gray-600">End
                <input type="time" className={`${inputCls} mt-1`} value={sched.end}
                  onChange={(e) => setSched({ ...sched, end: e.target.value })} />
              </label>
            </div>
            <label className="flex items-center gap-2 mt-3 text-sm text-gray-700">
              <input type="checkbox" checked={sched.lunchOn} onChange={(e) => setSched({ ...sched, lunchOn: e.target.checked })} />
              Lunch break
            </label>
            {sched.lunchOn && (
              <div className="grid grid-cols-2 gap-3 mt-2">
                <label className="text-xs text-gray-600">From
                  <input type="time" className={`${inputCls} mt-1`} value={sched.lunchStart}
                    onChange={(e) => setSched({ ...sched, lunchStart: e.target.value })} />
                </label>
                <label className="text-xs text-gray-600">To
                  <input type="time" className={`${inputCls} mt-1`} value={sched.lunchEnd}
                    onChange={(e) => setSched({ ...sched, lunchEnd: e.target.value })} />
                </label>
              </div>
            )}
          </F>

          <Nav onBack={back} onNext={saveDentist} busy={busy} nextLabel="Save & continue" />
        </div>
      )}

      {/* ── QR ── */}
      {i === 4 && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-gray-900">Your WhatsApp QR code</h2>
          <p className="text-sm text-gray-600">
            This is how patients reach you. Print it for your reception{reviewing ? ' once you’re approved' : ''}.
          </p>

          {!qr && <p className="text-gray-400 text-sm">Loading…</p>}

          {qr && qr.configured === false && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
              Your QR code isn’t ready yet. It’ll appear here (and in Settings) shortly — you can move on.
            </div>
          )}

          {qr && qr.configured && (
            <div className="flex flex-col sm:flex-row gap-5 items-start">
              <div className="shrink-0 mx-auto sm:mx-0 w-40 h-40 border border-gray-200 rounded-lg overflow-hidden"
                dangerouslySetInnerHTML={{ __html: qr.svg }} />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-gray-500 tracking-widest">{qr.code}</p>
                <a href={qr.link} target="_blank" rel="noopener noreferrer"
                  className="block text-sm font-medium text-blue-700 hover:underline break-all">{qr.link}</a>
                <button onClick={copyQrLink}
                  className="rounded-lg border border-gray-300 text-gray-700 text-sm px-3 py-1.5 hover:bg-gray-50">
                  Copy link
                </button>
                {qr.message && <p className="text-xs text-gray-400">Opens WhatsApp with: “{qr.message}”</p>}
              </div>
            </div>
          )}

          <Nav onBack={back} onNext={finish} busy={busy} nextLabel="Finish setup" />
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 py-8 px-4">
      <div className="max-w-xl mx-auto">
        <div className="text-center mb-6">
          <BrandMark className="w-12 h-12 mx-auto mb-2 drop-shadow" />
          <h1 className="text-lg font-bold text-gray-900">Set up MediBook</h1>
        </div>
        <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">{children}</div>
      </div>
    </div>
  );
}

function F({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

function Nav({ onBack, onNext, busy, nextLabel = 'Continue', nextDisabled }) {
  return (
    <div className="flex items-center justify-between pt-2">
      {onBack
        ? <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700">← Back</button>
        : <span />}
      <button onClick={onNext} disabled={busy || nextDisabled}
        className="rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium px-5 py-2.5 text-sm">
        {busy ? 'Saving…' : nextLabel}
      </button>
    </div>
  );
}
