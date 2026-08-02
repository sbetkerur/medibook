'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import api, { clearSessionTimers } from '@/lib/api';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

export default function SuperAdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState('tenants');
  const [tenants, setTenants] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  // Suspension modal state
  const [suspendModal, setSuspendModal] = useState(null); // { tenant }
  const [suspendReason, setSuspendReason] = useState('');
  const [suspending, setSuspending] = useState(false);

  // City edit state. There is no general tenant-edit modal, and city is the one
  // field the bot's "clinics near me" search depends on, so it gets its own
  // focused affordance rather than waiting for a full edit form.
  const [cityModal, setCityModal] = useState(null); // { tenant }
  const [cityValue, setCityValue] = useState('');
  const [savingCity, setSavingCity] = useState(false);

  // Tenant health state
  const [tenantHealth, setTenantHealth] = useState({}); // { [tenantId]: healthData }
  const [loadingHealth, setLoadingHealth] = useState(null);

  // Password recovery for tenant users. Self-service reset goes out by email, so
  // with no email provider configured a locked-out clinic admin has no way back
  // in — this is that path.
  const [pwModal, setPwModal] = useState(null); // { tenant, users, issued }
  const [pwLoadingUsers, setPwLoadingUsers] = useState(false);
  const [pwResettingId, setPwResettingId] = useState(null);

  // Billing dashboard state (Enhancement 13)
  const [billing, setBilling] = useState(null);
  const [billingLoading, setBillingLoading] = useState(false);

  // Rate limits state (Feature 32)
  const [rateLimits, setRateLimits] = useState(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);

  // Backups state (Feature 33)
  const [backups, setBackups] = useState(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [triggeringBackup, setTriggeringBackup] = useState(false);

  useEffect(() => {
    const u = localStorage.getItem('user');
    if (!u) { router.push('/login'); return; }
    let parsed;
    try { parsed = JSON.parse(u); } catch { router.push('/login'); return; }
    if (parsed.role !== 'super_admin') { router.push('/dashboard'); return; }
    fetchAll();
  }, []);

  async function logout() {
    // Revoke the session server-side (jti blacklist + refresh-token revocation)
    // — clearing localStorage alone leaves the tokens valid for up to 1h / 30d.
    try { await api.post('/auth/logout'); } catch (_) {}
    clearSessionTimers();
    localStorage.clear();
    router.push('/login');
  }

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

  async function openPasswordModal(tenant) {
    setPwModal({ tenant, users: [], issued: null });
    setPwLoadingUsers(true);
    try {
      const { data } = await api.get(`/superadmin/tenants/${tenant.id}/users`);
      setPwModal(m => (m && m.tenant.id === tenant.id ? { ...m, users: data.users || [] } : m));
    } catch {
      toast.error('Failed to load clinic users');
    } finally { setPwLoadingUsers(false); }
  }

  async function resetUserPassword(tenant, user) {
    setPwResettingId(user.id);
    try {
      const { data } = await api.post(`/superadmin/tenants/${tenant.id}/users/${user.id}/reset-password`, {});
      // The password is returned exactly once and never stored, so it is held in
      // component state for the operator to copy before closing the modal.
      setPwModal(m => (m ? { ...m, issued: { email: data.user.email, password: data.password } } : m));
      toast.success('Password reset');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reset password');
    } finally { setPwResettingId(null); }
  }

  async function toggleStatus(tenant) {
    if (tenant.status === 'active') {
      // Show suspension reason modal
      setSuspendModal({ tenant });
      setSuspendReason('');
      return;
    }
    // Reactivate immediately
    try {
      await api.patch(`/superadmin/tenants/${tenant.id}`, { status: 'active' });
      toast.success('Tenant reactivated');
      fetchAll();
    } catch { toast.error('Failed to activate tenant'); }
  }

  async function confirmSuspend() {
    if (!suspendModal) return;
    setSuspending(true);
    try {
      await api.patch(`/superadmin/tenants/${suspendModal.tenant.id}`, {
        status: 'suspended',
        suspension_reason: suspendReason || null,
      });
      toast.success('Tenant suspended');
      setSuspendModal(null);
      setSuspendReason('');
      fetchAll();
    } catch { toast.error('Failed to suspend tenant'); }
    finally { setSuspending(false); }
  }

  function openCityModal(tenant) {
    setCityModal({ tenant });
    setCityValue(tenant.city || '');
  }

  async function saveCity() {
    if (!cityModal) return;
    setSavingCity(true);
    try {
      // An empty input is sent as '' rather than omitted — that is how the API
      // clears a city, whereas omitting the key would leave the old one in place.
      const city = cityValue.trim();
      await api.patch(`/superadmin/tenants/${cityModal.tenant.id}`, { city });
      toast.success(city ? 'City updated' : 'City cleared');
      setCityModal(null);
      setCityValue('');
      fetchAll();
    } catch { toast.error('Failed to update city'); }
    finally { setSavingCity(false); }
  }

  async function fetchBilling() {
    setBillingLoading(true);
    try {
      const { data } = await api.get('/superadmin/billing');
      setBilling(data);
    } catch { toast.error('Failed to load billing data'); }
    finally { setBillingLoading(false); }
  }

  async function fetchRateLimits() {
    setRateLimitsLoading(true);
    try {
      const { data } = await api.get('/superadmin/rate-limits');
      setRateLimits(data);
    } catch { toast.error('Failed to load rate limit data'); }
    finally { setRateLimitsLoading(false); }
  }

  async function unblockIp(ip) {
    try {
      await api.delete(`/superadmin/rate-limits/${encodeURIComponent(ip)}`);
      toast.success(`Unblocked ${ip}`);
      fetchRateLimits();
    } catch { toast.error('Failed to unblock IP'); }
  }

  async function fetchBackups() {
    setBackupsLoading(true);
    try {
      const { data } = await api.get('/superadmin/backups');
      setBackups(data);
    } catch { toast.error('Failed to load backups'); }
    finally { setBackupsLoading(false); }
  }

  async function triggerBackup() {
    setTriggeringBackup(true);
    try {
      await api.post('/superadmin/backups/trigger');
      toast.success('Backup started in background');
      setTimeout(fetchBackups, 3000);
    } catch { toast.error('Failed to trigger backup'); }
    finally { setTriggeringBackup(false); }
  }

  async function loadTenantHealth(tenantId) {
    if (tenantHealth[tenantId]) return; // already loaded
    setLoadingHealth(tenantId);
    try {
      const { data } = await api.get(`/superadmin/tenants/${tenantId}/health`);
      setTenantHealth(prev => ({ ...prev, [tenantId]: data }));
    } catch { /* silent */ }
    finally { setLoadingHealth(null); }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-blue-600">🏥 MediBook</span>
          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">Super Admin</span>
        </div>
        <button onClick={logout}
          className="text-sm text-gray-500 hover:text-red-500 transition">Sign Out</button>
      </nav>

      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Stats */}
        {stats && (
          <>
            {/* min-w-0 on every card: a grid item defaults to min-width:auto, so a
                long grouped number (₹1,50,000 MRR) would widen the card past its
                half-width track at 375px instead of truncating inside it. */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4">
              <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-blue-500 min-w-0">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">Total Tenants</p>
                <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">{stats.total_tenants}</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-green-500 min-w-0">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">Active</p>
                <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">{stats.active_tenants}</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-indigo-400 min-w-0">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">New (30d)</p>
                <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">{stats.monthly_growth ?? 0}</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-orange-400 min-w-0">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">Appts (30d)</p>
                <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">{(parseInt(stats.total_appointments_30d) || 0).toLocaleString('en-IN')}</p>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-pink-400 min-w-0">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">Total Patients</p>
                <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">{(parseInt(stats.total_patients) || 0).toLocaleString('en-IN')}</p>
              </div>
              {stats.mrr != null && (
                <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-yellow-400 min-w-0">
                  <p className="text-xs text-gray-500 uppercase tracking-wide truncate">MRR</p>
                  <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">₹{stats.mrr.toLocaleString('en-IN')}</p>
                </div>
              )}
              {stats.by_plan?.slice(0, 1).map(p => (
                <div key={p.plan} className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-purple-400 min-w-0">
                  <p className="text-xs text-gray-500 uppercase capitalize tracking-wide truncate">{p.plan} plan</p>
                  <p className="text-2xl sm:text-3xl font-bold text-gray-900 tabular-nums truncate">{p.count}</p>
                </div>
              ))}
            </div>

            {/* Plan distribution bar chart */}
            {stats.by_plan?.length > 0 && (
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h3 className="font-semibold text-gray-800 mb-4">Tenants by Plan</h3>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={stats.by_plan.map(p => ({ name: p.plan, count: parseInt(p.count) }))} barSize={40}>
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} allowDecimals={false} width={30} />
                    <Tooltip formatter={(v) => [v, 'Tenants']} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {stats.by_plan.map((_, i) => (
                        <Cell key={i} fill={['#3b82f6','#10b981','#8b5cf6','#f59e0b'][i % 4]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}

        {/* Tab bar. Tabs use basis-0 + grow rather than `flex-1`: flex-1 also sets
            flex-shrink, so it fights the shrink-0 below and whether the strip
            scrolls or squashes at 320px would depend on Tailwind's property
            order. Spelled out, the labels keep their width and the strip scrolls. */}
        <div className="flex gap-1 bg-white rounded-xl shadow-sm p-1 border border-gray-100 overflow-x-auto">
          {[
            { id: 'tenants', label: '🏥 Tenants' },
            { id: 'billing', label: '💰 Billing', onClick: () => { setTab('billing'); if (!billing) fetchBilling(); } },
            { id: 'rate_limits', label: '🚦 Rate Limits', onClick: () => { setTab('rate_limits'); if (!rateLimits) fetchRateLimits(); } },
            { id: 'backups', label: '💾 Backups', onClick: () => { setTab('backups'); if (!backups) fetchBackups(); } },
          ].map(t => (
            <button key={t.id}
              onClick={() => { if (t.onClick) t.onClick(); else setTab(t.id); }}
              className={`basis-0 grow shrink-0 whitespace-nowrap px-3 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition-colors ${tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tenants table */}
        {tab === 'tenants' && <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-gray-800">All Tenants ({tenants.length})</h2>
            <div className="flex flex-wrap gap-2">
              <button onClick={fetchAll} className="px-3 py-2 sm:py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">🔄 Refresh</button>
              <button onClick={() => router.push('/superadmin/new-tenant')} className="px-3 py-2 sm:py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">+ New Tenant</button>
            </div>
          </div>

          {loading ? (
            <div className="px-5 py-12 text-center text-gray-400">Loading tenants...</div>
          ) : (
            <>
            {/* Mobile tenant cards. Nine columns cannot be made legible by
                horizontal scrolling alone, so the row is restacked here and the
                table is hidden below md. */}
            <div className="md:hidden divide-y divide-gray-100">
              {tenants.map(t => {
                const health = tenantHealth[t.id];
                const flags = health?.flags || {};
                return (
                  <div key={`mob-${t.id}`} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 break-words">{t.name}</div>
                        {/* City rides under the clinic name rather than getting its
                            own column/row, matching the desktop table. Rendered even
                            when empty: no city means the clinic never appears in the
                            bot's "near me" results, which must not be invisible. */}
                        <div className="text-xs text-gray-500 break-words">
                          {t.city || <span className="text-gray-400">— no city —</span>}
                        </div>
                        <div className="font-mono text-xs text-blue-600 break-all">{t.slug}</div>
                        <div className="text-xs text-gray-600 break-all mt-0.5">{t.owner_email}</div>
                      </div>
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium shrink-0 ${
                        t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                      }`}>{t.status}</span>
                    </div>
                    {t.suspension_reason && (
                      <div className="text-xs text-red-400 break-words">{t.suspension_reason}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full capitalize">{t.plan_name || t.plan}</span>
                      <span className="text-green-600">✅ Shared</span>
                      <span className="text-gray-400">
                        {t.created_at ? format(parseISO(t.created_at), 'd MMM yy') : '—'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {health ? (
                        <>
                          {flags.no_recent_activity && (
                            <span className="text-xs text-orange-500" title="No appointments in 30 days">⚠️ Inactive</span>
                          )}
                          {flags.low_slots && (
                            <span className="text-xs text-yellow-600" title="Fewer than 5 available slots">📅 Low slots</span>
                          )}
                          {flags.no_whatsapp && (
                            <span className="text-xs text-gray-400" title="WhatsApp not configured">📵 No WA</span>
                          )}
                          {!flags.no_recent_activity && !flags.low_slots && !flags.no_whatsapp && (
                            <span className="text-xs text-green-600">✅ Healthy</span>
                          )}
                        </>
                      ) : (
                        <button
                          onClick={() => loadTenantHealth(t.id)}
                          disabled={loadingHealth === t.id}
                          className="inline-flex items-center justify-center min-h-[40px] px-3 py-2 text-xs text-blue-600 border border-blue-200 bg-blue-50 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition">
                          {loadingHealth === t.id ? '...' : '🩺 Check health'}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => toggleStatus(t)}
                        className={`inline-flex items-center justify-center min-h-[40px] px-3 py-2 text-xs rounded-lg border transition ${
                          t.status === 'active'
                            ? 'text-red-600 border-red-200 bg-red-50 hover:bg-red-100'
                            : 'text-green-600 border-green-200 bg-green-50 hover:bg-green-100'
                        }`}>
                        {t.status === 'active' ? 'Suspend' : 'Activate'}
                      </button>
                      <button onClick={() => openPasswordModal(t)}
                        className="inline-flex items-center justify-center min-h-[40px] px-3 py-2 text-xs text-blue-600 border border-blue-200 bg-blue-50 rounded-lg hover:bg-blue-100 transition">
                        🔑 Reset password
                      </button>
                      <button onClick={() => openCityModal(t)}
                        className="inline-flex items-center justify-center min-h-[40px] px-3 py-2 text-xs text-gray-600 border border-gray-200 bg-gray-50 rounded-lg hover:bg-gray-100 transition">
                        📍 Set city
                      </button>
                    </div>
                  </div>
                );
              })}
              {!tenants.length && (
                <div className="px-4 py-12 text-center text-gray-400">No tenants yet. Create the first one!</div>
              )}
            </div>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['Clinic', 'Slug', 'Owner', 'Plan', 'WhatsApp', 'Status', 'Health', 'Created', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {tenants.map(t => {
                    const health = tenantHealth[t.id];
                    const flags = health?.flags || {};
                    return (
                      <tr key={t.id} className="hover:bg-gray-50">
                        {/* City lives inside the Clinic cell rather than as a tenth
                            column: this table is already wide enough to scroll at md,
                            and a sub-line needs no header/colSpan change. Rendered
                            even when empty — a clinic with no city is silently
                            excluded from the bot's "near me" results. */}
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {t.name}
                          <div className="text-xs font-normal text-gray-500">
                            {t.city || <span className="text-gray-400">— no city —</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-blue-600">{t.slug}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{t.owner_email}</td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full capitalize">{t.plan_name || t.plan}</span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span className="text-green-600">✅ Shared</span>
                        </td>
                        <td className="px-4 py-3">
                          <div>
                            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                              t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                            }`}>{t.status}</span>
                            {t.suspension_reason && (
                              <div className="text-xs text-red-400 mt-0.5 max-w-[120px] truncate" title={t.suspension_reason}>
                                {t.suspension_reason}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {health ? (
                            <div className="flex flex-col gap-0.5">
                              {flags.no_recent_activity && (
                                <span className="text-xs text-orange-500" title="No appointments in 30 days">⚠️ Inactive</span>
                              )}
                              {flags.low_slots && (
                                <span className="text-xs text-yellow-600" title="Fewer than 5 available slots">📅 Low slots</span>
                              )}
                              {flags.no_whatsapp && (
                                <span className="text-xs text-gray-400" title="WhatsApp not configured">📵 No WA</span>
                              )}
                              {!flags.no_recent_activity && !flags.low_slots && !flags.no_whatsapp && (
                                <span className="text-xs text-green-600">✅ Healthy</span>
                              )}
                            </div>
                          ) : (
                            <button
                              onClick={() => loadTenantHealth(t.id)}
                              disabled={loadingHealth === t.id}
                              className="text-xs text-blue-500 hover:underline disabled:opacity-50">
                              {loadingHealth === t.id ? '...' : 'Check'}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">
                          {t.created_at ? format(parseISO(t.created_at), 'd MMM yy') : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col items-start gap-1">
                            <button onClick={() => toggleStatus(t)}
                              className={`text-xs px-2 py-1 rounded transition ${
                                t.status === 'active'
                                  ? 'text-red-600 hover:bg-red-50'
                                  : 'text-green-600 hover:bg-green-50'
                              }`}>
                              {t.status === 'active' ? 'Suspend' : 'Activate'}
                            </button>
                            <button onClick={() => openPasswordModal(t)}
                              className="text-xs px-2 py-1 rounded text-blue-600 hover:bg-blue-50 transition whitespace-nowrap">
                              🔑 Reset password
                            </button>
                            <button onClick={() => openCityModal(t)}
                              className="text-xs px-2 py-1 rounded text-gray-600 hover:bg-gray-100 transition whitespace-nowrap">
                              📍 Set city
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!tenants.length && (
                    <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">No tenants yet. Create the first one!</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>}

        {/* Billing Tab (Enhancement 13) */}
        {tab === 'billing' && (
          <div className="space-y-5">
            {billingLoading ? (
              <div className="bg-white rounded-xl p-12 text-center text-gray-400">Loading billing data...</div>
            ) : billing ? (
              <>
                {/* MRR Summary */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-green-500 min-w-0">
                    <p className="text-xs text-gray-500 uppercase tracking-wide truncate">Total MRR</p>
                    <p className="text-2xl sm:text-3xl font-bold text-gray-900 mt-1 tabular-nums truncate">₹{(billing.mrr_total || 0).toLocaleString('en-IN')}</p>
                  </div>
                  {billing.by_plan?.filter(p => parseInt(p.tenant_count) > 0).map(p => (
                    <div key={p.id} className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-blue-400 min-w-0">
                      <p className="text-xs text-gray-500 uppercase tracking-wide capitalize truncate">{p.name}</p>
                      <p className="text-2xl sm:text-3xl font-bold text-gray-900 mt-1 tabular-nums truncate">{p.tenant_count}</p>
                      <p className="text-sm text-gray-500 truncate">₹{(p.subtotal || 0).toLocaleString('en-IN')}/mo</p>
                    </div>
                  ))}
                </div>

                {/* Plan breakdown chart */}
                {billing.by_plan?.length > 0 && (
                  <div className="bg-white rounded-xl p-5 shadow-sm">
                    <h3 className="font-semibold text-gray-800 mb-4">Revenue by Plan</h3>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={billing.by_plan.map(p => ({ name: p.name, subtotal: p.subtotal || 0, tenants: parseInt(p.tenant_count) }))} barSize={50}>
                        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} width={60} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
                        <Tooltip formatter={(v, n) => n === 'subtotal' ? [`₹${v.toLocaleString('en-IN')}`, 'Revenue'] : [v, 'Tenants']} />
                        <Bar dataKey="subtotal" radius={[4,4,0,0]}>
                          {billing.by_plan.map((_, i) => (
                            <Cell key={i} fill={['#10b981','#3b82f6','#8b5cf6','#f59e0b'][i % 4]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Recent plan changes */}
                <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100">
                    <h3 className="font-semibold text-gray-800">Plan Change History</h3>
                  </div>
                  {/* Mobile plan-change cards (the table is hidden below md) */}
                  <div className="md:hidden divide-y divide-gray-100">
                    {billing.recent_changes?.map(c => (
                      <div key={`mob-${c.id}`} className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-gray-900 break-words min-w-0">{c.tenant_name}</div>
                          <div className="text-xs text-gray-400 shrink-0">
                            {c.changed_at ? format(parseISO(c.changed_at), 'd MMM yyyy') : '—'}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs capitalize">{c.old_plan || '—'}</span>
                          <span className="text-gray-400 text-xs">→</span>
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs capitalize">{c.new_plan}</span>
                        </div>
                      </div>
                    ))}
                    {!billing.recent_changes?.length && (
                      <div className="px-4 py-8 text-center text-gray-400">No plan changes yet</div>
                    )}
                  </div>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>{['Clinic', 'From', 'To', 'Date'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {billing.recent_changes?.map(c => (
                          <tr key={c.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium text-gray-900">{c.tenant_name}</td>
                            <td className="px-4 py-3"><span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs capitalize">{c.old_plan || '—'}</span></td>
                            <td className="px-4 py-3"><span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs capitalize">{c.new_plan}</span></td>
                            <td className="px-4 py-3 text-gray-400 text-xs">{c.changed_at ? format(parseISO(c.changed_at), 'd MMM yyyy') : '—'}</td>
                          </tr>
                        ))}
                        {!billing.recent_changes?.length && (
                          <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No plan changes yet</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl p-12 text-center">
                <button onClick={fetchBilling} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">Load Billing Data</button>
              </div>
            )}
          </div>
        )}

        {/* Rate Limits Tab (Feature 32) */}
        {tab === 'rate_limits' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-gray-800">Rate Limit Dashboard</h2>
              <button onClick={fetchRateLimits} className="px-3 py-2 sm:py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">🔄 Refresh</button>
            </div>

            {rateLimitsLoading ? (
              <div className="bg-white rounded-xl p-12 text-center text-gray-400">Loading rate limit data...</div>
            ) : rateLimits ? (
              <>
                {/* Blocked IPs */}
                <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100">
                    <h3 className="font-semibold text-gray-800">Blocked IPs ({rateLimits.blocked_ips?.length || 0})</h3>
                  </div>
                  {/* Mobile blocked-IP cards (the table is hidden below md) */}
                  <div className="md:hidden divide-y divide-gray-100">
                    {rateLimits.blocked_ips?.map(row => (
                      <div key={`mob-${row.ip}`} className="p-4 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-mono text-sm text-gray-900 break-all min-w-0">{row.ip}</span>
                          <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-medium shrink-0">
                            {row.offense_count} offenses
                          </span>
                        </div>
                        <dl className="text-xs space-y-1">
                          <div className="flex gap-2">
                            <dt className="text-gray-400 shrink-0">Blocked until</dt>
                            <dd className="text-gray-600 break-words ml-auto text-right">
                              {row.blocked_until ? new Date(row.blocked_until).toLocaleString('en-IN') : '—'}
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="text-gray-400 shrink-0">Blocked at</dt>
                            <dd className="text-gray-400 break-words ml-auto text-right">
                              {row.blocked_at ? new Date(row.blocked_at).toLocaleString('en-IN') : '—'}
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="text-gray-400 shrink-0">Reason</dt>
                            <dd className="text-gray-500 break-words ml-auto text-right">{row.reason || '—'}</dd>
                          </div>
                        </dl>
                        <button
                          onClick={() => unblockIp(row.ip)}
                          className="inline-flex items-center justify-center min-h-[40px] px-3 py-2 text-xs text-green-600 border border-green-200 bg-green-50 rounded-lg hover:bg-green-100 transition"
                        >
                          Unblock
                        </button>
                      </div>
                    ))}
                    {!rateLimits.blocked_ips?.length && (
                      <div className="px-4 py-8 text-center text-gray-400">No blocked IPs</div>
                    )}
                  </div>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          {['IP Address', 'Offense Count', 'Blocked Until', 'Reason', 'Blocked At', 'Action'].map(h => (
                            <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {rateLimits.blocked_ips?.map(row => (
                          <tr key={row.ip} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-mono text-sm text-gray-900">{row.ip}</td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-medium">{row.offense_count}</span>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600">
                              {row.blocked_until ? new Date(row.blocked_until).toLocaleString('en-IN') : '—'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500 max-w-xs truncate">{row.reason || '—'}</td>
                            <td className="px-4 py-3 text-xs text-gray-400">
                              {row.blocked_at ? new Date(row.blocked_at).toLocaleString('en-IN') : '—'}
                            </td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => unblockIp(row.ip)}
                                className="text-xs px-2 py-1 text-green-600 hover:bg-green-50 rounded transition"
                              >
                                Unblock
                              </button>
                            </td>
                          </tr>
                        ))}
                        {!rateLimits.blocked_ips?.length && (
                          <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No blocked IPs</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Live Traffic */}
                <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100">
                    <h3 className="font-semibold text-gray-800">Live Traffic — Current Minute</h3>
                    <p className="text-xs text-gray-400 mt-0.5">As of {rateLimits.timestamp ? new Date(rateLimits.timestamp).toLocaleTimeString('en-IN') : '—'}</p>
                  </div>
                  {/* Mobile live-traffic cards (the table is hidden below md) */}
                  <div className="md:hidden divide-y divide-gray-100">
                    {rateLimits.live_traffic?.map(row => (
                      <div key={`mob-${row.tenant_id}`} className="p-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 break-words">{row.tenant_name}</div>
                          <div className="font-mono text-xs text-blue-600 break-all">{row.tenant_slug}</div>
                          <span className="inline-block mt-1 px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full capitalize">{row.plan}</span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className={`font-bold tabular-nums ${row.requests_this_minute > 50 ? 'text-red-600' : 'text-gray-900'}`}>
                            {row.requests_this_minute}
                          </div>
                          <div className="text-xs text-gray-400">req/min</div>
                        </div>
                      </div>
                    ))}
                    {!rateLimits.live_traffic?.length && (
                      <div className="px-4 py-8 text-center text-gray-400">No active traffic this minute</div>
                    )}
                  </div>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          {['Tenant', 'Slug', 'Plan', 'Requests This Minute'].map(h => (
                            <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {rateLimits.live_traffic?.map(row => (
                          <tr key={row.tenant_id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium text-gray-900">{row.tenant_name}</td>
                            <td className="px-4 py-3 font-mono text-xs text-blue-600">{row.tenant_slug}</td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full capitalize">{row.plan}</span>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`font-bold ${row.requests_this_minute > 50 ? 'text-red-600' : 'text-gray-900'}`}>
                                {row.requests_this_minute}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {!rateLimits.live_traffic?.length && (
                          <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No active traffic this minute</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl p-12 text-center">
                <button onClick={fetchRateLimits} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">Load Rate Limit Data</button>
              </div>
            )}
          </div>
        )}

        {/* Backups Tab (Feature 33) */}
        {tab === 'backups' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-gray-800">Database Backups</h2>
              <div className="flex flex-wrap gap-2">
                <button onClick={fetchBackups} className="px-3 py-2 sm:py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition">🔄 Refresh</button>
                <button
                  onClick={triggerBackup}
                  disabled={triggeringBackup}
                  className="px-3 py-2 sm:py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {triggeringBackup ? 'Starting...' : '▶ Trigger Backup'}
                </button>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 sm:px-5 py-4 text-sm text-yellow-800">
              <strong>Restore Instructions:</strong> Download the backup file from the server via SSH/SFTP, then run:
              <code className="block bg-yellow-100 rounded px-3 py-2 mt-2 font-mono text-xs break-all">psql $DATABASE_URL &lt; medibook_backup_YYYYMMDD.sql</code>
            </div>

            {backupsLoading ? (
              <div className="bg-white rounded-xl p-12 text-center text-gray-400">Loading backup history...</div>
            ) : backups ? (
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100">
                  <h3 className="font-semibold text-gray-800">Backup History (last 30)</h3>
                </div>
                {/* Mobile backup cards (the table is hidden below md) */}
                <div className="md:hidden divide-y divide-gray-100">
                  {backups.backups?.map(b => (
                    <div key={`mob-${b.id}`} className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs text-gray-600 min-w-0 break-words">
                          {b.started_at ? new Date(b.started_at).toLocaleString('en-IN') : '—'}
                        </div>
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium shrink-0 ${
                          b.status === 'success' ? 'bg-green-100 text-green-700' :
                          b.status === 'failed' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>{b.status}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                        <span>Size: {b.size_bytes ? `${Math.round(b.size_bytes / 1024)}KB` : '—'}</span>
                        <span>Took: {b.duration_ms ? `${(b.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
                      </div>
                      <div className="text-xs text-gray-400 break-words">
                        Completed: {b.completed_at ? new Date(b.completed_at).toLocaleString('en-IN') : '—'}
                      </div>
                      <div className="text-xs text-gray-400 break-all" title={b.file_path || ''}>
                        {b.file_path ? b.file_path.split(/[/\\]/).pop() : '—'}
                      </div>
                      {b.error_message && (
                        <div className="text-xs text-red-500 break-words">{b.error_message}</div>
                      )}
                    </div>
                  ))}
                  {!backups.backups?.length && (
                    <div className="px-4 py-8 text-center text-gray-400">No backups yet. Trigger one above.</div>
                  )}
                </div>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        {['Started', 'Completed', 'Status', 'Size', 'Duration', 'File Path', 'Error'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {backups.backups?.map(b => (
                        <tr key={b.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-xs text-gray-600">
                            {b.started_at ? new Date(b.started_at).toLocaleString('en-IN') : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600">
                            {b.completed_at ? new Date(b.completed_at).toLocaleString('en-IN') : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                              b.status === 'success' ? 'bg-green-100 text-green-700' :
                              b.status === 'failed' ? 'bg-red-100 text-red-700' :
                              'bg-yellow-100 text-yellow-700'
                            }`}>{b.status}</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600">
                            {b.size_bytes ? `${Math.round(b.size_bytes / 1024)}KB` : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600">
                            {b.duration_ms ? `${(b.duration_ms / 1000).toFixed(1)}s` : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-400 max-w-xs truncate" title={b.file_path || ''}>
                            {b.file_path ? b.file_path.split(/[/\\]/).pop() : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-red-500 max-w-xs truncate" title={b.error_message || ''}>
                            {b.error_message || '—'}
                          </td>
                        </tr>
                      ))}
                      {!backups.backups?.length && (
                        <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No backups yet. Trigger one above.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl p-12 text-center">
                <button onClick={fetchBackups} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">Load Backup History</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Suspension Reason Modal */}
      {pwModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-white rounded-2xl p-4 sm:p-6 w-full max-w-lg shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h2 className="text-base font-semibold text-gray-900">Reset Password</h2>
              <button onClick={() => setPwModal(null)} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-4 break-words">{pwModal.tenant.name}</p>

            {pwModal.issued ? (
              <div className="space-y-3">
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 sm:p-4">
                  <p className="text-sm text-green-800 font-medium mb-2 break-all">
                    New password for {pwModal.issued.email}
                  </p>
                  <code className="block bg-white border border-green-200 rounded px-3 py-2 font-mono text-sm break-all">
                    {pwModal.issued.password}
                  </code>
                  <p className="text-xs text-green-700 mt-2">
                    Shown once and not stored anywhere. Copy it now, send it over a secure
                    channel, and ask them to change it after signing in.
                  </p>
                </div>
                <p className="text-xs text-gray-400">
                  Any existing sessions for this user have been signed out.
                </p>
                <button onClick={() => setPwModal(null)}
                  className="w-full px-4 py-2.5 sm:py-2 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-900 transition">
                  Done
                </button>
              </div>
            ) : pwLoadingUsers ? (
              <p className="text-sm text-gray-400 py-8 text-center">Loading users...</p>
            ) : !pwModal.users.length ? (
              <p className="text-sm text-gray-400 py-8 text-center">No users found for this clinic.</p>
            ) : (
              <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                {pwModal.users.map(u => (
                  <div key={u.id} className="p-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">{u.name || u.email}</div>
                      <div className="text-xs text-gray-500 truncate">{u.email}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                        u.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                      }`}>{u.role}</span>
                      <button
                        onClick={() => resetUserPassword(pwModal.tenant, u)}
                        disabled={pwResettingId === u.id}
                        className="min-h-[40px] sm:min-h-0 px-3 py-2 sm:py-1.5 text-xs border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 disabled:opacity-50 transition whitespace-nowrap">
                        {pwResettingId === u.id ? 'Resetting...' : 'Reset'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {suspendModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-white rounded-2xl p-4 sm:p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between gap-2 mb-4">
              <h2 className="text-base font-semibold text-gray-900">Suspend Tenant</h2>
              <button onClick={() => setSuspendModal(null)} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">✕</button>
            </div>
            <p className="text-sm text-gray-600 mb-4 break-words">
              You are about to suspend <strong>{suspendModal.tenant.name}</strong>. Their WhatsApp bot will stop responding immediately.
            </p>
            <div className="mb-5">
              <label className="block text-xs font-medium text-gray-700 mb-1">Reason (optional)</label>
              <textarea value={suspendReason}
                onChange={e => setSuspendReason(e.target.value)}
                rows={3}
                placeholder="e.g. Non-payment, policy violation..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none" />
            </div>
            {/* Stacked below sm: side by side, "Suspend Tenant" is wider than the
                half of a 320px modal it would get and would overflow. */}
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
              <button onClick={() => setSuspendModal(null)}
                className="flex-1 px-4 py-2.5 sm:py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
                Cancel
              </button>
              <button onClick={confirmSuspend} disabled={suspending}
                className="flex-1 px-4 py-2.5 sm:py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition">
                {suspending ? 'Suspending...' : 'Suspend Tenant'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cityModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-white rounded-2xl p-4 sm:p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between gap-2 mb-4">
              <h2 className="text-base font-semibold text-gray-900">Set City</h2>
              <button onClick={() => setCityModal(null)} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">✕</button>
            </div>
            <p className="text-sm text-gray-600 mb-4 break-words">
              The city for <strong>{cityModal.tenant.name}</strong>. Patients use it to find this clinic
              through the bot&apos;s &quot;clinics near me&quot; search — clear it to remove the clinic from those results.
            </p>
            <div className="mb-5">
              <label className="block text-xs font-medium text-gray-700 mb-1">City (leave blank to clear)</label>
              <input value={cityValue}
                onChange={e => setCityValue(e.target.value)}
                maxLength={100}
                placeholder="e.g. Bengaluru"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            {/* Stacked below sm for the same reason as the suspend modal: the two
                labels side by side are wider than a 320px modal allows. */}
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
              <button onClick={() => setCityModal(null)}
                className="flex-1 px-4 py-2.5 sm:py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
                Cancel
              </button>
              <button onClick={saveCity} disabled={savingCity}
                className="flex-1 px-4 py-2.5 sm:py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
                {savingCity ? 'Saving...' : 'Save City'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
