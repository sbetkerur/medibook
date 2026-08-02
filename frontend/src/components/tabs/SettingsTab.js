'use client';
import { useState, useEffect } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';

// `settings` is shared (also read by DoctorsTab) and stays owned by the parent,
// which self-fetches it on tab select and passes it (plus `fetchSettings` to
// refresh after a save) down here. The editable form is derived from `settings`.
export default function SettingsTab({ settings, fetchSettings, isAdmin }) {
  const [settingsForm, setSettingsForm] = useState({
    notify_phone: '',
    name: '', notification_prefs: {}
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [changePwdForm, setChangePwdForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [changingPwd, setChangingPwd] = useState(false);

  // Populate the editable form whenever the shared settings payload changes.
  // PATCH /settings merges these keys into the TOP level of tenants.settings,
  // so read them back from there (settings.notification_prefs never exists).
  useEffect(() => {
    if (!settings) return;
    setSettingsForm({
      name: settings.clinic_name || '',
      notification_prefs: {
        email_on_booking: settings.settings?.email_on_booking,
        reminder_24h_enabled: settings.settings?.reminder_24h_enabled,
        reminder_2h_enabled: settings.settings?.reminder_2h_enabled,
      },
      notify_phone: settings.notify_phone || '',
    });
  }, [settings]);

  async function saveSettings(e) {
    e.preventDefault();
    setSettingsSaving(true);
    try {
      const payload = {};
      if (settingsForm.name) payload.name = settingsForm.name;
      payload.notify_phone = settingsForm.notify_phone || '';
      // notification_prefs was bound to the toggle but never sent, so switching
      // it off showed "Settings saved!" and then fetchSettings() flipped it
      // straight back on from the server. The backend accepts and merges it.
      if (settingsForm.notification_prefs) {
        payload.notification_prefs = settingsForm.notification_prefs;
      }
      await api.patch('/admin/settings', payload);
      toast.success('Settings saved!');
      fetchSettings();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save settings');
    } finally { setSettingsSaving(false); }
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
      <div className="bg-white rounded-xl p-4 sm:p-6 shadow-sm">
        <h2 className="font-semibold text-gray-800 mb-5">Clinic Settings</h2>
        {settings === null ? (
          <div className="text-gray-400 py-8 text-center">Loading settings...</div>
        ) : (
          <form onSubmit={saveSettings} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Clinic Name</label>
              <input value={settingsForm.name}
                onChange={e => setSettingsForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Demo Clinic Hyderabad"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="pt-3 border-t border-gray-100">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">WhatsApp Integration</h3>
              <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                📱 WhatsApp is configured globally via a shared phone number. Contact your platform administrator to update credentials.
              </p>
            </div>
            <div className="pt-3 border-t border-gray-100">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Notifications</h3>
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <div className="relative">
                    <input type="checkbox" className="sr-only"
                      checked={settingsForm.notification_prefs?.email_on_booking !== false}
                      onChange={e => setSettingsForm(f => ({ ...f, notification_prefs: { ...f.notification_prefs, email_on_booking: e.target.checked } }))} />
                    <div className={`w-10 h-5 rounded-full transition-colors ${settingsForm.notification_prefs?.email_on_booking !== false ? 'bg-blue-500' : 'bg-gray-300'}`} />
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settingsForm.notification_prefs?.email_on_booking !== false ? 'translate-x-5' : ''}`} />
                  </div>
                  <span className="text-sm text-gray-700">Email notification on new booking</span>
                </label>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    SMS notification number
                    <span className="text-gray-400 font-normal ml-1">(optional — requires Twilio)</span>
                  </label>
                  <input
                    type="tel"
                    value={settingsForm.notify_phone}
                    onChange={e => setSettingsForm(f => ({ ...f, notify_phone: e.target.value }))}
                    placeholder="e.g. 917795676142"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">An SMS will be sent to this number each time an appointment is booked via the WhatsApp bot.</p>
                </div>
              </div>
            </div>
            <div className="pt-4">
              {isAdmin ? (
                <button type="submit" disabled={settingsSaving}
                  className="w-full sm:w-auto px-6 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
                  {settingsSaving ? 'Saving...' : '💾 Save Settings'}
                </button>
              ) : (
                <p className="text-xs text-gray-400">Only clinic admins can change these settings.</p>
              )}
            </div>
          </form>
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
                      {settings.usage?.active_doctors ?? '—'} / {settings.plan_limits.max_doctors === 999 ? '∞' : settings.plan_limits.max_doctors}
                    </span>
                  </div>
                  {settings.usage?.active_doctors != null && settings.plan_limits.max_doctors !== 999 && (
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
                      {settings.usage?.appointments_this_month ?? '—'} / {settings.plan_limits.max_appointments_per_month === 99999 ? '∞' : settings.plan_limits.max_appointments_per_month}
                    </span>
                  </div>
                  {settings.usage?.appointments_this_month != null && settings.plan_limits.max_appointments_per_month !== 99999 && (
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
