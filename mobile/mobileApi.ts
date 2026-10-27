export function getApiBaseUrl(): string {
 let raw = '';
 if (typeof window !== 'undefined') {
   try { raw = localStorage.getItem('ampysongscriber_api') || ''; } catch {}
 }
 raw = raw || process.env.NEXT_PUBLIC_API_BASE_URL || '';
 if (!raw) throw new Error('Backend not configured. Tap API Settings.');
 const url = new URL(raw);
 if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid backend protocol');
 return url.toString().replace(/\/$/, '');
}
