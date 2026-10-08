import db from './index.js';
import { backfillRoomCodes } from './qr.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function isEmpty(table) {
  const row = await db.one(`SELECT COUNT(*) AS c FROM ${table}`);
  return parseInt(row.c) === 0;
}

export async function runSeed() {
  // Применяем схему (CREATE IF NOT EXISTS — идемпотентно)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.run(schema);

  // --- admin ---
  // Пароль случайный, а не admin/admin: панель смотрит в интернет, и стандартную
  // пару перебирают первой. Печатается один раз — в журнал сервиса при установке
  if (await isEmpty('admins')) {
    const password = crypto.randomBytes(12).toString('base64url');
    await db.run('INSERT INTO admins (login, password_hash) VALUES ($1, $2)',
      ['admin', bcrypt.hashSync(password, 10)]);
    console.log(`✓ Создана учётка admin, пароль: ${password}. Смените его в панели (кнопка «Сменить пароль»)`);
  }

  // --- buildings ---
  if (await isEmpty('buildings')) {
    const buildings = [
      ['Корпус А', 4],
      ['Корпус Б', 3],
      ['Главный корпус', 5],
    ];
    for (const [name, floors_cnt] of buildings) {
      await db.run(
        'INSERT INTO buildings (name, floors_cnt) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [name, floors_cnt]
      );
    }
    console.log('✓ buildings: засеяно');
  }

  // --- room_types ---
  if (await isEmpty('room_types')) {
    for (const name of ['Лекционная', 'Компьютерный класс', 'Лаборатория', 'Санузел', 'Коридор', 'Кабинет']) {
      await db.run('INSERT INTO room_types (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
    console.log('✓ room_types: засеяно');
  }

  // --- rooms ---
  if (await isEmpty('rooms')) {
    const buildings = await db.many('SELECT * FROM buildings ORDER BY name');
    const roomTypes = await db.many('SELECT * FROM room_types ORDER BY name');
    const type = (n) => roomTypes.find(t => t.name === n)?.id ?? null;
    const ins = (bid, floor, rtId, num) =>
      db.run('INSERT INTO rooms (building_id, floor, room_type_id, number) VALUES ($1, $2, $3, $4)', [bid, floor, rtId, num]);

    const a = buildings.find(b => b.name === 'Корпус А')?.id;
    const b = buildings.find(b => b.name === 'Корпус Б')?.id;
    const m = buildings.find(b => b.name === 'Главный корпус')?.id;

    if (a) {
      await ins(a, 1, type('Лекционная'), '101');
      await ins(a, 1, type('Компьютерный класс'), '102');
      await ins(a, 1, type('Санузел'), '103');
      await ins(a, 2, type('Лекционная'), '201');
      await ins(a, 2, type('Лаборатория'), '202');
    }
    if (b) {
      await ins(b, 1, type('Кабинет'), 'Б101');
      await ins(b, 2, type('Лекционная'), 'Б201');
    }
    if (m) {
      await ins(m, 1, type('Лекционная'), '115');
      await ins(m, 2, type('Компьютерный класс'), '215');
      await ins(m, 3, type('Санузел'), '315');
    }
    console.log('✓ rooms: засеяно');
  }

  // --- fault_groups ---
  if (await isEmpty('fault_groups')) {
    for (const name of ['Электрика', 'Сантехника', 'Компьютерная техника', 'Мебель и оборудование', 'Чистота', 'Строительное', 'Прочее']) {
      await db.run('INSERT INTO fault_groups (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
    console.log('✓ fault_groups: засеяно');
  }

  // --- fault_types ---
  if (await isEmpty('fault_types')) {
    const groups   = await db.many('SELECT * FROM fault_groups ORDER BY id');
    const rtypes   = await db.many('SELECT * FROM room_types ORDER BY name');
    const grp  = (n) => groups.find(g => g.name === n)?.id;
    const rt   = (n) => rtypes.find(t => t.name === n)?.id ?? null;
    const ins  = (gid, name, rtId) =>
      db.run('INSERT INTO fault_types (group_id, name, room_type_id) VALUES ($1, $2, $3)', [gid, name, rtId]);

    for (const n of ['Не работает розетка', 'Не горит лампочка', 'Не работает выключатель', 'Повреждён провод', 'Прочее'])
      await ins(grp('Электрика'), n, null);
    for (const n of ['Нет воды', 'Протечка', 'Не работает унитаз', 'Нет туалетной бумаги / мыла', 'Прочее'])
      await ins(grp('Сантехника'), n, rt('Санузел'));
    for (const n of ['Не включается компьютер', 'Не работает монитор', 'Проблема с ПО', 'Не работает принтер', 'Нет интернета', 'Прочее'])
      await ins(grp('Компьютерная техника'), n, null);
    for (const n of ['Сломан стул', 'Сломан стол', 'Сломана доска', 'Прочее'])
      await ins(grp('Мебель и оборудование'), n, null);
    for (const n of ['Не убрано в аудитории', 'Мусор в коридоре', 'Прочее'])
      await ins(grp('Чистота'), n, null);
    for (const n of ['Повреждена стена / пол / потолок', 'Не закрывается дверь / окно', 'Прочее'])
      await ins(grp('Строительное'), n, null);
    await ins(grp('Прочее'), 'Другое', null);
    console.log('✓ fault_types: засеяно');
  }

  // --- equipment_types ---
  if (await isEmpty('equipment_types')) {
    for (const name of ['Монитор', 'Системный блок', 'Принтер', 'Проектор', 'Кондиционер']) {
      await db.run('INSERT INTO equipment_types (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
    console.log('✓ equipment_types: засеяно');
  }

  // --- QR-коды аудиторий ---
  // Идемпотентно: коды выдаются только тем аудиториям, у которых их ещё нет.
  const codesAdded = await backfillRoomCodes();
  if (codesAdded) console.log(`✓ QR-коды: выдано ${codesAdded}`);

  console.log('Сидинг завершён.');
}

// npm run seed — применить схему и справочники, не запуская бота
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSeed();
  await db.end();
}
