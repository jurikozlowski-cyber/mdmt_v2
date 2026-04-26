// api/write.js – Vercel Serverless Function

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
    const body = req.body;

    const topic            = body.topic || '';
    const length           = parseInt(body.length) || 3500;
    const tone             = body.tone || 'przyjazny';
    const audience         = body.audience || '';
    const keywords         = body.keywords || '';
    const link_pairs       = body.link_pairs || '';
    const extra_info       = body.extra_info || '';
    const research         = (body.research || '').substring(0, 1200);
    const masterprompt     = body.masterprompt || '';
    const api_provider_raw = body.api_provider || 'gemini';
    const api_provider     = api_provider_raw === 'claude_haiku' ? 'claude' : api_provider_raw;
    const api_model        = api_provider_raw === 'claude_haiku' ? 'claude-haiku-4-5-20251001' : (body.api_model || '');

    const maxTokensGemini = Math.min(Math.ceil((length / 3.0) * 1.25) + 300, 8192);
    const maxTokensClaude = 4096;

    let linksInstruction = 'brak';
    if (link_pairs.trim()) {
      const pairs = link_pairs.split('\n')
        .map(l => l.trim()).filter(l => l.includes('|'))
        .map(l => {
          const idx = l.indexOf('|');
          const anchor = l.substring(0, idx).trim();
          const rest = l.substring(idx + 1).trim();
          const urlParts = rest.split('|').map(s => s.trim());
          const url = urlParts[0];
          const nofollow = urlParts[1]?.toLowerCase() === 'nofollow';
          return { anchor, url, nofollow };
        }).filter(p => p.anchor && p.url);
      if (pairs.length > 0) {
        linksInstruction = pairs.map(p => {
          const rel = p.nofollow ? ' rel="nofollow"' : '';
          return `<a href="${p.url}"${rel}>${p.anchor}</a>`;
        }).join(', ');
      }
    }

    const DEFAULT_SYSTEM = `Jesteś copywriterem SEO. Pisz naturalnie po polsku, bez manier typowych dla AI.
Używaj aktywnej formy czasownika. Mieszaj zdania krótkie z długimi.
NIE używaj H1. Zacznij od leadu (3-6 zdań bez nagłówka), potem H2.
Nigdy nie stawiaj nagłówka bezpośrednio pod innym nagłówkiem – między nimi zawsze akapit.
Przy długich sekcjach H2 (powyżej 3 akapitów) rozważ dodanie nagłówków H3 jako podsekcji – poprawiają czytelność i strukturę SEO.
Akapity 5-10 zdań. Nagłówki: tylko pierwsza litera wielka.
Nie bolduj fraz kluczowych. Bold tylko dla ważnych danych lub liczb.
Zakaz słów: kluczowy, istotny, idealny, doskonały, rewolucyjny, przełomowy, warto zaznaczyć, warto podkreślić, w dzisiejszych czasach, w dobie, bez wątpienia, należy pamiętać, podsumowanie.
PRIORYTET: Pierwsza fraza kluczowa z listy MUSI pojawić się w pierwszym lub drugim zdaniu artykułu.
Frazy kluczowe MUSZĄ pojawić się w tekście i w nagłówkach H2/H3. Jeśli przy frazie jest liczba (np. x3), użyj jej minimum tyle razy. Odmieniaj przez przypadki tak żeby brzmiały naturalnie, ale nigdy nie pomijaj frazy całkowicie.`;

    const systemPrompt = masterprompt || DEFAULT_SYSTEM;
    const targetWords = Math.round(length / 6);

    const userPrompt = `Napisz artykuł SEO w HTML. Długość: dokładnie ${length} znaków ze spacjami (około ${targetWords} słów). Napisz dokładnie tyle – nie więcej i nie mniej. Zakończ ostatni akapit zdaniem CTA.

Temat: "${topic}"
Frazy kluczowe: ${keywords}
Styl: ${tone}
Grupa docelowa: ${audience || 'ogólna'}
Linkowanie: ${linksInstruction}
Wytyczne: ${extra_info || 'brak'}
Research: ${research}

Format: tagi HTML (<p>, <h2>, <h3>, <strong>), bez H1, bez html/head/body. Zacznij od <p>.`;

    let result = '';

    if (api_provider === 'gemini') {
      const model = api_model || 'gemini-2.5-flash';
      const geminiPayload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokensGemini,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 }
        }
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
          body: JSON.stringify({ model, max_tokens: maxTokensClaude, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
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
          body: JSON.stringify({ model, max_tokens: maxTokensClaude, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
        }).then(r => r.json())
      );
      if (data.error) throw new Error(`Claude: ${data.error.message}`);
      result = (data.content || []).map(b => b.text || '').join('').trim();

      if (data.stop_reason === 'max_tokens') {
        if (!result.trim().endsWith('>')) {
          const lastClose = Math.max(
            result.lastIndexOf('</p>'),
            result.lastIndexOf('</ul>'),
            result.lastIndexOf('</h2>')
          );
          if (lastClose > 0) {
            result = result.substring(0, lastClose + result.substring(lastClose).indexOf('>') + 1);
          }
        }
      }
    }

    if (!result) throw new Error('Pusta odpowiedź z API');

    result = result.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    result = result.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    result = result.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    result = result.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    const firstTag = result.indexOf('<');
    if (firstTag > 0 && firstTag < 500) result = result.substring(firstTag);

    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
