import 'dotenv/config';

// Токен только из .env. Раньше здесь был запасной токен прямо в коде — с ним
// любой, кто видел исходники или архив деплоя, мог писать от имени бота и
// перехватывать сообщения пользователей.
const botToken = (process.env.BOT_TOKEN || '').trim();
if (!botToken) {
  throw new Error('BOT_TOKEN не задан: пропишите токен бота MAX в .env');
}

// Публичный адрес панели: из него строятся ссылки внутри QR-кодов и кнопка
// сканера в боте. Камера в браузере работает только по HTTPS (или на localhost),
// поэтому в бою здесь должен быть https-адрес туннеля/домена.
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`)
  .replace(/\/+$/, '');

// Ставится в 1, когда URL мини-аппа прописан в кабинете business.max.ru
// (Чат-боты → бот → Расширенные настройки). Тогда бот шлёт кнопку open_app
// с нативным сканером MAX, а не ссылку на браузер.
export const MINIAPP_ENABLED = process.env.MAX_MINIAPP === '1';

// Ссылка на бота в MAX (напр. https://max.ru/my_support_bot). Нужна только для
// страницы, которая открывается при сканировании наклейки обычной камерой телефона.
export const BOT_LINK = (process.env.BOT_LINK || '').trim();

// Подпись в шапке QR-наклейки — чьё это здание
export const ORG_NAME = (process.env.ORG_NAME || 'Высшая ИТ-школа').trim();

export default botToken;
