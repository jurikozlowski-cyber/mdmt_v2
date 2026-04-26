// api/images.js – generowanie (Gemini) → kompresja (TinyPNG) → upload (WP / Joomla / Drupal)

async function withRetry(fn) {
  const delays = [0, 3000, 6000];
  let lastError;
  for (let i = 0; i < 3; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const result = await fn();
      if (result?.error) {
        const code = result.error.code || 0;
        const msg  = result.error.message || '';
        const isOverload = code === 429 || code === 503 || code === 529 || msg.includes('overloaded') || msg.includes('high demand');
        if (isOverload && i < 2) { lastError = result.error; continue; }
      }
      return result;
    } catch (e) { lastError = e; if (i < 2) continue; }
  }
  throw lastError instanceof Error ? lastError : new Error(lastError?.message || 'Błąd po 3 próbach');
}

// ─── Generowanie obrazu (Gemini) ─────────────────────────────────────────────

async function generateImage(promptText, GEMINI_KEY) {
  const fullPrompt = promptText + '. Zdjęcie BEZ napisów, tekstów, liter, cyfr, watermarków. Profesjonalna fotografia, naturalne oświetlenie.';
  const payload = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } }
  };
  const data = await withRetry(() =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    ).then(r => r.json())
  );
  if (data.error) throw new Error(`[GENEROWANIE] Gemini: ${data.error.message}`);
  const parts   = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData);
  if (!imgPart) throw new Error('[GENEROWANIE] Gemini nie zwrócił obrazu');
  return { data: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType };
}

// ─── Kompresja (TinyPNG) ──────────────────────────────────────────────────────

async function compressImage(imgBase64, mimeType, TINYPNG_KEY) {
  if (!TINYPNG_KEY) {
    console.log('TINYPNG_API_KEY nie ustawiony – pomijam kompresję');
    return { data: imgBase64, mimeType, compressed: false, skipped: true };
  }

  const buffer     = Buffer.from(imgBase64, 'base64');
  const tinifyAuth = 'Basic ' + Buffer.from(`api:${TINYPNG_KEY}`).toString('base64');

  const shrinkRes = await fetch('https://api.tinify.com/shrink', {
    method: 'POST',
    headers: { 'Authorization': tinifyAuth, 'Content-Type': mimeType },
    body: buffer
  });
  if (!shrinkRes.ok) {
    const errText = await shrinkRes.text();
    throw new Error(`[KOMPRESJA] TinyPNG błąd ${shrinkRes.status}: ${errText}`);
  }
  const location = shrinkRes.headers.get('location');
  if (!location) throw new Error('[KOMPRESJA] TinyPNG nie zwrócił lokalizacji');

  const convertRes = await fetch(location, {
    method: 'POST',
    headers: { 'Authorization': tinifyAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ convert: { type: 'image/jpeg' } })
  });
  if (!convertRes.ok) throw new Error(`[KOMPRESJA] TinyPNG konwersja błąd ${convertRes.status}`);

  const compressedBuf    = await convertRes.arrayBuffer();
  const compressedBuffer = Buffer.from(compressedBuf);
  const MAX_SIZE         = 300 * 1024;

  // Drugi pass jeśli nadal > 300KB
  if (compressedBuffer.length > MAX_SIZE) {
    const shrinkRes2 = await fetch('https://api.tinify.com/shrink', {
      method: 'POST',
      headers: { 'Authorization': tinifyAuth, 'Content-Type': 'image/jpeg' },
      body: compressedBuffer
    });
    if (shrinkRes2.ok) {
      const location2 = shrinkRes2.headers.get('location');
      if (location2) {
        const finalRes = await fetch(location2, { method: 'GET', headers: { 'Authorization': tinifyAuth } });
        if (finalRes.ok) {
          const finalBuf = await finalRes.arrayBuffer();
          return { data: Buffer.from(finalBuf).toString('base64'), mimeType: 'image/jpeg', compressed: true };
        }
      }
    }
  }

  return { data: compressedBuffer.toString('base64'), mimeType: 'image/jpeg', compressed: true };
}

// ─── Upload WordPress ─────────────────────────────────────────────────────────

