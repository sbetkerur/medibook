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

// ── Response interceptor: auto-refresh on 401 ────────────────
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;

    // Only attempt refresh on 401, not on the refresh endpoint itself, and only once
    if (
      err.response?.status === 401 &&
      typeof window !== 'undefined' &&
      !originalRequest._retried &&
      !originalRequest.url?.includes('/auth/refresh') &&
      !originalRequest.url?.includes('/auth/login') &&
      !originalRequest.url?.includes('/auth/superadmin/login')
    ) {
      const refreshToken = localStorage.getItem('refresh_token');

      if (!refreshToken) {
        // No refresh token available — redirect to login
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
        return Promise.reject(err);
      }

      if (isRefreshing) {
        // Another refresh is in-flight — queue this request
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((newToken) => {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        }).catch((e) => Promise.reject(e));
      }

      originalRequest._retried = true;
      isRefreshing = true;

      try {
        const { data } = await axios.post(`${API_PROXY_BASE}/auth/refresh`, { refresh_token: refreshToken });
        if (!data.token) throw new Error('Refresh response missing token');
        localStorage.setItem('token', data.token);
        if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
        resetSessionTimers();

        api.defaults.headers.common.Authorization = `Bearer ${data.token}`;
        processQueue(null, data.token);

        originalRequest.headers.Authorization = `Bearer ${data.token}`;
        return api(originalRequest);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        // Refresh failed — clear session and redirect
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
