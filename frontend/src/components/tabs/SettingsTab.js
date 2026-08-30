'use client';
import { useState, useEffect } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import ClinicQRCard from '@/components/ClinicQRCard';
import BillingPanel from '@/components/BillingPanel';

// `settings` is shared (also read by DoctorsTab) and stays owned by the parent,
// which self-fetches it on tab select and passes it (plus `fetchSettings` to
// refresh after a save) down here.
//
// 'Clinic Settings' used to also cover clinic name and the WhatsApp-alerts
// phone number — removed by request, along with the card's own name. Only the
// fee-display toggle is kept, since a clinic that waives/negotiates the
// consultation fee genuinely needs to turn the quoted number off.
export default function SettingsTab({ settings, fetchSettings, settingsFailed, isAdmin }) {
  const [showFee, setShowFee] = useState(true);
  const [feeSaving, setFeeSaving] = useState(false);
  const [changePwdForm, setChangePwdForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [changingPwd, setChangingPwd] = useState(false);
  const [reviewUrl, setReviewUrl] = useState('');
  const [reviewUrlSaving, setReviewUrlSaving] = useState(false);
  const [doctorDigest, setDoctorDigest] = useState(false);
  const [doctorDigestSaving, setDoctorDigestSaving] = useState(false);

  // PATCH /settings merges notification_prefs into the TOP level of
  // tenants.settings, so read it back from there.
  useEffect(() => {
    if (!settings) return;
    setShowFee(settings.settings?.show_consultation_fee !== false);
    setReviewUrl(settings.settings?.google_review_url || '');
    setDoctorDigest(settings.settings?.doctor_daily_schedule_enabled === true);
  }, [settings]);

  async function saveShowFee(next) {
    setShowFee(next); // optimistic — a slow save must not make the toggle feel stuck
    setFeeSaving(true);
    try {
      await api.patch('/admin/settings', { notification_prefs: { show_consultation_fee: next } });
      toast.success('Saved');
      fetchSettings();
    } catch (err) {
      setShowFee(!next); // revert on failure — the toggle must reflect what's actually saved
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setFeeSaving(false); }
  }

  async function saveReviewUrl() {
    const next = reviewUrl.trim();
    if (next === (settings.settings?.google_review_url || '')) return; // nothing changed
    setReviewUrlSaving(true);
    try {
      await api.patch('/admin/settings', { notification_prefs: { google_review_url: next } });
      toast.success('Saved');
      fetchSettings();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save — check the link is a full https:// URL');
    } finally { setReviewUrlSaving(false); }
  }

  async function saveDoctorDigest(next) {
    setDoctorDigest(next);
    setDoctorDigestSaving(true);
    try {
      await api.patch('/admin/settings', { notification_prefs: { doctor_daily_schedule_enabled: next } });
      toast.success('Saved');
      fetchSettings();
    } catch (err) {
      setDoctorDigest(!next);
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setDoctorDigestSaving(false); }
  }

  async function changePassword(e) {
    e.preventDefault();
    if (changePwdForm.new_password !== changePwdForm.confirm_password) {
      return toast.error('New passwords do not match');
    }
    setChangingPwd(true);
    try {
      await api.post('/auth/change-password', {
        current_password: changePwdForm.current_password,
        new_password: changePwdForm.new_password,
      });
      toast.success('Password changed successfully');
      setChangePwdForm({ current_password: '', new_password: '', confirm_password: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    } finally { setChangingPwd(false); }
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* First on the page deliberately: it is the only route a patient has to
          this clinic, and a QR sitting unprinted in a settings tab reaches
          nobody. Self-fetching rather than fed from `settings`, which is shared
          with DoctorsTab and has no reason to carry a rendered QR image. */}
      <ClinicQRCard isAdmin={isAdmin} />

      {/* Self-serve subscription, plan changes, usage, GST invoices, account
          closure. Renders "managed by MediBook" for a clinic the super admin
          provisioned, so it is safe to always mount. */}
      {isAdmin && <BillingPanel />}

      {/* 'Clinic Settings' used to also cover clinic name and the WhatsApp-
          alerts phone number — removed by request, along with the card's own
          heading. notify_phone stays on whichever admin users already had
          one; nothing here can change it any more (PATCH /admin/settings
          still accepts it server-side, in case another path needs to). */}
      <div className="bg-white rounded-xl p-4 sm:p-6 shadow-sm">
        {settings === null && settingsFailed ? (
          <div className="py-8 text-center">
            <p className="text-gray-500 mb-3">Settings could not be loaded.</p>
            <button onClick={fetchSettings}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
              Retry
            </button>
          </div>
        ) : settings === null ? (
          <div className="text-gray-400 py-8 text-center">Loading settings...</div>
        ) : (
          <div>
            {/* Off by choice, not by default: clinics that waive the
                consultation when treatment is taken, or negotiate it, do not
                want a firm number quoted in WhatsApp and then not charged at
                the desk. Defaults to on, which is what every clinic already
                shows today. */}
            <label className={`flex items-center gap-3 select-none py-2.5 -my-2.5 ${isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <div className="relative">
                <input type="checkbox" className="sr-only" disabled={!isAdmin || feeSaving}
                  checked={showFee}
                  onChange={e => saveShowFee(e.target.checked)} />
                <div className={`w-10 h-5 rounded-full transition-colors ${showFee ? 'bg-blue-500' : 'bg-gray-300'}`} />
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${showFee ? 'translate-x-5' : ''}`} />
              </div>
              <span className="text-sm text-gray-700">Show consultation fee to patients</span>
            </label>
            <p className="text-xs text-gray-400 mt-1">
              Turn this off if you waive or negotiate the consultation fee — patients will see no amount until they are at the clinic.
              {!isAdmin && ' Only clinic admins can change this.'}
            </p>

            {/* Google review link. When set, a patient who rates a visit 4 or 5
                on WhatsApp is invited once to leave a review — lower scores are
                never asked and stay internal. */}
            <div className="mt-6 pt-5 border-t border-gray-100">
              <label className="block text-sm text-gray-700 mb-1">Google review link</label>
              <input
                type="url"
                inputMode="url"
                placeholder="https://g.page/r/…/review"
                value={reviewUrl}
                disabled={!isAdmin || reviewUrlSaving}
                onChange={e => setReviewUrl(e.target.value)}
                onBlur={saveReviewUrl}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
              />
              <p className="text-xs text-gray-400 mt-1">
                Paste your clinic's Google review link. Patients who rate a visit 4 or 5 stars get a one-line
                invitation to review; 1–3 star ratings are never asked and go only to you. Leave blank to turn this off.
                {!isAdmin && ' Only clinic admins can change this.'}
              </p>
            </div>

            {/* Opt-in: each dentist with a WhatsApp alerts number set gets their
                own list for the day every morning. */}
            <div className="mt-6 pt-5 border-t border-gray-100">
              <label className={`flex items-center gap-3 select-none py-2.5 -my-2.5 ${isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                <div className="relative">
                  <input type="checkbox" className="sr-only" disabled={!isAdmin || doctorDigestSaving}
                    checked={doctorDigest}
                    onChange={e => saveDoctorDigest(e.target.checked)} />
                  <div className={`w-10 h-5 rounded-full transition-colors ${doctorDigest ? 'bg-blue-500' : 'bg-gray-300'}`} />
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${doctorDigest ? 'translate-x-5' : ''}`} />
                </div>
                <span className="text-sm text-gray-700">WhatsApp each dentist their schedule every morning</span>
              </label>
              <p className="text-xs text-gray-400 mt-1">
                Sent ~07:30 to any dentist who has a WhatsApp alerts number set on their staff account. A dentist with nothing booked that day gets no message.
                {!isAdmin && ' Only clinic admins can change this.'}
              </p>
            </div>
          </div>
        )}
      </div>

      {settings && (
        <div className="space-y-3">
          {/* Plan Usage */}
          {settings.plan_limits && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Plan Usage — <span className="text-blue-600 normal-case font-medium">{settings.plan_limits.name}</span>
                {settings.plan_limits.price_monthly > 0 && (
                  <span className="text-gray-400 font-normal ml-1">(₹{settings.plan_limits.price_monthly}/mo)</span>
                )}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Dentists */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600">Dentists</span>
                    <span className="font-medium text-gray-900">
                      {settings.usage?.active_doctors ?? '—'} / {settings.plan_limits.max_doctors == null ? '∞' : settings.plan_limits.max_doctors}
                    </span>
                  </div>
                  {settings.usage?.active_doctors != null && settings.plan_limits.max_doctors != null && (
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          settings.usage.active_doctors / settings.plan_limits.max_doctors >= 0.9 ? 'bg-red-500' :
                          settings.usage.active_doctors / settings.plan_limits.max_doctors >= 0.7 ? 'bg-yellow-500' : 'bg-green-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.round(settings.usage.active_doctors / settings.plan_limits.max_doctors * 100))}%` }}
                      />
                    </div>
                  )}
                </div>
                {/* Appointments this month */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600">Appts this month</span>
                    <span className="font-medium text-gray-900">
                      {settings.usage?.appointments_this_month ?? '—'} / {settings.plan_limits.max_appointments_per_month == null ? '∞' : settings.plan_limits.max_appointments_per_month}
                    </span>
                  </div>
                  {settings.usage?.appointments_this_month != null && settings.plan_limits.max_appointments_per_month != null && (
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          settings.usage.appointments_this_month / settings.plan_limits.max_appointments_per_month >= 0.9 ? 'bg-red-500' :
                          settings.usage.appointments_this_month / settings.plan_limits.max_appointments_per_month >= 0.7 ? 'bg-yellow-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.round(settings.usage.appointments_this_month / settings.plan_limits.max_appointments_per_month * 100))}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* Account info */}
          {/* break-words: the owner email and slug are single unbreakable tokens
              that would otherwise push this card past a 320px viewport. */}
          <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 text-xs text-gray-500 space-y-1.5 break-words">
            <p><strong className="text-gray-700">Tenant slug:</strong> {settings.slug}</p>
            <p><strong className="text-gray-700">Plan:</strong> {settings.plan}</p>
            <p><strong className="text-gray-700">Owner:</strong> {settings.owner_email}</p>
            <p><strong className="text-gray-700">Status:</strong> {settings.status}</p>
          </div>
        </div>
      )}

      {/* Change Password */}
      <div className="bg-white rounded-xl p-4 sm:p-6 shadow-sm">
        <h2 className="font-semibold text-gray-800 mb-1">Change Password</h2>
        <p className="text-xs text-gray-400 mb-5">Update your account password. Must be 8+ chars with uppercase, lowercase and a digit.</p>
        <form onSubmit={changePassword} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Current Password</label>
            <input type="password" value={changePwdForm.current_password}
              onChange={e => setChangePwdForm(f => ({ ...f, current_password: e.target.value }))}
              placeholder="Enter current password"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">New Password</label>
              <input type="password" value={changePwdForm.new_password}
                onChange={e => setChangePwdForm(f => ({ ...f, new_password: e.target.value }))}
                placeholder="New password"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Confirm New Password</label>
              <input type="password" value={changePwdForm.confirm_password}
                onChange={e => setChangePwdForm(f => ({ ...f, confirm_password: e.target.value }))}
                placeholder="Confirm new password"
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  changePwdForm.confirm_password && changePwdForm.new_password !== changePwdForm.confirm_password
                    ? 'border-red-300 bg-red-50' : 'border-gray-300'
                }`} required />
            </div>
          </div>
          {changePwdForm.confirm_password && changePwdForm.new_password !== changePwdForm.confirm_password && (
            <p className="text-xs text-red-500">Passwords do not match</p>
          )}
          <div className="pt-2">
            <button type="submit" disabled={changingPwd || (changePwdForm.confirm_password && changePwdForm.new_password !== changePwdForm.confirm_password)}
              className="w-full sm:w-auto px-6 py-2.5 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-900 disabled:opacity-50 transition">
              {changingPwd ? 'Changing...' : '🔒 Change Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
