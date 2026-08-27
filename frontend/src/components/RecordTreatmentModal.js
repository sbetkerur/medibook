'use client';
import { useState, useEffect } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import Modal from '@/components/ui/Modal';

/**
 * "The dentist advised a treatment" — recorded in one place, opened from two.
 *
 * The friction here decides whether the whole treatment-plan feature works at
 * all. In a clinic seeing 25 patients a day, anything that costs more than a
 * few seconds loses to "I'll do it later", which means never — and with nothing
 * recorded, the outstanding queue, the nudges and patient self-booking all have
 * no input. So:
 *
 *   - Two required fields. What the treatment is, and how many sittings.
 *     Tooth, cost, category and notes are real but optional, folded away.
 *   - When opened from an appointment (`appointment`), the patient, branch and
 *     referring dentist come from that visit and the picker never appears. The
 *     picker only exists for the standalone entry point on the Treatments tab.
 */
export default function RecordTreatmentModal({ appointment, onClose, onSaved }) {
  const [doctors, setDoctors] = useState([]);
  const [recentAppts, setRecentAppts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [form, setForm] = useState({
    appointment_id: appointment?.id || '',
    treating_doctor_id: '', department_id: '', title: '',
    tooth_ref: '', total_visits: '2', estimated_cost: '', notes: '',
  });

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/admin/doctors');
        setDoctors(data.doctors || []);
      } catch { /* silent — the field is optional */ }
      // Only needed for the standalone entry point.
      if (!appointment) {
        try {
          const { data } = await api.get('/admin/appointments?status=completed,confirmed&limit=50');
          setRecentAppts(data.appointments || []);
        } catch { toast.error('Failed to load recent appointments'); }
      }
    })();
  }, [appointment]);

  const treatingDoctorDepartments =
    doctors.find(d => d.id === form.treating_doctor_id)?.departments || [];

  async function submit(e) {
    e.preventDefault();
    if (!form.appointment_id) return toast.error('Pick the visit this was advised in');
    if (!form.title.trim()) return toast.error('Describe the treatment');
    setSaving(true);
    try {
      await api.post('/admin/treatment-plans', {
        appointment_id: form.appointment_id,
        treating_doctor_id: form.treating_doctor_id || undefined,
        department_id: form.department_id || undefined,
        title: form.title.trim(),
        tooth_ref: form.tooth_ref || null,
        total_visits: Number(form.total_visits) || 1,
        estimated_cost: Number(form.estimated_cost) || 0,
        notes: form.notes || null,
      });
      toast.success('Treatment recorded');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to record treatment');
    } finally { setSaving(false); }
  }

  const title = appointment
    ? `Treatment for ${appointment.patient_name || 'patient'}`
    : 'Record Treatment Advised';

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        {appointment ? (
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            Advised during the visit with <strong>Dr. {appointment.doctor_name}</strong>
            {appointment.appointment_date ? ` on ${appointment.appointment_date}` : ''}.
          </p>
        ) : (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Advised during <span className="text-red-400">*</span>
            </label>
            <select value={form.appointment_id} required
              onChange={e => setForm(f => ({ ...f, appointment_id: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Select the visit…</option>
              {recentAppts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.patient_name}{a.patient_phone ? ` (${a.patient_phone})` : ''} — Dr. {a.doctor_name} — {a.appointment_date}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-gray-400">
              The patient, branch and referring dentist come from this visit.
            </p>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Treatment <span className="text-red-400">*</span>
          </label>
          <input value={form.title} required maxLength={255} autoFocus
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="e.g. Root canal — upper left first molar"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Sittings <span className="text-red-400">*</span>
          </label>
          {/* Presets, not a spinner: 1–3 covers most dental work and one tap
              beats typing. "Same visit" is the case a number field makes people
              stop and think about. The number box mirrors whichever preset is
              selected (it's the same total_visits value, not a second field) —
              without the "or" divider that looked like a stray duplicate
              whenever the mirrored value matched one of the visible chips,
              e.g. presets "2 3 4 6" plus a box also reading "2". */}
          <div className="flex flex-wrap items-center gap-2">
            {[['1', 'Done in this visit'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']].map(([v, label]) => (
              <button key={v} type="button"
                onClick={() => setForm(f => ({ ...f, total_visits: v }))}
                // min-w: a single-digit chip is only 33px wide at px-3, and
                // these sit side by side where a mis-tap changes the number of
                // sittings a course is booked for.
                className={`px-3 h-10 min-w-[2.75rem] rounded-lg text-xs font-medium border transition-colors ${
                  form.total_visits === v
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                {label}
              </button>
            ))}
            <span className="text-xs text-gray-400">or</span>
            <input type="number" min="1" max="60" value={form.total_visits}
              onChange={e => setForm(f => ({ ...f, total_visits: e.target.value }))}
              aria-label="Custom number of sittings"
              className="w-16 h-10 border border-gray-300 rounded-lg px-2 text-sm" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Rendered by</label>
          <select value={form.treating_doctor_id}
            onChange={e => setForm(f => ({ ...f, treating_doctor_id: e.target.value, department_id: '' }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="">
              {appointment ? `Dr. ${appointment.doctor_name} (same dentist)` : 'Same dentist who advised it'}
            </option>
            {doctors.map(d => (
              <option key={d.id} value={d.id}>Dr. {d.name}{d.specialization ? ` — ${d.specialization}` : ''}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-gray-400">
            Pick a specialist to refer the treatment within the clinic.
          </p>
        </div>

        {/* Everything below is real but rarely known at the chair. Hidden so the
            common case is three controls. */}
        <button type="button" onClick={() => setShowMore(v => !v)}
          className="text-xs text-blue-600 hover:underline py-2">
          {showMore ? '− Fewer details' : '+ Tooth, cost, category, notes'}
        </button>

        {showMore && (<>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Tooth</label>
              <input value={form.tooth_ref} maxLength={50}
                onChange={e => setForm(f => ({ ...f, tooth_ref: e.target.value }))}
                placeholder="e.g. 26"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Estimate ₹</label>
              <input type="number" min="0" value={form.estimated_cost}
                onChange={e => setForm(f => ({ ...f, estimated_cost: e.target.value }))}
                placeholder="0"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Treatment category</label>
            <select value={form.department_id}
              onChange={e => setForm(f => ({ ...f, department_id: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Default — the dentist&apos;s specialty</option>
              {treatingDoctorDepartments.map(dep => (
                <option key={dep.id} value={dep.id}>{dep.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Clinical notes</label>
            <textarea rows={3} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Diagnosis, what was explained to the patient…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
        </>)}

        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Record'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
