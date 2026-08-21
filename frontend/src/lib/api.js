import axios from 'axios';

// All API calls go through the Next.js rewrite proxy (/api/proxy/* → backend).
// This means no NEXT_PUBLIC_API_URL needs to be baked into the bundle at build time.
// In production, set BACKEND_URL on the frontend service in Railway.
// In local dev, /api/proxy/* proxies to http://localhost:3001 automatically.
const API_PROXY_BASE = '/api/proxy/api';

const api = axios.create({
  baseURL: API_PROXY_BASE,
  timeout: 15000,
});

// ── Refresh token rotation state ───────────────────────────────
let isRefreshing = false;
let failedQueue = []; // [{resolve, reject}]

function processQueue(error, token = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token);
  });
  failedQueue = [];
}

// ── Request interceptor: attach access token ──────────────────
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Token refresh (cross-tab safe) ───────────────────────────
// Refresh tokens are STRICTLY one-time-use server-side. If two tabs (e.g. the
// dashboard and the reception queue display) refresh concurrently with the same
// stored refresh_token, the loser gets a 401 and would wipe localStorage —
// destroying the winner's freshly-written valid session and logging the whole
// clinic out. So:
//   1. Serialize refresh across tabs with the Web Locks API where available.
//   2. Inside the lock, if another tab already rotated the token (the stored
//      access token differs from the one that just failed), reuse it instead of
//      burning our (now stale) refresh token.
//   3. On refresh failure, if the stored refresh_token differs from the one we
//      sent, another tab won the race — recover with its session instead of
//      clearing storage.
async function performTokenRefresh(failedAccessToken) {
  const doRefresh = async () => {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) {
      const e = new Error('No refresh token');
      e.code = 'NO_REFRESH_TOKEN';
      throw e;
    }
    try {
      // An explicit timeout, because this is a BARE axios call — it does not
      // inherit the `api` instance's 15s, and axios defaults to no timeout at
      // all. It also runs while holding the cross-tab Web Lock and with every
      // 401'd request parked on failedQueue, so a backend that accepts the
      // connection and never answers (an ordinary moment during a redeploy)
      // used to wedge the whole dashboard: Save buttons stuck on "Saving…" with
      // no toast, proactiveRefresh short-circuiting on isRefreshing, and other
      // tabs blocked on the same lock. Timing out lets processQueue reject and
      // the failure actually surface.
      const { data } = await axios.post(
        `${API_PROXY_BASE}/auth/refresh`,
        { refresh_token: refreshToken },
        { timeout: 15000 },
      );
      if (!data.token) throw new Error('Refresh response missing token');
      localStorage.setItem('token', data.token);
      if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
      resetSessionTimers();
      // Notify long-lived consumers of the old token (e.g. the dashboard's SSE
      // EventSource, which embeds the token in its URL) so they can reconnect.
      window.dispatchEvent(new CustomEvent('medibook:token-refreshed', { detail: { token: data.token } }));
      return data.token;
    } catch (refreshErr) {
      // Another tab may have rotated the token while we were in flight (possible
      // when Web Locks are unavailable). Its session is valid — recover with it.
      const current = localStorage.getItem('refresh_token');
      if (current && current !== refreshToken) {
        const freshAccess = localStorage.getItem('token');
        if (freshAccess) return adoptToken(freshAccess);
      }
      throw refreshErr;
    }
  };

  // Adopting a token another tab rotated is just as much a refresh as doing it
  // ourselves, and must announce itself the same way. It didn't: these paths
  // returned the token bare, so `medibook:token-refreshed` never fired and
  // resetSessionTimers() never re-armed. The dashboard's SSE stream closes
  // itself on a token_expired frame and reconnects only on that event, so after
  // a cross-tab rotation the dashboard sat with no live bookings until some
  // later refresh happened to go through doRefresh().
  const adoptToken = (token) => {
    resetSessionTimers();
    window.dispatchEvent(new CustomEvent('medibook:token-refreshed', { detail: { token } }));
    return token;
  };

  const lockedRefresh = async () => {
    // While we waited for the lock, another tab may have refreshed already.
    // Only reuse the stored token if it differs from the one that just 401'd
    // (a same-token 401 means expiry/revocation — a real refresh is needed).
    const stored = localStorage.getItem('token');
    if (stored && failedAccessToken && stored !== failedAccessToken) return adoptToken(stored);
    return doRefresh();
  };

  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('medibook:token-refresh', lockedRefresh);
  }
  return lockedRefresh();
}

