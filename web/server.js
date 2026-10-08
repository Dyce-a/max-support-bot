import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import authRouter    from './routes/auth.js';
import ticketsRouter from './routes/tickets.js';
import refsRouter    from './routes/refs.js';
import usersRouter   from './routes/users.js';
import qrRouter      from './routes/qr.js';
import scanRouter, { PUBLIC_PATHS } from './routes/scan.js';
import { PUBLIC_URL } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Секрет подписи куки. Захардкоженный в репозитории означал бы, что любой, кто
// видел исходники, может подделать сессию админа — панель доступна по домену.
// Без переменной поднимемся на случайном: безопасно, но сессии слетят при рестарте.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Короткая дата для списков: «сегодня, 11:46», «вчера, 18:02», «26 сент., 14:20».
// Считаем по Москве, как и fmtDate, — сервер может жить в UTC
const MSK = 'Europe/Moscow';
const mskDay = (d) => new Date(d).toLocaleDateString('ru-RU', { timeZone: MSK });
function fmtWhen(d) {
  if (!d) return '—';
  const date = new Date(d);
  const now = Date.now();
  const time = date.toLocaleTimeString('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit' });
  const day = mskDay(date);
  if (day === mskDay(now)) return `сегодня, ${time}`;
  if (day === mskDay(now - 864e5)) return `вчера, ${time}`;
  if (day.slice(-4) !== mskDay(now).slice(-4)) return `${day}, ${time}`;
  return `${date.toLocaleDateString('ru-RU', { timeZone: MSK, day: 'numeric', month: 'short' })}, ${time}`;
}
// Буквы для аватарки: «Борисов Павел» → «БП»
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

export function createWebApp() {
  const app = express();

  if (!process.env.SESSION_SECRET) {
    console.warn('⚠ SESSION_SECRET не задан — сгенерирован временный, вход слетит при перезапуске');
  }

  // За nginx и cloudflared: без этого req.protocol и req.ip показывают прокси, а не клиента.
  // Доверяем только прокси на этой же машине. Было «1» — первому звену, кем бы оно
  // ни было: приложение слушает :3000 на всех интерфейсах, и любой в сети вуза,
  // придя напрямую, подставлял свои X-Forwarded-For и обходил ограничение попыток входа.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  const isPublicPath = (p) => PUBLIC_PATHS.some(pp => p === pp || p.startsWith(pp));
  const HTTPS_DOMAIN = PUBLIC_URL.startsWith('https://');
  const PUBLIC_HOST  = new URL(PUBLIC_URL).host;

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    // В адресе сканера одноразовый токен (?t=…) — не отдаём его чужим сайтам в Referer
    res.set('Referrer-Policy', 'same-origin');
    // Браузер запомнит, что панель только по https, и перестанет слать куку сессии
    // открытым текстом на первый http-запрос перед редиректом шлюза.
    // Полученный по http заголовок браузеры игнорируют, так что локально он не мешает.
    if (HTTPS_DOMAIN) res.set('Strict-Transport-Security', 'max-age=15552000');
    // Админку нельзя встраивать во фреймы (кликджекинг). Сканер — можно:
    // веб-версия MAX открывает мини-апп во фрейме.
    if (!isPublicPath(req.path)) {
      res.set('X-Frame-Options', 'DENY');
      res.set('Content-Security-Policy', "frame-ancestors 'none'");
    }
    next();
  });

  // CSRF. Кука сессии с SameSite=Lax не защищает от «соседей по сайту»: для браузера
  // все поддомены вуза — один сайт, и страница на любом из них могла бы
  // отправить форму в панель от имени вошедшего админа. Изменяющие запросы
  // принимаем только со своей страницы.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const site = req.get('sec-fetch-site');
    if (site) {
      return site === 'same-origin' || site === 'none' ? next() : res.status(403).send('Запрос с чужого сайта отклонён');
    }
    // Старые браузеры без Sec-Fetch-*: сверяем Origin. Без Origin это не браузерная
    // форма (curl и т. п.) — у такого клиента нет чужой куки, подделывать нечего.
    const origin = req.get('origin');
    if (!origin) return next();
    let host = null;
    try { host = new URL(origin).host; } catch { /* Origin: null и прочий мусор */ }
    if (host && (host === req.get('host') || host === PUBLIC_HOST)) return next();
    res.status(403).send('Запрос с чужого сайта отклонён');
  });

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // COOKIE_SECURE=1 — всегда secure. Иначе 'auto': флаг ставится, когда прокси
      // сообщил, что запрос пришёл по https (X-Forwarded-Proto), — по http, через
      // SSH-туннель на localhost, вход продолжает работать
      secure: process.env.COOKIE_SECURE === '1' ? true : 'auto',
      maxAge: 1000 * 60 * 60 * 8,
    },
  }));

  // Делаем admin (если залогинен) и текущий путь доступными во всех шаблонах
  app.use((req, res, next) => {
    res.locals.admin   = req.session.admin || null;
    res.locals.flash   = req.session.flash || null;
    req.session.flash  = null;
    res.locals.urlPath = req.path;

    // В шаблонах было new Date(d + 'Z') — конкатенация Date со строкой. Парсер
    // это переваривал, но время съезжало на смещение таймзоны сервера. pg отдаёт
    // готовый Date, а часовой пояс задаём явно, чтобы не зависеть от настроек машины.
    res.locals.fmtDate = (d) => d
      ? new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
      : '—';
    res.locals.fmtWhen = fmtWhen;
    res.locals.initials = initials;

    next();
  });

  // Гард авторизации для всего, кроме /login и страниц сканера
  // (их открывают пользователи бота, у них нет учётки админки)
  function requireAuth(req, res, next) {
    if (req.path.startsWith('/login') || req.path === '/logout') return next();
    if (isPublicPath(req.path)) return next();
    if (!req.session.admin) return res.redirect('/login');
    next();
  }
  app.use(requireAuth);

  app.get('/', (req, res) => res.redirect('/tickets'));

  app.use('/',         scanRouter);
  app.use('/',         authRouter);
  app.use('/tickets',  ticketsRouter);
  app.use('/refs',     refsRouter);
  app.use('/users',    usersRouter);
  app.use('/qr',       qrRouter);

  app.use((err, req, res, _next) => {
    console.error(err);
    // Текст ошибки нельзя отдавать как HTML: pg цитирует в нём ввод из адреса
    // (invalid input syntax for type integer: "<script>…"), и ссылка, присланная
    // админу, выполняла бы чужой скрипт в панели. Подробности — только вошедшему
    // админу и только простым текстом.
    const detail = req.session?.admin ? '\n\n' + err.message : '';
    res.status(500).type('text/plain; charset=utf-8').send('Внутренняя ошибка сервера' + detail);
  });

  return app;
}
