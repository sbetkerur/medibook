'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import Modal from '@/components/ui/Modal';

// Self-contained. `setConfirmModal` drives the shared confirm dialog rendered
// at the page root.
export default function StaffTab({ isAdmin, setConfirmModal }) {
  const [newPassword, setNewPassword] = useState(null);
  const [staff, setStaff] = useState([]);
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const [staffForm, setStaffForm] = useState({ name: '', email: '', password: '', role: 'staff' });
  const [staffSaving, setStaffSaving] = useState(false);

  const fetchStaff = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/staff');
      setStaff(data.staff || []);
    } catch { toast.error('Failed to load staff'); }
  }, []);

  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  async function saveStaff(e) {
    e.preventDefault();
    if (!staffForm.name || !staffForm.email) return toast.error('Name and email required');
    if (!editingStaff && !staffForm.password) return toast.error('Password required for new staff');
    setStaffSaving(true);
    try {
      if (editingStaff) {
        const payload = { name: staffForm.name, role: staffForm.role };
        if (staffForm.password) payload.password = staffForm.password;
        await api.patch(`/admin/staff/${editingStaff.id}`, payload);
        toast.success('Staff updated');
      } else {
        await api.post('/admin/staff', staffForm);
        toast.success('Staff member added');
      }
      setShowStaffModal(false);
      setStaffForm({ name: '', email: '', password: '', role: 'staff' });
      setEditingStaff(null);
      fetchStaff();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save staff');
    } finally { setStaffSaving(false); }
  }

  // The new password comes back ONCE and is never stored, so it is held in
  // component state and shown until dismissed. Reloading the page loses it —
  // which is correct: there is nowhere safe to keep it.
  function resetPassword(member) {
    setConfirmModal({
      title: `Reset password for ${member.name}?`,
      message: 'They will be signed out everywhere, and you will get a new password to give them directly.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const { data } = await api.post(`/admin/staff/${member.id}/reset-password`);
          setNewPassword({ name: member.name, email: data.user?.email, password: data.password });
        } catch (err) {
          toast.error(err.response?.data?.error || 'Could not reset the password');
        }
      },
    });
  }

  function deactivateStaff(member) {
    setConfirmModal({
      title: `Deactivate ${member.name}?`,
      message: 'They will lose access to the dashboard immediately.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/staff/${member.id}`);
          toast.success('Staff member deactivated');
          fetchStaff();
        } catch (err) {
          toast.error(err.response?.data?.error || 'Failed to deactivate');
        }
      },
    });
  }

  return (
    <>
      {newPassword && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            New password for {newPassword.name}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Shown once. Give it to them directly and ask them to change it — we cannot show it again.
          </p>
          <code className="mt-2 block break-all rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-sm">
            {newPassword.password}
          </code>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(newPassword.password)
                  .then(() => toast.success('Copied'))
                  .catch(() => toast.error('Could not copy — select it and copy by hand'));
              }}
              className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition">
              Copy
            </button>
            <button onClick={() => setNewPassword(null)}
              className="px-3 py-1.5 text-xs border border-amber-300 text-amber-900 rounded-lg hover:bg-amber-100 transition">
              Done
            </button>
          </div>
        </div>
      )}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">{staff.length} team member{staff.length !== 1 ? 's' : ''}</p>
          {isAdmin && (
          <button onClick={() => { setEditingStaff(null); setStaffForm({ name: '', email: '', password: '', role: 'staff' }); setShowStaffModal(true); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition">
            + Add Staff
          </button>
          )}
        </div>
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {/* Mobile staff cards — the table below is hidden under md because a
              5-column table forces horizontal scrolling on a phone. */}
          <div className="md:hidden divide-y divide-gray-100">
            {staff.map(m => (
              <div key={`mob-${m.id}`} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">{m.name}</div>
                    <div className="text-xs text-gray-500 truncate">{m.email}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${m.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                      {m.role}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${m.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-500'}`}>
                      {m.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => { setEditingStaff(m); setStaffForm({ name: m.name, email: m.email, password: '', role: m.role }); setShowStaffModal(true); }}
                      className="px-3 py-2 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition">
                      ✏️ Edit
                    </button>
                    {m.is_active && m.id !== undefined && (
                      <button onClick={() => resetPassword(m)}
                        className="px-3 py-2 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition">
                        🔑 Reset password
                      </button>
                    )}
                    {m.is_active && (
                      <button onClick={() => deactivateStaff(m)}
                        className="px-3 py-2 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 transition">
                        🚫 Deactivate
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {!staff.length && (
              <div className="px-4 py-12 text-center text-gray-400">No staff members yet. Add one to get started.</div>
            )}
          </div>
          <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Name', 'Email', 'Role', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {staff.map(m => (
                <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{m.name}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{m.email}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${m.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${m.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-500'}`}>
                      {m.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {isAdmin && (
                    <div className="flex gap-2">
                      <button onClick={() => { setEditingStaff(m); setStaffForm({ name: m.name, email: m.email, password: '', role: m.role }); setShowStaffModal(true); }}
                        className="px-2 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-gray-50 transition">
                        ✏️ Edit
                      </button>
                      {/* Also on the desktop table, not just the mobile cards.
                          Removing email left this the clinic's only self-service
                          unlock, and a front desk on a desktop had to shrink the
                          window to reach it. */}
                      {m.is_active && m.id !== undefined && (
                        <button onClick={() => resetPassword(m)}
                          className="px-2 py-1 text-xs border border-gray-200 text-gray-600 rounded hover:bg-gray-50 transition">
                          🔑 Reset password
                        </button>
                      )}
                      {m.is_active && (
                        <button onClick={() => deactivateStaff(m)}
                          className="px-2 py-1 text-xs border border-red-200 text-red-500 rounded hover:bg-red-50 transition">
                          🚫 Deactivate
                        </button>
                      )}
                    </div>
                    )}
                  </td>
                </tr>
              ))}
              {!staff.length && (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No staff members yet. Add one to get started.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* ── ADD / EDIT STAFF MODAL ── */}
      {showStaffModal && (
        <Modal title={editingStaff ? `Edit ${editingStaff.name}` : 'Add Staff Member'} onClose={() => { setShowStaffModal(false); setEditingStaff(null); }}>
          <form onSubmit={saveStaff} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Full Name *</label>
              <input value={staffForm.name} onChange={e => setStaffForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Ravi Kumar"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Email *</label>
              <input type="email" value={staffForm.email}
                onChange={e => setStaffForm(f => ({ ...f, email: e.target.value }))}
                placeholder="ravi@clinic.com"
                disabled={!!editingStaff}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Password {editingStaff && <span className="text-gray-400 font-normal">(leave blank to keep existing)</span>}
              </label>
              <input type="password" value={staffForm.password}
                onChange={e => setStaffForm(f => ({ ...f, password: e.target.value }))}
                placeholder={editingStaff ? 'New password (optional)' : 'Set a password *'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Role</label>
              <select value={staffForm.role} onChange={e => setStaffForm(f => ({ ...f, role: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="staff">Staff</option>
                <option value="doctor">Dentist</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowStaffModal(false); setEditingStaff(null); }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
                Cancel
              </button>
              <button type="submit" disabled={staffSaving}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
                {staffSaving ? 'Saving...' : editingStaff ? 'Update Staff' : 'Add Staff'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
