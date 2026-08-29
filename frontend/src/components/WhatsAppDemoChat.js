'use client';
import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import BrandMark from '@/components/BrandMark';

// Per-tab only (sessionStorage, not localStorage): every visitor needs their
// OWN synthetic phone number on the backend (routes/demoChat.js derives one
// from this id) so two people trying the widget at once don't land in the
// same bot_sessions row and see each other's mid-conversation state.
const SID_KEY = 'medibook_demo_chat_sid';

function newSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'demo-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function readOrCreateSessionId() {
  try {
    const existing = sessionStorage.getItem(SID_KEY);
    if (existing) return existing;
  } catch {}
  const sid = newSessionId();
  try { sessionStorage.setItem(SID_KEY, sid); } catch {}
  return sid;
}

/**
 * Live, interactive glimpse of the WhatsApp bot — not a scripted animation.
 * Every message here runs through the real bot engine (routes/demoChat.js),
 * against the same read-only demo clinic the dashboard "See a live demo"
 * button opens. Booking is disabled at the mutation itself
 * (services/bot/utils.js isReadOnlyDemo), so nothing typed here can ever
 * change the shared demo data.
 */
export default function WhatsAppDemoChat() {
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    const sid = readOrCreateSessionId();
    setSessionId(sid);
    sendToBot(sid, { is_first: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, loading]);

  async function sendToBot(sid, payload) {
    setLoading(true);
    try {
      const { data } = await api.post('/demo/chat', { session_id: sid, ...payload });
      const bot = (data.responses || []).map((r) => ({ ...r, from: 'bot', key: Math.random() }));
      setMessages((m) => [...m, ...bot]);
      setUnavailable(false);
    } catch (err) {
      if (err?.response?.status === 404) {
        setUnavailable(true);
      } else {
        setMessages((m) => [...m, { from: 'bot', type: 'text', text: 'Connection hiccup at our end — try again in a moment.', key: Math.random() }]);
      }
    } finally {
      setLoading(false);
    }
  }

  function tap(label, buttonId) {
    if (loading || !sessionId) return;
    setMessages((m) => [...m, { from: 'user', text: label, key: Math.random() }]);
    sendToBot(sessionId, { button_id: buttonId });
  }

  function submit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading || !sessionId) return;
    setMessages((m) => [...m, { from: 'user', text, key: Math.random() }]);
    setInput('');
    sendToBot(sessionId, { message: text });
  }

  function restart() {
    const sid = newSessionId();
    try { sessionStorage.setItem(SID_KEY, sid); } catch {}
    setSessionId(sid);
    setMessages([]);
    sendToBot(sid, { is_first: true });
  }

  const last = messages[messages.length - 1];
  const quickReplies = last && last.from === 'bot' && !loading
    ? last.type === 'buttons'
      ? (last.buttons || []).map((title, i) => ({ title, id: last.ids?.[i] || title }))
      : last.type === 'list'
        ? (last.sections || []).flatMap((s) => s.rows || [])
        : []
    : [];

  return (
    <div className="mx-auto max-w-sm rounded-3xl border border-gray-200 bg-gradient-to-b from-emerald-50 to-white p-4 shadow-xl">
      <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-3">
        <BrandMark className="h-7 w-7" />
        <div className="text-sm font-semibold">Pragati Dental Studio</div>
        <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
          WhatsApp
        </span>
      </div>

      {unavailable ? (
        <div className="py-8 text-center text-sm text-gray-500">
          The live chat demo isn’t available right now.
        </div>
      ) : (
        <>
          <div className="flex h-72 flex-col gap-2 overflow-y-auto pr-1 text-sm">
            {messages.map((m) => (
              <ChatBubble key={m.key} m={m} />
            ))}
            {loading && (
              <div className="w-fit max-w-[60%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-gray-400 shadow-sm ring-1 ring-gray-100">
                …
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {quickReplies.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {quickReplies.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => tap(opt.title, opt.id)}
                  disabled={loading}
                  className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {opt.title}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="mt-2 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
              placeholder="Type a message…"
              className="min-w-0 flex-1 rounded-full border border-gray-200 px-3 py-1.5 text-xs focus:border-emerald-400 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-gray-400">
        <span>Live demo · shared · booking is view-only</span>
        <button onClick={restart} className="font-medium text-emerald-700 hover:underline">
          Restart chat
        </button>
      </div>
    </div>
  );
}

function ChatBubble({ m }) {
  if (m.from === 'user') {
    return (
      <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-500 px-3 py-2 text-white">
        {m.text}
      </div>
    );
  }
  // Bot turn — header/footer are WhatsApp's own small-caption slots
  // (services/whatsapp.js sendButtons/sendList 6th arg), rendered the same
  // way here so the widget matches what a patient actually sees.
  return (
    <div className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 shadow-sm ring-1 ring-gray-100">
      {m.header && <div className="mb-1 text-[11px] font-semibold text-gray-500">{m.header}</div>}
      <div className="whitespace-pre-wrap">{m.text}</div>
      {m.footer && <div className="mt-1 text-[10px] text-gray-400">{m.footer}</div>}
    </div>
  );
}
