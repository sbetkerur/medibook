'use client';
import { useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';

export default function TestBotTab({ isAdmin }) {
  const [botPhone, setBotPhone] = useState('917795676142');
  const [botMessage, setBotMessage] = useState('Hi');
  const [botResponse, setBotResponse] = useState(null);
  const [botLoading, setBotLoading] = useState(false);
  const [botResetting, setBotResetting] = useState(false);

  async function resetBotSession() {
    if (!botPhone) return toast.error('Enter a phone number first');
    setBotResetting(true);
    try {
      await api.delete(`/admin/bot-sessions/${botPhone}`);
      toast.success(`Session reset for ${botPhone}`);
      setBotResponse(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'No active session found');
    } finally { setBotResetting(false); }
  }

  async function testBot() {
    setBotLoading(true);
    setBotResponse(null);
    try {
      // Authenticated dashboard route — scoped to this admin's own tenant by the
      // JWT, unlike /webhook/test which is unauthenticated and only registered
      // outside production (or with ENABLE_TEST_ENDPOINT=true), which prod
      // doesn't set. See routes/admin.js POST /bot-test.
      const { data } = await api.post('/admin/bot-test', { phone: botPhone, message: botMessage });
      setBotResponse(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bot test failed');
    } finally { setBotLoading(false); }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        <strong>🤖 WhatsApp Bot Tester</strong><br/>
        Test the bot without a real WhatsApp connection. Messages are intercepted locally.
      </div>

      <div className="bg-white rounded-xl p-5 shadow-sm space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
          <input value={botPhone} onChange={e => setBotPhone(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="917795676142" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
          {/* POST /admin/bot-test is adminOnly server-side, so the Enter-to-send
              shortcut must not fire for a non-admin either — see the button below. */}
          <input value={botMessage} onChange={e => setBotMessage(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && isAdmin && testBot()}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Hi" />
        </div>
        {isAdmin ? (<>
        <div className="flex flex-wrap gap-2">
          <button onClick={testBot} disabled={botLoading}
            className="px-5 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition">
            {botLoading ? 'Sending...' : '📨 Send Message'}
          </button>
          <div className="flex gap-2 flex-wrap">
            {['Hi', 'Book', 'My Appointments', 'Status'].map(m => (
              <button key={m} onClick={() => { setBotMessage(m); }}
                className="px-3 py-2 border border-gray-200 text-gray-600 rounded-lg text-xs hover:bg-gray-50 transition">
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="pt-1 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-gray-400">If the bot gets stuck, reset the session to start fresh.</span>
          <button onClick={resetBotSession} disabled={botResetting}
            className="px-3 py-1.5 text-xs border border-orange-200 text-orange-600 rounded-lg hover:bg-orange-50 disabled:opacity-50 transition whitespace-nowrap">
            {botResetting ? 'Resetting...' : '🔄 Reset Session'}
          </button>
        </div>
        </>) : (
          // POST /admin/bot-test and DELETE /admin/bot-sessions/:phone are both
          // adminOnly server-side. Rendering the Send button to staff/doctor
          // roles offered an action that could only ever 403 — the same class of
          // bug fixed elsewhere in this file for walk-ins and cancellation.
          <p className="text-xs text-gray-400">Only clinic admins can test the bot.</p>
        )}
      </div>

      {botResponse && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">
              🤖 Bot replied ({botResponse.responses?.length || 0} message{botResponse.responses?.length !== 1 ? 's' : ''})
            </span>
            <span className="text-xs text-gray-400">{botResponse.tenant}</span>
          </div>
          {/* WhatsApp-style chat bubbles */}
          <div className="p-4 space-y-3 bg-[#e5ddd5] min-h-[80px]">
            {/* Outgoing user message */}
            {/* max-w-xs/sm are wider than a 320px screen and bot replies carry
                unbreakable strings (links, booking IDs), so cap by percentage
                and break words below sm. */}
            <div className="flex justify-end">
              <div className="bg-[#dcf8c6] rounded-lg rounded-tr-none px-3 py-2 max-w-[85%] sm:max-w-xs shadow-sm">
                <p className="text-sm text-gray-800 break-words">{botResponse.message}</p>
                <p className="text-xs text-gray-400 text-right mt-0.5">You</p>
              </div>
            </div>
            {/* Bot responses */}
            {botResponse.responses?.map((r, i) => (
              <div key={i} className="flex justify-start">
                <div className="bg-white rounded-lg rounded-tl-none px-3 py-2 max-w-[85%] sm:max-w-sm shadow-sm min-w-0">
                  <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{r.text}</p>
                  {r.buttons && (
                    <div className="mt-2 pt-2 border-t border-gray-100 flex flex-col gap-1.5">
                      {r.buttons.map((b, bi) => (
                        <button key={bi}
                          onClick={() => { setBotMessage(String(b)); }}
                          className="text-sm text-blue-600 py-1 border border-blue-200 rounded-lg hover:bg-blue-50 transition text-center">
                          {b}
                        </button>
                      ))}
                    </div>
                  )}
                  {r.sections && r.sections.map((s, si) => (
                    <div key={si} className="mt-2 pt-2 border-t border-gray-100">
                      {s.title && <p className="text-xs font-semibold text-gray-500 mb-1.5">{s.title}</p>}
                      <div className="flex flex-col gap-1">
                        {s.rows?.map((row, ri) => (
                          <button key={ri}
                            onClick={() => setBotMessage(row.id || row.title)}
                            className="text-left text-sm px-2 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 transition">
                            <span className="font-medium text-gray-800">{row.title}</span>
                            {row.description && <span className="text-xs text-gray-400 ml-1">· {row.description}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-gray-400 text-right mt-1">MediBook Bot</p>
                </div>
              </div>
            ))}
            {!botResponse.responses?.length && (
              <div className="text-center text-gray-500 text-sm py-4">Bot sent no response — check backend logs</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
