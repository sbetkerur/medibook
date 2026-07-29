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
          {isAdmin && (
          <button onClick={() => setShowHospitalModal(true)}
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
                <div className="px-5 py-4 flex items-start justify-between border-b border-gray-50">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-base">{h.name}</h3>
                    <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-500">
                      {h.city && <span>📍 {h.city}</span>}
                      {h.address && <span>{h.address}</span>}
                      {h.phone && <span>📞 {h.phone}</span>}
                    </div>
                  </div>
                  {isAdmin && (
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <button onClick={() => openEditHospital(h)}
                      className="px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                      ✏️ Edit
                    </button>
                    <button
                      onClick={() => { setDeptHospital(h); setDeptForm({ name: '', description: '' }); setEditingDept(null); setShowDeptModal(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-green-50 text-green-600 border border-green-200 rounded-lg hover:bg-green-100 transition">
                      + Dept
                    </button>
                    <button onClick={() => deleteHospital(h)}
                      className="px-3 py-1.5 text-xs font-medium bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition">
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
                          {isAdmin && (<>
                          <button onClick={() => openEditDept(d, h)}
                            className="ml-1 text-blue-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition text-xs">✏️</button>
                          <button onClick={() => deleteDept(d, h)}
                            className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition text-xs">✕</button>
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
