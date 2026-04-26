// api/update_post.js – aktualizacja istniejącego wpisu (po korekcie)

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    if (!site_url || !site_login || !site_pass) throw new Error('Brak danych witryny');
    if (!post_id) throw new Error('Brak ID wpisu');

    const baseUrl = site_url.replace(/\/$/, '');

    // ── WordPress ─────────────────────────────────────────
    if (cms === 'wordpress') {
      const creds   = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
      const payload = { content, status, title };
      if (excerpt) payload.excerpt = excerpt;
      const updateRes = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${post_id}`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await updateRes.json();
      return res.status(200).json({ id: data.id, link: data.link, status: data.status });
    }

    // ── Joomla ────────────────────────────────────────────
    if (cms === 'joomla') {
      const res2 = await fetch(`${baseUrl}/api/index.php/v1/content/articles/${post_id}`, {
        method: 'PATCH',
        headers: { 'X-Joomla-Token': site_pass, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, articletext: content, state: status === 'publish' ? 1 : 0 })
      });
      const text = await res2.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Joomla błąd: ${text.substring(0, 200)}`); }
      if (data.errors) throw new Error(data.errors.map(e => e.title || e.detail).join(', '));
      return res.status(200).json({ id: post_id, status: data.data?.attributes?.state === 1 ? 'publish' : 'draft' });
    }

    // ── Drupal ────────────────────────────────────────────
    if (cms === 'drupal') {
      const creds = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
      const res2  = await fetch(`${baseUrl}/jsonapi/node/article/${post_id}`, {
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
      const text = await res2.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Drupal błąd: ${text.substring(0, 200)}`); }
      if (data.errors) throw new Error(data.errors.map(e => e.title || e.detail).join(', '));
      return res.status(200).json({ id: post_id, status: data.data?.attributes?.status ? 'publish' : 'draft' });
    }

    throw new Error(`Nieobsługiwany CMS: ${cms}`);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
