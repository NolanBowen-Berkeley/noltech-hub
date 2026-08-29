// Bearer-token auth. Every route except /health requires it.

export function checkAuth(request, env) {
  const expected = env.SHARED_AUTH_SECRET;
  if (!expected) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${expected}`;
}
