'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';

export default function SuperAdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState('tenants');
  const [tenants, setTenants] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '', slug: '', owner_email: '', owner_password: 'Admin@123456',
    owner_name: '', plan: 'starter', wa_phone_number_id: '', wa_access_token: '',
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const u = localStorage.getItem('user');
    if (!u) { router.push('/login'); return; }
    const parsed = JSON.parse(u);
    if (parsed.role !== 'super_admin') { router.push('/dashboard'); return; }
    fetchAll();
  }, []);

  async function fetchAll() {
    setLoading(true);
    try {
      const [t, s] = await Promise.all([
        api.get('/superadmin/tenants'),
        api.get('/superadmin/stats'),
      ]);
      setTenants(t.data.tenants || []);
      setStats(s.data);
    } catch { toast.error('Failed to load data'); }
    finally { setLoading(false); }
  }

  async function createTenant() {
    if (!form.name || !form.slug || !form.owner_email) {
      toast.error('Name, slug, and email are required');
      return;
    }
    setCreating(true);
    try {
      const { data } = await api.post('/superadmin/tenants', form);
      toast.success(`Tenant "${data.tenant.name}" created!`);
      setShowCreate(false);
      setForm({ name: '', slug: '', owner_email: '', owner_password: 'Admin@123456', owner_name: '', plan: 'starter', wa_phone_number_id: '', wa_access_token: '' });
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create tenant');
    } finally { setCreating(false); }
  }

  async function toggleStatus(tenant) {
    const newStatus = tenant.status === 'active' ? 'suspended' : 'active';
    try {
      await api.patch(`/superadmin/tenants/${tenant.id}`, { status: newStatus });
      toast.success(`Tenant ${newStatus}`);
      fetchAll();
    } catch { toast.error('Failed to update status'); }
  }

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-blue-600">🏥 MediBook</span>
          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">Super Admin</span>
        </div>
        <button onClick={() => { localStorage.clear(); router.push('/login'); }}
          className="text-sm text-gray-500 hover:text-red-500 transition">Sign Out</button>
      </nav>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-blue-500">
              <p className="text-xs text-gray-500 uppercase">Total Tenants</p>
              <p className="text-3xl font-bold text-gray-900">{stats.total_tenants}</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-green-500">
              <p className="text-xs text-gray-500 uppercase">Active</p>
              <p className="text-3xl font-bold text-gray-900">{stats.active_tenants}</p>
            </div>
            {stats.by_plan?.map(p => (
              <div key={p.plan} className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-purple-400">
                <p className="text-xs text-gray-500 uppercase capitalize">{p.plan} Plan</p>
                <p className="text-3xl font-bold text-gray-900">{p.count}</p>
              </div>
            ))}
          </div>
        )}

        {/* Tenants table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">All Tenants ({tenants.length})</h2>
            <div className="flex gap-2">
              <button onClick={fetchAll} className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">🔄 Refresh</button>
              <button onClick={() => setShowCreate(true)} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">+ New Tenant</button>
            </div>
          </div>

          {loading ? (
            <div className="px-5 py-12 text-center text-gray-400">Loading tenants...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['Clinic', 'Slug', 'Owner', 'Plan', 'WhatsApp', 'Status', 'Created', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {tenants.map(t => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-blue-600">{t.slug}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{t.owner_email}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full capitalize">{t.plan}</span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {t.wa_phone_number_id
                          ? <span className="text-green-600">✅ Configured</span>
                          : <span className="text-gray-400">Not set</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                          t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                        }`}>{t.status}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {t.created_at ? format(parseISO(t.created_at), 'd MMM yy') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleStatus(t)}
                          className={`text-xs px-2 py-1 rounded transition ${
                            t.status === 'active'
                              ? 'text-red-600 hover:bg-red-50'
                              : 'text-green-600 hover:bg-green-50'
                          }`}>
                          {t.status === 'active' ? 'Suspend' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!tenants.length && (
                    <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">No tenants yet. Create the first one!</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Create Tenant Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-gray-900">Create New Tenant</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="space-y-3">
              {[
                ['Clinic Name *', 'name', 'text', 'e.g. Apollo Clinic Mumbai'],
                ['Slug (URL ID) *', 'slug', 'text', 'e.g. apollo-mumbai'],
                ['Owner Email *', 'owner_email', 'email', 'admin@apollomumbai.com'],
                ['Owner Name', 'owner_name', 'text', 'Dr. Sharma'],
                ['Password', 'owner_password', 'text', 'Admin@123456'],
              ].map(([label, name, type, placeholder]) => (
                <div key={name}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                  <input type={type} value={form[name]}
                    onChange={e => {
                      const val = e.target.value;
                      setForm(f => ({
                        ...f,
                        [name]: val,
                        ...(name === 'name' && !f.slug ? { slug: slugify(val) } : {}),
                      }));
                    }}
                    placeholder={placeholder}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              ))}

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Plan</label>
                <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="starter">Starter (Free)</option>
                  <option value="growth">Growth (₹1,999/mo)</option>
                  <option value="professional">Professional (₹4,999/mo)</option>
                  <option value="enterprise">Enterprise (₹9,999/mo)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">WhatsApp Phone Number ID (optional)</label>
                <input value={form.wa_phone_number_id}
                  onChange={e => setForm(f => ({ ...f, wa_phone_number_id: e.target.value }))}
                  placeholder="From Meta Developer Console"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowCreate(false)}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition">Cancel</button>
              <button onClick={createTenant} disabled={creating}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
                {creating ? 'Creating...' : 'Create Tenant'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
