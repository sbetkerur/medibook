import BrandMark from '@/components/BrandMark';

export const metadata = {
  title: 'MediBook — WhatsApp appointment booking for dental clinics',
  description:
    'Patients book by chatting with your clinic on WhatsApp. Your front desk runs the day from one dashboard — walk-ins, reminders, treatment plans, day-close. Built for Indian dental practices.',
};

const STEPS = [
  {
    n: '1',
    title: 'Put your QR where patients wait',
    body: 'We generate a poster and card for your clinic. A patient scans it and a WhatsApp chat opens, already addressed to your practice.',
  },
  {
    n: '2',
    title: 'They book by chatting',
    body: 'No app, no form, no login. The bot asks for the treatment, dentist, date and time, confirms, and holds the slot — in your clinic’s voice.',
  },
  {
    n: '3',
    title: 'Your desk sees everything',
    body: 'Every booking lands on the dashboard the moment it’s made. Reminders and no-show follow-ups go out on their own.',
  },
];

const FEATURES = [
  ['Opens on today', 'The landing screen is today’s queue and a + Walk-in button — because half the footfall walks in.'],
  ['Reminders that cut no-shows', '24-hour reminders with a one-tap confirm, and tomorrow’s schedule doubles as the evening call-list.'],
  ['Multi-dentist, multi-branch', 'Resident dentists and visiting consultants, each at the branch they actually sit at that day, on their own weekly rota.'],
  ['Treatment plans over visits', 'A root canal or implant course tracked across sittings, with the patient booking the follow-ups themselves.'],
  ['Payments & receipts', 'Record a payment and the patient gets a WhatsApp receipt — amount, method, paid-so-far, balance.'],
  ['End-of-day count', 'Day-close totals consultation fees and treatment payments by method, ready to count against the drawer.'],
  ['Front-desk PDFs', 'Day schedule grouped by dentist, day-close, pending requests — printed, not exported.'],
  ['Fits the walk-in reality', 'Empty slot list? The desk still books them in, and the bot offers a callback instead of a dead end.'],
];

const INDIA = [
  'The consultation fee is quotable — show it, hide it, or waive it when treatment is taken.',
  'Orthodontics books itself on a monthly cadence; short courses get gentle nudges, not weekly nagging.',
  'A dentist belongs to several treatments — the GP does simple root canals, the specialist takes the hard cases.',
  'A working day is a list of sessions: 10–1 at one clinic, 5–9 at another, same day.',
];

