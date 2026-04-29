// api/update_post.js – aktualizacja istniejącego wpisu (WP, Joomla, Drupal 7, Drupal 8+)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body       = req.body;
    const cms        = (body.cms || 'wordpress').toLowerCase();
    const site_url   = body.site_url   || '';
    const site_login = body.site_login || '';
    const site_pass  = body.site_pass  || '';
    const post_id    = body.post_id    || '';
    const content    = body.content    || '';
    const title      = body.title      || '';
    const status     = body.status     || 'draft';
    const excerpt    = body.excerpt    || '';

    if (!site_url || !site_pass) throw new Error('Brak danych witryny');
    if (!post_id) throw new Error('Brak ID wpisu');

    const baseUrl = site_url.replace(/\/$/, '');

    // ── WordPress ─────────────────────────────────────────────────────────
    if (cms === 'wordpress') {
      const creds   = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
      const payload = { content, status, title };
      if (excerpt) payload.excerpt = excerpt;
      const r = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${post_id}`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      return res.status(200).json({ id: data.id, link: data.link, status: data.status });
    }

    // ── Joomla ────────────────────────────────────────────────────────────
    if (cms === 'joomla') {
      const r = await fetch(`${baseUrl}/api/index.php/v1/content/articles/${post_id}`, {
        method: 'PATCH',
        headers: { 'X-Joomla-Token': site_pass, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, articletext: content, state: status === 'publish' ? 1 : 0 })
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Joomla błąd: ${text.substring(0,200)}`); }
      if (data.errors) throw new Error(data.errors.map(e => e.title||e.detail).join(', '));
      return res.status(200).json({ id: post_id, status: data.data?.attributes?.state === 1 ? 'publish' : 'draft' });
    }

    // ── Drupal (auto-detect 7 vs 8+) ─────────────────────────────────────
    if (cms === 'drupal') {
      const creds = Buffer.from(`${site_login}:${site_pass}`).toString('base64');

      // Sprawdź czy to Drupal 8+ (JSON:API)
      const d8check = await fetch(`${baseUrl}/jsonapi`, {
        headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/vnd.api+json' },
        signal: AbortSignal.timeout(5000)
      }).catch(() => ({ ok: false, status: 0 }));

      if (d8check.ok) {
        // Drupal 8+ – JSON:API PATCH
        const r = await fetch(`${baseUrl}/jsonapi/node/article/${post_id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Basic ${creds}`,
            'Content-Type': 'application/vnd.api+json',
            'Accept': 'application/vnd.api+json'
          },
          body: JSON.stringify({
            data: {
              type: 'node--article',
              id: post_id,
              attributes: {
                title,
                body: { value: content, format: 'full_html' },
                status: status === 'publish'
              }
            }
          })
        });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch { throw new Error(`Drupal 8+ błąd: ${text.substring(0,200)}`); }
        if (data.errors) throw new Error(data.errors.map(e => e.title||e.detail).join(', '));
        return res.status(200).json({ id: post_id, status: data.data?.attributes?.status ? 'publish' : 'draft' });
      }

      // Drupal 7 – Services API
      const loginRes  = await fetch(`${baseUrl}/api/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: site_login, password: site_pass })
      });
      const loginData = await loginRes.json();
      if (!loginData.sessid) throw new Error(`Drupal 7 logowanie: ${loginData.message || 'błędne dane'}`);

      const d7Headers = {
        'Content-Type': 'application/json',
        'Cookie': `${loginData.session_name}=${loginData.sessid}`,
        'X-CSRF-Token': loginData.token || ''
      };

      const r7 = await fetch(`${baseUrl}/api/node/${post_id}`, {
        method: 'PUT',
        headers: d7Headers,
        body: JSON.stringify({
          title,
          body: [{ value: content, format: 'full_html' }],
          status: status === 'publish' ? 1 : 0
        })
      });
      const text7 = await r7.text();

      // Wyloguj
      try { await fetch(`${baseUrl}/api/user/logout`, { method: 'POST', headers: d7Headers }); } catch(e) {}

      let data7;
      try { data7 = JSON.parse(text7); } catch { throw new Error(`Drupal 7 update błąd: ${text7.substring(0,200)}`); }
      return res.status(200).json({ id: post_id, status: status === 'publish' ? 'publish' : 'draft' });
    }

    throw new Error(`Nieobsługiwany CMS: ${cms}`);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
