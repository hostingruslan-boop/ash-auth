const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const SITE_URL = process.env.SITE_URL; // адрес вашего сайта, без / на конце

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();

// Открывает игроку страницу входа Steam
app.get('/steamAuth', (req, res) => {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': process.env.RENDER_EXTERNAL_URL + '/steamCallback',
    'openid.realm': process.env.RENDER_EXTERNAL_URL,
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

app.listen(process.env.PORT || 3000);
