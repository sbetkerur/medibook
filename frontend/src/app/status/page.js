'use client';
import { useEffect, useState } from 'react';

const LABELS = {
  database: 'Database',
  webhook_queue: 'Message processing',
  whatsapp: 'WhatsApp delivery',
  crons: 'Scheduled jobs',
};
const CRON_LABELS = {
  reminders: 'Appointment reminders',
  slot_generator: 'Slot generation',
  billing_dunning: 'Billing',
  backup: 'Backups',
  webhook_retry: 'Webhook retries',
  feedback: 'Feedback requests',
  recalls: 'Recall reminders',
  treatment_nudges: 'Treatment nudges',
  weekly_digest: 'Weekly digest',
  account_deletion: 'Account deletion',
};

function Dot({ ok }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />;
}

export default function StatusPage() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/proxy/api/status', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (alive) { setData(j); setFailed(false); } })
        .catch(() => { if (alive) setFailed(true); });
    };
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const overall = failed ? false : data?.ok;

  return (
    <main className="mx-auto max-w-lg px-5 py-16 text-[15px]">
      <h1 className="text-xl font-semibold text-gray-900">MediBook status</h1>
      <div className="mt-3 flex items-center gap-2 text-gray-700">
        <Dot ok={!!overall} />
        {failed ? 'Could not reach the status service'
          : data == null ? 'Checking…'
          : overall ? 'All systems operational'
          : 'Some systems are degraded'}
      </div>

      {data && !failed && (
        <div className="mt-6 divide-y divide-gray-100 rounded-xl border border-gray-200">
          {Object.entries(data.components || {}).map(([key, val]) => {
            if (key === 'crons') {
              const jobs = Object.entries(val || {});
              const allOk = jobs.every(([, j]) => j.ok);
              return (
                <details key={key} className="px-4 py-3">
                  <summary className="flex cursor-pointer items-center justify-between">
                    <span className="text-gray-800">{LABELS.crons}</span>
                    <Dot ok={allOk} />
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {jobs.map(([name, j]) => (
                      <li key={name} className="flex items-center justify-between text-sm text-gray-500">
                        <span>{CRON_LABELS[name] || name}</span>
                        <Dot ok={j.ok} />
                      </li>
                    ))}
                  </ul>
                </details>
              );
            }
            return (
              <div key={key} className="flex items-center justify-between px-4 py-3">
                <span className="text-gray-800">{LABELS[key] || key}</span>
                <Dot ok={val?.ok !== false} />
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-gray-400">
        Refreshes every 30s. The clinic dashboard keeps working during a WhatsApp outage — only patient messaging pauses.
      </p>
    </main>
  );
}
