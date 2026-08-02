'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

export default function FeedbackTab() {
  const [feedback, setFeedback] = useState([]);
  const [feedbackPage, setFeedbackPage] = useState(1);
  const [feedbackHasMore, setFeedbackHasMore] = useState(false);
  const [feedbackAvgRating, setFeedbackAvgRating] = useState(null);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackDistribution, setFeedbackDistribution] = useState([]);

  const fetchFeedback = useCallback(async (page = 1) => {
    try {
      const { data } = await api.get(`/admin/feedback?page=${page}&limit=25`);
      setFeedback(data.feedback || []);
      setFeedbackPage(page);
      setFeedbackHasMore(data.has_more || false);
      setFeedbackAvgRating(data.avg_rating);
      // total_all, not total: this number sits beside the clinic-wide average and
      // is the denominator for the distribution bars below, both of which are
      // unfiltered. `total` is the FILTERED count (it drives has_more), so using
      // it here would make the bars add up to more than 100% under a filter.
      setFeedbackTotal(data.total_all ?? data.total ?? 0);
      setFeedbackDistribution(data.distribution || []);
    } catch { toast.error('Failed to load feedback'); }
  }, []);

  useEffect(() => {
    fetchFeedback(1);
  }, [fetchFeedback]);

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-5 border-l-4 border-yellow-400 shadow-sm col-span-2 lg:col-span-1">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Avg Rating</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            {feedbackAvgRating ? `${feedbackAvgRating} ⭐` : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">{feedbackTotal} total reviews</p>
        </div>
        {/* Star distribution */}
        <div className="bg-white rounded-xl p-5 shadow-sm col-span-2 lg:col-span-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Rating Distribution</p>
          <div className="space-y-1.5">
            {[5,4,3,2,1].map(star => {
              const found = feedbackDistribution.find(d => parseInt(d.rating) === star);
              const count = found ? parseInt(found.count) : 0;
              const pct = feedbackTotal > 0 ? Math.round((count / feedbackTotal) * 100) : 0;
              return (
                <div key={star} className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-gray-500 w-4">{star}⭐</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2">
                    <div className="bg-yellow-400 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 w-10 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Feedback list */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {/* Mobile feedback cards. The comment is the point of this view, so it
            wraps in full here rather than being truncated as it is in the table. */}
        <div className="md:hidden divide-y divide-gray-100">
          {feedback.map(f => (
            <div key={`mob-${f.id}`} className="p-4 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{f.patient_name || '—'}</div>
                  <div className="text-xs text-gray-500 truncate">Dr. {f.doctor_name}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-yellow-500 text-sm">{'⭐'.repeat(f.rating)}</div>
                  <div className="text-xs text-gray-400">({f.rating}/5)</div>
                </div>
              </div>
              <div className="text-xs text-gray-400">
                {f.appointment_date ? (() => { try { return format(parseISO(f.appointment_date), 'd MMM yy'); } catch { return f.appointment_date; } })() : '—'}
              </div>
              <div className="text-sm text-gray-600 break-words">
                {f.comment || <span className="text-gray-300 italic">No comment</span>}
              </div>
            </div>
          ))}
          {!feedback.length && (
            <div className="px-4 py-12 text-center text-gray-400">
              No feedback yet — it will appear here after patients rate their appointments
            </div>
          )}
        </div>
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Patient', 'Doctor', 'Date', 'Rating', 'Comment'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {feedback.map(f => (
                <tr key={f.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{f.patient_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-700">Dr. {f.doctor_name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {f.appointment_date ? (() => { try { return format(parseISO(f.appointment_date), 'd MMM yy'); } catch { return f.appointment_date; } })() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-yellow-500 font-medium">{'⭐'.repeat(f.rating)}</span>
                    <span className="text-gray-400 ml-1 text-xs">({f.rating}/5)</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-xs truncate" title={f.comment || ''}>
                    {f.comment || <span className="text-gray-300 italic">No comment</span>}
                  </td>
                </tr>
              ))}
              {!feedback.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    No feedback yet — it will appear here after patients rate their appointments
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {(feedbackPage > 1 || feedbackHasMore) && (
        <div className="flex items-center justify-between mt-2">
          <button onClick={() => fetchFeedback(feedbackPage - 1)} disabled={feedbackPage === 1}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
            ← Previous
          </button>
          <span className="text-sm text-gray-500">Page {feedbackPage}</span>
          <button onClick={() => fetchFeedback(feedbackPage + 1)} disabled={!feedbackHasMore}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
