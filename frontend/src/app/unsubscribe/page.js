'use client';
import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import api, { getApiError } from '@/lib/api';
import toast from 'react-hot-toast';

function UnsubscribeForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [tokenMissing, setTokenMissing] = useState(false);

  useEffect(() => {
    if (!token) setTokenMissing(true);
  }, [token]);

  async function handleUnsubscribe() {
    setLoading(true);
    try {
      // Through the proxy via lib/api (baseURL /api/proxy/api) — no API origin
      // is baked into the bundle, and this page is opened from an email so it
      // must work with no session and no stored token.
      await api.post('/unsubscribe', { token });
      setDone(true);
      toast.success('Unsubscribed successfully');
    } catch (err) {
      toast.error(getApiError(err, 'Could not unsubscribe — the link may be invalid'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">✉️</div>
          <h1 className="text-2xl font-bold text-gray-900">Email Preferences</h1>
          <p className="text-gray-500 text-sm mt-1">MediBook Appointment Emails</p>
        </div>

        {tokenMissing ? (
          <div className="text-center space-y-4">
            <div className="text-5xl">⚠️</div>
            <p className="text-gray-700 font-medium">Invalid unsubscribe link</p>
            <p className="text-sm text-gray-500">
              This link is missing its unsubscribe token. Please open the link directly from
              the email you received, or reply <strong>Hi</strong> to your clinic on WhatsApp
              for help.
            </p>
          </div>
        ) : done ? (
          <div className="text-center space-y-4">
            <div className="text-5xl">✅</div>
            <p className="text-gray-700 font-medium">You&apos;re unsubscribed</p>
            <p className="text-sm text-gray-500">
              You will no longer receive appointment confirmation or reminder emails.
              You&apos;ll still get WhatsApp messages about your appointments — reply{' '}
              <strong>Stop</strong> on WhatsApp to opt out of those too.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-600 text-center">
              Unsubscribe from MediBook appointment confirmation and reminder emails?
            </p>
            <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3">
              This only stops emails. Appointment updates sent over WhatsApp are unaffected.
            </div>
            <button
              onClick={handleUnsubscribe}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 text-sm">
              {loading ? 'Unsubscribing...' : 'Unsubscribe'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  // useSearchParams() opts the tree into client-side rendering; without this
  // Suspense boundary `next build` fails prerendering this route outright.
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    }>
      <UnsubscribeForm />
    </Suspense>
  );
}
