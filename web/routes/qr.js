import { Router } from 'express';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../../db/index.js';
import { assignRoomCode, backfillRoomCodes, extractCode } from '../../db/qr.js';
import { PUBLIC_URL, ORG_NAME } from '../../config.js';

const router = Router();

// Что зашито в QR: ссылка на публичную страницу аудитории. Так наклейка работает
// и в сканере бота, и в обычной камере телефона (откроется страница с кнопкой «В MAX»).
const codeUrl = (code) => `${PUBLIC_URL}/s/${code}`;

// margin — «тихая зона» вокруг кода в модулях. Без неё сканеры читают код
// хуже, особенно если картинку положили на цветной фон.
const QR_OPTIONS = { margin: 2, errorCorrectionLevel: 'M' };

// Логотип для шапки наклейки. Если положить настоящий файл в web/public/logo.svg,
// он подставится вместо встроенной отрисовки — читаем один раз при старте.
const LOGO_SVG = (() => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'logo.svg');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
})();

// Поиск идёт по всему, что видно в строке таблицы: номер, код, корпус, тип,
// а чисто числовой запрос дополнительно сверяется с этажом.
const listRooms = (buildingId, floor, q) => db.many(`
  SELECT r.id, r.number, r.floor, r.qr_code,
         b.name  AS building_name,
         rt.name AS room_type_name
  FROM rooms r
  LEFT JOIN buildings  b  ON b.id  = r.building_id
  LEFT JOIN room_types rt ON rt.id = r.room_type_id
  WHERE ($1::int IS NULL OR r.building_id = $1)
    AND ($2::int IS NULL OR r.floor = $2)
    AND ($3::text IS NULL OR
         r.number   ILIKE '%' || $3 || '%' OR
         r.qr_code  ILIKE '%' || $3 || '%' OR
         b.name     ILIKE '%' || $3 || '%' OR
         rt.name    ILIKE '%' || $3 || '%' OR
         r.floor::text = $3)
  ORDER BY b.name, r.floor, r.number
`, [buildingId, floor, q]);

const intOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (v) => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};

router.get('/', async (req, res) => {
  const buildingId = intOrNull(req.query.building_id);
  const floor      = intOrNull(req.query.floor);
  const q          = strOrNull(req.query.q);

  const [buildings, floors, rooms, missing] = await Promise.all([
    db.many('SELECT id, name FROM buildings ORDER BY name'),
    db.many('SELECT DISTINCT floor FROM rooms ORDER BY floor'),
    listRooms(buildingId, floor, q),
    db.one('SELECT COUNT(*) AS c FROM rooms WHERE qr_code IS NULL'),
  ]);

  res.render('qr/index', {
    pageTitle: 'QR-коды аудиторий',
    buildings, floors, rooms,
    buildingId, floor, q,
    missing: parseInt(missing.c, 10),
    publicUrl: PUBLIC_URL,
  });
});

// PNG одной аудитории — превью в таблице и «скачать» по кнопке
router.get('/png/:code', async (req, res, next) => {
  try {
    const code = extractCode(req.params.code);
    if (!code) return res.status(400).send('Некорректный код');

    const size = Math.min(Math.max(intOrNull(req.query.size) || 320, 64), 1200);
    const png = await QRCode.toBuffer(codeUrl(code), { ...QR_OPTIONS, width: size });
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="qr-${code}.png"`);
    }
    res.type('png').send(png);
  } catch (e) { next(e); }
});

// SVG одной аудитории. Конструктор листа собирает наклейки в браузере и тянет
// код сюда картинкой: вектор печатается чётко при любом размере наклейки.
router.get('/svg/:code', async (req, res, next) => {
  try {
    const code = extractCode(req.params.code);
    if (!code) return res.status(400).send('Некорректный код');

    const svg = await QRCode.toString(codeUrl(code), { ...QR_OPTIONS, type: 'svg' });
    // Код аудитории не меняется без перевыпуска, а на листе таких картинок сотни —
    // без кеша каждый пересчёт раскладки дёргал бы сервер заново.
    res.type('svg').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch (e) { next(e); }
});

// Конструктор листа наклеек: /qr/print?id=1&id=2... либо ?all=1 с теми же фильтрами.
// На лист попадают выбранные аудитории, но в боковом списке доступны все —
// оттуда их перетаскивают мышью.
router.get('/print', async (req, res, next) => {
  try {
    const ids = [].concat(req.query.id || []).map(intOrNull).filter(Boolean);

    const [picked, all] = await Promise.all([
      ids.length
        ? db.many(`
            SELECT r.id, r.number, r.floor, r.qr_code,
                   b.name AS building_name, rt.name AS room_type_name
            FROM rooms r
            LEFT JOIN buildings  b  ON b.id  = r.building_id
            LEFT JOIN room_types rt ON rt.id = r.room_type_id
            WHERE r.id = ANY($1::int[])
            ORDER BY b.name, r.floor, r.number
          `, [ids])
        : listRooms(intOrNull(req.query.building_id), intOrNull(req.query.floor), strOrNull(req.query.q)),
      listRooms(null, null, null),
    ]);

    const withQr = (rows) => rows.filter(r => r.qr_code);

    res.render('qr/print', {
      pageTitle: 'Печать QR-наклеек',
      rooms: withQr(picked),
      allRooms: withQr(all),
      orgName: ORG_NAME, logoSvg: LOGO_SVG,
    });
  } catch (e) { next(e); }
});

// Перевыпуск кода: старая наклейка после этого перестаёт работать
router.post('/:id/regen', async (req, res) => {
  try {
    const code = await assignRoomCode(intOrNull(req.params.id));
    req.session.flash = `Новый код: ${code}. Старую наклейку нужно заменить.`;
  } catch (e) {
    req.session.flash = 'Ошибка: ' + e.message;
  }
  res.redirect('/qr');
});

// Выдать коды аудиториям, добавленным после первого сидинга
router.post('/backfill', async (req, res) => {
  try {
    const n = await backfillRoomCodes();
    req.session.flash = n ? `Коды выданы: ${n}` : 'Все аудитории уже с кодами';
  } catch (e) {
    req.session.flash = 'Ошибка: ' + e.message;
  }
  res.redirect('/qr');
});

export default router;
