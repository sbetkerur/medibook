'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import Modal from '@/components/ui/Modal';

/**
 * A dentist's working week.
 *
 * Extracted from dashboard/page.js, which held 93 useState hooks in one
 * component — the tabs had already been split out, but every modal's state had
 * stayed behind. This one owned six of those hooks, and none of them meant
 * anything to the rest of the page.
 *
 * The state moved WITH the markup rather than being passed down as props: the
 * parent now knows only which doctor is being scheduled (null = closed), and
 * this component owns the draft week, loads it, saves it and reports back. A
 * modal that keeps its own draft cannot leave a half-edited schedule behind in
 * the page when it closes, which the shared-state version could.
 *
 * @param {object}   doctor      the dentist being scheduled; mounting implies open
 * @param {Array}    hospitals   branches, for the visiting-consultant selector
 * @param {Function} onClose     dismiss without saving
 * @param {Function} onSaved     slots were generated — refresh the doctor list
 */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A weekday is a LIST of sessions, not one row. An Indian dentist routinely
// does 10–1 at one clinic and 5–9 at another on the same day, and for a
// visiting endodontist that is the default arrangement — doctor_schedules is
// keyed (doctor_id, day_of_week, start_time) for exactly this reason.
//
// This modal used to model one session per weekday: it loaded with .find() and
// saved one row per day, while POST /doctors/:id/schedule DELETEs every row for
// each submitted day before re-inserting. So opening a two-session Tuesday
// showed only the morning, and pressing Save silently deleted the evening
// session and the slots generated from it.
let _sessionKeySeq = 0;
const nextSessionKey = () => `s${++_sessionKeySeq}`;

const blankSession = (dayOfWeek, isWorking) => ({
  _key: nextSessionKey(),
  day_of_week: dayOfWeek,
  is_working: isWorking,
  start_time: '09:00',
  end_time: '17:00',
  has_lunch: false,
  lunch_start_time: '13:00',
  lunch_end_time: '14:00',
  // Visiting consultants only. '' = the dentist's primary branch;
  // [] = every week (which is what a resident dentist always means).
  hospital_id: '',
  week_of_month: [],
});

const defaultSchedule = () => DAYS.map((_, i) => blankSession(i, i >= 1 && i <= 6));

// "1st Saturday", "3rd Tuesday" — counted as the Nth occurrence of that weekday
// in the month, which is how clinics say it. Alternate weeks = 1st, 3rd and 5th.
const WEEK_LABELS = ['1st', '2nd', '3rd', '4th', '5th'];

