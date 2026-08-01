'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import { todayIST } from '@/lib/dateIST';
import { format, parseISO } from 'date-fns';
import Badge from '@/components/ui/Badge';

// Self-contained. Fetches the current month on mount; the prev/next/today
// buttons refetch directly.
export default function CalendarTab() {
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [calendarAppts, setCalendarAppts] = useState([]);
  const [selectedCalDay, setSelectedCalDay] = useState(null);
  const [calDayAppts, setCalDayAppts] = useState([]);

  const fetchCalendarAppts = useCallback(async (year, month) => {
    try {
      const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${new Date(year, month + 1, 0).getDate()}`;
      // The backend caps `limit` at 100 and sorts DESC — a busy month can exceed
      // that, silently dropping the earliest days. Page through until has_more
      // is false (safety cap of 10 pages = 1000 appointments).
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const { data } = await api.get(
          `/admin/appointments?from=${startDate}&to=${endDate}&limit=100&page=${page}&status=confirmed,completed`
        );
        all.push(...(data.appointments || []));
        if (!data.has_more) break;
      }
      // Group by date
      const byDate = {};
      all.forEach(a => {
        const d = a.appointment_date;
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(a);
      });
      setCalendarAppts(byDate);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchCalendarAppts(calendarDate.getFullYear(), calendarDate.getMonth());
    // Mount-only: subsequent month changes fetch via the nav buttons below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getCalendarDays(year, month) {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(d);
    return days;
  }

  function formatCalDate(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            const d = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
            setCalendarDate(d); setSelectedCalDay(null);
            fetchCalendarAppts(d.getFullYear(), d.getMonth());
          }}
          className="p-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-gray-600">← Prev</button>
        <h2 className="font-semibold text-gray-800 text-base min-w-[160px] text-center">
          {calendarDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
        </h2>
        <button
          onClick={() => {
            const d = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
            setCalendarDate(d); setSelectedCalDay(null);
            fetchCalendarAppts(d.getFullYear(), d.getMonth());
          }}
          className="p-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-gray-600">Next →</button>
        <button
          onClick={() => {
            const d = new Date();
            const first = new Date(d.getFullYear(), d.getMonth(), 1);
            setCalendarDate(first); setSelectedCalDay(null);
            fetchCalendarAppts(first.getFullYear(), first.getMonth());
          }}
          className="px-3 py-1.5 text-sm border border-blue-300 text-blue-600 rounded-lg hover:bg-blue-50 transition">
          Today
        </button>
      </div>
      <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
        <div className="flex-1 min-w-0 bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="py-2 text-center text-xs font-semibold text-gray-400 uppercase">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {getCalendarDays(calendarDate.getFullYear(), calendarDate.getMonth()).map((day, i) => {
              if (!day) return <div key={`e-${i}`} className="border-r border-b border-gray-100 min-h-[76px]" />;
              const dateStr = formatCalDate(calendarDate.getFullYear(), calendarDate.getMonth(), day);
              const dayAppts = calendarAppts[dateStr] || [];
              const todayStr = todayIST();
              const isToday = dateStr === todayStr;
              const isSelected = selectedCalDay === dateStr;
              return (
                <div key={day}
                  onClick={() => { setSelectedCalDay(dateStr); setCalDayAppts(dayAppts); }}
                  className={`border-r border-b border-gray-100 min-h-[76px] p-2 cursor-pointer transition-colors
                    ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <div className={`text-sm font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full mx-auto
                    ${isToday ? 'bg-blue-600 text-white' : 'text-gray-700'}`}>
                    {day}
                  </div>
                  {dayAppts.length > 0 && (
                    <div className={`text-xs px-1 py-0.5 rounded text-center font-medium
                      ${dayAppts.length >= 5 ? 'bg-red-100 text-red-700' : dayAppts.length >= 3 ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                      {/* A 7-column grid leaves ~50px per cell on a phone, which
                          cannot fit "3 appts" — show the bare count there. */}
                      <span className="sm:hidden">{dayAppts.length}</span>
                      <span className="hidden sm:inline">{dayAppts.length} appt{dayAppts.length !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {selectedCalDay && (
          <div className="w-full lg:w-72 lg:shrink-0 bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <h3 className="font-semibold text-gray-800 text-sm">
                {(() => { try { return format(parseISO(selectedCalDay), 'EEEE, d MMMM'); } catch { return selectedCalDay; } })()}
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">{calDayAppts.length} appointment{calDayAppts.length !== 1 ? 's' : ''}</p>
            </div>
            <div className="divide-y divide-gray-50 max-h-[440px] overflow-y-auto">
              {calDayAppts.length === 0 ? (
                <div className="px-4 py-8 text-center text-gray-400 text-sm">No appointments this day</div>
              ) : calDayAppts.map(a => (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-blue-600">{a.appointment_time?.slice(0, 5)}</span>
                    <Badge status={a.status} />
                  </div>
                  <div className="text-sm font-medium text-gray-900">{a.patient_name}</div>
                  <div className="text-xs text-gray-500">Dr. {a.doctor_name}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
