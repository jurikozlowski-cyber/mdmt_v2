// api/seo.js – Vercel Serverless Function

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
    const body             = req.body;
    const article          = body.article || '';
    const main_keyword     = body.main_keyword || '';
    const topic            = body.topic || '';
    const site_name        = body.site_name || '';
    const api_provider_raw = body.api_provider || 'gemini';
    const api_provider     = api_provider_raw === 'claude_haiku' ? 'claude' : api_provider_raw;
    const api_model        = api_provider_raw === 'claude_haiku' ? 'claude-haiku-4-5-20251001' : (body.api_model || '');

    const shortArticle = article.substring(0, 2000);
    const systemPrompt = 'Jesteś ekspertem SEO. Odpowiadaj WYŁĄCZNIE w formacie JSON, bez komentarzy, bez markdown.';
    const siteNamePart = site_name ? ` | ${site_name}` : '';
    const maxTitleLen  = site_name ? (55 - siteNamePart.length) : 55;
    const userPrompt   = `Przygotuj meta dane SEO.\nTemat: ${topic}\nFraza kluczowa: ${main_keyword}\nNazwa witryny: ${site_name || 'brak'}\nFragment artykułu: ${shortArticle}\n\nOdpowiedz TYLKO tym JSON (bez żadnego tekstu poza JSON):\n{"meta_title":"max ${maxTitleLen} znaków z frazą kluczową (BEZ nazwy witryny)","meta_description":"max 155 znaków – konkretny opis zachęcający do kliknięcia, zawiera frazę kluczową","seo_notes":"1 zdanie oceny SEO"}`;

    let raw = '';

    if (api_provider === 'gemini') {
      const model = api_model || 'gemini-2.5-flash';
      const data = await withRetry(() =>
        fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { maxOutputTokens: 600, responseMimeType: 'application/json' }
          })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Gemini: ${data.error.message}`);
      raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } else if (api_provider === 'openai') {
      const model = api_model || 'gpt-4o-mini';
      const data = await withRetry(() =>
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
      raw = data.choices?.[0]?.message?.content || '';

    } else {
      const model = api_model || 'claude-sonnet-4-6';
      const data = await withRetry(() =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Claude: ${data.error.message}`);
      raw = (data.content || []).map(b => b.text || '').join('\n').trim();
    }

    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch {
      // Fallback – wyciągnij JSON z tekstu jeśli model dodał komentarz
      const m = raw.match(/\{[^{}]*"meta_title"[^{}]*\}/);
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
      if (!parsed) {
        parsed = {
          meta_title: topic.substring(0, 55),
          meta_description: `${topic} – ${main_keyword}. Przeczytaj nasz artykuł i dowiedz się więcej.`.substring(0, 155),
          seo_notes: 'Meta dane wygenerowane automatycznie.'
        };
      }
    }
    // Dodaj nazwę witryny do meta_title
    if (site_name && parsed.meta_title) {
      const suffix = ` | ${site_name}`;
      const maxLen = 55;
      parsed.meta_title = parsed.meta_title.substring(0, maxLen).trim() + suffix;
    } else if (parsed.meta_title) {
      parsed.meta_title = parsed.meta_title.substring(0, 60).trim();
    }
    if (parsed.meta_description) {
      parsed.meta_description = parsed.meta_description.substring(0, 155).trim();
    }
    parsed.corrected_article = article;
    return res.status(200).json({ result: parsed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
