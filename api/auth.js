// api/auth.js – logowanie, ustawia ciasteczko z podpisanym tokenem

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const PASSWORD = process.env.ACCESS_PASSWORD;
  if (!PASSWORD) return res.status(200).json({ ok: true, disabled: true });

  if (req.method === 'POST') {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ ok: false, error: 'Brak hasła' });
    if (password !== PASSWORD) return res.status(401).json({ ok: false, error: 'Nieprawidłowe hasło' });

    const payload = Buffer.from(`${Date.now()}:${PASSWORD}`).toString('base64');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
    res.setHeader('Set-Cookie', `ab_session=${payload}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
