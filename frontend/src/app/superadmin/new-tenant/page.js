'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import toast from 'react-hot-toast';

const STEPS = ['Clinic Info', 'Plan Selection', 'WhatsApp Config', 'Review & Create'];

const PLAN_DETAILS = {
  starter:      { icon: '🌱', color: 'border-gray-300',   badge: 'bg-gray-100 text-gray-700',   desc: 'Single-chair clinics. Up to two dentists, one location.' },
  professional: { icon: '⭐', color: 'border-purple-400', badge: 'bg-purple-100 text-purple-700', desc: 'Everything else. Priced per branch — set the agreed amount on the tenant after creating it.' },
};

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function NewTenantPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [plans, setPlans] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createdTenant, setCreatedTenant] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({
    name: '', slug: '', city: '', owner_email: '', owner_name: '', owner_password: '',
    plan: 'starter',
  });

  useEffect(() => {
    const u = localStorage.getItem('user');
    if (!u) { router.push('/login'); return; }
    let parsed;
    try { parsed = JSON.parse(u); } catch { router.push('/login'); return; }
    if (parsed.role !== 'super_admin') { router.push('/dashboard'); return; }
    api.get('/superadmin/plans').then(r => setPlans(r.data.plans || [])).catch(() => {});
  }, []);

  function set(field, value) {
    setForm(f => ({
      ...f,
      [field]: value,
      ...(field === 'name' && !f._slugEdited ? { slug: slugify(value) } : {}),
    }));
  }

  function validateStep() {
    if (step === 1) {
      if (!form.name.trim()) { toast.error('Clinic name is required'); return false; }
      if (!form.slug.trim()) { toast.error('Clinic slug is required'); return false; }
      if (!/^[a-z0-9-]+$/.test(form.slug)) { toast.error('Slug must be lowercase letters, numbers, and hyphens only'); return false; }
      if (!form.owner_email.trim()) { toast.error('Owner email is required'); return false; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.owner_email)) { toast.error('Invalid email address'); return false; }
      // City is optional and never blocks creation — only normalised, so the
      // review step and the create payload agree on what was actually typed.
      if (form.city !== form.city.trim()) setForm(f => ({ ...f, city: f.city.trim() }));
    }
    if (step === 2) {
      if (!form.plan) { toast.error('Select a plan'); return false; }
    }
    return true;
  }

  function next() {
    if (!validateStep()) return;
    setStep(s => Math.min(s + 1, 4));
  }

  async function create() {
    if (!validateStep()) return;
    setCreating(true);
    try {
      const { data } = await api.post('/superadmin/tenants', {
        name: form.name.trim(),
        slug: form.slug.trim(),
        city: form.city.trim() || undefined,
        owner_email: form.owner_email.trim(),
        owner_name: form.owner_name.trim() || form.name.trim() + ' Admin',
        owner_password: form.owner_password.trim() || undefined,
        plan: form.plan,
      });
      setCreatedTenant(data);
      setStep(5);
      toast.success(`Clinic "${data.tenant.name}" created!`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create tenant');
    } finally {
      setCreating(false);
    }
  }

  const selectedPlan = plans.find(p => p.id === form.plan);

  // ── SUCCESS SCREEN ────────────────────────────────────────────
  if (step === 5 && createdTenant) {
    const creds = createdTenant.credentials;
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 sm:p-6">
        <div className="bg-white rounded-2xl shadow-xl p-5 sm:p-8 w-full max-w-lg">
          <div className="text-center mb-6">
            <div className="text-5xl mb-3">🎉</div>
            <h1 className="text-2xl font-bold text-gray-900">Clinic Created!</h1>
            <p className="text-gray-500 text-sm mt-1 break-words">{createdTenant.tenant.name} is ready to use</p>
          </div>

          {/* break-all on every value: generated passwords and clinic emails are
              single unbreakable tokens and would otherwise push this card wider
              than a 320px viewport. */}
          <div className="bg-gray-50 rounded-xl p-4 mb-5 font-mono text-sm space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Login Credentials</p>
            <div className="flex justify-between gap-3"><span className="text-gray-500 shrink-0">Email:</span><span className="font-medium break-all text-right">{creds.email}</span></div>
            <div className="flex justify-between items-start gap-2">
              <span className="text-gray-500 shrink-0">Password:</span>
              <div className="flex items-start gap-2 min-w-0">
                <span className="font-medium break-all text-right">{showPassword ? creds.password : '••••••••••••'}</span>
                <button type="button" onClick={() => setShowPassword(v => !v)}
                  className="text-xs text-blue-500 hover:text-blue-700 underline shrink-0">
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <div className="flex justify-between gap-3"><span className="text-gray-500 shrink-0">Clinic Slug:</span><span className="font-medium text-blue-600 break-all text-right">{creds.tenant_slug}</span></div>
          </div>

          <div className="bg-blue-50 rounded-xl p-4 mb-6">
            <p className="text-xs font-semibold text-blue-700 mb-3">Setup Checklist</p>
            <ol className="text-sm text-blue-800 space-y-2">
              <li>1. Save the credentials above — the password cannot be recovered</li>
              <li>2. Configure WhatsApp in Meta Developer Console if not done</li>
              <li>3. Set webhook URL: <code className="bg-blue-100 px-1 rounded break-all">/api/webhook/whatsapp</code></li>
              <li>4. Log in as clinic admin and add doctors &amp; schedules</li>
              <li>5. Generate appointment slots from the Slots tab</li>
              <li>6. Test the bot via the Bot Tester tab</li>
            </ol>
          </div>

          {/* Stacked below sm: these buttons carry no horizontal padding, so side
              by side their labels alone are wider than a 320px card. */}
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => { navigator.clipboard.writeText(`Email: ${creds.email}\nPassword: ${creds.password}\nSlug: ${creds.tenant_slug}`); toast.success('Copied!'); }}
              className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 transition">
              Copy Credentials
            </button>
            <button
              onClick={() => router.push('/superadmin')}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition">
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center gap-3 sm:gap-4">
        <button onClick={() => router.push('/superadmin')} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">←</button>
        <div className="min-w-0">
          <h1 className="font-semibold text-gray-900 truncate">New Clinic Onboarding</h1>
          <p className="text-xs text-gray-500 truncate">Step {step} of 4 — {STEPS[step - 1]}</p>
        </div>
      </nav>

      {/* Progress bar */}
      <div className="h-1 bg-gray-200">
        <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${(step / 4) * 100}%` }} />
      </div>

      <div className="max-w-2xl mx-auto p-4 sm:p-6">
        {/* Step indicators. Below sm the labels are hidden, so only the four
            32px circles and the connectors have to fit: at 320px the original
            w-8 + mx-2 connectors summed to exactly the available width with no
            slack, hence the narrower mobile connector. */}
        <div className="flex items-center justify-between mb-8">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center">
              <div className={`flex items-center justify-center w-8 h-8 shrink-0 rounded-full text-sm font-medium transition-colors ${
                i + 1 < step ? 'bg-green-500 text-white' :
                i + 1 === step ? 'bg-blue-600 text-white' :
                'bg-gray-200 text-gray-500'
              }`}>
                {i + 1 < step ? '✓' : i + 1}
              </div>
              <span className={`ml-2 text-xs hidden sm:block ${i + 1 === step ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
                {label}
              </span>
              {i < STEPS.length - 1 && <div className="w-4 sm:w-12 h-px bg-gray-200 mx-1 sm:mx-2" />}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-4 sm:p-6">
          {/* STEP 1: Clinic Info */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">Clinic Information</h2>
                <p className="text-sm text-gray-500">Basic details about the clinic and their admin account.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clinic Name *</label>
                <input value={form.name} onChange={e => set('name', e.target.value)}
                  placeholder="e.g. Smile Dental Clinic"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clinic Slug * <span className="text-gray-400 font-normal">(used for login)</span></label>
                <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500">
                  <span className="px-3 py-2 bg-gray-50 text-gray-400 text-sm border-r border-gray-200">medibook.com/</span>
                  <input value={form.slug} onChange={e => { setForm(f => ({ ...f, slug: slugify(e.target.value), _slugEdited: true })); }}
                    placeholder="smile-dental"
                    className="flex-1 px-3 py-2 text-sm focus:outline-none" />
                </div>
              </div>
              {/* City sits with the clinic fields, not the admin ones: it describes
                  where the clinic IS, and is what the bot matches on for
                  "clinics near me". Optional — a clinic without one still works,
                  it just never surfaces in a near-me search. */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">City <span className="text-gray-400 font-normal">(used for &quot;clinics near me&quot; search)</span></label>
                <input value={form.city} onChange={e => set('city', e.target.value)}
                  maxLength={100}
                  placeholder="e.g. Bengaluru"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Admin Name</label>
                <input value={form.owner_name} onChange={e => set('owner_name', e.target.value)}
                  placeholder="Dr. Arjun Sharma"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Admin Email *</label>
                <input type="email" value={form.owner_email} onChange={e => set('owner_email', e.target.value)}
                  placeholder="admin@smileclinic.com"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Admin Password <span className="text-gray-400 font-normal">(auto-generated if blank)</span></label>
                <input type="password" value={form.owner_password} onChange={e => set('owner_password', e.target.value)}
                  placeholder="Leave blank for auto-generated"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}

          {/* STEP 2: Plan Selection */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">Select a Plan</h2>
                <p className="text-sm text-gray-500">Choose the subscription plan for this clinic.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(plans.length ? plans : ['starter','professional'].map(id => ({ id, name: id, max_doctors: 0, price_monthly: 0 }))).map(p => {
                  const pd = PLAN_DETAILS[p.id] || PLAN_DETAILS.starter;
                  return (
                    <button key={p.id} onClick={() => set('plan', p.id)}
                      className={`text-left border-2 rounded-xl p-4 transition-all ${form.plan === p.id ? `${pd.color} bg-blue-50 shadow-sm` : 'border-gray-200 hover:border-gray-300'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xl">{pd.icon}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${pd.badge}`}>{p.id}</span>
                      </div>
                      <div className="text-base font-semibold text-gray-900 capitalize">{p.name}</div>
                      <div className="text-sm text-gray-500 mt-1">{pd.desc}</div>
                      <div className="mt-3 space-y-1">
                        {/* NULL is the unlimited sentinel (was 999 / 99999). A
                            plain `> 0` test hides the row entirely for NULL,
                            which reads as missing data rather than "no limit".
                            0/undefined still hides — that's the offline
                            fallback above, where the real limits are unknown. */}
                        {(p.max_doctors === null || p.max_doctors > 0) && (
                          <div className="text-xs text-gray-600">👨‍⚕️ {p.max_doctors === null ? 'Unlimited' : `Up to ${p.max_doctors}`} doctors</div>
                        )}
                        {(p.max_branches === null || p.max_branches > 0) && (
                          <div className="text-xs text-gray-600">🏥 {p.max_branches === null ? 'Unlimited' : `Up to ${p.max_branches}`} {p.max_branches === 1 ? 'branch' : 'branches'}</div>
                        )}
                        {(p.max_appointments_per_month === null || p.max_appointments_per_month > 0) && (
                          <div className="text-xs text-gray-600">📅 {p.max_appointments_per_month === null ? 'Unlimited' : p.max_appointments_per_month.toLocaleString()} appts/month</div>
                        )}
                        <div className="text-sm font-semibold text-gray-900 mt-2">
                          {p.price_monthly === 0 ? 'Free' : `₹${p.price_monthly.toLocaleString('en-IN')}/mo`}
                        </div>
                      </div>
                      {form.plan === p.id && <div className="text-xs text-blue-600 font-medium mt-2">✓ Selected</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 3: WhatsApp (shared — info only) */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">WhatsApp</h2>
                <p className="text-sm text-gray-500">All clinics share a single global WhatsApp number.</p>
              </div>
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800 space-y-2">
                <p className="font-semibold">✅ Shared WhatsApp Number Active</p>
                <p className="text-xs">This platform uses one shared WhatsApp phone number for all clinics. Patients are routed to their chosen clinic automatically via a clinic-selection menu.</p>
                <p className="text-xs">To update the global WhatsApp credentials, set <code className="bg-green-100 px-1 rounded">META_PHONE_NUMBER_ID</code> and <code className="bg-green-100 px-1 rounded">META_ACCESS_TOKEN</code> in the server environment variables.</p>
              </div>
            </div>
          )}

          {/* STEP 4: Review */}
          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">Review & Create</h2>
                <p className="text-sm text-gray-500">Confirm all details before creating the clinic.</p>
              </div>
              <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
                {[
                  { label: 'Clinic Name', value: form.name },
                  { label: 'Slug', value: form.slug, mono: true },
                  // Shown even when blank: a missing city silently keeps the clinic
                  // out of the bot's "near me" results, so its absence has to be
                  // visible here rather than discovered later.
                  { label: 'City', value: form.city.trim() || '— not set —' },
                  { label: 'Admin Email', value: form.owner_email },
                  { label: 'Admin Name', value: form.owner_name || `${form.name} Admin` },
                  { label: 'Plan', value: selectedPlan ? `${selectedPlan.name} (${selectedPlan.price_monthly === 0 ? 'Free' : '₹' + selectedPlan.price_monthly + '/mo'})` : form.plan },
                  { label: 'WhatsApp', value: 'Shared global number' },
                ].map(({ label, value, mono }) => (
                  <div key={label} className="flex justify-between items-start gap-3 px-4 py-3 text-sm">
                    <span className="text-gray-500 shrink-0">{label}</span>
                    <span className={`font-medium text-gray-900 min-w-0 text-right break-words ${mono ? 'font-mono text-blue-600 break-all' : ''}`}>{value}</span>
                  </div>
                ))}
              </div>
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-xs text-yellow-800">
                ⚠️ A database schema will be provisioned for this clinic. This action creates live tenant infrastructure.
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-6 pt-5 border-t border-gray-100">
            <button onClick={() => step === 1 ? router.push('/superadmin') : setStep(s => s - 1)}
              className="px-4 sm:px-5 py-2.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg transition hover:bg-gray-50 whitespace-nowrap">
              {step === 1 ? 'Cancel' : '← Back'}
            </button>
            {step < 4 ? (
              <button onClick={next}
                className="px-4 sm:px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium whitespace-nowrap">
                Next →
              </button>
            ) : (
              <button onClick={create} disabled={creating}
                className="px-4 sm:px-6 py-2.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium disabled:opacity-50 flex items-center gap-2 whitespace-nowrap">
                {creating ? (
                  <><span className="animate-spin">⏳</span> Creating...</>
                ) : (
                  '🚀 Create Clinic'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
