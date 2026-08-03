'use client';

export default function Badge({ status }) {
  const map = {
    confirmed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
    completed: 'bg-blue-100 text-blue-700',
    no_show: 'bg-gray-100 text-gray-600',
  };
  return (
    // whitespace-nowrap: two-word labels ("no show") otherwise break across two
    // lines inside the pill when the badge sits in a narrow mobile card.
    <span className={`whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium capitalize ${map[status] || 'bg-gray-100 text-gray-600'}`}>
      {status?.replace('_', ' ')}
    </span>
  );
}
