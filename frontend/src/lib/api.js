import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
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

export default api;
