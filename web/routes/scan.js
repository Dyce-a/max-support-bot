import { Router } from 'express';
import crypto from 'crypto';
import { createRequire } from 'module';
import { getScanToken, markScanTokenUsed, roomByCode, extractCode } from '../../db/qr.js';
import { applyScannedRoom } from '../../bot/bot.js';
import botToken, { BOT_LINK, PUBLIC_URL, MINIAPP_ENABLED } from '../../config.js';

const router = Router();
const require = createRequire(import.meta.url);

// Публичные пути этого роутера — они же перечислены в гарде авторизации в server.js
export const PUBLIC_PATHS = ['/scan', '/s/', '/api/scan', '/vendor/'];

// Токен сканера выдаёт бот: 24 случайных байта в base64url. Всё, что на него
// не похоже, отсекаем сразу — строка из адреса попадает в скрипт страницы.
const isScanToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);

// Мини-апп MAX представляется строкой WebApp.initData, подписанной токеном бота
// (схема dev.max.ru/docs/webapps/validation, как у Telegram): ключ —
// HMAC-SHA256(«WebAppData», токен), подпись — HMAC-SHA256(ключ, поля без hash,
// отсортированные по имени, «имя=значение» через перевод строки). Раньше страница слала
// голый id из initDataUnsafe, и кто угодно мог POST-ом представиться любым
// пользователем бота: сбить ему черновик заявки и слать сообщения от бота.
const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;
const WEBAPP_KEY = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

// Разбор как в примере из доки MAX: split по & и =, значение — decodeURIComponent
// один раз. URLSearchParams здесь не годится: он превращает «+» в пробел.
function parseLaunchParams(str) {
  const out = [];
  for (const part of str.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const raw = i < 0 ? '' : part.slice(i + 1);
    let v;
    try { v = decodeURIComponent(raw); } catch { return null; }
    out.push([k, v]);
  }
  return out;
}

const hmac = (data) => crypto.createHmac('sha256', WEBAPP_KEY).update(data).digest();

