// api/proofread.js – Vercel Serverless Function

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
    const body           = req.body;
    const article        = body.article || '';
    const keywords       = body.keywords || '';
    const api_provider_raw = body.api_provider || 'gemini';
    const api_provider   = api_provider_raw === 'claude_haiku' ? 'claude' : api_provider_raw;
    const api_model      = api_provider_raw === 'claude_haiku' ? 'claude-haiku-4-5-20251001' : (body.api_model || '');

    if (!article.trim()) throw new Error('Brak artykułu');

    const maxTokens = Math.min(Math.ceil(article.length / 2) + 500, 8192);

    const keywordsClean = keywords.split(',').map(k => k.replace(/x\d+$/i, '').trim()).filter(Boolean).join(', ');
    const keywordsRule  = keywordsClean
      ? `\nCHRONIONE FRAZY KLUCZOWE – nie zmieniaj ich rdzenia (mogą być odmieniane, ale słowa kluczowe muszą pozostać): ${keywordsClean}`
      : '';

    const systemPrompt = `Jesteś korektorem języka polskiego. Wykonujesz WYŁĄCZNIE korektę językową tekstu HTML.

ZAKRES KOREKTY – poprawiaj TYLKO:
- Błędy ortograficzne (literówki, błędna pisownia)
- Błędy gramatyczne (błędne formy, odmiana)
- Błędy interpunkcyjne (przecinki, kropki)
- Rażące niezręczności stylistyczne (powtórzenie tego samego słowa 2x w jednym zdaniu)

ABSOLUTNIE ZAKAZANE:
- Dodawanie nowych zdań lub informacji
- Usuwanie istniejących zdań
- Zmiana treści merytorycznej
- Zmiana tagów HTML, atrybutów, linków
- Zmiana lub usuwanie atrybutów href, rel="nofollow", class
- Zmiana anchor textów w linkach
- Skracanie akapitów
- Przepisywanie zdań (chyba że zawierają błąd gramatyczny)

FORMAT: Zwróć WYŁĄCZNIE poprawiony HTML. Zero komentarzy, zero wyjaśnień.${keywordsRule}`;

    let result = '';

    if (api_provider === 'gemini') {
      const model = api_model || 'gemini-2.5-flash';
      const data = await withRetry(() =>
        fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: `Wykonaj korektę językową. Zwróć TYLKO HTML:\n\n${article}` }] }],
            generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } }
          })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Gemini: ${data.error.message}`);
      result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } else if (api_provider === 'openai') {
      const model = api_model || 'gpt-4o-mini';
      const data = await withRetry(() =>
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Wykonaj korektę. Zwróć TYLKO HTML:\n\n${article}` }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
      result = data.choices?.[0]?.message?.content || '';

    } else {
      const model = api_model || 'claude-sonnet-4-6';
      const data = await withRetry(() =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: `Wykonaj korektę. Zwróć TYLKO HTML:\n\n${article}` }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Claude: ${data.error.message}`);
      result = (data.content || []).map(b => b.text || '').join('').trim();
    }

    result = result.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const firstTag = result.indexOf('<');
    if (firstTag > 0 && firstTag < 300) result = result.substring(firstTag);

    const originalTags = (article.match(/<\/[a-z0-9]+>/gi) || []).length;
    const resultTags   = (result.match(/<\/[a-z0-9]+>/gi) || []).length;
    const lengthRatio  = result.length / article.length;
    const tagsRatio    = originalTags > 0 ? resultTags / originalTags : 1;
    const isComplete   = lengthRatio >= 0.85 && tagsRatio >= 0.90;

    if (!isComplete) {
      return res.status(200).json({ result: article, skipped: true, reason: `Korekta niekompletna (${Math.round(lengthRatio*100)}% długości, ${Math.round(tagsRatio*100)}% tagów)` });
    }

    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
