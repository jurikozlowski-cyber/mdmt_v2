// api/history.js – zapis i odczyt historii publikacji w Supabase

const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const { method } = req;

  try {
    // GET – pobierz historię (ostatnie 200 wpisów)
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('publications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return res.status(200).json({ publications: data });
    }

    // POST – zapisz wynik publikacji
    if (method === 'POST') {
      const {
        topic,
        keywords,
        site_id,
        site_name,
        site_url,
        cms,
        model_used,
        char_count,
        status,
        post_url,
        post_id,
        error_message,
        duration_ms,
        scheduled_at
      } = req.body;

      if (!topic || !site_name || !status) {
        return res.status(400).json({ error: 'Brak wymaganych pól: topic, site_name, status' });
      }

      const { data, error } = await supabase
        .from('publications')
        .insert([{
          topic,
          keywords: keywords || '',
          site_id: site_id || null,
          site_name,
          site_url: site_url || '',
          cms: cms || 'wordpress',
          model_used: model_used || '',
          char_count: char_count || 0,
          status,
          post_url: post_url || '',
          post_id: post_id ? String(post_id) : '',
          error_message: error_message || '',
          duration_ms: duration_ms || 0,
          scheduled_at: scheduled_at || null
        }])
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json({ publication: data });
    }

    // DELETE – usuń wpis z historii
    if (method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Brak id' });
      const { error } = await supabase.from('publications').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
