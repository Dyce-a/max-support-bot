import db from './index.js';
import { runSeed } from './seed.js';
import { backfillRoomCodes } from './qr.js';

// Демо-данные, чтобы панель не была пустой: ещё аудитории, люди, исполнители
// по группам и по видам неисправностей, полсотни заявок в разных статусах с историей.
// MAX ID у людей выдуманные — написать им бот не сможет, для показа это не нужно.
// Запуск: npm run demo. Повторный запуск ничего не дублирует.

const EXECUTORS = [
  // max_id, имя, категория, группа (null — исполнитель только по видам неисправностей)
  ['900000101', 'Олег Петров',     'Электрик',      'Электрика'],
  ['900000102', 'Игорь Волков',    'Сантехник',     'Сантехника'],
  ['900000103', 'Дмитрий Соколов', 'ИТ-специалист', 'Компьютерная техника'],
  ['900000104', 'Алексей Морозов', 'ИТ-специалист', null],
  ['900000105', 'Наталья Орлова',  'Уборщик',       'Чистота'],
  ['900000106', 'Виктор Лебедев',  'Плотник',       null],
];

// Исполнители видов неисправностей. Вид главнее группы: заявки «Нет интернета»
// уходят Морозову, хотя в группе «Компьютерная техника» стоит Соколов
const TYPE_EXECUTORS = [
  ['Компьютерная техника', 'Нет интернета', '900000104'],
  ['Компьютерная техника', 'Проблема с ПО', '900000104'],
  ['Мебель и оборудование', 'Сломан стул', '900000106'],
  ['Мебель и оборудование', 'Сломан стол', '900000106'],
];

const AUTHORS = [
  ['900000201', 'Анна Смирнова',   'Преподаватель'],
  ['900000202', 'Елена Васильева', 'Преподаватель'],
  ['900000203', 'Пётр Иванов',     'Студент'],
  ['900000204', 'Кирилл Новиков',  'Студент'],
  ['900000205', 'Мария Кузнецова', 'Сотрудник'],
];

// Ещё аудитории к тем, что заводит seed.js: корпус, этаж, тип, номер
const MORE_ROOMS = [
  ['Корпус А', 1, 'Кабинет', '104'],
  ['Корпус А', 2, 'Компьютерный класс', '203'],
  ['Корпус А', 2, 'Коридор', 'Коридор 2 эт.'],
  ['Корпус А', 3, 'Лекционная', '301'],
  ['Корпус А', 3, 'Компьютерный класс', '302'],
  ['Корпус А', 3, 'Санузел', '303'],
  ['Корпус А', 4, 'Лекционная', '401'],
  ['Корпус Б', 1, 'Лаборатория', 'Б102'],
  ['Корпус Б', 2, 'Кабинет', 'Б202'],
  ['Корпус Б', 3, 'Лекционная', 'Б301'],
  ['Главный корпус', 1, 'Кабинет', '116'],
  ['Главный корпус', 2, 'Лекционная', '216'],
  ['Главный корпус', 4, 'Лекционная', '401'],
  ['Главный корпус', 5, 'Кабинет', '501'],
];

