// api/sites.js – CRUD witryn w Supabase z szyfrowaniem haseł (pgcrypto)

import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Klucz szyfrowania – ACCESS_PASSWORD jako seed, lub dedykowany ENCRYPT_KEY
function getEncryptKey() {
  return process.env.ENCRYPT_KEY || process.env.ACCESS_PASSWORD || 'mdmt_default_key';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const { method } = req;
  const ENC_KEY = getEncryptKey();

  try {
    // GET – pobierz wszystkie witryny (odszyfruj hasła)
    if (method === 'GET') {
      const { data, error } = await supabase.rpc('get_sites_decrypted', {
        enc_key: ENC_KEY
      });

      // Fallback: jeśli RPC nie istnieje, pobierz bez deszyfrowania
      if (error && error.message?.includes('does not exist')) {
        const { data: raw, error: rawErr } = await supabase
          .from('sites')
          .select('*')
          .order('created_at', { ascending: true });
        if (rawErr) throw rawErr;
        return res.status(200).json({ sites: raw || [] });
      }

      if (error) throw error;
      return res.status(200).json({ sites: data || [] });
    }

    // POST – dodaj witrynę (zaszyfruj hasło)
    if (method === 'POST') {
      const { name, url, cms, login, password, tags, categories, default_status, notes } = req.body;
      if (!name || !url || !password) {
        return res.status(400).json({ error: 'Brak wymaganych pól: name, url, password' });
      }

      // Zaszyfruj hasło przez pgcrypto
      const { data: encData, error: encErr } = await supabase.rpc('encrypt_password', {
        plain_password: password,
        enc_key: ENC_KEY
      });

      const passwordToStore = (encErr || !encData) ? password : encData;

      const { data, error } = await supabase
        .from('sites')
        .insert([{
          name,
          url: url.replace(/\/$/, ''),
          cms: cms || 'wordpress',
          login: login || '',
          password_enc: passwordToStore,
          tags: tags || '',
          categories: categories || '',
          default_status: default_status || 'draft',
          notes: notes || ''
        }])
        .select()
        .single();

      if (error) throw error;

      // Zwróć z odszyfrowanym hasłem (dla UI)
      return res.status(200).json({ site: { ...data, password_enc: password } });
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

      if (password) {
        const { data: encData, error: encErr } = await supabase.rpc('encrypt_password', {
          plain_password: password,
          enc_key: ENC_KEY
        });
        updates.password_enc = (encErr || !encData) ? password : encData;
      }

      const { data, error } = await supabase
        .from('sites')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      // Zwróć z jawnym hasłem jeśli było zmienione
      const returnData = password ? { ...data, password_enc: password } : data;
      return res.status(200).json({ site: returnData });
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
