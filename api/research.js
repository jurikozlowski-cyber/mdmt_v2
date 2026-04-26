// api/research.js – Vercel Serverless Function

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

const DEFAULT_SYSTEM_PROMPT = `Jesteś asystentem do researchu SEO. Zbierasz wyłącznie sprawdzalne informacje – działasz jako filtr oddzielający fakty od spekulacji.

Zasady:
- Podajesz tylko to, co wiesz na pewno. Jeśli brak danych – napisz wprost "Brak danych". Nie szacuj, nie zmyślaj, nie uzupełniaj luk.
- Liczby i statystyki tylko gdy masz co do nich pewność – w przeciwnym razie opisuj zjawisko słowami ("rynek rośnie") zamiast podawać konkretną cyfrę.`;

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
    const topic            = body.topic || '';
    const keywords         = body.keywords || '';
    const audience         = body.audience || '';
    const extra_info       = body.extra_info || '';
    const api_provider_raw = body.api_provider || 'gemini';
    const api_provider     = api_provider_raw === 'claude_haiku' ? 'claude' : api_provider_raw;
    const api_model        = api_provider_raw === 'claude_haiku' ? 'claude-haiku-4-5-20251001' : (body.api_model || '');

    const systemPrompt = body.researchprompt || DEFAULT_SYSTEM_PROMPT;

    const userPrompt = `Temat: "${topic}"
Frazy kluczowe: ${keywords}
Grupa docelowa: ${audience || 'ogólna'}
Wskazówki: ${extra_info || 'brak'}

Napisz 4-6 punktów researchowych. Każdy punkt: 2-3 zdania sprawdzalnych faktów i kontekstu przydatnych do artykułu SEO.`;

    let result = '';

    if (api_provider === 'gemini') {
      const model = api_model || 'gemini-2.5-flash';
      const geminiPayload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 1500 }
      };
      let data;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiPayload) }
        );
        data = await geminiRes.json();
        if (!data.error) break;
        const code = data.error.code || 0;
        if (code !== 429 && code !== 503) break;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
      }
      if (data.error) throw new Error(`Gemini: ${data.error.message}`);
      result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } else if (api_provider === 'openai') {
      const model = api_model || 'gpt-4o-mini';
      const data = await withRetry(() =>
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
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
          body: JSON.stringify({ model, max_tokens: 1500, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Claude: ${data.error.message}`);
      result = (data.content || []).map(b => b.text || '').join('\n').trim();
    }

    if (!result) throw new Error('Pusta odpowiedź');

    result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
    result = result.replace(/\*([^*]+)\*/g, '$1');
    result = result.replace(/^#{1,3} /gm, '');
    result = result.replace(/^```[\s\S]*?```$/gm, '');

    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