async function uploadToWordPress(imgData, mimeType, altTxt, titleTxt, filename, baseUrl, login, pass) {
  const creds  = Buffer.from(`${login}:${pass}`).toString('base64');
  const auth   = { 'Authorization': `Basic ${creds}` };
  const buffer = Buffer.from(imgData, 'base64');
  const ext    = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';

  const uploadRes  = await fetch(`${baseUrl}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: { ...auth, 'Content-Disposition': `attachment; filename="${filename}.${ext}"`, 'Content-Type': mimeType },
    body: buffer
  });
  const uploadText = await uploadRes.text();
  let uploadData;
  try { uploadData = JSON.parse(uploadText); } catch { throw new Error('[DODAWANIE WP] Nieprawidłowa odpowiedź'); }
  if (!uploadData.id) throw new Error(`[DODAWANIE WP] Błąd: ${uploadText.substring(0, 100)}`);

  await fetch(`${baseUrl}/wp-json/wp/v2/media/${uploadData.id}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: titleTxt || altTxt || '', alt_text: altTxt || '' })
  });

  const sizes    = uploadData.media_details?.sizes;
  const largeUrl = sizes?.large?.source_url || sizes?.medium_large?.source_url || uploadData.source_url;
  return { id: uploadData.id, url: largeUrl };
}

// ─── Upload Joomla ────────────────────────────────────────────────────────────

async function uploadToJoomla(imgData, mimeType, altTxt, filename, baseUrl, token) {
  const buffer = Buffer.from(imgData, 'base64');
  const ext    = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  const fname  = `${filename}.${ext}`;

  // Joomla Media API – upload przez /api/index.php/v1/media/files
  // Wymaga multipart/form-data
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const res  = await fetch(`${baseUrl}/api/index.php/v1/media/files`, {
    method: 'POST',
    headers: {
      'X-Joomla-Token': token,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`[DODAWANIE JOOMLA] Błąd: ${text.substring(0, 200)}`); }
  if (data.errors) throw new Error(data.errors.map(e => e.title || e.detail).join(', '));

  // Joomla zwraca URL względny do katalogu media
  const fileUrl = data.data?.attributes?.url || `${baseUrl}/images/${fname}`;
  return { id: fname, url: fileUrl };
}

// ─── Upload Drupal ────────────────────────────────────────────────────────────

async function uploadToDrupal(imgData, mimeType, altTxt, filename, baseUrl, login, pass) {
  const creds  = Buffer.from(`${login}:${pass}`).toString('base64');
  const buffer = Buffer.from(imgData, 'base64');
  const ext    = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  const fname  = `${filename}.${ext}`;

  // Krok 1: upload pliku przez JSON:API file upload endpoint
  const fileRes  = await fetch(`${baseUrl}/jsonapi/node/article/field_image`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `file; filename="${fname}"`,
      'Accept': 'application/vnd.api+json'
    },
    body: buffer
  });
  const fileText = await fileRes.text();
  let fileData;
  try { fileData = JSON.parse(fileText); } catch { throw new Error(`[DODAWANIE DRUPAL] Błąd pliku: ${fileText.substring(0, 200)}`); }
  if (fileData.errors) throw new Error(fileData.errors.map(e => e.title || e.detail).join(', '));

  const fileId  = fileData.data?.id;
  const fileUrl = fileData.data?.attributes?.uri?.url
    ? `${baseUrl}${fileData.data.attributes.uri.url}`
    : null;

  return { id: fileId, url: fileUrl };
}