function Section({ id, children, className = '' }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>
      {children}
    </section>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-gray-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3 sm:px-8">
          <a href="/" className="flex items-center gap-2">
            <BrandMark className="h-8 w-8" />
            <span className="text-lg font-bold tracking-tight">MediBook</span>
          </a>
          <nav className="hidden items-center gap-7 text-sm text-gray-600 md:flex">
            <a href="#how" className="hover:text-gray-900">How it works</a>
            <a href="#features" className="hover:text-gray-900">Features</a>
            <a href="#pricing" className="hover:text-gray-900">Pricing</a>
          </nav>
          <div className="flex items-center gap-2">
            <a
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              Log in
            </a>
            <a
              href="/demo"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              See live demo
            </a>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────── */}
      <Section className="grid gap-10 pb-8 pt-14 sm:pt-20 lg:grid-cols-2 lg:items-center lg:gap-12">
        <div>
          <p className="mb-4 inline-flex rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700">
            For dental clinics in India
          </p>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
            Your clinic’s WhatsApp,{' '}
            <span className="text-blue-600">now books appointments.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-gray-600">
            Patients scan a QR in your waiting room and book by chatting — no app, no calls
            to the front desk. Your staff run the whole day from one dashboard.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="/demo"
              className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
            >
              See a live demo
            </a>
            <a
              href="/signup"
              className="rounded-xl border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Start a free trial
            </a>
          </div>
          <p className="mt-3 text-xs text-gray-400">
            14 days free · no card needed · super-admin approves every clinic
          </p>
        </div>

        {/* Stylised WhatsApp chat → dashboard, all inline */}
        <div className="relative">
          <div className="mx-auto max-w-sm rounded-3xl border border-gray-200 bg-gradient-to-b from-emerald-50 to-white p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-3">
              <BrandMark className="h-7 w-7" />
              <div className="text-sm font-semibold">Pragati Dental Studio</div>
              <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                WhatsApp
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-500 px-3 py-2 text-white">
                Hi, I’d like a check-up
              </div>
              <div className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 shadow-sm ring-1 ring-gray-100">
                Sure! Which dentist — or reply <b>1</b> for the next available?
              </div>
              <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-500 px-3 py-2 text-white">
                1, tomorrow evening
              </div>
              <div className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 shadow-sm ring-1 ring-gray-100">
                Booked ✅ Tomorrow 6:30 pm with Dr. Ananya Rao. We’ll remind you 24h before.
              </div>
            </div>
          </div>
          <div className="mx-auto -mt-4 max-w-xs rounded-2xl border border-gray-200 bg-white p-3 shadow-lg">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Front desk · Today
            </div>
            <div className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 text-sm">
              <span className="font-medium">6:30 pm · Ananya Rao</span>
              <span className="text-blue-700">New booking</span>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Problem ─────────────────────────────────────────── */}
      <Section className="py-14">
        <div className="grid gap-6 rounded-2xl bg-gray-50 p-8 sm:grid-cols-3">
          {[
            ['The phone never stops', 'Every booking, reschedule and “are you open?” is a call the front desk has to take mid-consultation.'],
            ['Messages get lost', 'Bookings over a personal WhatsApp sit in one person’s chat list. Nobody else can see the day.'],
            ['No-shows', 'A chair sits empty because the reminder was a sticky note that fell off the monitor.'],
          ].map(([h, b]) => (
            <div key={h}>
              <h3 className="font-semibold text-gray-900">{h}</h3>
              <p className="mt-1 text-sm text-gray-600">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── How it works ────────────────────────────────────── */}
      <Section id="how" className="py-8">
        <h2 className="text-center text-3xl font-bold tracking-tight">How it works</h2>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-2xl border border-gray-200 p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
                {s.n}
              </div>
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-gray-600">{s.body}</p>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-gray-500">
          The QR is the only way in — it routes a patient to <em>your</em> clinic and no one
          else’s. A shared platform number, but from the patient’s side it’s the clinic’s
          WhatsApp.
        </p>
      </Section>

      {/* ── Features ────────────────────────────────────────── */}
      <Section id="features" className="py-16">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          Everything the front desk needs
        </h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(([h, b]) => (
            <div key={h} className="rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900">{h}</h3>
              <p className="mt-1.5 text-sm text-gray-600">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Built for India ─────────────────────────────────── */}
      <Section className="py-8">
        <div className="rounded-2xl bg-blue-600 p-8 text-white sm:p-10">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Built for how Indian dental practices actually run
          </h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {INDIA.map((t) => (
              <li key={t} className="flex gap-3 text-sm text-blue-50">
                <span aria-hidden className="mt-0.5 font-bold text-white">→</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── Pricing ─────────────────────────────────────────── */}
      <Section id="pricing" className="py-16">
        <h2 className="text-center text-3xl font-bold tracking-tight">Simple pricing</h2>
        <p className="mt-3 text-center text-sm text-gray-500">
          14-day free trial on both. No card to start. No GST charged.
        </p>
        <div className="mx-auto mt-10 grid max-w-3xl gap-6 sm:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 p-7">
            <div className="text-sm font-semibold uppercase tracking-wide text-gray-500">Starter</div>
            <div className="mt-2 text-3xl font-extrabold">
              ₹799<span className="text-base font-medium text-gray-500">/month</span>
            </div>
            <ul className="mt-5 space-y-2 text-sm text-gray-600">
              <li>Up to 2 dentists</li>
              <li>1 branch</li>
              <li>WhatsApp booking + reminders</li>
              <li>Treatment plans, payments, day-close</li>
              <li>No appointment quota</li>
            </ul>
            <a
              href="/signup"
              className="mt-6 block rounded-xl border border-gray-300 py-2.5 text-center text-sm font-semibold hover:bg-gray-50"
            >
              Start free trial
            </a>
          </div>
          <div className="rounded-2xl border-2 border-blue-600 p-7 shadow-sm">
            <div className="text-sm font-semibold uppercase tracking-wide text-blue-700">
              Professional
            </div>
            <div className="mt-2 text-3xl font-extrabold">
              ₹1,799<span className="text-base font-medium text-gray-500">/month per branch</span>
            </div>
            <ul className="mt-5 space-y-2 text-sm text-gray-600">
              <li>Unlimited dentists</li>
              <li>Multiple branches &amp; visiting consultants</li>
              <li>Everything in Starter</li>
              <li>Multi-branch pricing negotiated per practice</li>
              <li>No appointment quota</li>
            </ul>
            <a
              href="/signup"
              className="mt-6 block rounded-xl bg-blue-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-blue-700"
            >
              Start free trial
            </a>
          </div>
        </div>
      </Section>

      {/* ── Trust ───────────────────────────────────────────── */}
      <Section className="py-8">
        <div className="rounded-2xl border border-gray-200 p-8 text-center">
          <h2 className="text-xl font-bold">Your patients’ data stays yours</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-gray-600">
            WhatsApp is the only channel — no email lists, no SMS. We process patient data
            only to run the service for you, never to sell or to train AI models. Aligned
            with India’s DPDP Act; you can export everything for 30 days if you leave.
          </p>
        </div>
      </Section>

      {/* ── Final CTA ───────────────────────────────────────── */}
      <Section className="py-16 text-center">
        <h2 className="text-3xl font-bold tracking-tight">See it working in 30 seconds</h2>
        <p className="mt-3 text-gray-600">
          Open a real dashboard loaded with a sample clinic — read-only, nothing to set up.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <a
            href="/demo"
            className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Open the live demo
          </a>
          <a
            href="/signup"
            className="rounded-xl border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Start a free trial
          </a>
        </div>
      </Section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="border-t border-gray-100">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-sm text-gray-500 sm:flex-row sm:px-8">
          <div className="flex items-center gap-2">
            <BrandMark className="h-6 w-6" />
            <span>MediBook — from Pragati Solutions</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a href="/terms" className="hover:text-gray-800">Terms</a>
            <a href="/privacy" className="hover:text-gray-800">Privacy</a>
            <a href="/dpa" className="hover:text-gray-800">DPA</a>
            <a href="/login" className="hover:text-gray-800">Log in</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
