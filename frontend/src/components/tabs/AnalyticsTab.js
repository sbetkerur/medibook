'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// `analyticsSummary` (the overview revenue card) stays in page.js and is
// refreshed by the parent tab-switch effect; this component owns only the
// analytics breakdown and revenue sections.
// referral_source codes (backend REFERRAL_SOURCES + the 'unknown' bucket) → labels
const SOURCE_LABELS = {
  walk_past: 'Walked past', google: 'Google', friend: 'Friend / family',
  doctor_referral: 'Doctor referral', social: 'Social media', returning: 'Returning patient',
  other: 'Other', unknown: 'Not recorded',
};

export default function AnalyticsTab() {
  const [analytics, setAnalytics] = useState(null);
  const [analyticsFailed, setAnalyticsFailed] = useState(false);
  const [revenueData, setRevenueData] = useState(null);
  const [revenueMonths, setRevenueMonths] = useState(6);
  const [funnel, setFunnel] = useState(null);

  // A failure used to leave `analytics` at null, which renders "Loading
  // analytics..." forever. The toast is gone in four seconds, after which a
  // broken tab is indistinguishable from a slow one — and there was no way to
  // retry short of knowing to switch tabs away and back to remount. Track the
  // failure and offer the retry.
  const fetchAnalytics = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/analytics');
      setAnalytics(data);
      setAnalyticsFailed(false);
    } catch {
      setAnalyticsFailed(true);
      toast.error('Failed to load analytics');
    }
  }, []);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  // Treatment conversion funnel — its own endpoint (own rate-limit bucket), so
  // a failure here never blocks the rest of the tab. Silent-fails to a no-data
  // state, like the revenue section.
  useEffect(() => {
    let cancelled = false;
    api.get('/admin/analytics/funnel?days=90')
      .then(({ data }) => { if (!cancelled) setFunnel(data); })
      .catch(() => { /* silent — funnel section shows no-data state */ });
    return () => { cancelled = true; };
  }, []);

  // `revenueMonths` is the only trigger for a revenue fetch. The dropdown used
  // to also call fetchRevenue() itself, and because that callback closed over
  // revenueMonths its identity changed too — re-running the mount effect for a
  // second /analytics/revenue plus a pointless /analytics. Three requests per
  // dropdown change against a 5/min per-user limit meant real users got 429s.
  useEffect(() => {
    let cancelled = false;
    api.get(`/admin/analytics/revenue?months=${revenueMonths}`)
      .then(({ data }) => { if (!cancelled) setRevenueData(data); })
      .catch(() => { /* silent — revenue section shows no-data state */ });
    return () => { cancelled = true; };
  }, [revenueMonths]);

  return (
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
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={analytics.by_department.map(d => ({ name: d.name || 'Other', count: parseInt(d.count) }))}
                  margin={{ bottom: 40 }}
                >
                  {/* Angled + every label shown: on a phone, 4+ upright department
                      names overlapped into an unreadable smear. */}
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={50} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={30} />
                  <Tooltip formatter={(v) => [v, 'Appointments']} />
                  <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {/* New patients by source — the marketing-spend question. */}
          {analytics.by_source?.length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm">
              <h3 className="font-semibold text-gray-800 mb-4">New Patients by Source (30 days)</h3>
              <div className="space-y-3">
                {(() => {
                  const total = analytics.by_source.reduce((sum, x) => sum + parseInt(x.count), 0);
                  return analytics.by_source.map(row => {
                    const pct = total ? Math.round(parseInt(row.count) / total * 100) : 0;
                    return (
                      <div key={row.source}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-700">{SOURCE_LABELS[row.source] || row.source}</span>
                          <span className="font-medium">{row.count} ({pct}%)</span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-teal-500 rounded-full" style={{ width: pct + '%' }} />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
              <p className="text-xs text-gray-400 mt-3">Set a patient's source from their profile — Patients tab → open a patient → Source.</p>
            </div>
          )}
        </>
      ) : analyticsFailed ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-3">Analytics could not be loaded.</p>
          <button onClick={fetchAnalytics}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
            Retry
          </button>
        </div>
      ) : (
        <div className="text-center text-gray-400 py-12">Loading analytics...</div>
      )}

      {/* ── TREATMENT CONVERSION FUNNEL ── */}
      {funnel && funnel.stages?.[0]?.count > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-1">Treatment Conversion (90 days)</h3>
          <p className="text-xs text-gray-400 mb-4">
            {funnel.consultations} consultation{funnel.consultations === 1 ? '' : 's'} completed · {funnel.stages[0].count} treatment{funnel.stages[0].count === 1 ? '' : 's'} advised
          </p>
          <div className="space-y-2">
            {funnel.stages.map(st => (
              <div key={st.key}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-700">{st.label}</span>
                  <span className="font-medium">{st.count} <span className="text-gray-400">({st.pct_of_advised}%)</span></span>
                </div>
                <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full" style={{ width: Math.max(st.pct_of_advised, st.count > 0 ? 2 : 0) + '%' }} />
                </div>
              </div>
            ))}
          </div>

          {funnel.by_dentist?.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">By dentist</h4>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 text-left">
                    <th className="py-1 pr-3 font-medium">Dentist</th>
                    <th className="py-1 px-2 font-medium text-right">Advised</th>
                    <th className="py-1 px-2 font-medium text-right">Booked</th>
                    <th className="py-1 px-2 font-medium text-right">Completed</th>
                    <th className="py-1 pl-2 font-medium text-right">% booked</th>
                  </tr>
                </thead>
                <tbody>
                  {funnel.by_dentist.map(row => (
                    <tr key={row.dentist} className="border-t border-gray-100">
                      <td className="py-1.5 pr-3 text-gray-700 whitespace-nowrap">{row.dentist === 'Unassigned' ? row.dentist : `Dr. ${row.dentist}`}</td>
                      <td className="py-1.5 px-2 text-right">{row.advised}</td>
                      <td className="py-1.5 px-2 text-right">{row.booked}</td>
                      <td className="py-1.5 px-2 text-right">{row.completed}</td>
                      <td className="py-1.5 pl-2 text-right font-medium">{row.advised > 0 ? Math.round(row.booked / row.advised * 100) : 0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── REVENUE SECTION (A6) ── */}
      <div className="bg-white rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 className="font-semibold text-gray-800">💰 Revenue Analytics</h3>
          <select value={revenueMonths}
            onChange={e => setRevenueMonths(Number(e.target.value))}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {[3, 6, 12, 24].map(m => <option key={m} value={m}>Last {m} months</option>)}
          </select>
        </div>
        {revenueData ? (
          <div className="space-y-5">
            {/* KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <div className="bg-green-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-green-700">₹{(parseInt(revenueData.total_revenue) || 0).toLocaleString('en-IN')}</div>
                <div className="text-xs text-green-600 mt-1">Total Revenue ({revenueMonths}m)</div>
              </div>
              <div className="bg-blue-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-blue-700">{revenueData.monthly?.length || 0}</div>
                <div className="text-xs text-blue-600 mt-1">Active Months</div>
              </div>
              <div className="bg-purple-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-purple-700">
                  ₹{revenueData.monthly?.length ? Math.round((parseInt(revenueData.total_revenue) || 0) / revenueData.monthly.length).toLocaleString('en-IN') : 0}
                </div>
                <div className="text-xs text-purple-600 mt-1">Avg Monthly</div>
              </div>
            </div>
            {/* Monthly revenue bar chart */}
            {revenueData.monthly?.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Monthly Revenue (₹)</h4>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={revenueData.monthly.map(m => ({ month: m.month, revenue: parseInt(m.revenue) || 0 }))}>
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
                      // The fixed name + amount columns add up to more than a
                      // 320px card is wide, leaving the bar negative space, so
                      // both narrow on phones. The amount stays nowrap because
                      // ₹1,50,000 has no break opportunity.
                      <div key={d.doctor_id || d.doctor_name} className="flex items-center gap-2 sm:gap-3">
                        <span className="text-xs font-bold text-gray-400 w-4">#{i + 1}</span>
                        <span className="text-sm text-gray-700 w-20 sm:w-28 truncate">Dr. {d.doctor_name}</span>
                        <div className="flex-1 min-w-0 h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-sm font-semibold text-gray-800 w-20 sm:w-24 text-right whitespace-nowrap">₹{parseInt(d.revenue).toLocaleString('en-IN')}</span>
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
                    <div key={t.category} className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500 truncate">{t.category}</div>
                      <div className="text-sm font-bold text-gray-800 mt-1">₹{parseInt(t.revenue).toLocaleString('en-IN')}</div>
                      <div className="text-xs text-gray-400">{t.appointments} appts</div>
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
  );
}
