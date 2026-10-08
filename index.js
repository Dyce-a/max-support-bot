import { PUBLIC_URL } from './config.js';
import { runSeed } from './db/seed.js';
import bot from './bot/bot.js';
import { createWebApp } from './web/server.js';

const PORT = process.env.PORT || 3000;

// 0) Применяем схему БД и начальные данные
await runSeed();

// 1) Веб-панель
const app = createWebApp();
app.listen(PORT, () => {
  console.log(`🌐 Админ-панель слушает порт ${PORT}, публичный адрес: ${PUBLIC_URL}`);
});

// 2) Бот Max. SDK 0.2.2 сбоев сети не переживает: при обрыве связи с MAX опрос
// либо бросает ошибку из bot.start() — и раньше процесс падал, systemd поднимал
// его заново, а черновики заявок в памяти пропадали (07.10 так вышло 165 раз
// за два часа), — либо молча останавливается. Поэтому опрос перезапускаем сами,
// с растущей паузой, а процесс и сессии остаются живы.
async function runBot() {
  let delay = 2000;
  for (;;) {
    const started = Date.now();
    try {
      await bot.start();
      console.warn('Опрос MAX остановился, перезапускаю');
    } catch (e) {
      console.error('Нет связи с MAX:', e?.cause?.code || e?.message || e);
    }
    bot.stop();
    if (Date.now() - started > 60_000) delay = 2000;   // долго работал — сбой разовый
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 60_000);
  }
}
runBot();
console.log('🤖 Бот Max запущен');

// Отправки в MAX местами идут в фоне без await. Если такая упадёт без .catch,
// Node 20 по умолчанию завершает процесс — для бота это хуже, чем строка в логе
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));

process.on('SIGINT',  () => { console.log('\nЗавершение...'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
