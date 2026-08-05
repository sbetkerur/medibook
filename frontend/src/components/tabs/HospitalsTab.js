'use client';

// Presentational component. `hospitals` is shared (doctor modal, services,
// holidays, walk-in) and `deptsByHospital` is populated by the hospital/dept
// modals rendered in page.js, so all that state and those modals stay in the
// parent; the raw setters/handlers are threaded in so this JSX is unchanged.
export default function HospitalsTab({
  hospitals,
  isAdmin,
  deptsByHospital,
  setEditingHospital,
  setHospitalForm,
  setShowHospitalModal,
  openEditHospital,
  deleteHospital,
  setDeptHospital,
  setDeptForm,
  setEditingDept,
  setShowDeptModal,
  openEditDept,
  deleteDept,
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{hospitals.length} hospital{hospitals.length !== 1 ? 's' : ''}</p>
        {isAdmin && (
        <button onClick={() => { setEditingHospital(null); setHospitalForm({ name: '', address: '', city: '', phone: '' }); setShowHospitalModal(true); }}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
          + Add Hospital
        </button>
        )}
      </div>

      {hospitals.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl shadow-sm">
          <div className="text-5xl mb-3">🏥</div>
          <p className="text-gray-500 font-medium">No hospitals yet</p>
          <p className="text-gray-400 text-sm mt-1">Add your first hospital to get started</p>
          {/* The button below resets editingHospital and the form, exactly like
              the header button. Without that reset it opened a modal titled
              "Add New Hospital" pre-filled with whatever was last edited —
              neither Cancel nor the modal's onClose clears hospitalForm —
              leaving the operator one click from creating a duplicate branch. */}
          {isAdmin && (
          <button onClick={() => { setEditingHospital(null); setHospitalForm({ name: '', address: '', city: '', phone: '' }); setShowHospitalModal(true); }}
            className="mt-4 px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
            + Add Hospital
          </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {hospitals.map(h => {
            const depts = deptsByHospital[h.id] || [];
            return (
              <div key={h.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                {/* The three action buttons are ~190px wide and must not shrink,
                    which leaves too little for the hospital name on a phone —
                    stack them under it below sm. */}
                <div className="px-5 py-4 flex flex-col sm:flex-row items-start justify-between gap-3 border-b border-gray-50">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-gray-900 text-base">{h.name}</h3>
                    <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-500">
                      {h.city && <span>📍 {h.city}</span>}
                      {h.address && <span>{h.address}</span>}
                      {h.phone && <span>📞 {h.phone}</span>}
                    </div>
                  </div>
                  {isAdmin && (
                  <div className="flex items-center gap-2 shrink-0 sm:ml-3">
                    <button onClick={() => openEditHospital(h)}
                      className="px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                      ✏️ Edit
                    </button>
                    <button
                      onClick={() => { setDeptHospital(h); setDeptForm({ name: '', description: '' }); setEditingDept(null); setShowDeptModal(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-green-50 text-green-600 border border-green-200 rounded-lg hover:bg-green-100 transition">
                      + Dept
                    </button>
                    {/* Deleting a whole branch: icon-only, so give it a real
                        target rather than a 34x30 sliver next to "+ Dept". */}
                    <button onClick={() => deleteHospital(h)} aria-label={`Delete ${h.name}`}
                      className="w-10 h-10 flex items-center justify-center shrink-0 text-xs font-medium bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition md:w-auto md:h-auto md:px-3 md:py-1.5">
                      🗑
                    </button>
                  </div>
                  )}
                </div>
                <div className="px-5 py-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                    Departments ({depts.length})
                  </p>
                  {depts.length === 0 ? (
                    <p className="text-sm text-gray-400 italic">No departments yet — add one to start booking</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {depts.map(d => (
                        <div key={d.id}
                          className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 text-sm rounded-lg border border-blue-100 group">
                          <span>{d.name}</span>
                          {d.description && <span className="text-blue-400 ml-1 text-xs">— {d.description}</span>}
                          {/* Reveal-on-hover only from md up: a touch device never
                              fires hover, so on a phone these were permanently
                              invisible and departments could not be edited at all. */}
                          {isAdmin && (<>
                          {/* Icon-only and side by side, so on touch they get
                              real 36px targets — at px-2 py-1 they were 32x24
                              and 26x24, close enough together to mis-tap
                              DELETE when reaching for edit. */}
                          <button onClick={() => openEditDept(d, h)} aria-label={`Edit ${d.name}`}
                            className="ml-1 shrink-0 w-9 h-9 -my-2 flex items-center justify-center text-blue-400 hover:text-blue-600 md:w-auto md:h-auto md:my-0 md:px-0 md:py-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity text-xs">✏️</button>
                          <button onClick={() => deleteDept(d, h)} aria-label={`Delete ${d.name}`}
                            className="shrink-0 w-9 h-9 -my-2 flex items-center justify-center text-red-400 hover:text-red-600 md:w-auto md:h-auto md:my-0 md:px-0 md:py-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity text-xs">✕</button>
                          </>)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
