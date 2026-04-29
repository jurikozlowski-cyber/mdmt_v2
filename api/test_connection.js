// api/test_connection.js – testuje połączenie z CMS (auto-detect Drupal 7 vs 8+)

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

    // ── WordPress ─────────────────────────────────────────────────────────
    if (cms === 'wordpress' || !cms) {
      const r = await fetch(`${baseUrl}/wp-json/wp/v2/users/me`, {
        headers: { 'Authorization': `Basic ${creds}` },
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (r.ok && d.id) return res.status(200).json({ ok: true, user: d.name || d.slug, cms: 'wordpress' });
      throw new Error(d.message || `HTTP ${r.status}`);
    }

    // ── Joomla ────────────────────────────────────────────────────────────
    if (cms === 'joomla') {
      const r = await fetch(`${baseUrl}/api/index.php/v1/users?page[limit]=1`, {
        headers: { 'X-Joomla-Token': site_pass },
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (r.ok && !d.errors) return res.status(200).json({ ok: true, cms: 'joomla' });
      throw new Error(d.errors?.[0]?.title || `HTTP ${r.status}`);
    }

    // ── Drupal – auto-detect 7 vs 8+ ─────────────────────────────────────
    if (cms === 'drupal') {
      // Sprawdź Drupal 8+ przez JSON:API
      try {
        const r8 = await fetch(`${baseUrl}/jsonapi`, {
          headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/vnd.api+json' },
          signal: AbortSignal.timeout(8000)
        });
        if (r8.ok) {
          return res.status(200).json({ ok: true, cms: 'drupal', version: '8+', note: 'JSON:API dostępne' });
        }
        if (r8.status === 401) {
          return res.status(200).json({ ok: false, cms: 'drupal', version: '8+', error: 'Błąd autoryzacji – sprawdź login i hasło oraz moduł basic_auth' });
        }
        if (r8.status === 403) {
          return res.status(200).json({ ok: false, cms: 'drupal', version: '8+', error: 'Brak uprawnień do JSON:API – sprawdź uprawnienia roli użytkownika' });
        }
      } catch(e8) {
        // JSON:API nie odpowiada – sprawdź Drupal 7
      }

      // Sprawdź Drupal 7 przez Services
      try {
        const r7 = await fetch(`${baseUrl}/api/user/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: site_login, password: site_pass }),
          signal: AbortSignal.timeout(8000)
        });
        const d7 = await r7.json();
        if (r7.ok && d7.sessid) {
          // Wyloguj od razu
          try {
            await fetch(`${baseUrl}/api/user/logout`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Cookie': `${d7.session_name}=${d7.sessid}` },
              signal: AbortSignal.timeout(5000)
            });
          } catch(e) {}
          return res.status(200).json({ ok: true, cms: 'drupal', version: '7', user: d7.user?.name, note: 'Drupal 7 Services API' });
        }
        throw new Error(d7.message || `HTTP ${r7.status}`);
      } catch(e7) {
        throw new Error(`Nie można połączyć z Drupal. Sprawdź czy moduł Services (D7) lub basic_auth + JSON:API (D8+) są włączone. Szczegół: ${e7.message}`);
      }
    }

    throw new Error(`Nieobsługiwany CMS: ${cms}`);

  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Timeout – brak odpowiedzi po 10s' : err.message;
    return res.status(200).json({ ok: false, error: msg });
  }
}
