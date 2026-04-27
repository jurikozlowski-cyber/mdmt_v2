// api/sites.js – CRUD witryn w Supabase

import { createClient } from '@supabase/supabase-js';

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
    // GET – pobierz wszystkie witryny
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('sites')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ sites: data });
    }

    // POST – dodaj witrynę
    if (method === 'POST') {
      const { name, url, cms, login, password, tags, categories, default_status, notes } = req.body;
      if (!name || !url || !password) {
        return res.status(400).json({ error: 'Brak wymaganych pól: name, url, password' });
      }
      const { data, error } = await supabase
        .from('sites')
        .insert([{
          name,
          url: url.replace(/\/$/, ''),
          cms: cms || 'wordpress',
          login: login || '',
          password_enc: password,
          tags: tags || '',
          categories: categories || '',
          default_status: default_status || 'draft',
          notes: notes || ''
        }])
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ site: data });
    }

    // PUT – edytuj witrynę
    if (method === 'PUT') {
      const { id, name, url, cms, login, password, tags, categories, default_status, notes } = req.body;
      if (!id) return res.status(400).json({ error: 'Brak id witryny' });
      const updates = {
        name,
        url: url?.replace(/\/$/, ''),
        cms: cms || 'wordpress',
        login: login || '',
        tags: tags || '',
        categories: categories || '',
        default_status: default_status || 'draft',
        notes: notes || ''
      };
      if (password) updates.password_enc = password;
      const { data, error } = await supabase
        .from('sites')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ site: data });
    }

    // DELETE – usuń witrynę
    if (method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Brak id witryny' });
      const { error } = await supabase.from('sites').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
