import crypto from 'crypto';
import db from './index.js';

// Алфавит без похожих символов (0/O, 1/I/L) — код печатается на наклейке
// и его должно быть можно продиктовать или ввести руками.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Сколько живёт ссылка на сканер, выданная ботом
export const SCAN_TOKEN_TTL_MIN = 15;

export function newRoomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Выдаёт аудитории новый уникальный код (старый QR после этого перестаёт работать)
export async function assignRoomCode(roomId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = newRoomCode();
    try {
      await db.run('UPDATE rooms SET qr_code = $1 WHERE id = $2', [code, roomId]);
      return code;
    } catch (e) {
      if (e.code !== '23505') throw e; // 23505 — unique_violation, пробуем другой код
    }
  }
  throw new Error('Не удалось подобрать свободный QR-код');
}

// Проставляет коды всем аудиториям, у которых их ещё нет
export async function backfillRoomCodes() {
  const rooms = await db.many('SELECT id FROM rooms WHERE qr_code IS NULL');
  for (const r of rooms) await assignRoomCode(r.id);
  return rooms.length;
}

// Из наклейки прилетает полный URL (https://…/s/R7K2M9), из ручного ввода — сам код.
// Берём последний сегмент пути и проверяем, что он похож на код аудитории.
export function extractCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const tail = s.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const code = tail.toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

export const roomByCode = (code) => db.one(`
  SELECT r.id, r.number, r.floor, r.qr_code,
         r.building_id, b.name AS building_name,
         rt.name AS room_type_name
  FROM rooms r
  LEFT JOIN buildings  b  ON b.id  = r.building_id
  LEFT JOIN room_types rt ON rt.id = r.room_type_id
  WHERE r.qr_code = $1
`, [String(code || '').trim().toUpperCase()]);

// =================== Токены сканера ===================

export async function createScanToken(userId, maxId) {
  const token = crypto.randomBytes(24).toString('base64url');
  await db.run(
    'INSERT INTO scan_tokens (token, user_id, max_id) VALUES ($1, $2, $3)',
    [token, userId, String(maxId)]
  );
  // Подчищаем протухшие, чтобы таблица не росла бесконечно
  db.run("DELETE FROM scan_tokens WHERE created_at < NOW() - INTERVAL '1 day'").catch(() => {});
  return token;
}

// Токен живёт SCAN_TOKEN_TTL_MIN минут и в течение этого времени работает
// многократно — чтобы можно было пересканировать, если навёл не на ту дверь.
export function getScanToken(token) {
  if (!token) return Promise.resolve(null);
  return db.one(`
    SELECT * FROM scan_tokens
    WHERE token = $1 AND created_at > NOW() - make_interval(mins => $2::int)
  `, [token, SCAN_TOKEN_TTL_MIN]);
}

export function markScanTokenUsed(token) {
  return db.run('UPDATE scan_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = $1', [token]);
}