// ─── Handler główny ───────────────────────────────────────────────────────────

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
    const prompt     = body.prompt1   || '';
    const prompt2    = body.prompt2   || '';
    const post_id    = body.post_id   || null;
    const site_url   = body.site_url  || '';
    const site_login = body.site_login || '';
    const site_pass  = body.site_pass  || '';
    const alt_text   = body.alt1      || '';
    const alt_text2  = body.alt2      || '';
    const img_title  = body.img_title || '';
    const image_num  = body.image_num || 1;

    const GEMINI_KEY  = process.env.GEMINI_API_KEY;
    const TINYPNG_KEY = process.env.TINYPNG_API_KEY;
    if (!GEMINI_KEY) throw new Error('Brak klucza GEMINI_API_KEY');

    const baseUrl = site_url.replace(/\/$/, '');

    // ── Zdjęcie 1 (featured / wyróżnione) ────────────────
    if (image_num === 1) {
      const img1        = await generateImage(prompt, GEMINI_KEY);
      const compressed1 = await compressImage(img1.data, img1.mimeType, TINYPNG_KEY);
      let   media1      = null;

      if (cms === 'wordpress') {
        media1 = await uploadToWordPress(compressed1.data, compressed1.mimeType, alt_text, img_title, 'featured', baseUrl, site_login, site_pass);
        // Ustaw jako featured image
        if (media1?.id && post_id) {
          const creds = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
          await fetch(`${baseUrl}/wp-json/wp/v2/posts/${post_id}`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ featured_media: media1.id })
          });
        }

      } else if (cms === 'joomla') {
        media1 = await uploadToJoomla(compressed1.data, compressed1.mimeType, alt_text, 'featured', baseUrl, site_pass);
        // Joomla: wstaw img do treści artykułu (intro image przez PATCH)
        if (media1?.url && post_id) {
          await fetch(`${baseUrl}/api/index.php/v1/content/articles/${post_id}`, {
            method: 'PATCH',
            headers: { 'X-Joomla-Token': site_pass, 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: { image_intro: media1.url, image_intro_alt: alt_text, image_fulltext: media1.url, image_fulltext_alt: alt_text } })
          });
        }

      } else if (cms === 'drupal') {
        media1 = await uploadToDrupal(compressed1.data, compressed1.mimeType, alt_text, 'featured', baseUrl, site_login, site_pass);
        // Drupal: przypisz plik do node przez PATCH
        if (media1?.id && post_id) {
          const creds = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
          await fetch(`${baseUrl}/jsonapi/node/article/${post_id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/vnd.api+json', 'Accept': 'application/vnd.api+json' },
            body: JSON.stringify({
              data: {
                type: 'node--article',
                id: post_id,
                relationships: {
                  field_image: { data: { type: 'file--file', id: media1.id, meta: { alt: alt_text, title: img_title } } }
                }
              }
            })
          });
        }
      }

      return res.status(200).json({ success: true, media_id: media1?.id, image_url: media1?.url, compressed: compressed1.compressed });
    }

    // ── Zdjęcie 2 (śródtekstowe) ──────────────────────────
    const promptToUse = prompt2 || prompt;
    const img2        = await generateImage(promptToUse, GEMINI_KEY);
    const compressed2 = await compressImage(img2.data, img2.mimeType, TINYPNG_KEY);
    let   media2      = null;

    if (cms === 'wordpress') {
      media2 = await uploadToWordPress(compressed2.data, compressed2.mimeType, alt_text2 || alt_text, img_title, 'srodtekstowe', baseUrl, site_login, site_pass);
      // Wstaw śródtekstowo w połowie artykułu
      if (media2?.url && post_id) {
        const creds   = Buffer.from(`${site_login}:${site_pass}`).toString('base64');
        const auth    = { 'Authorization': `Basic ${creds}` };
        const postRes = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${post_id}?context=edit`, { headers: auth });
        const postData = await postRes.json();
        let currentContent = postData.content?.raw || '';
        if (currentContent) {
          const closingTags = [...currentContent.matchAll(/<\/(p|h[2-6]|ul|ol)>/gi)];
          const midTag      = closingTags[Math.floor(closingTags.length / 2)];
          const insertPos   = midTag ? midTag.index + midTag[0].length : Math.floor(currentContent.length / 2);
          const imgHtml     = `\n\n<figure class="wp-block-image size-large"><img src="${media2.url}" alt="${alt_text2 || alt_text}" /></figure>\n\n`;
          currentContent    = currentContent.substring(0, insertPos) + imgHtml + currentContent.substring(insertPos);
          await fetch(`${baseUrl}/wp-json/wp/v2/posts/${post_id}`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: currentContent })
          });
        }
      }

    } else if (cms === 'joomla') {
      media2 = await uploadToJoomla(compressed2.data, compressed2.mimeType, alt_text2 || alt_text, 'srodtekstowe', baseUrl, site_pass);

    } else if (cms === 'drupal') {
      media2 = await uploadToDrupal(compressed2.data, compressed2.mimeType, alt_text2 || alt_text, 'srodtekstowe', baseUrl, site_login, site_pass);
    }

    return res.status(200).json({ success: true, media_id: media2?.id, image_url: media2?.url, compressed: compressed2.compressed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
