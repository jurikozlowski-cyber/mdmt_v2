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

    const shortArticle = article.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").substring(0, 1000).trim();
    const systemPrompt = 'Jesteś ekspertem SEO. Odpowiadaj WYŁĄCZNIE w formacie JSON, bez komentarzy, bez markdown.';
    const siteNamePart = site_name ? ` | ${site_name}` : '';
    const maxTitleLen  = site_name ? (55 - siteNamePart.length) : 55;
    const userPrompt   = `Przygotuj meta dane SEO. Odpowiedz TYLKO czystym JSON bez żadnego tekstu.

Dane:
- Temat: ${topic}
- Fraza kluczowa: ${main_keyword}
- Fragment artykułu: ${shortArticle}

WYMAGANIA (KRYTYCZNE):
- meta_title: DOKŁADNIE ${maxTitleLen} znaków lub mniej, musi zawierać frazę kluczową, musi być kompletnym zdaniem, BEZ nazwy witryny
- meta_description: DOKŁADNIE 155 znaków lub mniej, zachęca do kliknięcia, zawiera frazę kluczową, musi być kompletnym zdaniem
- seo_notes: 1 krótkie zdanie

{"meta_title":"...","meta_description":"...","seo_notes":"..."}`;

    let raw = '';

    if (api_provider === 'gemini') {
      const model = api_model || 'gemini-2.5-flash';
      const data = await withRetry(() =>
        fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { maxOutputTokens: 1000, responseMimeType: 'application/json' }
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
          body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
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
          body: JSON.stringify({ model, max_tokens: 1000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Claude: ${data.error.message}`);
      raw = (data.content || []).map(b => b.text || '').join('\n').trim();
    }

    console.log('[SEO] raw length:', raw.length);

    let parsed;
    const cleanRaw = raw.replace(/```json|```/g, '').trim();

    // Próba 1: bezpośredni parse
    try { parsed = JSON.parse(cleanRaw); }
    catch(e1) {
      // Próba 2: napraw obcięty JSON – dodaj brakujące cudzysłowy i nawiasy
      let repaired = cleanRaw;
      if (!repaired.endsWith('}')) {
        // Zamknij niezamknięte stringi i obiekt
        const quoteCount = (repaired.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) repaired += '"';
        repaired += '}';
      }
      try { parsed = JSON.parse(repaired); }
      catch {
        // Próba 3: wyciągnij tylko meta_title i meta_description z surowego tekstu
        const titleMatch = raw.match(/"meta_title"\s*:\s*"([^"]{1,60})"/);
        const descMatch  = raw.match(/"meta_description"\s*:\s*"([^"]{1,155})"/);
        if (titleMatch || descMatch) {
          parsed = {
            meta_title:       titleMatch ? titleMatch[1] : topic.substring(0, 55),
            meta_description: descMatch  ? descMatch[1]  : `${topic} – ${main_keyword}.`.substring(0, 155),
            seo_notes: ''
          };
        } else {
          console.error('[SEO] all parse attempts failed | raw:', raw.substring(0, 200));
          parsed = {
            meta_title: topic.substring(0, 55),
            meta_description: `${topic} – ${main_keyword}. Przeczytaj nasz artykuł i dowiedz się więcej.`.substring(0, 155),
            seo_notes: 'Meta dane wygenerowane automatycznie.'
          };
        }
      }
    }
    // Funkcja inteligentnego obcinania – nie tnie w połowie słowa
    function smartTrim(str, maxLen) {
      if (!str) return '';
      str = str.trim();
      if (str.length <= maxLen) return str;
      const cut = str.lastIndexOf(' ', maxLen);
      return cut > 0 ? str.substring(0, cut).trim() : str.substring(0, maxLen).trim();
    }

    // Dodaj nazwę witryny do meta_title
    if (site_name && parsed.meta_title) {
      const suffix   = ` | ${site_name}`;
      const maxTitle = 60 - suffix.length;
      parsed.meta_title = smartTrim(parsed.meta_title, maxTitle) + suffix;
    } else if (parsed.meta_title) {
      parsed.meta_title = smartTrim(parsed.meta_title, 60);
    }
    if (parsed.meta_description) {
      parsed.meta_description = smartTrim(parsed.meta_description, 155);
    }
    parsed.corrected_article = article;
    return res.status(200).json({ result: parsed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
