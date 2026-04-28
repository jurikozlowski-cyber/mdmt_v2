// api/sheets.js – pobiera dane z publicznego arkusza Google Sheets

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Brak klucza GOOGLE_SHEETS_API_KEY w zmiennych środowiskowych.' });

  try {
    const { sheet_url, sheet_name } = req.body;
    if (!sheet_url) return res.status(400).json({ error: 'Podaj URL arkusza Google Sheets.' });

    // Wyciągnij Spreadsheet ID z różnych formatów URL
    let spreadsheetId = '';
    const patterns = [
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
      /^([a-zA-Z0-9-_]{20,})$/
    ];
    for (const p of patterns) {
      const m = sheet_url.match(p);
      if (m) { spreadsheetId = m[1]; break; }
    }
    if (!spreadsheetId) return res.status(400).json({ error: 'Nie można wyciągnąć ID arkusza z podanego URL. Upewnij się że wklejasz pełny link do arkusza Google Sheets.' });

    // Pobierz nazwy arkuszy jeśli nie podano
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${API_KEY}&fields=sheets.properties.title`;
    const metaRes = await fetch(metaUrl);
    const metaData = await metaRes.json();

    if (metaData.error) {
      const code = metaData.error.code;
      if (code === 403) return res.status(403).json({ error: 'Brak dostępu do arkusza. Upewnij się że arkusz jest udostępniony jako "Każdy z linkiem może wyświetlać".' });
      if (code === 404) return res.status(404).json({ error: 'Arkusz nie istnieje lub ID jest nieprawidłowe.' });
      return res.status(400).json({ error: `Google Sheets API: ${metaData.error.message}` });
    }

    const sheets = metaData.sheets?.map(s => s.properties.title) || [];
    if (!sheets.length) return res.status(400).json({ error: 'Arkusz jest pusty – brak zakładek.' });

    // Użyj podanej nazwy zakładki lub pierwszej
    const targetSheet = sheet_name || sheets[0];

    // Pobierz dane z arkusza
    const range = encodeURIComponent(`${targetSheet}!A1:Z1000`);
    const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?key=${API_KEY}`;
    const dataRes = await fetch(dataUrl);
    const sheetData = await dataRes.json();

    if (sheetData.error) return res.status(400).json({ error: `Błąd pobierania danych: ${sheetData.error.message}` });

    const rows = sheetData.values || [];
    if (rows.length < 2) return res.status(400).json({ error: 'Arkusz zawiera tylko nagłówek lub jest pusty.' });

    // Parsuj nagłówek (pierwszy wiersz)
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const col = name => headers.indexOf(name);

    // Sprawdź wymagane kolumny
    if (col('topic') === -1 && col('temat') === -1) {
      return res.status(400).json({
        error: 'Brak kolumny "topic" lub "temat" w pierwszym wierszu arkusza.',
        available_columns: headers,
        sheets_available: sheets
      });
    }

    // Mapowanie polskich nazw kolumn na angielskie
    const colMap = {
      topic:        col('topic') > -1       ? col('topic')        : col('temat'),
      keywords:     col('keywords') > -1    ? col('keywords')     : col('frazy'),
      site_name:    col('site_name') > -1   ? col('site_name')    : col('blog'),
      length:       col('length') > -1      ? col('length')       : col('długość'),
      tone:         col('tone') > -1        ? col('tone')         : col('styl'),
      scheduled_at: col('scheduled_at') > -1? col('scheduled_at') : col('data'),
      img1_prompt:  col('img1_prompt') > -1 ? col('img1_prompt')  : col('zdjecie'),
      audience:     col('audience') > -1    ? col('audience')     : col('odbiorcy'),
      extra_info:   col('extra_info') > -1  ? col('extra_info')   : col('wytyczne'),
    };

    // Parsuj wiersze danych
    const records = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.length || row.every(c => !c.trim())) continue;
      const get = idx => (idx > -1 && idx < row.length) ? (row[idx] || '').trim() : '';
      const topic = get(colMap.topic);
      if (!topic) continue;
      records.push({
        topic,
        keywords:     get(colMap.keywords),
        site_name:    get(colMap.site_name),
        length:       get(colMap.length)   || '4000',
        tone:         get(colMap.tone)     || 'przyjazny i naturalny',
        scheduled_at: get(colMap.scheduled_at),
        img1_prompt:  get(colMap.img1_prompt),
        audience:     get(colMap.audience),
        extra_info:   get(colMap.extra_info),
      });
    }

    return res.status(200).json({
      records,
      sheets_available: sheets,
      used_sheet: targetSheet,
      headers_found: headers,
      total: records.length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