// ── Response interceptor: auto-refresh on 401 ────────────────
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;

    // Only attempt refresh on 401, not on the refresh endpoint itself, and only once
    if (
      err.response?.status === 401 &&
      typeof window !== 'undefined' &&
      originalRequest &&
      !originalRequest._retried &&
      !originalRequest.url?.includes('/auth/refresh') &&
      !originalRequest.url?.includes('/auth/login') &&
      !originalRequest.url?.includes('/auth/superadmin/login')
    ) {
      if (!localStorage.getItem('refresh_token')) {
        // No refresh token available — redirect to login
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
        return Promise.reject(err);
      }

      if (isRefreshing) {
        // Another refresh is in-flight in this tab — queue this request.
        // Mark it retried BEFORE replaying: without this a queued request whose
        // replay also 401s re-entered this branch, so it could bounce between
        // "queue" and "retry" instead of failing once and surfacing the error.
        originalRequest._retried = true;
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((newToken) => {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        }).catch((e) => Promise.reject(e));
      }

      originalRequest._retried = true;
      isRefreshing = true;
      const failedAccessToken =
        String(originalRequest.headers?.Authorization || '').replace(/^Bearer\s+/i, '') || null;

      try {
        const newToken = await performTokenRefresh(failedAccessToken);
        api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
        processQueue(null, newToken);

        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshErr) {
        processQueue(refreshErr, null);

        // Only a 401/403 from /auth/refresh means the refresh token is actually
        // dead. Treating EVERY failure as "session over" destroyed valid 30-day
        // sessions on a network blip, a 502 during a Railway redeploy, or a 429
        // — and /auth/refresh is rate limited per IP, which an entire clinic
        // shares behind one NAT address. Staff were being logged out and forced
        // to re-enter passwords because a colleague's tab rotated a token.
        const status = refreshErr?.response?.status;
        if (status !== 401 && status !== 403) {
          return Promise.reject(refreshErr);
        }

        localStorage.removeItem('token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('user');
        delete api.defaults.headers.common.Authorization;
        window.location.href = '/login';
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(err);
  }
);

// Shared error message extractor — use instead of err.response?.data?.error || 'fallback'
export function getApiError(err, fallback = 'Something went wrong') {
  if (err?.response?.data?.error) return err.response.data.error;
  if (err?.response?.status === 503) return 'Service temporarily unavailable';
  if (err?.response?.status === 429) return 'Too many requests — please slow down';
  if (err?.message === 'Network Error') return 'Cannot connect to server. Check your internet.';
  if (err?.code === 'ECONNABORTED') return 'Request timed out. Please try again.';
  return fallback;
}

// ── Session timeout warning ───────────────────────────────────
// Timers are set relative to the token's actual `exp` claim, not from the
// current time. This ensures page reloads don't reset the countdown and
// the warning fires 60 minutes before the token truly expires.

let _warnTimer    = null;
let _expireTimer  = null;
let _refreshTimer = null;

function parseTokenExp(token) {
  try {
    // JWT payload is the second base64url segment. Restore padding stripped by base64url encoding.
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null; // convert to ms
  } catch (_) {
    return null;
  }
}

// Proactively refresh the access token ahead of its expiry, instead of
// waiting for some other request to 401 first. Without this, a staff member
// idle on a tab that makes no API calls (e.g. Settings, with only a
// long-lived SSE connection open) would never trigger the reactive 401
// refresh path, and long-lived consumers like the dashboard's SSE
// EventSource would silently stop working once the token actually expired.
// Shares `isRefreshing`/`failedQueue` with the reactive 401 path so a
// request that 401s while this is in flight queues instead of firing a
// second, redundant refresh.
async function proactiveRefresh() {
  if (typeof window === 'undefined') return;
  if (!localStorage.getItem('refresh_token')) return; // nothing to refresh with — the expiry timer below handles logout
  if (isRefreshing) return; // a refresh (reactive or proactive) is already in flight

  isRefreshing = true;
  try {
    const newToken = await performTokenRefresh(null);
    api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
    processQueue(null, newToken);
  } catch (err) {
    // Swallow failures here — this is a best-effort early refresh. If it
    // genuinely can't refresh, the next real API call will 401 and go
    // through the reactive path (which does force a logout on failure), or
    // the expiry timer below will retry once more as a last resort.
    processQueue(err, null);
  } finally {
    isRefreshing = false;
  }
}

export function resetSessionTimers() {
  if (typeof window === 'undefined') return;
  clearTimeout(_warnTimer);
  clearTimeout(_expireTimer);
  clearTimeout(_refreshTimer);

  const token = localStorage.getItem('token');
  if (!token) return;

  const expMs = parseTokenExp(token);
  if (!expMs) return; // malformed token — let the server reject it naturally

  const now = Date.now();
  const msUntilExpiry = expMs - now;
  if (msUntilExpiry <= 0) return; // already expired

  // Warn 5 minutes before actual token expiry.
  // A 60-minute threshold was previously used, but access tokens expire in 1h,
  // so msUntilExpiry − 3600000 ≤ 0 immediately after login and the timer never fired.
  const WARN_BEFORE_MS = 5 * 60 * 1000; // 5 minutes
  const msUntilWarn = msUntilExpiry - WARN_BEFORE_MS;

  // Proactively refresh at the same 5-minute-before-expiry mark. Scheduled
  // BEFORE the warn timer below (with the same delay) so, given same-delay
  // timers fire in scheduling order, the refresh resolves first: on success
  // it calls resetSessionTimers() again, which clears the about-to-fire warn
  // timer before it runs — so an active tab that refreshes in time never
  // sees the "session expiring" toast at all.
  if (msUntilWarn > 0) {
    _refreshTimer = setTimeout(() => { proactiveRefresh(); }, msUntilWarn);
    _warnTimer = setTimeout(() => {
      // Dispatch a custom event; dashboard listens and shows a toast
      window.dispatchEvent(new CustomEvent('medibook:session-warning', {
        detail: { minutesLeft: 5 }
      }));
    }, msUntilWarn);
  }

  _expireTimer = setTimeout(() => {
    // The proactive refresh above should already have renewed the session by
    // now. If it failed (e.g. a transient network blip) and no other request
    // happened to trigger the reactive 401 path either (a fully idle tab),
    // make one last-resort attempt here rather than leaving the session dead
    // until the user's next action. If there's no refresh token at all, the
    // session truly can't be renewed — force logout.
    const hasRefresh = !!localStorage.getItem('refresh_token');
    if (!hasRefresh) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login?reason=expired';
    } else {
      proactiveRefresh();
    }
  }, msUntilExpiry);
}

export function clearSessionTimers() {
  clearTimeout(_warnTimer);
  clearTimeout(_expireTimer);
  clearTimeout(_refreshTimer);
}

// Start timers immediately if a token already exists (e.g. after page reload)
if (typeof window !== 'undefined' && localStorage.getItem('token')) {
  resetSessionTimers();
}

export default api;
