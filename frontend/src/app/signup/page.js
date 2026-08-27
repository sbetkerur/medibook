'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api, { getApiError, resetSessionTimers } from '@/lib/api';
import BrandMark from '@/components/BrandMark';
import toast from 'react-hot-toast';

const STEPS = ['Details', 'Verify', 'Done'];

const pwRules = [
  { label: 'At least 8 characters', ok: (p) => p.length >= 8 },
  { label: 'One uppercase letter', ok: (p) => /[A-Z]/.test(p) },
  { label: 'One lowercase letter', ok: (p) => /[a-z]/.test(p) },
  { label: 'One number', ok: (p) => /[0-9]/.test(p) },
];
const passwordOk = (p) => pwRules.every((r) => r.ok(p));
const slugify = (s) =>
  String(s || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

export default function SignupPage() {
  const router = useRouter();
  const [config, setConfig] = useState(null); // null = loading, {} once fetched
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    name: '', slug: '', owner_name: '', owner_email: '', owner_phone: '',
    owner_password: '', plan: 'starter',
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugState, setSlugState] = useState(null); // { checking, available, reason }

  const [phoneHint, setPhoneHint] = useState('');
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [signupToken, setSignupToken] = useState('');
  const [trialDays, setTrialDays] = useState(14);

  // ── config ────────────────────────────────────────────────
  useEffect(() => {
    api.get('/signup/config')
      .then(({ data }) => setConfig(data || { enabled: false }))
      .catch(() => setConfig({ enabled: false }));
  }, []);

  // ── slug auto-suggest + availability ──────────────────────
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    if (!slugTouched) set('slug', slugify(form.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.name, slugTouched]);

  const slugTimer = useRef(null);
  const checkSlug = useCallback((slug) => {
    clearTimeout(slugTimer.current);
    if (!slug || slug.length < 3) { setSlugState(null); return; }
    setSlugState({ checking: true });
    slugTimer.current = setTimeout(async () => {
      try {
        const { data } = await api.get('/signup/slug-available', { params: { slug } });
        setSlugState({ checking: false, available: data.available, reason: data.reason });
      } catch {
        setSlugState({ checking: false, available: null, reason: 'Could not check right now' });
      }
    }, 400);
  }, []);
  useEffect(() => { checkSlug(form.slug); }, [form.slug, checkSlug]);

  // ── resend countdown ─────────────────────────────────────
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const startPayload = () => ({
    name: form.name.trim(),
    slug: form.slug.trim(),
    owner_email: form.owner_email.trim(),
    owner_name: form.owner_name.trim(),
    owner_phone: form.owner_phone.trim(),
    owner_password: form.owner_password,
    plan: form.plan,
  });

  async function submitStart(e) {
    e?.preventDefault();
    if (!passwordOk(form.owner_password)) return toast.error('Please meet all password requirements');
    if (slugState && slugState.available === false) return toast.error('Please choose an available Clinic ID');
    setSubmitting(true);
    try {
      const { data } = await api.post('/signup/start', startPayload());
      setPhoneHint(data.phone_hint || '');
      setResendIn(45);
      setStep(2);
      toast.success('Verification code sent on WhatsApp');
    } catch (err) {
      toast.error(getApiError(err, 'Could not start signup'));
    } finally { setSubmitting(false); }
  }

  async function resendCode() {
    if (resendIn > 0) return;
    setSubmitting(true);
    try {
      const { data } = await api.post('/signup/start', startPayload());
      setPhoneHint(data.phone_hint || phoneHint);
      setResendIn(45);
      toast.success('New code sent');
    } catch (err) {
      const ra = err?.response?.data?.retry_after;
      if (ra) setResendIn(ra);
      toast.error(getApiError(err, 'Could not resend'));
    } finally { setSubmitting(false); }
  }

  async function submitVerify(e) {
    e?.preventDefault();
    if (!/^\d{6}$/.test(code)) return toast.error('Enter the 6-digit code');
    setSubmitting(true);
    try {
      const { data } = await api.post('/signup/verify-otp', { owner_phone: form.owner_phone.trim(), code });
      setSignupToken(data.signup_token);
      if (data.trial_days) setTrialDays(data.trial_days);
      setStep(3);
    } catch (err) {
      toast.error(getApiError(err, 'That code did not work'));
    } finally { setSubmitting(false); }
  }

  async function submitConfirm() {
    setSubmitting(true);
    try {
      const { data } = await api.post('/signup/confirm', { signup_token: signupToken });
      const s = data.session;
      if (s?.token) {
        localStorage.setItem('token', s.token);
        if (s.refresh_token) localStorage.setItem('refresh_token', s.refresh_token);
        if (s.user) localStorage.setItem('user', JSON.stringify(s.user));
        resetSessionTimers();
      }
      if (data.review_pending) {
        toast.success('Your clinic is being reviewed — you can set everything up now.');
      } else {
        toast.success('Clinic created!');
      }
      router.push('/onboarding');
    } catch (err) {
      toast.error(getApiError(err, 'Could not finish setup'));
    } finally { setSubmitting(false); }
  }

  // ── render ────────────────────────────────────────────────
  if (config === null) {
    return <Centered><p className="text-gray-400 text-sm">Loading…</p></Centered>;
  }

  if (!config.enabled) {
    return (
      <Centered>
        <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 text-center">
          <h1 className="text-lg font-bold text-gray-900 mb-2">Self-serve signup isn’t open yet</h1>
          <p className="text-sm text-gray-600">
            {config.reason || 'Please get in touch and we’ll set your clinic up.'}
          </p>
          <a href="/login" className="inline-block mt-5 text-sm font-medium text-blue-600 hover:underline">
            Back to sign in
          </a>
        </div>
      </Centered>
    );
  }

  const inputCls =
    'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent';

  return (
    <Centered wide>
      <div className="text-center mb-6">
        <BrandMark className="w-14 h-14 mx-auto mb-3 drop-shadow-lg" />
        <h1 className="text-2xl font-bold text-gray-900">Create your clinic</h1>
        <p className="text-gray-500 text-sm mt-1">Free for {trialDays} days · no card needed</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-center gap-2 mb-6">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const active = n === step, done = n < step;
          return (
            <div key={label} className="flex items-center gap-2">
              <span className={`w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center ${
                done ? 'bg-green-500 text-white' : active ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'
              }`}>{done ? '✓' : n}</span>
              <span className={`text-xs ${active ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>{label}</span>
              {n < STEPS.length && <span className="w-6 h-px bg-gray-200" />}
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">
        {step === 1 && (
          <form onSubmit={submitStart} className="space-y-4">
            <Field label="Clinic name">
              <input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)}
                placeholder="Bright Smile Dental" required />
            </Field>

            <Field label="Clinic ID" hint="Used to sign in. Lowercase letters, numbers and hyphens.">
              <input className={inputCls} value={form.slug}
                onChange={(e) => { setSlugTouched(true); set('slug', slugify(e.target.value)); }}
                placeholder="bright-smile" required minLength={3} />
              {form.slug.length >= 3 && slugState && (
                <p className={`mt-1 text-xs ${
                  slugState.checking ? 'text-gray-400'
                  : slugState.available ? 'text-green-600' : 'text-red-600'
                }`}>
                  {slugState.checking ? 'Checking…'
                    : slugState.available ? '✓ Available'
                    : `✗ ${slugState.reason || 'Not available'}`}
                </p>
              )}
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Your name">
                <input className={inputCls} value={form.owner_name} onChange={(e) => set('owner_name', e.target.value)}
                  placeholder="Dr. Asha Rao" required />
              </Field>
              <Field label="Email" hint="You’ll sign in with this.">
                <input type="email" className={inputCls} value={form.owner_email}
                  onChange={(e) => set('owner_email', e.target.value)} placeholder="you@clinic.com" required />
              </Field>
            </div>

            <Field label="WhatsApp number" hint="We’ll send a verification code here.">
              <input className={inputCls} value={form.owner_phone}
                onChange={(e) => set('owner_phone', e.target.value)} placeholder="+91 98765 43210" required />
            </Field>

            <Field label="Password">
              <input type="password" className={inputCls} value={form.owner_password}
                onChange={(e) => set('owner_password', e.target.value)} placeholder="••••••••" required />
              <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                {pwRules.map((r) => (
                  <li key={r.label} className={`text-xs flex items-center gap-1 ${
                    r.ok(form.owner_password) ? 'text-green-600' : 'text-gray-400'
                  }`}>
                    <span>{r.ok(form.owner_password) ? '✓' : '○'}</span>{r.label}
                  </li>
                ))}
              </ul>
            </Field>

            <Field label="Plan">
              <div className="space-y-2">
                {(config.plans || []).map((p) => (
                  <label key={p.id} className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition ${
                    form.plan === p.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                    <input type="radio" name="plan" className="mt-1" checked={form.plan === p.id}
                      onChange={() => set('plan', p.id)} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {p.name} · ₹{Number(p.price_monthly).toLocaleString('en-IN')}/mo
                      </p>
                      <p className="text-xs text-gray-500">
                        {p.max_doctors == null ? 'Unlimited dentists' : `Up to ${p.max_doctors} dentist${p.max_doctors === 1 ? '' : 's'}`}
                        {' · '}
                        {p.max_branches == null ? 'unlimited branches' : `${p.max_branches} branch${p.max_branches === 1 ? '' : 'es'}`}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </Field>

            <button type="submit" disabled={submitting}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors mt-2">
              {submitting ? 'Sending code…' : 'Continue'}
            </button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={submitVerify} className="space-y-4">
            <p className="text-sm text-gray-600">
              Enter the 6-digit code we sent on WhatsApp to <span className="font-medium">…{phoneHint}</span>.
            </p>
            <input inputMode="numeric" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full border border-gray-300 rounded-lg px-3 py-3 text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="••••••" autoFocus />
            <button type="submit" disabled={submitting || code.length !== 6}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors">
              {submitting ? 'Verifying…' : 'Verify'}
            </button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" onClick={() => setStep(1)} className="text-gray-500 hover:text-gray-700">← Change details</button>
              <button type="button" onClick={resendCode} disabled={resendIn > 0 || submitting}
                className="text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline">
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div className="space-y-4 text-center">
            <div className="w-14 h-14 rounded-full bg-green-100 text-green-600 text-2xl flex items-center justify-center mx-auto">✓</div>
            <h2 className="text-lg font-bold text-gray-900">You’re all set</h2>
            <p className="text-sm text-gray-600">
              Starting your <span className="font-medium">{trialDays}-day free trial</span>. No card needed now —
              add one later from Settings to keep going after the trial.
            </p>
            <button onClick={submitConfirm} disabled={submitting}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors">
              {submitting ? 'Creating your clinic…' : 'Create my clinic'}
            </button>
          </div>
        )}
      </div>

      <p className="text-center mt-4 text-xs text-gray-400">
        Already have an account? <a href="/login" className="text-blue-600 hover:underline">Sign in</a>
      </p>
    </Centered>
  );
}

function Centered({ children, wide }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className={wide ? 'w-full max-w-lg' : 'w-full max-w-md'}>{children}</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
