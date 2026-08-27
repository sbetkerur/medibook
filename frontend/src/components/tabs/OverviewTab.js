'use client';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import StatCard from '@/components/ui/StatCard';
import Badge from '@/components/ui/Badge';
import RequestsPanel from '@/components/RequestsPanel';

/**
 * Dashboard landing tab.
 *
 * Ordered for a front desk, not for an owner reading a report. Roughly half of
 * an Indian clinic's footfall walks in, so the first thing on the page is
 * TODAY — who is coming, and a one-tap way to add the person standing at the
 * counter — followed by the patients the bot could not serve. The stat row is
 * still here, just no longer first: nobody starts their day by reading it.
 */
export default function OverviewTab({
  loading,
  stats,
  statsLastUpdated,
  statsRefreshing,
  fetchStats,
  analyticsSummary,
  setTab,
  exportCSV,
  onAddWalkin,
  isAdmin,
}) {
  return (
    <div className="space-y-6">
      {/* ── TODAY ──────────────────────────────────────────── */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 md:px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-800">
            Today
            {stats?.todays_schedule?.length ? (
              <span className="ml-2 text-xs font-normal text-gray-500">
                {stats.todays_schedule.length} booked
              </span>
            ) : null}
          </h2>
          {/* The walk-in button lives HERE, not two tabs away. A patient at the
              counter is the most common thing that happens in the day and it
              used to be the least accessible action in the product.
              Gated on isAdmin to match POST /admin/appointments, which is
              adminOnly: rendering it to staff and doctors offered an action
              that always answered 403. The Appointments tab already gates its
              copy of this button the same way. */}
          {isAdmin && (
            <button onClick={onAddWalkin}
              className="shrink-0 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
              + Walk-in
            </button>
          )}
        </div>
        {loading ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : stats?.todays_schedule?.length ? (
          <div className="divide-y divide-gray-50">
            {/* Keyed on the appointment, not the array index: this list is
                refetched every 60s and after every status change, so an index
                key made React reuse a row for a different patient. */}
            {stats.todays_schedule.map((a, i) => (
              <div key={a.id || a.booking_id || i} className="px-4 md:px-5 py-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="text-sm font-medium text-blue-600 w-12 shrink-0">{a.appointment_time?.slice(0,5)}</div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{a.patient_name}</div>
                    <div className="text-xs text-gray-500 truncate">Dr. {a.doctor_name}</div>
                  </div>
                </div>
                <Badge status={a.status} />
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            Nothing booked yet today.{isAdmin ? ' Walk-ins go straight in with the button above.' : ''}
          </div>
        )}
      </div>

      <RequestsPanel />

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="bg-white rounded-xl p-3 md:p-5 border-l-4 border-gray-200 shadow-sm animate-pulse">
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
          {/* Bare text at 51x16 — padding gives it a thumb-sized row without
              changing how it looks. */}
          <button onClick={() => fetchStats(true)} disabled={statsRefreshing}
            className="shrink-0 px-3 py-2.5 -my-2 -mr-3 text-xs text-blue-500 hover:text-blue-700 disabled:opacity-50 transition md:px-0 md:py-0 md:m-0">
            ↻ Refresh
          </button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
          <StatCard label="Today" value={stats?.today_appointments} icon="📅" color="border-blue-500" />
          <StatCard label="Upcoming" value={stats?.upcoming_appointments} icon="🗓" color="border-green-500" />
          <StatCard label="Patients" value={stats?.total_patients} icon="👥" color="border-purple-500" />
          <StatCard label="Open Slots" value={stats?.available_slots} icon="⏰" color="border-orange-500" />
          {/* Treatment the clinic has already advised and nobody has booked —
              revenue agreed and sitting idle. It was a filter chip on another
              tab; an owner should see the number without going looking. */}
          <StatCard
            label="Unbooked Treatment"
            value={stats?.outstanding_treatments == null
              ? '—'
              : stats.outstanding_treatment_value > 0
                ? `₹${Number(stats.outstanding_treatment_value).toLocaleString('en-IN')}`
                : String(stats.outstanding_treatments)}
            sub={stats?.outstanding_treatments != null
              ? `${stats.outstanding_treatments} treatment${stats.outstanding_treatments === 1 ? '' : 's'} to book`
              : null}
            icon="🩺"
            color="border-teal-500"
          />
          <StatCard
            label="Revenue (30d)"
            value={analyticsSummary ? `₹${Number(analyticsSummary.revenue || 0).toLocaleString('en-IN')}` : '—'}
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


      <div className="bg-white rounded-xl p-5 shadow-sm">
        <h3 className="font-semibold text-gray-800 mb-3">Quick Actions</h3>
        <div className="flex flex-wrap gap-3">
          {isAdmin && (
            <button onClick={onAddWalkin} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition">+ Walk-in</button>
          )}
          <button onClick={() => setTab('appointments')} className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">View All Appointments</button>
          <button onClick={() => setTab('doctors')} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition">Manage Dentists</button>
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
  );
}
