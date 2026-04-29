// api/publish.js – adaptery WordPress, Joomla 4+, Drupal 8+ (JSON:API), Drupal 7 (Services)

function toSlug(str) {
  return str.toLowerCase()
    .replace(/ą/g,'a').replace(/ć/g,'c').replace(/ę/g,'e').replace(/ł/g,'l')
    .replace(/ń/g,'n').replace(/ó/g,'o').replace(/ś/g,'s').replace(/ź/g,'z').replace(/ż/g,'z')
    .replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').trim();
}

function toSentenceCase(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ─── WordPress ───────────────────────────────────────────────────────────────
async function publishWordPress({ baseUrl, login, pass, title, content, status, excerpt, meta_title, meta_desc, post_slug, brief_topic, scheduled_at }) {
  const creds = Buffer.from(`${login}:${pass}`).toString('base64');
  const auth  = { 'Authorization': `Basic ${creds}` };

  let postStatus = status || 'draft';
  if (scheduled_at) postStatus = 'future';

  const postPayload = {
    title:   toSentenceCase(brief_topic || title),
    content: content || '',
    status:  postStatus,
    slug:    post_slug || toSlug(meta_title || title),
    excerpt: excerpt || '',
    meta: {
      _yoast_wpseo_title:    meta_title || '',
      _yoast_wpseo_metadesc: meta_desc  || '',
    }
  };

  if (scheduled_at) postPayload.date = new Date(scheduled_at).toISOString();

  const postRes  = await fetch(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(postPayload)
  });
  const postText = await postRes.text();
  let postData;
  try { postData = JSON.parse(postText); } catch { throw new Error(`WordPress błąd: ${postText.substring(0,200)}`); }
  if (postData.code) throw new Error(postData.message || 'Błąd WordPress API');
  if (!postData.id)  throw new Error('WordPress nie zwrócił ID wpisu');

  const postId = postData.id;

  if (meta_title || meta_desc) {
    try {
      await fetch(`${baseUrl}/wp-json/wp/v2/posts/${postId}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _yoast_wpseo_title: meta_title, _yoast_wpseo_metadesc: meta_desc } })
      });
    } catch(e) { console.log('Yoast meta warning:', e.message); }
  }

  return { id: postId, link: postData.link, status: postData.status };
}

// ─── Joomla 4+ ───────────────────────────────────────────────────────────────
async function publishJoomla({ baseUrl, token, title, content, status, meta_title, meta_desc, scheduled_at }) {
  const headers = { 'X-Joomla-Token': token, 'Content-Type': 'application/json' };

  const articlePayload = {
    title,
    articletext: content || '',
    state: status === 'publish' ? 1 : 0,
    metadesc: meta_desc || '',
    metadata: { metatitle: meta_title || title },
    catid: 2,
    language: '*',
    featured: 0
  };

  if (scheduled_at) {
    articlePayload.publish_up = new Date(scheduled_at).toISOString().replace('T',' ').substring(0,19);
    articlePayload.state = 0;
  }

  const res  = await fetch(`${baseUrl}/api/index.php/v1/content/articles`, {
    method: 'POST', headers, body: JSON.stringify(articlePayload)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Joomla błąd: ${text.substring(0,200)}`); }
  if (data.errors) throw new Error(data.errors.map(e => e.title||e.detail).join(', '));
  if (!data.data?.id) throw new Error(`Joomla nie zwróciło ID: ${text.substring(0,200)}`);

  const articleId = data.data.id;
  return { id: articleId, link: `${baseUrl}/index.php?option=com_content&view=article&id=${articleId}`, status: articlePayload.state === 1 ? 'publish' : 'draft' };
}

// ─── Drupal 8+ (JSON:API) ────────────────────────────────────────────────────
async function publishDrupal8({ baseUrl, login, pass, title, content, status, meta_title, meta_desc, scheduled_at }) {
  const creds   = Buffer.from(`${login}:${pass}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${creds}`,
    'Content-Type': 'application/vnd.api+json',
    'Accept': 'application/vnd.api+json'
  };

  const nodePayload = {
    data: {
      type: 'node--article',
      attributes: {
        title,
        body: { value: content || '', format: 'full_html' },
        status: status === 'publish',
        ...(meta_title || meta_desc ? {
          field_meta_tags: { title: meta_title || title, description: meta_desc || '' }
        } : {})
      }
    }
  };

  if (scheduled_at) {
    nodePayload.data.attributes.status = false;
    nodePayload.data.attributes.publish_on = Math.floor(new Date(scheduled_at).getTime() / 1000);
  }

  const res  = await fetch(`${baseUrl}/jsonapi/node/article`, { method: 'POST', headers, body: JSON.stringify(nodePayload) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Drupal błąd: ${text.substring(0,200)}`); }
  if (data.errors) throw new Error(data.errors.map(e => e.title||e.detail).join(', '));
  if (!data.data?.id) throw new Error(`Drupal nie zwróciło ID node: ${text.substring(0,200)}`);

  const nodeUuid = data.data.id;
  const alias    = data.data.attributes?.path?.alias || '';
  const nid      = data.data.attributes?.drupal_internal__nid || null;
  return {
    id: nodeUuid, nid,
    link: alias ? `${baseUrl}${alias}` : `${baseUrl}/node/${nid||nodeUuid}`,
    status: status === 'publish' ? 'publish' : 'draft'
  };
}

// ─── Drupal 7 (Services module) ──────────────────────────────────────────────
async function publishDrupal7({ baseUrl, login, pass, title, content, status, meta_title, meta_desc, scheduled_at }) {
  // Krok 1: Pobierz CSRF token
  const tokenRes = await fetch(`${baseUrl}/services/session/token`, {
    method: 'GET',
    headers: { 'Accept': 'text/plain' }
  });
  const csrfToken = tokenRes.ok ? (await tokenRes.text()).trim() : '';

  // Krok 2: Logowanie – sesja Services
  const loginRes  = await fetch(`${baseUrl}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: login, password: pass })
  });
  const loginText = await loginRes.text();
  let loginData;
  try { loginData = JSON.parse(loginText); } catch { throw new Error(`Drupal 7 logowanie błąd: ${loginText.substring(0,200)}`); }
  if (!loginData.sessid) throw new Error(`Drupal 7: błąd logowania – ${loginData.message || 'nieprawidłowe dane'}`);

  const sessionCookie = `${loginData.session_name}=${loginData.sessid}`;
  const sessionToken  = loginData.token || csrfToken;

  const authHeaders = {
    'Content-Type': 'application/json',
    'Cookie': sessionCookie,
    'X-CSRF-Token': sessionToken
  };

  // Krok 3: Utwórz node
  const nodePayload = {
    type:   'article',
    title,
    body:   [{ value: content || '', format: 'full_html' }],
    status: status === 'publish' ? 1 : 0,
    language: 'und'
  };

  if (scheduled_at) {
    nodePayload.status = 0;
    nodePayload.publish_on = Math.floor(new Date(scheduled_at).getTime() / 1000);
  }

  const nodeRes  = await fetch(`${baseUrl}/api/node`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(nodePayload)
  });
  const nodeText = await nodeRes.text();
  let nodeData;
  try { nodeData = JSON.parse(nodeText); } catch { throw new Error(`Drupal 7 node błąd: ${nodeText.substring(0,200)}`); }
  if (!nodeData.nid) throw new Error(`Drupal 7 nie zwróciło nid: ${nodeText.substring(0,200)}`);

  const nid = nodeData.nid;

  // Krok 4: Wyloguj (zwolnij sesję)
  try {
    await fetch(`${baseUrl}/api/user/logout`, {
      method: 'POST',
      headers: authHeaders
    });
  } catch(e) { console.log('Drupal 7 logout warning:', e.message); }

  return {
    id:     nid,
    nid,
    link:   `${baseUrl}/node/${nid}`,
    status: nodePayload.status === 1 ? 'publish' : 'draft'
  };
}

