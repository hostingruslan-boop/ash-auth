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
app.use(express.json());

// Пускаем запросы только с нашего сайта (иначе браузер блокирует их как чужие)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (['https://ash-clans.web.app', 'https://ash-clans.firebaseapp.com'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
            body: m.type === 'voice' ? '🔊 Голосовое сообщение' : (m.text || '').slice(0, 200),
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

// ---------- Операции через админ-ключ (мимо правил базы) ----------

const SANE_UID = /^steam_\d{17}$/;

// Регистрация токена уведомлений
app.post('/fcm', async (req, res) => {
  try {
    const me = await admin.auth().verifyIdToken(String(req.body.idToken || ''));
    const uid = me.uid;
    if (!SANE_UID.test(uid)) throw new Error('bad uid');
    const fcm = String(req.body.fcm || '');
    if (!fcm || fcm.length > 250) throw new Error('bad fcm token');
    await db.doc('users/' + uid).set(
      { fcmTokens: { [fcm]: Date.now() } },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('fcm error:', e.message);
    res.status(400).json({ error: 'не удалось сохранить токен' });
  }
});

// Исключение участника клана
app.post('/kick', async (req, res) => {
  try {
    const me = await admin.auth().verifyIdToken(String(req.body.idToken || ''));
    const uid = me.uid;
    const targetUid = String(req.body.targetUid || '');
    if (!SANE_UID.test(targetUid)) throw new Error('bad target');
    if (targetUid === uid) throw new Error('себя не исключить');

    const meDoc = (await db.doc('users/' + uid).get()).data() || {};
    const clanId = meDoc.clanId;
    if (!clanId) throw new Error('вы не в клане');
    const clanRef = db.doc('clans/' + clanId);
    const clanDoc = (await clanRef.get()).data() || {};
    const meMember = (await clanRef.collection('members').doc(uid).get()).data() || {};
    const isOwner = clanDoc.ownerId === uid || meMember.role === 'owner';
    const allowed = isOwner || (meMember.permissions || []).includes('kick_members');
    if (!allowed) throw new Error('нет права на исключение');

    const targetDoc = await clanRef.collection('members').doc(targetUid).get();
    if (!targetDoc.exists) throw new Error('участник не найден');
    const tData = targetDoc.data() || {};
    if ((tData.role || '') === 'owner') throw new Error('главу исключить нельзя');

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(clanRef);
      const count = Math.max(((snap.data() || {}).membersCount || 1) - 1, 0);
      tx.delete(clanRef.collection('members').doc(targetUid));
      tx.update(clanRef, { membersCount: count });
      tx.update(db.doc('users/' + targetUid), { clanId: null, role: null, permissions: [] });
      tx.set(clanRef.collection('logs').doc(), {
        text: (tData.nickname || targetUid) + ' исключён из клана',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    console.log('kick ok:', targetUid, 'из', clanId, 'кем', uid);
    res.json({ ok: true });
  } catch (e) {
    console.error('kick error:', e.message);
    res.status(400).json({ error: e.message || 'не удалось исключить' });
  }
});

app.listen(process.env.PORT || 3000);
