'use client';

export default function StatCard({ label, value, icon, color = 'border-blue-500', sub }) {
  return (
    // These sit two-per-row on a phone (~142px each), and a value like
    // ₹1,50,000 cannot wrap — at p-4/text-xl it overflowed the card and pushed
    // the page sideways, so mobile gets tighter padding and a smaller value.
    <div className={`bg-white rounded-xl p-3 md:p-5 border-l-4 ${color} shadow-sm`}>
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="text-lg sm:text-2xl md:text-3xl font-bold text-gray-900 mt-1">{value ?? '—'}</p>
          {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
        </div>
        <span className="text-xl md:text-2xl shrink-0">{icon}</span>
      </div>
    </div>
  );
}
