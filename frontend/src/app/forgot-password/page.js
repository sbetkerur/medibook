'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import api, { getApiError } from '@/lib/api';
import BrandMark from '@/components/BrandMark';
import toast from 'react-hot-toast';

const pwRules = [
  { label: 'At least 8 characters', ok: (p) => p.length >= 8 },
  { label: 'One uppercase letter', ok: (p) => /[A-Z]/.test(p) },
  { label: 'One lowercase letter', ok: (p) => /[a-z]/.test(p) },
  { label: 'One number', ok: (p) => /[0-9]/.test(p) },
];
const passwordOk = (p) => pwRules.every((r) => r.ok(p));

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ tenant_slug: '', email: '', code: '', new_password: '', confirm: '' });
  const [notice, setNotice] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const inputCls =
    'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent';

  async function requestCode(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post('/auth/forgot-password', {
        tenant_slug: form.tenant_slug.trim(), email: form.email.trim(),
      });
      setNotice(data.message || 'If that account has a WhatsApp number on file, a code has been sent.');
      setStep(2);
    } catch (err) {
      // Endpoint is enumeration-safe and returns 200; only a network error lands here.
      toast.error(getApiError(err, 'Could not send a code. Try again.'));
    } finally { setBusy(false); }
  }

  async function resetPassword(e) {
    e.preventDefault();
    if (!passwordOk(form.new_password)) return toast.error('Please meet all password requirements');
    if (form.new_password !== form.confirm) return toast.error('Passwords do not match');
    setBusy(true);
    try {
      await api.post('/auth/reset-password', {
        tenant_slug: form.tenant_slug.trim(),
        email: form.email.trim(),
        code: form.code.trim(),
        new_password: form.new_password,
      });
      toast.success('Password updated — sign in with your new password.');
      router.push('/login');
    } catch (err) {
      toast.error(getApiError(err, 'Could not reset password'));
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <BrandMark className="w-16 h-16 mx-auto mb-4 drop-shadow-lg" />
          <h1 className="text-2xl font-bold text-gray-900">Reset your password</h1>
          <p className="text-gray-500 text-sm mt-1">We send a code to your WhatsApp number on file</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">
          {step === 1 && (
            <form onSubmit={requestCode} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clinic ID</label>
                <input className={inputCls} value={form.tenant_slug}
                  onChange={(e) => set('tenant_slug', e.target.value)} placeholder="e.g. bright-smile" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" className={inputCls} value={form.email}
                  onChange={(e) => set('email', e.target.value)} placeholder="you@clinic.com" required />
              </div>
              <button type="submit" disabled={busy}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors">
                {busy ? 'Sending…' : 'Send code'}
              </button>
            </form>
          )}

          {step === 2 && (
            <form onSubmit={resetPassword} className="space-y-4">
              {notice && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                  {notice}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">6-digit code</label>
                <input inputMode="numeric" maxLength={6} className={`${inputCls} tracking-[0.4em] text-center font-mono`}
                  value={form.code} onChange={(e) => set('code', e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
                <input type="password" className={inputCls} value={form.new_password}
                  onChange={(e) => set('new_password', e.target.value)} placeholder="••••••••" required />
                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  {pwRules.map((r) => (
                    <li key={r.label} className={`text-xs flex items-center gap-1 ${
                      r.ok(form.new_password) ? 'text-green-600' : 'text-gray-400'
                    }`}>
                      <span>{r.ok(form.new_password) ? '✓' : '○'}</span>{r.label}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm new password</label>
                <input type="password" className={inputCls} value={form.confirm}
                  onChange={(e) => set('confirm', e.target.value)} placeholder="••••••••" required />
              </div>
              <button type="submit" disabled={busy}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors">
                {busy ? 'Updating…' : 'Set new password'}
              </button>
              <button type="button" onClick={() => setStep(1)}
                className="w-full text-xs text-gray-500 hover:text-gray-700">← Start over</button>
            </form>
          )}

          <p className="text-center mt-4 text-xs text-gray-400">
            Remembered it? <a href="/login" className="text-blue-600 hover:underline">Sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}
