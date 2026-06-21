const TOKEN_KEY = 'gym_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, { method, headers, body: payload });

  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Session expired');
  }

  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b),
  patch: (p, b) => req('PATCH', p, b),
  del: (p) => req('DELETE', p),
  login: (username, password) => req('POST', '/login', { username, password }),
};
