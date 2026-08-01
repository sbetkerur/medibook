'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';

// Self-contained. Rendered only for admins (gated by the parent). Fetches once
// on mount; filter edits do NOT auto-fetch — the user clicks Search.
export default function AuditTab() {
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFrom, setAuditFrom] = useState('');
  const [auditTo, setAuditTo] = useState('');
  const [auditAction, setAuditAction] = useState('');

  const fetchAuditLogs = useCallback(async (page = 1) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (auditFrom) params.set('from', auditFrom);
      if (auditTo) params.set('to', auditTo);
      if (auditAction) params.set('action', auditAction);
      const { data } = await api.get(`/admin/audit-logs?${params}`);
      setAuditLogs(data.logs || []);
      setAuditPage(page);
      setAuditHasMore(data.has_more || false);
      setAuditTotal(data.total || 0);
    } catch { toast.error('Failed to load audit logs'); }
  }, [auditFrom, auditTo, auditAction]);

  useEffect(() => {
    fetchAuditLogs(1);
    // Mount-only: filter changes are applied via the Search button, not on every
    // keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl p-4 shadow-sm flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
          <input type="date" value={auditFrom} onChange={e => setAuditFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
          <input type="date" value={auditTo} onChange={e => setAuditTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Action</label>
          <input value={auditAction} onChange={e => setAuditAction(e.target.value)}
            placeholder="e.g. CREATE_DOCTOR"
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-44 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button onClick={() => fetchAuditLogs(1)}
          className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition">
          Search
        </button>
        <span className="text-sm text-gray-400 ml-auto">{auditTotal} records</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {/* Mobile log cards — 6 columns of mostly-technical detail is unreadable
            on a phone, so the least important fields drop to a second line. */}
        <div className="md:hidden divide-y divide-gray-100">
          {auditLogs.map(log => (
            <div key={`mob-${log.id}`} className="p-4 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-medium text-gray-800 break-all">{log.action || '—'}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${log.actor_role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                  {log.actor_role || '—'}
                </span>
              </div>
              <div className="text-xs text-gray-500">
                {log.created_at ? new Date(log.created_at).toLocaleString('en-IN') : '—'}
              </div>
              <div className="text-xs text-gray-400 flex flex-wrap gap-x-3">
                <span>{log.resource_type || '—'}</span>
                {log.resource_id && <span className="font-mono break-all">{log.resource_id}</span>}
                {log.ip_address && <span>{log.ip_address}</span>}
              </div>
            </div>
          ))}
          {!auditLogs.length && (
            <div className="px-4 py-8 text-center text-gray-400">No audit log entries found</div>
          )}
        </div>
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Timestamp', 'Role', 'Action', 'Resource', 'Resource ID', 'IP'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {auditLogs.map(log => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                    {log.created_at ? new Date(log.created_at).toLocaleString('en-IN') : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${log.actor_role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                      {log.actor_role || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs font-medium text-gray-800">{log.action || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-600 text-xs">{log.resource_type || '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-400 truncate max-w-[120px]">{log.resource_id || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-400">{log.ip_address || '—'}</td>
                </tr>
              ))}
              {!auditLogs.length && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No audit log entries found</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {(auditLogs.length > 0 || auditPage > 1) && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-3">
            <button disabled={auditPage <= 1}
              onClick={() => fetchAuditLogs(auditPage - 1)}
              className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
              ← Prev
            </button>
            <span className="text-sm text-gray-500">Page {auditPage}</span>
            <button disabled={!auditHasMore}
              onClick={() => fetchAuditLogs(auditPage + 1)}
              className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
