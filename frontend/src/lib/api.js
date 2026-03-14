import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Warn if pointing to localhost in a non-local environment
if (typeof window !== 'undefined' && API_URL === 'http://localhost:3001' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  console.warn('⚠️ MediBook: NEXT_PUBLIC_API_URL is pointing to localhost in a non-local environment. Check your environment variables.');
}

const api = axios.create({
  baseURL: `${API_URL}/api`,
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
        const { data } = await axios.post(`${API_URL}/api/auth/refresh`, { refresh_token: refreshToken });
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
    // JWT payload is the second base64url segment
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
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

  // Warn 60 minutes before actual token expiry
  const msUntilWarn = msUntilExpiry - 60 * 60 * 1000;
  if (msUntilWarn > 0) {
    _warnTimer = setTimeout(() => {
      // Dispatch a custom event; dashboard listens and shows a toast
      window.dispatchEvent(new CustomEvent('medibook:session-warning', {
        detail: { minutesLeft: 60 }
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
