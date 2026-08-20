'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import api, { getApiError, resetSessionTimers } from '@/lib/api';
import BrandMark from '@/components/BrandMark';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState('clinic'); // 'clinic' | 'super'
  const [form, setForm] = useState({ email: '', password: '', tenant_slug: '' });
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <BrandMark className="w-16 h-16 mx-auto mb-4 drop-shadow-lg" />
          <h1 className="text-2xl font-bold text-gray-900">MediBook</h1>
          <p className="text-gray-500 text-sm mt-1">WhatsApp Appointment System</p>
          <p className="text-gray-400 text-xs mt-2">from Pragati Solutions</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">
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

          <p className="text-center mt-4 text-xs text-gray-400">
            Forgot your password? Contact your clinic administrator.
          </p>

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
