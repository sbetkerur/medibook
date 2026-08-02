'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import Modal from '@/components/ui/Modal';

// Self-contained. `hospitals` is shared (ensured loaded by the parent before
// this tab renders) and `setConfirmModal` drives the shared confirm dialog
// rendered at the page root.
export default function ServicesTab({ hospitals, isAdmin, setConfirmModal }) {
  const [services, setServices] = useState([]);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [editingService, setEditingService] = useState(null);
  const [serviceForm, setServiceForm] = useState({ name: '', description: '', category: '', duration_minutes: '30', price: '', hospital_id: '' });
  const [serviceSaving, setServiceSaving] = useState(false);

  const fetchServices = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/services');
      setServices(data.services || []);
    } catch { toast.error('Failed to load services'); }
  }, []);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  async function saveService(e) {
    e.preventDefault();
    if (!serviceForm.name.trim()) return toast.error('Service name is required');
    setServiceSaving(true);
    try {
      const payload = { ...serviceForm, duration_minutes: Number(serviceForm.duration_minutes) || 30, price: Number(serviceForm.price) || 0 };
      if (editingService) {
        await api.patch(`/admin/services/${editingService.id}`, payload);
        toast.success('Service updated');
      } else {
        await api.post('/admin/services', payload);
        toast.success('Service added');
      }
      setShowServiceModal(false);
      setEditingService(null);
      setServiceForm({ name: '', description: '', category: '', duration_minutes: '30', price: '', hospital_id: '' });
      fetchServices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save service');
    } finally { setServiceSaving(false); }
  }

  function openEditService(svc) {
    setEditingService(svc);
    setServiceForm({ name: svc.name || '', description: svc.description || '', category: svc.category || '', duration_minutes: String(svc.duration_minutes || 30), price: String(svc.price || ''), hospital_id: svc.hospital_id || '' });
    setShowServiceModal(true);
  }

  function deleteService(svc) {
    setConfirmModal({
      title: `Remove "${svc.name}"?`,
      message: 'This service will be deactivated and hidden from bookings.',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.delete(`/admin/services/${svc.id}`);
          toast.success('Service removed');
          fetchServices();
        } catch (err) { toast.error(err.response?.data?.error || 'Failed to remove'); }
      },
    });
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">{services.length} treatment{services.length !== 1 ? 's' : ''} in catalog</p>
          {isAdmin && (
          <button onClick={() => { setEditingService(null); setServiceForm({ name: '', description: '', category: '', duration_minutes: '30', price: '', hospital_id: hospitals[0]?.id || '' }); setShowServiceModal(true); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition">
            + Add Service
          </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {services.map(svc => (
            <div key={svc.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 text-sm truncate">{svc.name}</h3>
                  {svc.category && <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{svc.category}</span>}
                </div>
                {isAdmin && (
                <div className="flex gap-1 ml-2 shrink-0">
                  <button onClick={() => openEditService(svc)}
                    className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition">✏️</button>
                  <button onClick={() => deleteService(svc)}
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition">🗑️</button>
                </div>
                )}
              </div>
              {svc.description && <p className="text-xs text-gray-500 mb-3 line-clamp-2">{svc.description}</p>}
              <div className="flex items-center gap-3 text-xs text-gray-600">
                <span className="bg-gray-100 px-2 py-1 rounded">⏱ {svc.duration_minutes} min</span>
                {svc.price > 0 && <span className="bg-green-50 text-green-700 px-2 py-1 rounded font-semibold">₹{svc.price.toLocaleString('en-IN')}</span>}
                {svc.hospital_name && <span className="text-gray-400 truncate">{svc.hospital_name}</span>}
              </div>
            </div>
          ))}
          {!services.length && (
            <div className="col-span-3 text-center py-16 bg-white rounded-xl shadow-sm">
              <div className="text-4xl mb-3">💊</div>
              <p className="text-gray-500 font-medium">No services yet</p>
              <p className="text-gray-400 text-sm mt-1">Add treatments like Root Canal, Cleaning, Braces consultation, etc.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── ADD / EDIT SERVICE MODAL (A1) ── */}
      {showServiceModal && (
        <Modal title={editingService ? `Edit "${editingService.name}"` : 'Add Treatment Service'} onClose={() => { setShowServiceModal(false); setEditingService(null); }}>
          <form onSubmit={saveService} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Service Name <span className="text-red-400">*</span></label>
              <input value={serviceForm.name} onChange={e => setServiceForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Root Canal Treatment, Teeth Cleaning"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
              <select value={serviceForm.category} onChange={e => setServiceForm(f => ({ ...f, category: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— Select category —</option>
                {['Preventive', 'Restorative', 'Cosmetic', 'Orthodontics', 'Surgery', 'Endodontics', 'Periodontics', 'Pediatric', 'Other'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
              <textarea value={serviceForm.description} onChange={e => setServiceForm(f => ({ ...f, description: e.target.value }))}
                rows={2} placeholder="Brief description of the treatment"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            {/* Two form controls side by side cannot shrink past their intrinsic
                widths, so they overflow the modal on a phone — stack them below sm. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Duration (minutes)</label>
                <select value={serviceForm.duration_minutes} onChange={e => setServiceForm(f => ({ ...f, duration_minutes: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {[15, 20, 30, 45, 60, 90, 120].map(m => <option key={m} value={m}>{m} min</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Price (₹)</label>
                <input type="number" min="0" value={serviceForm.price}
                  onChange={e => setServiceForm(f => ({ ...f, price: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Branch (optional)</label>
              <select value={serviceForm.hospital_id} onChange={e => setServiceForm(f => ({ ...f, hospital_id: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— All Branches —</option>
                {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setShowServiceModal(false); setEditingService(null); }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
                Cancel
              </button>
              <button type="submit" disabled={serviceSaving}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
                {serviceSaving ? 'Saving...' : editingService ? 'Update Service' : 'Add Service'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
