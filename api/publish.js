// api/publish.js – adaptery WordPress, Joomla 4+, Drupal (JSON:API + Basic Auth)

// ─── Helpers ────────────────────────────────────────────────────────────────

function toSlug(str) {
  return str.toLowerCase()
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e').replace(/ł/g, 'l')
    .replace(/ń/g, 'n').replace(/ó/g, 'o').replace(/ś/g, 's').replace(/ź/g, 'z').replace(/ż/g, 'z')
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

function toSentenceCase(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Adapter WordPress ───────────────────────────────────────────────────────

async function publishWordPress({ baseUrl, login, pass, title, content, status, excerpt, meta_title, meta_desc, tags, categories, post_slug, brief_topic, scheduled_at }) {
  const creds = Buffer.from(`${login}:${pass}`).toString('base64');
  const auth  = { 'Authorization': `Basic ${creds}` };

  const finalSlug = post_slug || toSlug(meta_title || title);
  const postTitle = toSentenceCase(brief_topic || title);

  // Ustal status z uwzględnieniem harmonogramu
  let postStatus = status || 'draft';
  if (scheduled_at) postStatus = 'future';

  const postPayload = {
    title:   postTitle,
    content: content || '',
    status:  postStatus,
    slug:    finalSlug,
    excerpt: excerpt || '',
    meta: {
      _yoast_wpseo_title:    meta_title || '',
      _yoast_wpseo_metadesc: meta_desc  || '',
    }
  };

  if (scheduled_at) postPayload.date = new Date(scheduled_at).toISOString();
  if (tags)       postPayload.tags_input       = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (categories) postPayload.categories_input = categories.split(',').map(c => c.trim()).filter(Boolean);

  const postRes  = await fetch(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(postPayload)
  });
  const postText = await postRes.text();
  let postData;
  try { postData = JSON.parse(postText); } catch { throw new Error(`WordPress błąd: ${postText.substring(0, 200)}`); }
  if (postData.code) throw new Error(postData.message || 'Błąd WordPress API');
  if (!postData.id)  throw new Error('WordPress nie zwrócił ID wpisu');

  const postId = postData.id;

  // Drugi request – Yoast meta dla pewności
  if (meta_title || meta_desc) {
    try {
      await fetch(`${baseUrl}/wp-json/wp/v2/posts/${postId}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _yoast_wpseo_title: meta_title, _yoast_wpseo_metadesc: meta_desc } })
      });
    } catch (e) { console.log('Meta Yoast warning:', e.message); }
  }

  return { id: postId, link: postData.link, status: postData.status };
}

// ─── Adapter Joomla 4+ ───────────────────────────────────────────────────────

async function publishJoomla({ baseUrl, token, title, content, status, meta_title, meta_desc, tags, categories, scheduled_at }) {
  const headers = {
    'X-Joomla-Token': token,
    'Content-Type': 'application/json'
  };

  // Joomla state: 1 = opublikowany, 0 = szkic
  let joomlaState = (status === 'publish') ? 1 : 0;

  const articlePayload = {
    title,
    articletext: content || '',
    state: joomlaState,
    metadesc: meta_desc || '',
    metadata: { metatitle: meta_title || title },
    catid: categories ? parseInt(categories.split(',')[0]) || 2 : 2, // domyślna kategoria Joomla = 2 (Uncategorised)
    language: '*',
    featured: 0
  };

  // Harmonogram – Joomla używa publish_up
  if (scheduled_at) {
    articlePayload.publish_up = new Date(scheduled_at).toISOString().replace('T', ' ').substring(0, 19);
    articlePayload.state = 0; // szkic do czasu publikacji
  }

  // Tagi Joomla – wymagają osobnego formatu
  if (tags) {
    articlePayload.tags = tags.split(',').map(t => ({ title: t.trim() })).filter(t => t.title);
  }

  const res  = await fetch(`${baseUrl}/api/index.php/v1/content/articles`, {
    method: 'POST',
    headers,
    body: JSON.stringify(articlePayload)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Joomla błąd: ${text.substring(0, 200)}`); }

  if (data.errors) throw new Error(data.errors.map(e => e.title || e.detail).join(', '));
  if (!data.data?.id) throw new Error(`Joomla nie zwróciło ID artykułu: ${text.substring(0, 200)}`);

  const articleId  = data.data.id;
  const articleUrl = `${baseUrl}/index.php?option=com_content&view=article&id=${articleId}`;

  return { id: articleId, link: articleUrl, status: joomlaState === 1 ? 'publish' : 'draft' };
}

// ─── Adapter Drupal (JSON:API + Basic Auth) ──────────────────────────────────

async function publishDrupal({ baseUrl, login, pass, title, content, status, meta_title, meta_desc, tags, scheduled_at }) {
  const creds = Buffer.from(`${login}:${pass}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${creds}`,
    'Content-Type': 'application/vnd.api+json',
    'Accept': 'application/vnd.api+json'
  };

  // Drupal JSON:API payload dla node--article
  const nodePayload = {
    data: {
      type: 'node--article',
      attributes: {
        title,
        body: {
          value: content || '',
          format: 'full_html'
        },
        status: status === 'publish' ? true : false,
        // meta tagi przez moduł Metatag (jeśli zainstalowany)
        ...(meta_title || meta_desc ? {
          field_meta_tags: {
            title: meta_title || title,
            description: meta_desc || ''
          }
        } : {})
      }
    }
  };

  // Harmonogram przez moduł Scheduler (opcjonalny)
  if (scheduled_at) {
    nodePayload.data.attributes.status = false;
    nodePayload.data.attributes.publish_on = Math.floor(new Date(scheduled_at).getTime() / 1000);
  }

  const res  = await fetch(`${baseUrl}/jsonapi/node/article`, {
    method: 'POST',
    headers,
    body: JSON.stringify(nodePayload)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Drupal błąd: ${text.substring(0, 200)}`); }

  if (data.errors) throw new Error(data.errors.map(e => e.title || e.detail).join(', '));
  if (!data.data?.id) throw new Error(`Drupal nie zwróciło ID node: ${text.substring(0, 200)}`);

  const nodeUuid  = data.data.id;
  const nodeAlias = data.data.attributes?.path?.alias || '';
  const nodeLink  = nodeAlias ? `${baseUrl}${nodeAlias}` : `${baseUrl}/node/${data.data.attributes?.drupal_internal__nid || nodeUuid}`;

  return {
    id: nodeUuid,
    nid: data.data.attributes?.drupal_internal__nid || null,
    link: nodeLink,
    status: status === 'publish' ? 'publish' : 'draft'
  };
}

// ─── Handler główny ──────────────────────────────────────────────────────────

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
    const body = req.body;

    const cms          = (body.cms || 'wordpress').toLowerCase();
    const site_url     = body.site_url   || '';
    const site_login   = body.site_login || '';
    const site_pass    = body.site_pass  || '';
    const title        = body.title      || '';
    const content      = body.content    || '';
    const status       = body.status     || 'draft';
    const excerpt      = body.excerpt    || '';
    const meta_title   = body.meta_title || '';
    const meta_desc    = body.meta_desc  || '';
    const tags         = body.tags       || '';
    const categories   = body.categories || '';
    const post_slug    = body.post_slug  || '';
    const brief_topic  = body.brief_topic || '';
    const scheduled_at = body.scheduled_at || null;

    // Aktualizacja istniejącego wpisu (tylko WP na razie)
    const post_id_update = body.post_id_update || null;

    if (!site_url || !site_login || !site_pass) throw new Error('Brak danych witryny (url, login, hasło)');

    const baseUrl = site_url.replace(/\/$/, '');

    // ── Aktualizacja WP ──────────────────────────────────
    if (post_id_update && cms === 'wordpress') {
      const creds = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
      const payload2 = { content, status, title };
      if (excerpt) payload2.excerpt = excerpt;
      const updateRes = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${post_id_update}`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload2)
      });
      const data2 = await updateRes.json();
      return res.status(200).json({ id: data2.id, link: data2.link, status: data2.status });
    }

    // ── Routing CMS ──────────────────────────────────────
    let result;

    if (cms === 'wordpress') {
      result = await publishWordPress({
        baseUrl, login: site_login, pass: site_pass,
        title, content, status, excerpt, meta_title, meta_desc,
        tags, categories, post_slug, brief_topic, scheduled_at
      });

    } else if (cms === 'joomla') {
      // Joomla używa API Token zamiast Basic Auth
      // Token przekazywany jako site_pass (pole hasło w formularzu)
      result = await publishJoomla({
        baseUrl, token: site_pass,
        title, content, status, meta_title, meta_desc,
        tags, categories, scheduled_at
      });

    } else if (cms === 'drupal') {
      result = await publishDrupal({
        baseUrl, login: site_login, pass: site_pass,
        title, content, status, meta_title, meta_desc,
        tags, scheduled_at
      });

    } else {
      throw new Error(`Nieobsługiwany CMS: ${cms}`);
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
