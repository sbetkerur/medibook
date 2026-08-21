'use client';
import { useState, useEffect, useCallback } from 'react';
import { format, parseISO, subDays, addDays } from 'date-fns';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { todayIST } from '@/lib/dateIST';

/**
 * End of day: what came in, so the drawer can be counted against it.
 *
 * Every clinic does this before locking up, and it was the one front-desk
 * ritual the product had no answer for. The layout follows the order the count
 * actually happens in: the total to match first, then the breakdown by method
 * (cash against the drawer, UPI against the phone), then who saw whom.
 *
 * The two money streams are shown SEPARATELY on purpose. Consultation fees sit
 * on the appointment; treatment payments sit against a course as a whole.
 * Adding them anywhere but the one total below double-counts revenue.
 */
const METHOD_LABELS = {
  cash: 'Cash', card: 'Card', upi: 'UPI',
  bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other',
};

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function DayCloseTab() {
  // todayIST(), not the device's local date. The product is IST but a reception
  // PC may be set to UTC or sit abroad, and this value is load-bearing three
  // times over — it seeds the picker, caps it via max=, and gates the "next
  // day" arrow. On a UTC-set machine the tab opened on YESTERDAY between 00:00
  // and 05:30 IST and today's collections could not be selected at all, which
  // is precisely when a clinic closing at 21:00 IST does its count.
  const todayStr = todayIST();
  const [date, setDate] = useState(todayStr);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const fetchDay = useCallback(async (d) => {
    setLoading(true);
    try {
      const { data } = await api.get(`/admin/day-close?date=${encodeURIComponent(d)}`);
      setData(data);
      setFailed(false);
    } catch (err) {
      setFailed(true);
      toast.error(err.response?.data?.error || 'Could not load the day');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchDay(date); }, [date, fetchDay]);

  const shift = (days) => {
    const next = format(days > 0 ? addDays(parseISO(date), days) : subDays(parseISO(date), -days), 'yyyy-MM-dd');
    // Never past today — there is nothing to reconcile in the future, and an
    // empty screen reads as a bug rather than as "not yet".
    if (next > todayStr) return;
    setDate(next);
  };

  const a = data?.appointments || {};
  const byMethod = data?.treatment_payments?.by_method || [];
  const treatmentTotal = data?.treatment_payments?.total || 0;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ── Date picker ─────────────────────────────────────── */}
      <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm flex flex-wrap items-center gap-3">
        <button onClick={() => shift(-1)}
          className="px-3 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
          ←
        </button>
        <input type="date" value={date} max={todayStr}
          onChange={e => e.target.value && setDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button onClick={() => shift(1)} disabled={date >= todayStr}
          className="px-3 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40 transition">
          →
        </button>
        {date !== todayStr && (
          <button onClick={() => setDate(todayStr)}
            className="px-3 py-2 text-sm text-blue-600 hover:underline">Today</button>
        )}
        <button onClick={() => fetchDay(date)} disabled={loading}
          className="ml-auto px-3 py-2 text-xs text-blue-500 hover:text-blue-700 disabled:opacity-50 transition">
          ↻ Refresh
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl p-10 shadow-sm text-center text-gray-400 text-sm">Loading…</div>
      ) : failed ? (
        <div className="bg-white rounded-xl p-8 shadow-sm text-center">
          <p className="text-gray-500 mb-3 text-sm">The day could not be loaded.</p>
          <button onClick={() => fetchDay(date)}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">Retry</button>
        </div>
      ) : (
        <>
          {/* ── The number to count against ──────────────────── */}
          <div className="bg-white rounded-xl p-5 sm:p-6 shadow-sm border-l-4 border-green-500">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Collected today</p>
            <p className="mt-1 text-3xl font-bold text-gray-900">{money(data.collected_total)}</p>
            <p className="mt-2 text-xs text-gray-500">
              {money(a.fees_completed)} in consultation fees for the {a.completed || 0} appointment{a.completed === 1 ? '' : 's'} seen today, plus {money(treatmentTotal)} in treatment payments.
            </p>
            {/* There used to be a "still marked unpaid" amber line here, driven by
                appointments.payment_status. Nothing in the product ever writes
                that column, so the line fired on every clinic, every day, always
                claiming 100% of consultation fees were unpaid — and the headline
                above it read ₹0. A number that is wrong every single time is
                worse than no number: it is what teaches a receptionist to stop
                reading the screen. If per-appointment payment marking is ever
                built, bring the split back then. */}
          </div>

          {/* ── By method: cash vs the drawer ────────────────── */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-800">Treatment payments by method</h2>
              <p className="text-xs text-gray-500 mt-0.5">Count the drawer against the cash line.</p>
            </div>
            {byMethod.length ? (
              <div className="divide-y divide-gray-50">
                {byMethod.map(m => (
                  <div key={m.method} className="px-5 py-3 flex items-center justify-between">
                    <div className="text-sm text-gray-700">
                      {METHOD_LABELS[m.method] || m.method}
                      <span className="ml-2 text-xs text-gray-400">{m.count} payment{m.count === 1 ? '' : 's'}</span>
                    </div>
                    <div className="text-sm font-semibold text-gray-900">{money(m.amount)}</div>
                  </div>
                ))}
                <div className="px-5 py-3 flex items-center justify-between bg-gray-50">
                  <div className="text-sm font-medium text-gray-700">Total</div>
                  <div className="text-sm font-bold text-gray-900">{money(treatmentTotal)}</div>
                </div>
              </div>
            ) : (
              <div className="px-5 py-8 text-center text-gray-400 text-sm">No treatment payments taken.</div>
            )}
          </div>

          {/* ── The day itself ───────────────────────────────── */}
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-3">Appointments</h2>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
              {[
                ['Booked', a.total, 'text-gray-900'],
                ['Completed', a.completed, 'text-green-600'],
                ['Still open', a.still_open, 'text-blue-600'],
                ['No-show', a.no_show, 'text-amber-600'],
                ['Cancelled', a.cancelled, 'text-gray-400'],
              ].map(([label, value, cls]) => (
                <div key={label} className="py-2">
                  <div className={`text-2xl font-bold ${cls}`}>{value ?? 0}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
            {a.still_open > 0 && date === todayStr && (
              <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {a.still_open} appointment{a.still_open === 1 ? ' is' : 's are'} still marked confirmed. Mark them completed or no-show before closing, or today&apos;s figures stay wrong.
              </p>
            )}
          </div>

          {/* ── Per dentist ──────────────────────────────────── */}
          {data.by_doctor?.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h2 className="font-semibold text-gray-800">By dentist</h2>
              </div>
              <div className="divide-y divide-gray-50">
                {data.by_doctor.map(d => (
                  <div key={d.doctor_name} className="px-5 py-3 flex items-center justify-between">
                    <div className="text-sm text-gray-700">
                      Dr. {d.doctor_name}
                      <span className="ml-2 text-xs text-gray-400">{d.seen} patient{d.seen === 1 ? '' : 's'}</span>
                    </div>
                    <div className="text-sm text-gray-900">{money(d.fees)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-gray-400 px-1">
            Consultation fees and treatment payments are counted separately and added once above — the same money is never
            reported twice.
          </p>
        </>
      )}
    </div>
  );
}
