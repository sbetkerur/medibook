'use client';
import { format, parseISO } from 'date-fns';
import Badge from '@/components/ui/Badge';

/**
 * Appointments tab: filters, bulk actions, the mobile card list and the desktop
 * table. Extracted from dashboard/page.js verbatim — behaviour unchanged.
 *
 * The modals themselves stay in the page (they are shared with other tabs), so
 * this component takes intent callbacks — onMessagePatient, onAddWalkin,
 * onEditNotes, onCancelAppt — rather than the dozen individual setState props
 * that opening each one used to require.
 */
export default function AppointmentsTab({
  appointments,
  isAdmin,
  filterDate, setFilterDate,
  filterStatus, setFilterStatus,
  apptTotal, apptPage, setApptPage, apptHasMore,
  fetchAppointments,
  selectedApptIds, setSelectedApptIds,
  bulkUpdating, bulkUpdateAppointments,
  updateApptStatus,
  printReceipt,
  waLink,
  onMessagePatient,
  onAddWalkin,
  onEditNotes,
  onCancelAppt,
}) {
  const fmtDate = (d) => { try { return format(parseISO(d), 'd MMM yy'); } catch { return d; } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Status</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="no_show">No Show</option>
        </select>
        {(filterDate || filterStatus) && (
          <button onClick={() => { setFilterDate(''); setFilterStatus(''); }}
            className="text-sm text-blue-600 hover:underline">Clear filters</button>
        )}
        <span className="text-sm text-gray-400 ml-auto">{apptTotal > 0 ? `${apptTotal} total` : `${appointments.length} records`}</span>
        {isAdmin && (<>
        <button onClick={() => onMessagePatient('')}
          className="px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition flex items-center gap-1.5">
          📤 Message Patient
        </button>
        <button onClick={onAddWalkin}
          className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition flex items-center gap-1.5">
          + Walk-in
        </button>
        </>)}
      </div>

      {isAdmin && selectedApptIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-blue-700">{selectedApptIds.size} selected</span>
          <button onClick={() => bulkUpdateAppointments('completed')} disabled={bulkUpdating}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
            ✅ Mark Completed
          </button>
          <button onClick={() => bulkUpdateAppointments('no_show')} disabled={bulkUpdating}
            className="px-3 py-1.5 bg-gray-600 text-white text-xs font-medium rounded-lg hover:bg-gray-700 disabled:opacity-50 transition">
            🚫 Mark No-Show
          </button>
          <button onClick={() => bulkUpdateAppointments('cancelled')} disabled={bulkUpdating}
            className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition">
            ✕ Cancel All
          </button>
          <button onClick={() => setSelectedApptIds(new Set())}
            className="px-3 py-1.5 border border-gray-300 text-gray-600 text-xs rounded-lg hover:bg-gray-50 transition ml-auto">
            Clear selection
          </button>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {/* Mobile appointment cards */}
        <div className="md:hidden divide-y divide-gray-100">
          {appointments.map(a => (
            <div key={`mob-${a.id}`} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{a.patient_name}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <a href={waLink(a.patient_phone)} target="_blank" rel="noreferrer"
                      className="text-xs text-green-600 hover:underline">{a.patient_phone}</a>
                    {isAdmin && (
                    <button onClick={() => onMessagePatient(a.patient_phone || '')}
                      className="text-xs text-green-500 hover:text-green-700">📤</button>
                    )}
                  </div>
                </div>
                <Badge status={a.status} />
              </div>
              <div className="text-xs text-gray-500 space-y-0.5">
                <div>🦷 Dr. {a.doctor_name}</div>
                <div>📅 {fmtDate(a.appointment_date)} at {a.appointment_time?.slice(0, 5)}</div>
                <div className="font-mono text-blue-600">{a.booking_id} · <span className="capitalize">{a.visit_type?.replace('_', ' ')}</span></div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {a.status === 'confirmed' && (<>
                  <button onClick={() => updateApptStatus(a.id, 'completed')}
                    className="px-3 py-1.5 text-xs bg-blue-50 text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-100 transition">
                    ✅ Done
                  </button>
                  <button onClick={() => updateApptStatus(a.id, 'no_show')}
                    className="px-3 py-1.5 text-xs bg-gray-50 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                    🚫 No Show
                  </button>
                  <button onClick={() => onCancelAppt(a)}
                    className="px-3 py-1.5 text-xs bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition">
                    ✕ Cancel
                  </button>
                </>)}
                <button onClick={() => printReceipt(a.id)}
                  className="px-3 py-1.5 text-xs bg-purple-50 text-purple-600 border border-purple-200 rounded-lg hover:bg-purple-100 transition">
                  🖨️ Receipt
                </button>
                <button onClick={() => onEditNotes(a)}
                  className={`px-3 py-1.5 text-xs border rounded-lg transition ${a.notes ? 'bg-yellow-50 text-yellow-700 border-yellow-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                  📝 {a.notes ? 'Notes' : 'Add Note'}
                </button>
              </div>
            </div>
          ))}
          {!appointments.length && (
            <div className="px-4 py-12 text-center text-gray-400">
              No appointments found{filterDate || filterStatus ? ' for selected filters' : ''}
            </div>
          )}
        </div>
        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-3 py-3 w-8">
                  {isAdmin && (
                  <input type="checkbox"
                    checked={appointments.length > 0 && appointments.every(a => selectedApptIds.has(a.id))}
                    onChange={e => {
                      if (e.target.checked) setSelectedApptIds(new Set(appointments.map(a => a.id)));
                      else setSelectedApptIds(new Set());
                    }}
                    className="rounded border-gray-300 text-blue-600" />
                  )}
                </th>
                {['Booking ID', 'Patient', 'Doctor', 'Date', 'Time', 'Type', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {appointments.map(a => (
                <tr key={a.id} className={`hover:bg-gray-50 transition-colors ${selectedApptIds.has(a.id) ? 'bg-blue-50' : ''}`}>
                  <td className="px-3 py-3">
                    {isAdmin && (
                    <input type="checkbox" checked={selectedApptIds.has(a.id)}
                      onChange={e => {
                        const next = new Set(selectedApptIds);
                        if (e.target.checked) next.add(a.id); else next.delete(a.id);
                        setSelectedApptIds(next);
                      }}
                      className="rounded border-gray-300 text-blue-600" />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-medium text-blue-600">{a.booking_id}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 text-sm">{a.patient_name}</div>
                    <div className="flex items-center gap-1.5">
                      <a href={waLink(a.patient_phone)} target="_blank" rel="noreferrer"
                        className="text-xs text-green-600 hover:underline">{a.patient_phone}</a>
                      {isAdmin && (
                      <button onClick={() => onMessagePatient(a.patient_phone || '')}
                        title="Send WhatsApp message"
                        className="text-xs text-green-500 hover:text-green-700">📤</button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700 text-sm">Dr. {a.doctor_name}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{fmtDate(a.appointment_date)}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{a.appointment_time?.slice(0, 5)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 capitalize">{a.visit_type?.replace('_', ' ')}</td>
                  <td className="px-4 py-3"><Badge status={a.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {a.status === 'confirmed' && (<>
                        <button onClick={() => updateApptStatus(a.id, 'completed')}
                          className="px-2 py-1 text-xs bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-100 transition whitespace-nowrap">
                          ✅ Done
                        </button>
                        <button onClick={() => updateApptStatus(a.id, 'no_show')}
                          className="px-2 py-1 text-xs bg-gray-50 text-gray-500 border border-gray-200 rounded hover:bg-gray-100 transition whitespace-nowrap">
                          🚫 No Show
                        </button>
                        <button onClick={() => onCancelAppt(a)}
                          className="px-2 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition whitespace-nowrap">
                          ✕ Cancel
                        </button>
                      </>)}
                      <button onClick={() => printReceipt(a.id)} title="Print receipt"
                        className="px-2 py-1 text-xs bg-purple-50 text-purple-600 border border-purple-200 rounded hover:bg-purple-100 transition whitespace-nowrap">
                        🖨️ Receipt
                      </button>
                      <button onClick={() => onEditNotes(a)} title="Edit clinical notes"
                        className={`px-2 py-1 text-xs border rounded hover:bg-gray-100 transition whitespace-nowrap ${a.notes ? 'bg-yellow-50 text-yellow-700 border-yellow-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                        📝 {a.notes ? 'Notes' : 'Add Note'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!appointments.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    No appointments found{filterDate || filterStatus ? ' for selected filters' : ''}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {(apptPage > 1 || apptHasMore) && (
        <div className="flex items-center justify-between mt-2">
          <button onClick={() => { const p = apptPage - 1; setApptPage(p); fetchAppointments(p); }}
            disabled={apptPage === 1}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
            ← Previous
          </button>
          <span className="text-sm text-gray-500">Page {apptPage}</span>
          <button onClick={() => { const p = apptPage + 1; setApptPage(p); fetchAppointments(p); }}
            disabled={!apptHasMore}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