export default function DoctorScheduleModal({ doctor, hospitals = [], onClose, onSaved }) {
  const [schedule, setSchedule] = useState(defaultSchedule);
  const [isVisiting, setIsVisiting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Loads the doctor's stored week. Runs once per doctor: the modal is only
  // mounted while one is being scheduled, so `doctor` never changes underneath it.
  const loadSchedule = useCallback(async (doc) => {
    setSchedule(defaultSchedule());
    try {
      const { data } = await api.get(`/admin/doctors/${doc.id}/schedule`);
      if (data.schedule?.length) {
        // Group by weekday and keep EVERY session, in start_time order. The old
        // .find() took only the first and the save then destroyed the rest.
        const byDay = new Map();
        for (const s of data.schedule) {
          if (!byDay.has(s.day_of_week)) byDay.set(s.day_of_week, []);
          byDay.get(s.day_of_week).push(s);
        }
        setSchedule(DAYS.flatMap((_, dow) => {
          const saved = (byDay.get(dow) || [])
            .slice()
            .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
          // A weekday with nothing stored is a day off, shown as one blank row.
          if (!saved.length) return [blankSession(dow, false)];
          return saved.map(s => ({
            ...blankSession(dow, s.is_working),
            is_working: s.is_working,
            start_time: s.start_time?.slice(0, 5) || '09:00',
            end_time: s.end_time?.slice(0, 5) || '17:00',
            has_lunch: !!(s.lunch_start_time && s.lunch_end_time),
            lunch_start_time: s.lunch_start_time?.slice(0, 5) || '13:00',
            lunch_end_time: s.lunch_end_time?.slice(0, 5) || '14:00',
            hospital_id: s.hospital_id || '',
            week_of_month: s.week_of_month || [],
          }));
        }));
        // Show the visiting controls if the saved schedule already uses them,
        // even when the flag on the doctor was never set.
        setIsVisiting(Boolean(doc.is_visiting) ||
          data.schedule.some(s => s.hospital_id || (s.week_of_month || []).length));
      } else {
        setIsVisiting(Boolean(doc.is_visiting));
      }
    } catch { /* use defaults */ }
  }, []);

  async function saveSchedule() {
    setSaving(true);
    try {
      // Every session, not one row per day: the backend REPLACES all rows for
      // each day_of_week it receives, so omitting a session deletes it.
      const schedules = schedule.map(d => ({
        day_of_week: d.day_of_week,
        is_working: d.is_working,
        start_time: d.start_time,
        end_time: d.end_time,
        lunch_start_time: d.is_working && d.has_lunch ? d.lunch_start_time : null,
        lunch_end_time:   d.is_working && d.has_lunch ? d.lunch_end_time   : null,
        // Only sent for a visiting consultant. Turning the toggle off clears
        // both, restoring "primary branch, every week" — otherwise a dentist
        // who stopped visiting would keep a hidden per-day branch override.
        hospital_id: isVisiting ? (d.hospital_id || null) : null,
        week_of_month: isVisiting ? (d.week_of_month || []) : [],
      }));
      await api.post(`/admin/doctors/${doctor.id}/schedule`, { schedules });
      // Cosmetic flag — it only decides whether these controls open next time.
      // Best-effort: the schedule itself is already saved and is what matters.
      if (Boolean(doctor.is_visiting) !== isVisiting) {
        await api.patch(`/admin/doctors/${doctor.id}`, { is_visiting: isVisiting })
          .catch(() => {});
      }
      toast.success('Schedule saved');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save schedule');
      setSaving(false);
      // Report failure to the caller. "Save & Generate Slots" awaited this and
      // ignored the result, so a rejected save (e.g. end time before start
      // time) still generated slots — from the PREVIOUSLY saved hours — and
      // then reported "168 slots generated". The admin believed the new hours
      // were live while patients were booked into the old window.
      return false;
    }
    setSaving(false);
    return true;
  }

  async function generateSlots() {
    setGenerating(true);
    try {
      const { data } = await api.post('/admin/slots/generate', { doctor_id: doctor.id, days: 7 });
      toast.success(`${data.generated} slots generated for 7 days`);
      onSaved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate slots');
    } finally { setGenerating(false); }
  }

  // Keyed on the session's stable _key rather than its array index: sessions
  // are added and removed within a day, so an index captured in a closure goes
  // stale and would edit the neighbouring session.
  function updateScheduleDay(key, field, value) {
    setSchedule(prev => prev.map(d => d._key === key ? { ...d, [field]: value } : d));
  }

  // A second (or third) session on the same weekday — the 10–1 / 5–9 split.
  // Defaults to an evening window after the last session of that day so the
  // backend's overlap check passes without the admin having to think about it.
  function addScheduleSession(dayOfWeek) {
    setSchedule(prev => {
      const ofDay = prev.filter(d => d.day_of_week === dayOfWeek);
      const last = ofDay[ofDay.length - 1];
      const lastEndHour = parseInt(String(last?.end_time || '17:00').slice(0, 2), 10) || 17;
      // Never earlier than the previous session ends — the backend rejects
      // overlapping sessions outright, and clamping the +1 at 22 could
      // otherwise propose a start BEFORE a late-finishing session's end.
      const startHour = Math.max(Math.min(22, lastEndHour + 1), lastEndHour);
      const added = {
        ...blankSession(dayOfWeek, true),
        start_time: `${String(startHour).padStart(2, '0')}:00`,
        end_time: `${String(Math.min(23, startHour + 4)).padStart(2, '0')}:00`,
        // Inherit the branch so a two-branch day starts from the likely answer.
        hospital_id: last?.hospital_id || '',
      };
      // Insert directly after that day's existing sessions to keep the list in
      // weekday order.
      const lastIdx = prev.map(d => d.day_of_week).lastIndexOf(dayOfWeek);
      const next = prev.slice();
      next.splice(lastIdx + 1, 0, added);
      return next;
    });
  }

  function removeScheduleSession(key) {
    setSchedule(prev => {
      const target = prev.find(d => d._key === key);
      if (!target) return prev;
      const remaining = prev.filter(d => d.day_of_week === target.day_of_week && d._key !== key);
      // Never leave a weekday with no row at all — the save would then send
      // nothing for that day, and the backend only replaces days it receives,
      // so the deleted sessions would survive. Collapse to a day off instead.
      if (!remaining.length) {
        return prev.map(d => d._key === key ? { ...blankSession(d.day_of_week, false), _key: d._key } : d);
      }
      return prev.filter(d => d._key !== key);
    });
  }
  useEffect(() => { if (doctor) loadSchedule(doctor); }, [doctor, loadSchedule]);

  if (!doctor) return null;

  return (
  <Modal title={`Schedule — Dr. ${doctor.name}`} onClose={onClose} wide="xl">
    <div className="space-y-2 mb-6">
      <p className="text-xs text-gray-500 mb-3">
        Set working hours for each day. Toggle <strong>Lunch</strong> to block a break window — no slots will be generated during that time. After saving, click <strong>Save &amp; Generate Slots</strong> to create bookable slots for the next 7 days.
      </p>

      {/* Visiting consultants: the specialist who comes on alternate
          Saturdays, or does Monday at one branch and Wednesday at another.
          Off by default so resident dentists keep the simpler form. */}
      <label className="flex items-start gap-2 mb-3 p-2.5 rounded-lg bg-amber-50 cursor-pointer">
        <input type="checkbox" checked={isVisiting}
          onChange={e => setIsVisiting(e.target.checked)}
          className="mt-0.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
        <span className="text-xs text-gray-700">
          <strong>Visiting consultant</strong>
          <span className="block text-gray-500 mt-0.5">
            Attends on some weeks only, or at a different branch on different days.
          </span>
        </span>
      </label>
      {/* Header row */}
      <div className="hidden sm:grid grid-cols-[90px_60px_1fr_1fr_70px_1fr_1fr] gap-2 px-2 text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
        <span>Day</span><span>On</span><span>Start</span><span>End</span><span>Lunch</span><span>Break Start</span><span>Break End</span>
      </div>
      {schedule.map((day) => {
        const sessionKey = day._key;
        const ofDay = schedule.filter(d => d.day_of_week === day.day_of_week);
        const seq = ofDay.indexOf(day);
        const isFirstOfDay = seq === 0;
        const isLastOfDay = seq === ofDay.length - 1;
        const dayLabel = isFirstOfDay
          ? DAYS[day.day_of_week]
          : `${DAYS[day.day_of_week].slice(0, 3)} · session ${seq + 1}`;
        return (
        <div key={day._key}>
          {/* Mobile card layout */}
          <div className={`sm:hidden rounded-lg p-3 mb-1 ${day.is_working ? 'bg-blue-50' : 'bg-gray-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-gray-700">{dayLabel}</span>
              {/* The switch itself stays 36x20; the LABEL is the hit area,
                  and at content height that was a 20px-tall target on the
                  screen reception uses to set a dentist's week. The negative
                  margin keeps the row looking the same. */}
              <label className="flex items-center gap-2 cursor-pointer py-2.5 -my-2.5 pl-3 -ml-3">
                <span className="text-xs text-gray-400">{day.is_working ? 'Working' : 'Off'}</span>
                <div className="relative">
                  <input type="checkbox" className="sr-only" checked={day.is_working} onChange={e => updateScheduleDay(sessionKey, 'is_working', e.target.checked)} />
                  <div className={`w-9 h-5 rounded-full transition-colors ${day.is_working ? 'bg-blue-500' : 'bg-gray-300'}`} />
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.is_working ? 'translate-x-4' : ''}`} />
                </div>
              </label>
            </div>
            {day.is_working && (<>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Start</p>
                  <input type="time" value={day.start_time} onChange={e => updateScheduleDay(sessionKey, 'start_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">End</p>
                  <input type="time" value={day.end_time} onChange={e => updateScheduleDay(sessionKey, 'end_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full" />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer mb-2 py-2.5 -my-0.5 pr-3">
                <div className="relative">
                  <input type="checkbox" className="sr-only" checked={day.has_lunch} onChange={e => updateScheduleDay(sessionKey, 'has_lunch', e.target.checked)} />
                  <div className={`w-9 h-5 rounded-full transition-colors ${day.has_lunch ? 'bg-orange-400' : 'bg-gray-300'}`} />
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.has_lunch ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-gray-500">🍽 Lunch break</span>
              </label>
              {day.has_lunch && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Break Start</p>
                    <input type="time" value={day.lunch_start_time} onChange={e => updateScheduleDay(sessionKey, 'lunch_start_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 w-full" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Break End</p>
                    <input type="time" value={day.lunch_end_time} onChange={e => updateScheduleDay(sessionKey, 'lunch_end_time', e.target.value)} className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 w-full" />
                  </div>
                </div>
              )}
            </>)}
          </div>
          {/* Desktop row layout */}
          <div className={`hidden sm:grid grid-cols-[90px_60px_1fr_1fr_70px_1fr_1fr] gap-2 items-center px-2 py-2 rounded-lg transition-colors ${day.is_working ? 'bg-blue-50' : 'bg-gray-50'}`}>
            <span className={`text-sm text-gray-700 ${isFirstOfDay ? 'font-medium' : 'text-xs text-gray-400 pl-2'}`}>{dayLabel}</span>
            {/* Same padding on the ≥640px row: a tablet in portrait renders
                this layout and is still a touch device. */}
            <label className="flex items-center cursor-pointer py-2.5 -my-2.5">
              <div className="relative">
                <input type="checkbox" className="sr-only"
                  checked={day.is_working}
                  onChange={e => updateScheduleDay(sessionKey, 'is_working', e.target.checked)} />
                <div className={`w-9 h-5 rounded-full transition-colors ${day.is_working ? 'bg-blue-500' : 'bg-gray-300'}`} />
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.is_working ? 'translate-x-4' : ''}`} />
              </div>
            </label>
            <input type="time" value={day.start_time}
              disabled={!day.is_working}
              onChange={e => updateScheduleDay(sessionKey, 'start_time', e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-30 disabled:bg-gray-100 w-full" />
            <input type="time" value={day.end_time}
              disabled={!day.is_working}
              onChange={e => updateScheduleDay(sessionKey, 'end_time', e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-30 disabled:bg-gray-100 w-full" />
            <label className={`flex items-center gap-1 cursor-pointer py-2.5 -my-2.5 ${!day.is_working ? 'opacity-30 pointer-events-none' : ''}`}>
              <div className="relative">
                <input type="checkbox" className="sr-only"
                  checked={day.has_lunch}
                  disabled={!day.is_working}
                  onChange={e => updateScheduleDay(sessionKey, 'has_lunch', e.target.checked)} />
                <div className={`w-9 h-5 rounded-full transition-colors ${day.has_lunch && day.is_working ? 'bg-orange-400' : 'bg-gray-300'}`} />
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${day.has_lunch && day.is_working ? 'translate-x-4' : ''}`} />
              </div>
              <span className="text-xs text-gray-500">🍽</span>
            </label>
            <input type="time" value={day.lunch_start_time}
              disabled={!day.is_working || !day.has_lunch}
              onChange={e => updateScheduleDay(sessionKey, 'lunch_start_time', e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-30 disabled:bg-gray-100 w-full" />
            <input type="time" value={day.lunch_end_time}
              disabled={!day.is_working || !day.has_lunch}
              onChange={e => updateScheduleDay(sessionKey, 'lunch_end_time', e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-30 disabled:bg-gray-100 w-full" />
          </div>

          {/* Visiting sub-row, shared by both layouts. Only for working days —
              a branch or week pattern on a day off means nothing. */}
          {isVisiting && day.is_working && (
            <div className="mt-1 mb-1 ml-0 sm:ml-2 px-2.5 py-2 rounded-lg bg-amber-50/60 border border-amber-100 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-gray-500 w-10">Branch</span>
                <select value={day.hospital_id}
                  onChange={e => updateScheduleDay(sessionKey, 'hospital_id', e.target.value)}
                  className="border border-gray-200 rounded px-2 py-1 text-xs bg-white min-w-[10rem]">
                  <option value="">Primary branch</option>
                  {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] text-gray-500">Weeks</span>
                {WEEK_LABELS.map((label, wi) => {
                  const week = wi + 1;
                  const on = (day.week_of_month || []).includes(week);
                  return (
                    <button key={week} type="button"
                      onClick={() => updateScheduleDay(sessionKey, 'week_of_month',
                        on ? day.week_of_month.filter(w => w !== week)
                           : [...(day.week_of_month || []), week].sort((a, b) => a - b))}
                      // Five chips in a row: small AND adjacent, so a
                      // mis-tap silently changes which weeks a consultant
                      // attends. 36px square on touch, compact on desktop.
                      className={`w-9 h-9 flex items-center justify-center rounded text-[11px] font-medium border transition-colors md:w-auto md:h-auto md:px-2 md:py-1 ${
                        on ? 'bg-amber-500 text-white border-amber-500'
                           : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                      {label}
                    </button>
                  );
                })}
                <span className="text-[11px] text-gray-400">
                  {(day.week_of_month || []).length ? '' : 'every week'}
                </span>
              </div>
            </div>
          )}

          {/* Session controls. "Add session" is the 10–1 / 5–9 split, which
              is ordinary for a resident dentist and the default arrangement
              for a visiting one — so it is offered on every working day,
              not just when the visiting toggle is on. */}
          {day.is_working && isLastOfDay && (
            <div className="flex items-center gap-3 px-2 mb-2 mt-0.5">
              <button type="button" onClick={() => addScheduleSession(day.day_of_week)}
                className="text-[11px] text-blue-600 hover:underline">
                + Add another session on {DAYS[day.day_of_week]}
              </button>
              {ofDay.length > 1 && (
                <button type="button" onClick={() => removeScheduleSession(day._key)}
                  className="text-[11px] text-red-500 hover:underline">
                  Remove this session
                </button>
              )}
            </div>
          )}
          {day.is_working && !isLastOfDay && ofDay.length > 1 && (
            <div className="px-2 mb-2 mt-0.5">
              <button type="button" onClick={() => removeScheduleSession(day._key)}
                className="text-[11px] text-red-500 hover:underline">
                Remove this session
              </button>
            </div>
          )}
        </div>
        );
      })}
    </div>
    <div className="border-t border-gray-100 pt-4 flex flex-col sm:flex-row gap-3">
      <button onClick={onClose}
        className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
        Close
      </button>
      <button onClick={saveSchedule} disabled={saving}
        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
        {saving ? 'Saving...' : '💾 Save Schedule'}
      </button>
      <button onClick={async () => { if (await saveSchedule()) await generateSlots(); }}
        disabled={saving || generating}
        className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
        {generating ? 'Generating...' : '⚡ Save & Generate Slots'}
      </button>
    </div>
  </Modal>
  );
}
