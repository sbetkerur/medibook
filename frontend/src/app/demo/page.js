'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import api, { getApiError, resetSessionTimers } from '@/lib/api';
import BrandMark from '@/components/BrandMark';
import toast from 'react-hot-toast';

const TRY = [
  'Open today’s queue and add a walk-in',
  'Follow a root-canal patient across their treatment plan',
  'Print the day’s schedule as a PDF (grouped by dentist)',
  'Run day-close and see the cash count by method',
  'Look at how the WhatsApp booking bot is configured',
];

export default function DemoPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function openDemo() {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/demo-session');
      localStorage.setItem('token', data.token);
      if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
      localStorage.setItem('user', JSON.stringify(data.user));
      resetSessionTimers();
      router.push('/dashboard');
    } catch (err) {
      toast.error(getApiError(err, 'The live demo isn’t available right now. Please try again shortly.'));
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-4 sm:px-8">
        <a href="/" className="flex items-center gap-2">
          <BrandMark className="h-8 w-8" />
          <span className="text-lg font-bold tracking-tight text-gray-900">MediBook</span>
        </a>
        <a href="/login" className="text-sm font-medium text-blue-600 hover:underline">
          Log in
        </a>
      </header>

      <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-8">
        <div className="rounded-2xl bg-white p-6 shadow-xl sm:p-8">
          <p className="inline-flex rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700">
            Live demo
          </p>
          <h1 className="mt-4 text-2xl font-bold text-gray-900 sm:text-3xl">
            Take a look inside — no signup
          </h1>
          <p className="mt-3 text-sm text-gray-600">
            This opens a real MediBook dashboard loaded with a sample practice,
            <span className="font-medium"> Pragati Dental Studio</span> — three dentists,
            a full appointment book, treatment plans and payments already in it.
          </p>
          <p className="mt-2 text-sm text-gray-600">
            Want the patient’s side too?{' '}
            <a href="/#try" className="font-medium text-emerald-700 hover:underline">
              Chat with the live booking bot
            </a>{' '}
            on the home page.
          </p>

          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            It’s <strong>read-only</strong>. Click around anything you like — booking,
            editing and settings are disabled, so nothing you do changes the demo or
            affects anyone else viewing it.
          </div>

          <div className="mt-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              Things worth trying
            </div>
            <ul className="mt-3 space-y-2">
              {TRY.map((t) => (
                <li key={t} className="flex gap-2.5 text-sm text-gray-700">
                  <span aria-hidden className="mt-0.5 font-bold text-blue-600">→</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>

          <button
            onClick={openDemo}
            disabled={loading}
            className="mt-7 w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {loading ? 'Opening…' : 'Open the demo dashboard'}
          </button>

          <p className="mt-4 text-center text-sm text-gray-500">
            Ready to run your own clinic on it?{' '}
            <a href="/signup" className="font-medium text-blue-600 hover:underline">
              Start a free trial
            </a>
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-gray-400">
          The demo session lasts about an hour. Come back here any time to open a fresh one.
        </p>
      </main>
    </div>
  );
}
