'use client';

// Presentational component. `doctors` is shared with the Slots tab, the walk-in
// modal and the Leaves tab, so the list, its fetch and the doctor/schedule/slot
// modals stay in page.js and are threaded in as props/callbacks.
export default function DoctorsTab({
  doctors,
  settings,
  isAdmin,
  showInactive,
  setShowInactive,
  importingDoctors,
  importDoctorsCSV,
  openAddDoctor,
  openEditDoctor,
  openSchedule,
  openSlotsViewer,
  toggleDoctorStatus,
}) {
  return (
    <div className="space-y-4">
      {/* Plan quota warning */}
      {/* max_doctors == null means UNLIMITED. Without that guard `n >= null`
          coerces to `n >= 0` and every top-tier clinic sees "limit reached". */}
      {settings && settings.plan_limits && settings.usage &&
        settings.plan_limits.max_doctors != null &&
        settings.usage.active_doctors >= settings.plan_limits.max_doctors && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-xl">⚠️</span>
          <div>
            <p className="text-sm font-medium text-amber-800">Dentist limit reached ({settings.usage.active_doctors}/{settings.plan_limits.max_doctors})</p>
            <p className="text-xs text-amber-600">Upgrade your plan to add more dentists.</p>
          </div>
        </div>
      )}
      {/* Count + inactive toggle on the left, import/add on the right. Four
          controls do not fit a phone width, so allow the row to wrap. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <p className="text-sm text-gray-500">{doctors.length} dentist{doctors.length !== 1 ? 's' : ''}</p>
          {/* The switch is 32x16; the label is the hit area, so pad it. */}
          <label className="flex items-center gap-2 cursor-pointer select-none py-2.5 -my-2.5">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={showInactive}
                onChange={e => setShowInactive(e.target.checked)} />
              <div className={`w-8 h-4 rounded-full transition-colors ${showInactive ? 'bg-blue-500' : 'bg-gray-300'}`} />
              <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${showInactive ? 'translate-x-4' : ''}`} />
            </div>
            <span className="text-sm text-gray-500">Show inactive</span>
          </label>
        </div>
        {isAdmin && (
        <div className="flex items-center gap-2">
          <label className={`px-3 py-2 text-sm border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition whitespace-nowrap ${importingDoctors ? 'opacity-50 pointer-events-none' : ''}`}>
            {importingDoctors ? '⏳ Importing...' : '📤 Import CSV'}
            <input type="file" accept=".csv" className="hidden" onChange={importDoctorsCSV} disabled={importingDoctors} />
          </label>
          <button onClick={openAddDoctor}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
            + Add Doctor
          </button>
        </div>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {doctors.map(d => (
          <div key={d.id} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 hover:border-blue-200 transition flex flex-col">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-xl shrink-0">👨‍⚕️</div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900 truncate">Dr. {d.name}</h3>
                <p className="text-sm text-blue-600 truncate">{d.specialization}</p>
                <p className="text-xs text-gray-400 truncate">{d.qualification}</p>
                <p className="text-xs text-gray-500 mt-1 truncate">🏥 {d.hospital_name}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-green-600 font-medium">{d.consultation_fee > 0 ? `₹${d.consultation_fee}` : 'Free'}</span>
              <div className="text-right text-xs text-gray-500">
                <div>{d.total_appointments} appts</div>
                <div>{d.available_slots} open slots</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-400">{d.slot_duration_minutes}min slots · {d.department_name || 'No dept'}</div>
            {/* Every treatment this dentist is bookable for. The primary is shown
                above; the rest are what makes them reachable from another
                treatment's list in the bot — worth seeing at a glance. */}
            {Array.isArray(d.departments) && d.departments.length > 1 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {d.departments.filter(dep => dep.id !== d.department_id).map(dep => (
                  <span key={dep.id} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] leading-4">
                    {dep.name}
                  </span>
                ))}
              </div>
            )}
            {!d.is_active && (
              <p className="mt-2 text-xs text-red-400 font-medium">⚠️ Inactive — hidden from bot</p>
            )}
            {/* Two columns still fit a 320px phone (~124px per button); only the
                vertical padding is raised to a thumb-sized target below sm. */}
            <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
              {isAdmin && (
              <button onClick={() => openEditDoctor(d)}
                className="px-3 py-3 sm:py-2 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition">
                ✏️ Edit
              </button>
              )}
              {isAdmin && (
              <button onClick={() => openSchedule(d)}
                className="px-3 py-3 sm:py-2 text-xs font-medium border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 transition">
                📅 Schedule
              </button>
              )}
              <button onClick={() => openSlotsViewer(d)}
                className="px-3 py-3 sm:py-2 text-xs font-medium border border-green-200 text-green-600 rounded-lg hover:bg-green-50 transition">
                ⏰ View Slots
              </button>
              {isAdmin && (
              <button onClick={() => toggleDoctorStatus(d)}
                className={`px-3 py-3 sm:py-2 text-xs font-medium border rounded-lg transition ${d.is_active ? 'border-red-200 text-red-500 hover:bg-red-50' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                {d.is_active ? '🚫 Deactivate' : '✅ Activate'}
              </button>
              )}
            </div>
          </div>
        ))}
        {/* col-span-full, not col-span-3: the grid is 1 column on a phone, and a
            fixed 3-column span there conjures two implicit columns that widen the
            row past the viewport. */}
        {!doctors.length && (
          <div className="col-span-full text-center py-16">
            <div className="text-4xl mb-3">🦷</div>
            <p className="text-gray-500 font-medium">No dentists yet</p>
            <p className="text-gray-400 text-sm mt-1">Click "Add Dentist" to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}