// Группа, вид, комментарий заявителя
const TEMPLATES = [
  ['Электрика', 'Не работает розетка', 'Розетка у окна не работает, ноутбук не зарядить'],
  ['Компьютерная техника', 'Нет интернета', 'На всех компьютерах в классе нет интернета'],
  ['Мебель и оборудование', 'Сломан стул', 'Сломан стул у последней парты'],
  ['Сантехника', 'Протечка', 'Течёт кран, под раковиной лужа'],
  ['Компьютерная техника', 'Не включается компьютер', 'Компьютер на третьем месте не включается'],
  ['Чистота', 'Не убрано в аудитории', 'После пары остался мусор на партах'],
  ['Электрика', 'Не горит лампочка', 'Над доской не горят две лампы'],
  ['Компьютерная техника', 'Проблема с ПО', 'Нужно поставить VS Code на все машины'],
  ['Строительное', 'Не закрывается дверь / окно', 'Окно не закрывается до конца, дует'],
  ['Мебель и оборудование', 'Сломан стол', 'Шатается преподавательский стол'],
  ['Компьютерная техника', 'Не работает принтер', 'Принтер зажевал бумагу'],
  ['Сантехника', 'Нет туалетной бумаги / мыла', 'Закончилось мыло'],
  ['Электрика', 'Не работает выключатель', 'Выключатель у двери искрит'],
  ['Прочее', 'Другое', 'Нужно повесить расписание на дверь'],
  ['Компьютерная техника', 'Не работает монитор', 'Монитор мигает и гаснет'],
  ['Чистота', 'Мусор в коридоре', 'Рассыпан мусор у лестницы'],
  ['Мебель и оборудование', 'Сломана доска', 'Маркерная доска плохо держится на стене'],
  ['Строительное', 'Повреждена стена / пол / потолок', 'Отвалилась плитка у входа'],
];

const REPORTS = [
  'Заменил розетку, всё работает',
  'Перезагрузил коммутатор, интернет появился',
  'Поменяли стул на новый',
  'Заменил прокладку в кране',
  'Сгорел блок питания, поставил другой',
];

// Чем старше заявка, тем дальше она продвинулась: свежие ещё новые, старые закрыты
function statusFor(i) {
  if (i < 6) return 'new';
  if (i < 10) return 'reviewed';
  if (i < 16) return 'in_work';
  if (i % 9 === 0) return 'postponed';
  if (i % 13 === 0) return 'rejected';
  return 'done';
}
const urgencyFor = (i) => (i % 11 === 3 ? 'critical' : i % 5 === 1 ? 'high' : i % 7 === 4 ? 'low' : 'normal');

async function upsertUser(maxId, name, role, category) {
  return (await db.one(`
    INSERT INTO users (max_id, name, role, category) VALUES ($1, $2, $3, $4)
    ON CONFLICT (max_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, category = EXCLUDED.category
    RETURNING id
  `, [maxId, name, role, category])).id;
}