// ─── Auto-detect Drupal version ───────────────────────────────────────────────
async function publishDrupal(params) {
  const { baseUrl, login, pass } = params;
  const creds = Buffer.from(`${login}:${pass}`).toString('base64');

  // Sprawdź czy to Drupal 8+ przez JSON:API endpoint
  try {
    const check = await fetch(`${baseUrl}/jsonapi`, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'Authorization': `Basic ${creds}`
      },
      signal: AbortSignal.timeout(8000)
    });
    if (check.ok || check.status === 401) {
      // JSON:API istnieje – Drupal 8+
      return await publishDrupal8(params);
    }
  } catch(e) {
    // timeout lub brak odpowiedzi – próbuj D7
  }

  // Fallback: Drupal 7 przez Services
  return await publishDrupal7(params);
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

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
    const post_slug    = body.post_slug  || '';
    const brief_topic  = body.brief_topic || '';
    const scheduled_at = body.scheduled_at || null;

    if (!site_url || !site_pass) throw new Error('Brak danych witryny (url, hasło)');
    const baseUrl = site_url.replace(/\/$/, '');

    let result;
    if (cms === 'wordpress') {
      result = await publishWordPress({ baseUrl, login: site_login, pass: site_pass, title, content, status, excerpt, meta_title, meta_desc, post_slug, brief_topic, scheduled_at });
    } else if (cms === 'joomla') {
      result = await publishJoomla({ baseUrl, token: site_pass, title, content, status, meta_title, meta_desc, scheduled_at });
    } else if (cms === 'drupal') {
      result = await publishDrupal({ baseUrl, login: site_login, pass: site_pass, title, content, status, meta_title, meta_desc, scheduled_at });
    } else {
      throw new Error(`Nieobsługiwany CMS: ${cms}`);
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
