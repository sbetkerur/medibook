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
      const { data } = await axios.post(`${API_PROXY_BASE}/auth/refresh`, { refresh_token: refreshToken });
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
        if (freshAccess) return freshAccess;
      }
      throw refreshErr;
    }
  };

  const lockedRefresh = async () => {
    // While we waited for the lock, another tab may have refreshed already.
    // Only reuse the stored token if it differs from the one that just 401'd
    // (a same-token 401 means expiry/revocation — a real refresh is needed).
    const stored = localStorage.getItem('token');
    if (stored && failedAccessToken && stored !== failedAccessToken) return stored;
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
        // Another refresh is in-flight in this tab — queue this request
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
        // Refresh genuinely failed (and no other tab holds a valid session) —
        // clear session and redirect
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

let _warnTimer   = null;
let _expireTimer = null;

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

export function resetSessionTimers() {
  if (typeof window === 'undefined') return;
  clearTimeout(_warnTimer);
  clearTimeout(_expireTimer);

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
  if (msUntilWarn > 0) {
    _warnTimer = setTimeout(() => {
      // Dispatch a custom event; dashboard listens and shows a toast
      window.dispatchEvent(new CustomEvent('medibook:session-warning', {
        detail: { minutesLeft: 5 }
      }));
    }, msUntilWarn);
  }

  _expireTimer = setTimeout(() => {
    // If a refresh token is present the interceptor already tried to refresh.
    // If we reach here the refresh also failed — force logout.
    const hasRefresh = !!localStorage.getItem('refresh_token');
    if (!hasRefresh) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login?reason=expired';
    }
  }, msUntilExpiry);
}

export function clearSessionTimers() {
  clearTimeout(_warnTimer);
  clearTimeout(_expireTimer);
}

// Start timers immediately if a token already exists (e.g. after page reload)
if (typeof window !== 'undefined' && localStorage.getItem('token')) {
  resetSessionTimers();
}

export default api;
