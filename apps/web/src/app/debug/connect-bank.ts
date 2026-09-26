const CSRF_COOKIE = 'personal_cfo_csrf';

export function readCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export async function startEnableBankingConnection(
  cookieHeader: string,
  fetchImplementation: typeof fetch,
  navigate: (url: URL) => void,
): Promise<void> {
  const csrf = readCookieValue(cookieHeader, CSRF_COOKIE);
  if (csrf === null) throw new Error('Missing CSRF token.');
  const response = await fetchImplementation('/api/v1/open-banking/enable-banking/connect', {
    method: 'POST',
    headers: { Accept: 'application/json', 'x-csrf-token': csrf },
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Connection could not be started.');
  const body = (await response.json()) as unknown;
  const authorizationUrl =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as Record<string, unknown>)['authorizationUrl'] === 'string'
      ? new URL((body as Record<string, string>)['authorizationUrl']!)
      : null;
  if (authorizationUrl === null || authorizationUrl.protocol !== 'https:') {
    throw new Error('Authorization URL is invalid.');
  }
  navigate(authorizationUrl);
}
