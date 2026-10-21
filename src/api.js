export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export async function apiRequest(path, { token, ...options } = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await response.json().catch(() => null);
  if (!data) throw new Error(`ExamSync API did not return JSON for ${path} (HTTP ${response.status}). Check the deployed backend URL and its API health endpoint.`);
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
