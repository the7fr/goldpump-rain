import http from 'http';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PORT = Number(process.env.PORT) || 8080;
const TWOCAPTCHA_KEY = (process.env.TWOCAPTCHA_KEY || '').trim();
const SITEKEY = (process.env.TURNSTILE_SITEKEY || '0x4AAAAAACLmkLF8v68bkhrE').trim();
const PROXY_TYPE = (process.env.PROXY_TYPE || 'HTTP').trim().toUpperCase();
const PROXY_HOST = (process.env.PROXY_HOST || 'na.proxy.2captcha.com').trim();
const PROXY_PORT = (process.env.PROXY_PORT || '2334').trim();
const PROXY_LOGIN = (process.env.PROXY_LOGIN || '').trim();
const PROXY_PASSWORD = (process.env.PROXY_PASSWORD || '').trim();
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN);
const JOIN_UNTIL = 100;
const WAGER_FROM = 125;
const WAGER_TO = 175;

function loadAccounts() {
  try {
    const raw = process.env.ACCOUNTS_JSON || '[]';
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((a) => ({
        sid: String(a.sid || '').trim(),
        username: String(a.username || '').slice(0, 64),
        autoJoin: !!a.autoJoin,
        autoWager: !!a.autoWager,
        useProxy: !!a.useProxy,
        safeWager: !!a.safeWager,
        game: a.game === 'dice' ? 'dice' : 'limbo',
        limboMulti: Number(a.limboMulti) || 2,
        diceChance: Number(a.diceChance) || 50,
        diceRollType: ['under', 'random'].includes(String(a.diceRollType || '').toLowerCase())
          ? String(a.diceRollType).toLowerCase()
          : 'over',
        safeThreshold: Math.floor(Number(a.safeThreshold) || 50),
      }))
      .filter((a) => a.sid.length >= 15);
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args) {
  const t = new Date().toISOString();
  console.log(`[${t}]`, ...args);
}

function localNow() {
  const off = Number.isFinite(TZ_OFFSET_MIN) ? TZ_OFFSET_MIN : 240;
  return new Date(Date.now() - off * 60 * 1000);
}

function cycleInfo() {
  const d = localNow();
  const m = d.getUTCMinutes();
  const sec = d.getUTCSeconds();
  const slot = m < 30 ? 0 : 30;
  const secsInto = (m - slot) * 60 + sec;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const sm = String(slot).padStart(2, '0');
  return { secsInto, key: `${y}-${mo}-${day} ${h}:${sm}` };
}

function proxyAgent() {
  if (!PROXY_HOST || !PROXY_PORT) return null;
  const auth =
    PROXY_LOGIN && PROXY_PASSWORD
      ? `${encodeURIComponent(PROXY_LOGIN)}:${encodeURIComponent(PROXY_PASSWORD)}@`
      : '';
  const url = `http://${auth}${PROXY_HOST}:${PROXY_PORT}`;
  return new HttpsProxyAgent(url);
}

function gpHeaders(sid, json) {
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-anti-csrf': 'true',
    Cookie: 'SID=' + sid,
    Origin: 'https://goldpump.com',
    Referer: 'https://goldpump.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  if (json) h['Content-Type'] = 'application/json';
  else h['Content-Type'] = 'application/x-www-form-urlencoded';
  return h;
}

async function gpFetch(url, { sid, method = 'POST', body, json = false, useProxy = false } = {}) {
  const opts = {
    method,
    headers: gpHeaders(sid, json),
    body: body === undefined ? (json ? '{}' : '') : body,
  };
  if (useProxy) {
    const agent = proxyAgent();
    if (agent) opts.agent = agent;
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { res, text, data };
}

async function solveTurnstile(useProxy) {
  if (!TWOCAPTCHA_KEY) throw new Error('TWOCAPTCHA_KEY missing');
  let createUrl =
    'https://2captcha.com/in.php?key=' +
    encodeURIComponent(TWOCAPTCHA_KEY) +
    '&method=turnstile&sitekey=' +
    encodeURIComponent(SITEKEY) +
    '&pageurl=' +
    encodeURIComponent('https://goldpump.com/') +
    '&json=1';
  if (useProxy && PROXY_HOST && PROXY_PORT) {
    const proxyStr =
      PROXY_LOGIN && PROXY_PASSWORD
        ? `${PROXY_LOGIN}:${PROXY_PASSWORD}@${PROXY_HOST}:${PROXY_PORT}`
        : `${PROXY_HOST}:${PROXY_PORT}`;
    createUrl +=
      '&proxytype=' +
      encodeURIComponent(PROXY_TYPE || 'HTTP') +
      '&proxy=' +
      encodeURIComponent(proxyStr);
  }
  const createRes = await fetch(createUrl);
  const createData = await createRes.json();
  if (createData.status !== 1) {
    throw new Error('2captcha create: ' + (createData.request || JSON.stringify(createData)));
  }
  const taskId = createData.request;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const pollUrl =
      'https://2captcha.com/res.php?key=' +
      encodeURIComponent(TWOCAPTCHA_KEY) +
      '&action=get&id=' +
      encodeURIComponent(taskId) +
      '&json=1';
    const pollRes = await fetch(pollUrl);
    const pollData = await pollRes.json();
    if (pollData.status === 1 && pollData.request) return pollData.request;
    if (pollData.request && pollData.request !== 'CAPCHA_NOT_READY') {
      throw new Error('2captcha: ' + pollData.request);
    }
  }
  throw new Error('2captcha timeout');
}

async function getBalance(sid) {
  const { res, data } = await gpFetch('https://api.goldpump.com/api/account/login-auto', {
    sid,
    body: '',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!data || !data.authenticated || !data.document) throw new Error('Not authenticated');
  const doc = data.document;
  let bal = null;
  if (doc.balances?.sweeps?.balance != null) bal = doc.balances.sweeps.balance;
  else if (doc.balances?.SC != null) bal = doc.balances.SC;
  else if (doc.balance != null) bal = doc.balance;
  else if (doc.tokenBalance != null) bal = doc.tokenBalance;
  if (bal == null) throw new Error('Balance missing');
  return Math.floor(Number(bal) * 100) / 100;
}

async function rainJoin(sid, useProxy) {
  const token = await solveTurnstile(!!useProxy);
  const url =
    'https://api.goldpump.com/api/rain/rain-join?captchaToken=' + encodeURIComponent(token);
  const { res, data, text } = await gpFetch(url, {
    sid,
    json: true,
    body: '{}',
    useProxy: !!useProxy,
  });
  const errMsg =
    (data && (data.error || data.message || data.msg)) ||
    (data && data.data && (data.data.error || data.data.message)) ||
    '';
  const httpOk = res.status >= 200 && res.status < 300;
  const explicitFail =
    (data && (data.success === false || data.ok === false || data.joined === false)) || !!errMsg;
  const explicitOk = data && (data.success === true || data.ok === true || data.joined === true);
  let ok = false;
  if (httpOk && explicitOk) ok = true;
  else if (httpOk && !explicitFail && !errMsg) ok = true;
  if (ok) return { ok: true, status: res.status, data };
  const already = /already|not eligible/i.test(String(errMsg));
  return {
    ok: already,
    already,
    error: errMsg || 'HTTP ' + res.status,
    status: res.status,
    raw: String(text).slice(0, 300),
  };
}

async function wager(sid, amount, settings) {
  const useSafe = settings.safeWager && amount >= (Number(settings.safeThreshold) || 50);
  if (settings.game === 'dice') {
    const chance = useSafe ? 93 : Number(settings.diceChance) || 50;
    let rollType = String(settings.diceRollType || 'over').toLowerCase();
    if (rollType === 'random') rollType = Math.random() < 0.5 ? 'over' : 'under';
    else if (rollType !== 'under') rollType = 'over';
    const rangeValue = Math.max(
      0.01,
      Math.min(99.99, rollType === 'under' ? chance : 100 - chance)
    );
    const url =
      'https://api.goldpump.com/api/dice/dice-play?betAmount=' +
      encodeURIComponent(amount) +
      '&rangeValue=' +
      encodeURIComponent(rangeValue) +
      '&rollType=' +
      encodeURIComponent(rollType);
    const { res, data } = await gpFetch(url, { sid, json: true, body: '{}' });
    if (res.status === 200 && data && ('won' in data || data.roll != null)) {
      return { ok: true, won: !!data.won, roll: data.roll };
    }
    return { ok: false, error: (data && (data.error || data.message)) || 'HTTP ' + res.status };
  }
  const multi = useSafe ? 1.01 : Number(settings.limboMulti) || 2;
  const url =
    'https://api.goldpump.com/api/limbo/limbo-play?betAmount=' +
    encodeURIComponent(amount) +
    '&multiplier=' +
    encodeURIComponent(multi);
  const { res, data } = await gpFetch(url, { sid, body: '' });
  if (res.status === 200 && data && ('won' in data || data.roll != null)) {
    return { ok: true, won: !!data.won, roll: data.roll };
  }
  return { ok: false, error: (data && (data.error || data.message)) || 'HTTP ' + res.status };
}

const state = new Map();

function getState(sid) {
  if (!state.has(sid)) state.set(sid, {});
  return state.get(sid);
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const accounts = loadAccounts();
    const { secsInto, key } = cycleInfo();
    const joinList = accounts.filter((a) => a.autoJoin);
    const wagerList = accounts.filter((a) => a.autoWager);

    if (!accounts.length) {
      log('no accounts in ACCOUNTS_JSON');
      return;
    }

    log(`tick key=${key} secsInto=${secsInto} accounts=${accounts.length}`);

    if (secsInto >= 0 && secsInto <= JOIN_UNTIL && joinList.length) {
      log(`JOIN phase (${joinList.length})`);
      for (const acc of joinList) {
        const st = getState(acc.sid);
        if (st.cycleKey === key && st.joined) {
          log(`${acc.username || acc.sid.slice(0, 8)} already joined`);
          continue;
        }
        let balBefore = st.balBefore;
        if (st.cycleKey !== key || balBefore == null) {
          try {
            balBefore = await getBalance(acc.sid);
            log(`${acc.username || acc.sid.slice(0, 8)} bal@join=${balBefore}`);
          } catch (e) {
            log(`${acc.username || acc.sid.slice(0, 8)} bal fail: ${e.message || e}`);
            balBefore = null;
          }
        }
        st.cycleKey = key;
        st.balBefore = balBefore;
        st.joined = false;
        st.wagered = false;
        try {
          log(
            `${acc.username || acc.sid.slice(0, 8)} joining… proxy=${acc.useProxy ? 'yes' : 'no'}`
          );
          const r = await rainJoin(acc.sid, acc.useProxy);
          if (r.ok) {
            st.joined = true;
            log(`${acc.username || acc.sid.slice(0, 8)} JOINED${r.already ? ' (already)' : ''}`);
          } else {
            log(`${acc.username || acc.sid.slice(0, 8)} join fail: ${r.error}`);
          }
        } catch (e) {
          log(`${acc.username || acc.sid.slice(0, 8)} join error: ${e.message || e}`);
        }
        await sleep(2000);
      }
      return;
    }

    if (secsInto >= WAGER_FROM && secsInto <= WAGER_TO && wagerList.length) {
      log(`WAGER phase (${wagerList.length})`);
      for (const acc of wagerList) {
        const st = getState(acc.sid);
        if (st.cycleKey !== key) {
          log(`${acc.username || acc.sid.slice(0, 8)} no join state — skip`);
          continue;
        }
        if (st.wagered) continue;
        if (st.balBefore == null) {
          st.wagered = true;
          continue;
        }
        try {
          const after = await getBalance(acc.sid);
          const gained = Math.max(0, Number(after) - Number(st.balBefore));
          log(
            `${acc.username || acc.sid.slice(0, 8)} after=${after} before=${st.balBefore} gain=${gained}`
          );
          if (gained < 1) {
            st.wagered = true;
            continue;
          }
          const bet = Math.max(1, Math.min(Math.floor(gained), Math.floor(after)));
          const w = await wager(acc.sid, bet, acc);
          log(
            `${acc.username || acc.sid.slice(0, 8)} wager ${bet} → ${
              w.ok ? (w.won ? 'WIN' : 'LOSS') : 'FAIL ' + w.error
            }`
          );
          st.wagered = true;
        } catch (e) {
          log(`${acc.username || acc.sid.slice(0, 8)} wager error: ${e.message || e}`);
        }
        await sleep(2000);
      }
    }
  } catch (e) {
    log('tick error:', e.message || e);
  } finally {
    ticking = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        accounts: loadAccounts().length,
        ...cycleInfo(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  log(`listening on ${PORT}`);
  log(`accounts loaded: ${loadAccounts().length}`);
  tick();
  setInterval(tick, 60 * 1000);
});
