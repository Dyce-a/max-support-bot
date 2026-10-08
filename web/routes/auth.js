import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../../db/index.js';

const router = Router();

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/tickets');
  res.render('login', { error: null });
});

// ----- Защита от подбора пароля
// После SLOW_AFTER неудачных попыток за окно WINDOW_MS каждая следующая попытка
// с того же адреса ждёт SLOW_MS. Именно замедление, а не блокировка: за шлюзом
// вуза все клиенты могут выглядеть одним адресом, и блокировка по нему
// закрыла бы вход всем админам разом, стоит боту перебрать пароли. Правильный
// пароль пускает всегда.
const WINDOW_MS  = 15 * 60 * 1000;
const SLOW_AFTER = 10;
const SLOW_MS    = 3000;
const fails = new Map();   // адрес -> { count, resetAt }

// Адрес клиента. За прокси на этой машине (nginx, cloudflared) берём самый левый
// из X-Forwarded-For — его ставит первый прокси в цепочке, то есть шлюз вуза.
// Клиент может его подделать, но этим он лишь обходит замедление для себя,
// а не замедляет других; против подбора всё равно стоит длинный пароль.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientKey(req) {
  const viaLocalProxy = LOOPBACK.has(req.socket.remoteAddress);
  const first = viaLocalProxy ? String(req.get('x-forwarded-for') || '').split(',')[0].trim() : '';
  return first || req.ip;
}

function failCount(key) {
  const f = fails.get(key);
  return f && f.resetAt > Date.now() ? f.count : 0;
}

function noteFail(key) {
  const now = Date.now();
  let f = fails.get(key);
  if (!f || f.resetAt <= now) f = { count: 0, resetAt: now + WINDOW_MS };
  f.count++;
  fails.set(key, f);
  // Чистим протухшие, чтобы перебор с разных адресов не раздувал память
  if (fails.size > 10000) for (const [k, v] of fails) if (v.resetAt <= now) fails.delete(k);
}

const slowDown = (key) => failCount(key) >= SLOW_AFTER
  ? new Promise(resolve => setTimeout(resolve, SLOW_MS))
  : null;

router.post('/login', async (req, res, next) => {
  const login    = String(req.body?.login ?? '');
  const password = String(req.body?.password ?? '');

  const key = clientKey(req);
  await slowDown(key);

  const admin = await db.one('SELECT * FROM admins WHERE login = $1', [login]);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    // Старый пароль — не перебор, а человек, до которого не дошла смена.
    // Попытку не засчитываем и говорим, к кому идти за новым
    if (admin?.prev_password_hash && bcrypt.compareSync(password, admin.prev_password_hash)) {
      return res.render('login', { error: null, oldPassword: true });
    }
    noteFail(key);
    console.warn(`Неудачный вход в панель: логин ${JSON.stringify(login.slice(0, 64))}, адрес ${key}`);
    return res.render('login', { error: 'Неверный логин или пароль' });
  }
  fails.delete(key);

  // Новая сессия при входе: иначе id, выданный до входа (например, подсунутый
  // атакующим), стал бы сессией админа — фиксация сессии
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.admin = { id: admin.id, login: admin.login };
    res.redirect('/tickets');
  });
});

// ----- Смена пароля (для вошедшего админа, гард в server.js)
const MIN_PASSWORD = 10;

router.get('/password', (req, res) => {
  res.render('password', { error: null, minLength: MIN_PASSWORD });
});

router.post('/password', async (req, res) => {
  const [current, password, password2] = ['current', 'password', 'password2']
    .map(k => String(req.body?.[k] ?? ''));
  const fail = (error) => res.render('password', { error, minLength: MIN_PASSWORD });

  // То же замедление, что и на входе: иначе с угнанной сессией подбирали бы сам пароль
  const key = clientKey(req);
  await slowDown(key);

  const admin = await db.one('SELECT * FROM admins WHERE id = $1', [req.session.admin.id]);
  if (!admin || !bcrypt.compareSync(current, admin.password_hash)) {
    noteFail(key);
    return fail('Текущий пароль неверный');
  }
  if (password.length < MIN_PASSWORD) return fail(`Новый пароль — не короче ${MIN_PASSWORD} символов`);
  if (password !== password2)         return fail('Новые пароли не совпадают');
  if (password === current)           return fail('Новый пароль совпадает со старым');

  // Старый хеш сохраняем: по нему вход узнает старый пароль и подскажет, к кому идти
  await db.run('UPDATE admins SET prev_password_hash = password_hash, password_hash = $1 WHERE id = $2',
    [bcrypt.hashSync(password, 10), admin.id]);

  // Пароль меняют, чтобы старый перестал пускать, — поэтому выкидываем и тех,
  // кто уже вошёл с ним. Текущую сессию оставляем. all() есть у MemoryStore
  // и большинства других хранилищ; где его нет, сессии доживут до maxAge.
  req.sessionStore.all?.((err, sessions) => {
    if (err || !sessions) return;
    for (const [sid, s] of Object.entries(sessions)) {
      if (sid !== req.sessionID && s.admin?.id === admin.id) req.sessionStore.destroy(sid, () => {});
    }
  });

  req.session.flash = 'Пароль изменён, остальные входы под этой учёткой завершены';
  res.redirect('/tickets');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

export default router;