async function main() {
  await runSeed();

  if (await db.one("SELECT 1 FROM users WHERE max_id = '900000101'")) {
    console.log('Демо-данные уже есть, ничего не меняю.');
    return;
  }

  // --- аудитории
  const buildings = await db.many('SELECT id, name FROM buildings');
  const roomTypes = await db.many('SELECT id, name FROM room_types');
  const idOf = (list, name) => list.find(x => x.name === name)?.id ?? null;
  for (const [b, floor, type, number] of MORE_ROOMS) {
    const bid = idOf(buildings, b);
    if (!bid) continue;
    await db.run('INSERT INTO rooms (building_id, floor, room_type_id, number) VALUES ($1, $2, $3, $4)',
      [bid, floor, idOf(roomTypes, type), number]);
  }
  await backfillRoomCodes();

  // --- люди и исполнители
  const groups = await db.many('SELECT id, name FROM fault_groups');
  const users = {};
  for (const [maxId, name, category, group] of EXECUTORS) {
    users[maxId] = await upsertUser(maxId, name, 'executor', category);
    if (group) {
      await db.run('INSERT INTO executor_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [users[maxId], idOf(groups, group)]);
    }
  }
  for (const [group, type, maxId] of TYPE_EXECUTORS) {
    await db.run('UPDATE fault_types SET executor_id = $1 WHERE group_id = $2 AND name = $3',
      [users[maxId], idOf(groups, group), type]);
  }
  const authors = [];
  for (const [maxId, name, category] of AUTHORS) authors.push(await upsertUser(maxId, name, 'user', category));

  // --- заявки
  const types = await db.many(`
    SELECT ft.id, ft.name, ft.group_id, ft.room_type_id, ft.executor_id, fg.name AS group_name
    FROM fault_types ft JOIN fault_groups fg ON fg.id = ft.group_id
  `);
  const rooms = await db.many('SELECT id, building_id, floor, room_type_id FROM rooms ORDER BY id');
  const groupExecutor = new Map((await db.many(`
    SELECT DISTINCT ON (eg.group_id) eg.group_id, u.id, u.name
    FROM executor_groups eg JOIN users u ON u.id = eg.user_id
    ORDER BY eg.group_id, u.id
  `)).map(r => [r.group_id, r]));
  const names = new Map((await db.many('SELECT id, name FROM users')).map(u => [u.id, u.name]));

  const N = 48;
  for (let i = 0; i < N; i++) {
    const [groupName, typeName, comment] = TEMPLATES[i % TEMPLATES.length];
    const type = types.find(t => t.group_name === groupName && t.name === typeName);
    if (!type) continue;
    // Сантехника заводится только для санузлов — как и в боте, где вид фильтруется по типу аудитории
    const fit = rooms.filter(r => !type.room_type_id || r.room_type_id === type.room_type_id);
    const room = fit[(i * 7) % fit.length];
    const author = authors[i % authors.length];
    const created = new Date(Date.now() - (i * 9.5 + 1) * 3600e3);

    // Исполнитель — тем же порядком, что в боте: вид неисправности, потом группа
    let executorId = type.executor_id;
    let reason = 'по виду неисправности';
    if (!executorId && groupExecutor.has(type.group_id)) {
      executorId = groupExecutor.get(type.group_id).id;
      reason = 'по группе';
    }
    // Без исполнителя заявку некому двигать — она ждёт администратора в «Новых»
    const status = executorId || statusFor(i) === 'rejected' ? statusFor(i) : 'new';
    const closed = status === 'done' || status === 'rejected';

    const { id } = await db.one(`
      INSERT INTO tickets (user_id, building_id, floor, room_id, fault_group_id, fault_type_id,
                           comment, status, urgency, executor_id, created_at, updated_at, done_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `, [author, room.building_id, room.floor, room.id, type.group_id, type.id,
        i % 6 === 5 ? null : comment, status, urgencyFor(i), executorId, created,
        new Date(created.getTime() + 2 * 3600e3), closed ? new Date(created.getTime() + 5 * 3600e3) : null]);

    // История: создание, автоназначение и шаги по статусу
    const at = (h) => new Date(created.getTime() + h * 3600e3);
    const journal = [['user', names.get(author), null, 'new', 'Заявка создана', at(0)]];
    const ex = names.get(executorId);
    if (executorId) journal.push(['system', 'автоназначение', null, null, `Исполнитель назначен ${reason}: ${ex}`, at(0)]);
    if (executorId && status === 'reviewed') journal.push(['executor', ex, 'new', 'reviewed', 'Исполнитель сменил статус', at(1)]);
    if (executorId && ['in_work', 'done', 'postponed'].includes(status)) {
      journal.push(['executor', ex, 'new', 'in_work', 'Исполнитель взял в работу', at(1)]);
      if (status === 'done') journal.push(['executor', ex, 'in_work', 'done', `Отчёт исполнителя: ${REPORTS[i % REPORTS.length]}`, at(5)]);
      if (status === 'postponed') journal.push(['executor', ex, 'in_work', 'postponed', 'Причина отложения: ждём запчасти', at(3)]);
    }
    if (status === 'rejected') journal.push(['admin', 'admin', 'new', 'rejected', 'Дубль другой заявки', at(5)]);
    for (const [kind, label, from, to, msg, time] of journal) {
      await db.run(`
        INSERT INTO ticket_journal (ticket_id, actor_kind, actor_label, status_from, status_to, message, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [id, kind, label, from, to, msg, time]);
    }
  }

  const count = async (t) => (await db.one(`SELECT COUNT(*)::int AS n FROM ${t}`)).n;
  console.log(`✓ Демо-данные: аудиторий ${await count('rooms')}, людей ${await count('users')}, заявок ${await count('tickets')}`);
}

await main();
await db.end();
