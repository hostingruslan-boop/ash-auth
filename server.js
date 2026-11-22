const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const SITE_URL = process.env.SITE_URL; // адрес сайта (ash-clans.web.app), без слэша на конце
// RENDER_EXTERNAL_URL Render подставляет сам — вручную добавлять не нужно.
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

if (!STEAM_API_KEY || !SITE_URL || !RENDER_URL) {
  console.error('Нет переменных окружения: STEAM_API_KEY, SITE_URL, RENDER_EXTERNAL_URL');
}

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();

// Пульс: cron-job.org ходит сюда каждые 10 минут, чтобы бесплатный Render не засыпал
app.get('/', (req, res) => res.send('Ash auth server alive'));

// Открывает игроку страницу входа Steam
app.get('/steamAuth', (req, res) => {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': RENDER_URL + '/steamCallback',
    'openid.realm': RENDER_URL,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect('https://steamcommunity.com/openid/login?' + params.toString());
});

// Steam вернул игрока — проверяем подлинность и выдаём токен
app.get('/steamCallback', async (req, res) => {
  try {
    const verifyData = new URLSearchParams({ ...req.query, 'openid.mode': 'check_authentication' });
    const verify = await axios.post(
      'https://steamcommunity.com/openid/login',
      verifyData.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!/is_valid\s*:\s*true/.test(verify.data)) return res.redirect(SITE_URL + '/#error=invalid');

    const m = String(req.query['openid.claimed_id'] || '').match(/(\d{17})/);
    if (!m) return res.redirect(SITE_URL + '/#error=invalid');
    const steamId = m[1];

    const resp = await axios.get(
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/',
      { params: { key: STEAM_API_KEY, steamids: steamId } }
    );
    const p = (resp.data.response.players || [])[0] || {};

    const uid = 'steam_' + steamId;
    await db.doc('users/' + uid).set({
      steamId,
      nickname: p.personaname || ('Игрок ' + steamId.slice(-4)),
      avatar: p.avatarmedium || '',
      profileUrl: p.profileurl || '',
    }, { merge: true });

    const token = await admin.auth().createCustomToken(uid);
    return res.redirect(SITE_URL + '/#token=' + encodeURIComponent(token));
  } catch (e) {
    console.error('steamCallback error:', e);
    return res.redirect(SITE_URL + '/#error=server');
  }
});

// ---------- Push-уведомления о новых сообщениях ----------
const messaging = admin.messaging();
const pushState = db.doc('pushState/main');

let lastPushMs = 0;
let seen = new Set();

(async () => {
  try {
    const snap = await pushState.get();
    lastPushMs = (snap.exists() && snap.data().lastPushMs) || 0;
  } catch (e) {
    console.error('pushState read:', e.message);
  }

  db.collectionGroup('messages').orderBy('createdAt', 'desc').limit(30).onSnapshot(async (snap) => {
    for (const ch of snap.docChanges()) {
      if (ch.type !== 'added') continue;
      const id = ch.doc.id;
      const m = ch.doc.data();
      const created = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().getTime() : 0;
      if (!created || created <= lastPushMs || seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 800) seen = new Set(Array.from(seen).slice(-300));
      lastPushMs = created;
      pushState.set({ lastPushMs }).catch(() => {});
      try {
        const clanRef = ch.doc.ref.parent.parent;
        if (!clanRef) continue;
        const clanDoc = await clanRef.get();
        const tag = (clanDoc.data() || {}).tag || '';
        const members = await clanRef.collection('members').get();
        const tokens = [];
        for (const mm of members.docs) {
          if (mm.id === m.senderId) continue; // автору своё сообщение не прилетает
          const u = await db.doc('users/' + mm.id).get();
          const t = u.exists && u.data().fcmTokens ? Object.keys(u.data().fcmTokens) : [];
          tokens.push(...t);
        }
        if (!tokens.length) continue;
        await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: (tag ? '[' + tag + '] ' : '') + (m.senderName || 'Клан'),
            body: String(m.text || '').slice(0, 200),
          },
          webpush: { fcmOptions: { link: SITE_URL } },
        });
        console.log('push sent to', tokens.length, 'device(s)');
      } catch (e) {
        console.error('push error:', e.message);
      }
    }
  });
})();

app.listen(process.env.PORT || 3000);
