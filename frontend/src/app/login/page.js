'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import api, { getApiError, resetSessionTimers } from '@/lib/api';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState('clinic'); // 'clinic' | 'super'
  const [form, setForm] = useState({ email: '', password: '', tenant_slug: '' });
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSlug, setForgotSlug] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  // Self-service reset needs an email provider. Without one the backend still
  // returns success (to avoid account enumeration) but nothing is delivered, so
  // offering the link would send users into a silent dead end. Default to hidden
  // and only show it once the backend confirms it works.
  const [resetEnabled, setResetEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/auth/capabilities')
      .then(({ data }) => { if (!cancelled) setResetEnabled(!!data?.password_reset_enabled); })
      .catch(() => { /* leave hidden — a probe failure is not a reason to promise recovery */ });
    return () => { cancelled = true; };
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const isSuperAdmin = mode === 'super';
      const endpoint = isSuperAdmin ? '/auth/superadmin/login' : '/auth/login';
      const payload = isSuperAdmin
        ? { email: form.email, password: form.password }
        : { email: form.email, password: form.password, tenant_slug: form.tenant_slug };

      const { data } = await api.post(endpoint, payload);
      localStorage.setItem('token', data.token);
      if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
      localStorage.setItem('user', JSON.stringify(data.user));
      resetSessionTimers();
      toast.success(`Welcome, ${data.user.name || data.user.email}!`);
      router.push(isSuperAdmin ? '/superadmin' : '/dashboard');
    } catch (err) {
      toast.error(getApiError(err, 'Login failed. Check your credentials.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword(e) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: forgotEmail, tenant_slug: forgotSlug || undefined });
      toast.success('If that email exists, a reset link has been sent!');
      setShowForgot(false);
      setForgotEmail('');
      setForgotSlug('');
    } catch (err) {
      toast.error(getApiError(err, 'Failed to send reset email'));
    } finally {
      setForgotLoading(false);
    }
  }

  const field = (label, name, type = 'text', placeholder = '') => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={form[name]}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
        placeholder={placeholder}
        required
        className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
  );

  if (showForgot) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
              <span className="text-3xl">🔑</span>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Reset Password</h1>
            <p className="text-gray-500 text-sm mt-1">Enter your email to receive a reset link</p>
          </div>
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  placeholder="admin@example.com"
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clinic ID (leave blank for Super Admin)</label>
                <input
                  type="text"
                  value={forgotSlug}
                  onChange={e => setForgotSlug(e.target.value)}
                  placeholder="e.g. demo-clinic (optional)"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button type="submit" disabled={forgotLoading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors">
                {forgotLoading ? 'Sending...' : 'Send Reset Link'}
              </button>
              <button type="button" onClick={() => setShowForgot(false)}
                className="w-full border border-gray-300 text-gray-600 font-medium py-2.5 rounded-xl hover:bg-gray-50 transition-colors">
                Back to Login
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-3xl">🏥</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">MediBook</h1>
          <p className="text-gray-500 text-sm mt-1">WhatsApp Appointment System</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Mode tabs */}
          <div className="flex rounded-xl bg-gray-100 p-1 mb-6">
            {[['clinic', 'Clinic Admin'], ['super', 'Super Admin']].map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setMode(val)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                  mode === val ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {mode === 'clinic' && field('Clinic ID', 'tenant_slug', 'text', 'e.g. demo-clinic')}
            {field('Email', 'email', 'email', 'admin@example.com')}
            {field('Password', 'password', 'password', '••••••••')}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl transition-colors mt-2"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {resetEnabled ? (
            <div className="text-center mt-4">
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              >
                Forgot your password?
              </button>
            </div>
          ) : (
            <p className="text-center mt-4 text-xs text-gray-400">
              Forgot your password? Contact your clinic administrator.
            </p>
          )}

          {process.env.NODE_ENV === 'development' && (
            <div className="mt-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
              <p className="font-semibold mb-1">Dev credentials:</p>
              <p>Super Admin: admin@medibook.com / SuperAdmin@123</p>
              <p>Clinic Admin: demo@medibook.com / Demo@123456 (slug: demo-clinic)</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
