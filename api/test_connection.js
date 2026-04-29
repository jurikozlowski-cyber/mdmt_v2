// api/test_connection.js – testuje połączenie z CMS

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { cms, site_url, site_login, site_pass } = req.body;
    if (!site_url || !site_pass) return res.status(400).json({ ok: false, error: 'Brak URL lub hasła' });

    const baseUrl = site_url.replace(/\/$/, '');
    const creds   = Buffer.from(`${site_login}:${site_pass}`).toString('base64');

    if (cms === 'wordpress' || !cms) {
      const r = await fetch(`${baseUrl}/wp-json/wp/v2/users/me`, {
        headers: { 'Authorization': `Basic ${creds}` },
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (r.ok && d.id) return res.status(200).json({ ok: true, user: d.name || d.slug, cms: 'wordpress' });
      throw new Error(d.message || `HTTP ${r.status}`);
    }

    if (cms === 'joomla') {
      const r = await fetch(`${baseUrl}/api/index.php/v1/users?page[limit]=1`, {
        headers: { 'X-Joomla-Token': site_pass },
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (r.ok && !d.errors) return res.status(200).json({ ok: true, cms: 'joomla' });
      throw new Error(d.errors?.[0]?.title || `HTTP ${r.status}`);
    }

    if (cms === 'drupal') {
      const r = await fetch(`${baseUrl}/jsonapi`, {
        headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/vnd.api+json' },
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) return res.status(200).json({ ok: true, cms: 'drupal' });
      throw new Error(`HTTP ${r.status} – sprawdź czy moduł basic_auth jest włączony`);
    }

    throw new Error(`Nieobsługiwany CMS: ${cms}`);
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Timeout – brak odpowiedzi po 10s' : err.message;
    return res.status(200).json({ ok: false, error: msg });
  }
}