function verifyInitData(initData) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  let str = initData.replace(/^#/, '');
  // Если прислали весь фрагмент адреса (#WebAppData=…&WebAppPlatform=…), достаём
  // из него сами параметры запуска — так их берёт пример из доки
  if (/^WebAppData=/.test(str)) str = new URLSearchParams(str).get('WebAppData') || '';

  const params = parseLaunchParams(str);
  if (!params) return null;
  const hashes = params.filter(([k]) => k === 'hash');
  if (hashes.length !== 1 || !/^[0-9a-f]{64}$/i.test(hashes[0][1])) return null;
  const given = Buffer.from(hashes[0][1], 'hex');
  const rest = params.filter(([k]) => k !== 'hash');

  // Сортировка по имени поля. В доке — localeCompare; для нынешних полей
  // (auth_date, chat, ip, query_id, start_param, user) он совпадает с побайтовым
  // порядком, но сверяем оба варианта, чтобы не зависеть от локали сервера
  const byLocale = [...rest].sort((a, b) => a[0].localeCompare(b[0]));
  const byCode   = [...rest].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ok = [byLocale, byCode].some(list => crypto.timingSafeEqual(
    hmac(list.map(([k, v]) => `${k}=${v}`).join('\n')), given));
  if (!ok) return null;

  const get = (key) => rest.find(([k]) => k === key)?.[1];

  // Старые подписанные данные не принимаем. В доке auth_date в секундах;
  // на случай миллисекунд (как в остальном API MAX) приводим
  let authDate = Number(get('auth_date')) || 0;
  if (authDate > 1e12) authDate = Math.floor(authDate / 1000);
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) return null;

  try {
    const id = JSON.parse(get('user') || 'null')?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

// Страховка от долбёжки: не чаще раза в 3 секунды на пользователя
const lastHit = new Map();
function rateLimitOk(key, ms = 3000) {
  const now = Date.now();
  const prev = lastHit.get(key);
  if (prev && now - prev < ms) return false;
  lastHit.set(key, now);
  if (lastHit.size > 5000) lastHit.clear();
  return true;
}

// --- Страница сканера (открывается из бота) ---
router.get('/scan', async (req, res) => {
  const token = isScanToken(req.query.t) ? req.query.t : '';
  const row   = token ? await getScanToken(token) : null;

  res.render('scan/index', {
    token,
    tokenValid: Boolean(row),
    tokenGiven: Boolean(token),
    miniappEnabled: MINIAPP_ENABLED,
    // Нужна, если мини-апп открыли с наклейки, а с ботом человек ещё не общался:
    // написать ему бот не может, зато первый запуск по ?start=КОД сработает
    botLink: BOT_LINK,
  });
});

// Deep link в бота. ?start=КОД MAX передаёт в событии bot_started, но оно приходит,
// только когда человек запускает бота впервые (или после остановки). У кого чат
// с ботом уже есть, переход просто открывал старую переписку: бот кода не получал,
// и человек видел аудиторию из своей прошлой заявки — «сканирую 302, а там 208».
// ?startapp=КОД открывает мини-апп (страницу /scan) при каждом переходе и
// отдаёт ему код в start_param — оттуда аудитория и приходит в бот.
// Наш код из шести латинских букв и цифр подходит под ограничения обоих параметров.
function botDeepLink(code, param = MINIAPP_ENABLED ? 'startapp' : 'start') {
  if (!BOT_LINK) return null;
  return `${BOT_LINK}${BOT_LINK.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(code)}`;
}

// --- Наклейку отсканировали обычной камерой телефона ---
router.get('/s/:code', async (req, res) => {
  const code = extractCode(req.params.code);
  const room = code ? await roomByCode(code) : null;
  const deepLink = room ? botDeepLink(room.qr_code) : null;

  // Камера должна вести сразу в бота с подставленной аудиторией, а не на
  // страницу-заглушку. Без BOT_LINK перенаправлять некуда — тогда как раньше.
  // ?stay=1 оставляет страницу: удобно проверить наклейку, не улетая в мессенджер.
  if (deepLink && req.query.stay === undefined) return res.redirect(302, deepLink);

  res.status(room ? 200 : 404).render('scan/landing', {
    room, code: code || req.params.code, botLink: deepLink || BOT_LINK, publicUrl: PUBLIC_URL,
  });
});

// --- Приём распознанного кода ---
router.post('/api/scan', async (req, res, next) => {
  try {
    const code = extractCode(req.body?.code);
    if (!code) return res.status(400).json({ ok: false, error: 'bad_code' });

    let maxId = null;

    if (req.body?.token) {
      const row = isScanToken(req.body.token) ? await getScanToken(req.body.token) : null;
      if (!row) return res.status(410).json({ ok: false, error: 'token_expired' });
      maxId = row.max_id;
      markScanTokenUsed(req.body.token).catch(() => {});
    } else if (req.body?.initData) {
      maxId = verifyInitData(req.body.initData);
      if (!maxId) {
        console.warn('Сканер: подпись initData мини-аппа не сошлась или данные устарели');
        return res.status(401).json({ ok: false, error: 'bad_signature' });
      }
      if (!rateLimitOk(maxId)) return res.status(429).json({ ok: false, error: 'too_fast' });
    }

    if (!maxId) return res.status(401).json({ ok: false, error: 'no_identity' });

    const result = await applyScannedRoom(maxId, code);
    if (!result.ok) return res.status(result.error === 'send_failed' ? 502 : 404).json(result);

    const r = result.room;
    res.json({
      ok: true,
      room: {
        number: r.number, floor: r.floor,
        building: r.building_name, type: r.room_type_name,
      },
    });
  } catch (e) { next(e); }
});

// jsQR отдаём прямо из node_modules — нужен там, где нет BarcodeDetector (iOS Safari)
router.get('/vendor/jsqr.js', (req, res) => {
  res.type('js').sendFile(require.resolve('jsqr'));
});

export default router;
