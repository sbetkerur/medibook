'use client';
import { format, parseISO } from 'date-fns';

// Presentational component. The patient list, its fetch and the patient
// history / edit / import flows stay in page.js because those modals (rendered
// at the page root) call fetchPatients() to refresh this list after mutations.
export default function PatientsTab({
  patients,
  isAdmin,
  patientSearch,
  setPatientSearch,
  patientTotal,
  patientPage,
  setPatientPage,
  patientHasMore,
  fetchPatients,
  importingPatients,
  importPatientsCSV,
  waLink,
  openPatientHistory,
  openEditPatient,
  deletePatient,
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name, phone or email..."
          value={patientSearch}
          onChange={e => setPatientSearch(e.target.value)}
          className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {isAdmin && (
        <label className={`px-3 py-1.5 text-sm border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition whitespace-nowrap ${importingPatients ? 'opacity-50 pointer-events-none' : ''}`}>
          {importingPatients ? '⏳ Importing...' : '📤 Import CSV'}
          <input type="file" accept=".csv" className="hidden" onChange={importPatientsCSV} disabled={importingPatients} />
        </label>
        )}
      </div>
      {patientTotal > 0 && (
        <p className="text-sm text-gray-400">{patientTotal} patient{patientTotal !== 1 ? 's' : ''} total</p>
      )}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {/* Mobile patient cards */}
        <div className="md:hidden divide-y divide-gray-100">
          {patients.map(p => (
            <div key={`mob-${p.id}`} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 cursor-pointer truncate" onClick={() => openPatientHistory(p)}>
                    {p.name || '—'}
                  </div>
                  {/* inline-block + py: a bare inline <a> is only as tall as
                      its text (16px), and this is how reception actually opens
                      a chat with the patient. */}
                  <a href={waLink(p.phone)} target="_blank" rel="noreferrer"
                    className="inline-block py-2 text-xs text-green-600 hover:underline">+{p.phone}</a>
                </div>
                <div className="text-xs text-gray-400 text-right shrink-0">
                  <div className="capitalize">{p.gender || '—'}</div>
                  <div>{p.visit_count} visits</div>
                </div>
              </div>
              {isAdmin && (
              <div className="flex gap-2 mt-3">
                <button onClick={e => { e.stopPropagation(); openEditPatient(p); }}
                  className="px-3 py-2 text-xs text-blue-600 border border-blue-200 bg-blue-50 rounded-lg hover:bg-blue-100 transition">
                  ✏️ Edit
                </button>
                <button onClick={e => { e.stopPropagation(); deletePatient(p); }}
                  className="px-3 py-2 text-xs text-red-500 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 transition">
                  🗑 Delete
                </button>
              </div>
              )}
            </div>
          ))}
          {!patients.length && (
            <div className="px-4 py-12 text-center text-gray-400">No patients found</div>
          )}
        </div>
        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Name', 'Phone', 'Gender', 'DOB', 'Visits', 'Since', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {patients.map(p => (
              <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-medium text-gray-900 hover:text-blue-600 cursor-pointer" onClick={() => openPatientHistory(p)}>{p.name || '—'}</td>
                <td className="px-4 py-3">
                  <a href={waLink(p.phone)} target="_blank" rel="noreferrer"
                    className="text-green-600 hover:underline">+{p.phone}</a>
                </td>
                <td className="px-4 py-3 capitalize text-gray-600">{p.gender || '—'}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {p.date_of_birth ? (() => { try { return format(parseISO(p.date_of_birth), 'd MMM yyyy'); } catch { return p.date_of_birth; } })() : '—'}
                </td>
                <td className="px-4 py-3 text-gray-600">{p.visit_count}</td>
                <td className="px-4 py-3 text-gray-400 text-xs">
                  {p.created_at ? (() => { try { return format(parseISO(p.created_at), 'd MMM yyyy'); } catch { return ''; } })() : '—'}
                </td>
                <td className="px-4 py-3">
                  {isAdmin && (
                  <div className="flex gap-2">
                    <button onClick={e => { e.stopPropagation(); openEditPatient(p); }}
                      className="text-xs text-blue-600 hover:underline whitespace-nowrap">✏️ Edit</button>
                    <button onClick={e => { e.stopPropagation(); deletePatient(p); }}
                      className="text-xs text-red-500 hover:underline whitespace-nowrap">🗑</button>
                  </div>
                  )}
                </td>
              </tr>
            ))}
            {!patients.length && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">No patients found</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      {(patientPage > 1 || patientHasMore) && (
        <div className="flex items-center justify-between mt-2">
          <button onClick={() => { const p = patientPage - 1; setPatientPage(p); fetchPatients(p); }}
            disabled={patientPage === 1}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
            ← Previous
          </button>
          <span className="text-sm text-gray-500">Page {patientPage}</span>
          <button onClick={() => { const p = patientPage + 1; setPatientPage(p); fetchPatients(p); }}
            disabled={!patientHasMore}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
