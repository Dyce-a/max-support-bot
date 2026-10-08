import { Bot, Keyboard } from '@maxhub/max-bot-api';
import botToken, { PUBLIC_URL, MINIAPP_ENABLED } from '../config.js';
import db from '../db/index.js';
import { createScanToken, roomByCode, extractCode, SCAN_TOKEN_TTL_MIN } from '../db/qr.js';

const bot = new Bot(botToken);
export default bot;

// MAX не разбирает разметку, пока явно не передать format. Жирный в их диалекте —
// **две** звёздочки, одинарная даёт курсив. Отправляем всё только через эти две
// обёртки, иначе формат легко забыть в новом месте и снова получить сырые звёздочки.
const MD = 'markdown';
const reply  = (ctx, text, attachments)   => ctx.reply(text, { attachments, format: MD });
const sendTo = (maxId, text, attachments) =>
  bot.api.sendMessageToUser(Number(maxId), text, { attachments, format: MD });

// Сессии в памяти
const sessions = {};
const getSession   = (uid) => (sessions[uid] ||= {});
const resetSession = (uid) => {
  const prev = sessions[uid]?.last_mid;
  sessions[uid] = {};
  if (prev) sessions[uid].last_mid = prev;
};
const clearSession = (uid) => { sessions[uid] = {}; };

// =================== DB-хелперы ===================

const q = {
  getUser:    (maxId) => db.one('SELECT * FROM users WHERE max_id = $1', [maxId]),
  insUser:    (maxId, name, role, cat) =>
    db.run('INSERT INTO users (max_id, name, role, category) VALUES ($1, $2, $3, $4)', [maxId, name, role, cat]),
  setName:    (name, id) =>
    db.run("UPDATE users SET name = $1 WHERE id = $2 AND (name IS NULL OR name = '')", [name, id]),

  buildings:    ()    => db.many('SELECT * FROM buildings ORDER BY name'),
  buildingById: (id)  => db.one('SELECT * FROM buildings WHERE id = $1', [id]),
  floorsOf:     (bid) => db.many(
    'SELECT DISTINCT floor FROM rooms WHERE building_id = $1 ORDER BY floor', [bid]),
  // Тип аудитории нужен, чтобы подписать одноимённые помещения на этаже:
  // номера больше не уникальны (два «Санузла» — нормальная ситуация).
  roomsOf:      (bid, floor) => db.many(`
    SELECT r.*, rt.name AS room_type_name
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.building_id = $1 AND r.floor = $2
    ORDER BY r.number, r.id
  `, [bid, floor]),
  roomById:     (id)  => db.one('SELECT * FROM rooms WHERE id = $1', [id]),

  groups:       ()    => db.many('SELECT * FROM fault_groups ORDER BY id'),
  groupById:    (id)  => db.one('SELECT * FROM fault_groups WHERE id = $1', [id]),
  // roomId и groupId — фильтруем типы неисправностей по типу аудитории
  typesOfGroup: (roomId, groupId) => db.many(`
    SELECT ft.* FROM fault_types ft
    LEFT JOIN rooms r ON r.id = $1
    WHERE ft.group_id = $2
      AND (ft.room_type_id IS NULL OR ft.room_type_id = r.room_type_id)
    ORDER BY ft.id
  `, [roomId, groupId]),
  typeById:     (id)  => db.one('SELECT * FROM fault_types WHERE id = $1', [id]),

  insTicket: (uid, bid, floor, rid, fgid, ftid, comment, photo) => db.one(`
    INSERT INTO tickets (user_id, building_id, floor, room_id, fault_group_id, fault_type_id, comment, photo_url, photo_token)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [uid, bid, floor, rid, fgid, ftid, comment, photo?.url || null, photo?.token || null]),

  insJournal: (tid, kind, label, sfrom, sto, msg) => db.run(`
    INSERT INTO ticket_journal (ticket_id, actor_kind, actor_label, status_from, status_to, message)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [tid, kind, label, sfrom, sto, msg]),

  myTickets: (uid) => db.many(`
    SELECT t.*, b.name AS building_name, r.number AS room_number,
           fg.name AS group_name, ft.name AS type_name
    FROM tickets t
    LEFT JOIN buildings    b  ON b.id = t.building_id
    LEFT JOIN rooms        r  ON r.id = t.room_id
    LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
    LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
    WHERE t.user_id = $1
    ORDER BY t.created_at DESC
    LIMIT 20
  `, [uid]),

  ticketById: (id) => db.one(`
    SELECT t.*, b.name AS building_name, r.number AS room_number,
           fg.name AS group_name, ft.name AS type_name,
           u.name AS author_name, u.max_id AS author_max_id
    FROM tickets t
    LEFT JOIN buildings    b  ON b.id = t.building_id
    LEFT JOIN rooms        r  ON r.id = t.room_id
    LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
    LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
    LEFT JOIN users        u  ON u.id  = t.user_id
    WHERE t.id = $1
  `, [id]),

  executorTickets: (uid) => db.many(`
    SELECT t.*, b.name AS building_name, r.number AS room_number,
           fg.name AS group_name, ft.name AS type_name
    FROM tickets t
    LEFT JOIN buildings    b  ON b.id = t.building_id
    LEFT JOIN rooms        r  ON r.id = t.room_id
    LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
    LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
    -- Раньше было IN ('in_work','reviewed'): свеженазначенная заявка висит в 'new',
    -- и исполнитель получал уведомление, но в своём списке её не находил.
    -- Отложенные тоже показываем, иначе их нечем вернуть в работу.
    WHERE t.executor_id = $1 AND t.status NOT IN ('done', 'rejected')
    ORDER BY t.created_at DESC
  `, [uid]),

  // Исполнители, закреплённые за группой неисправности (web/users → «Группы»).
  // Сортировка: сначала настоящие исполнители, затем наименее загруженные —
  // так заявки равномерно расходятся, если на группе висит несколько человек.
  executorsForGroup: (groupId) => db.many(`
    SELECT u.id, u.max_id, u.name, u.role,
           (SELECT COUNT(*) FROM tickets t
             WHERE t.executor_id = u.id AND t.status NOT IN ('done', 'rejected')) AS active_cnt
    FROM users u
    JOIN executor_groups eg ON eg.user_id = u.id
    WHERE eg.group_id = $1 AND u.role IN ('executor', 'admin')
    ORDER BY CASE WHEN u.role = 'executor' THEN 0 ELSE 1 END, active_cnt, u.id
  `, [groupId]),

  // Исполнитель из справочника «Виды неисправностей». Роль проверяем:
  // человек мог с тех пор перестать быть исполнителем
  executorForType: (typeId) => db.one(`
    SELECT u.id, u.max_id, u.name, u.role
    FROM fault_types ft
    JOIN users u ON u.id = ft.executor_id
    WHERE ft.id = $1 AND u.role IN ('executor', 'admin')
  `, [typeId]),

  setExecutor: (execId, ticketId) => db.run(
    'UPDATE tickets SET executor_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [execId, ticketId]),

  // $1 используется дважды — статус и для CASE WHEN (валидно в PostgreSQL)
  setStatus: (status, ticketId) => db.run(`
    UPDATE tickets
       SET status = $1, updated_at = CURRENT_TIMESTAMP,
           done_at = CASE WHEN $1 IN ('done', 'rejected') THEN CURRENT_TIMESTAMP ELSE done_at END
     WHERE id = $2
  `, [status, ticketId]),
};

// =================== Вспомогательные ===================

const STATUS_LABEL = {
  new: '🆕 Новая', reviewed: '👀 Рассмотрена', in_work: '🔧 В работе',
  done: '✅ Выполнена', rejected: '❌ Отклонена', postponed: '⏸️ Отложена',
};
const URGENCY_LABEL = {
  low: 'низкая', normal: 'обычная', high: 'высокая', critical: 'срочно',
};

// Статусы, которые исполнитель вправе выставить сам, не дожидаясь админа.
// 'new' в списке нет: вернуть заявку в необработанные может только панель.
// 'postponed' тоже нет — отложение всегда идёт через кнопку «Отложить (причина)»
// на карточке заявки, чтобы в журнале осталось объяснение, а не голый статус.
const EXEC_STATUSES = ['reviewed', 'in_work', 'done', 'rejected'];

async function ensureUser(ctx) {
  const maxId = String(ctx.user.user_id);
  let user = await q.getUser(maxId);
  if (!user) {
    await q.insUser(maxId, ctx.user.name || null, 'user', null);
    user = await q.getUser(maxId);
  } else if (ctx.user?.name) {
    await q.setName(ctx.user.name, user.id);
  }
  return user;
}

async function replyAndClean(ctx, session, text, attachments) {
  if (session.last_mid) {
    try { await ctx.api.deleteMessage(session.last_mid); } catch {}
    session.last_mid = null;
  }
  const sent = await reply(ctx, text, attachments);
  if (sent?.body?.mid) session.last_mid = sent.body.mid;
}

function formatTicketPreview(s) {
  return (
    `🏢 Корпус: **${s.building_name}**\n` +
    `🔢 Этаж: **${s.floor}**\n` +
    `🚪 Аудитория: **${s.room}**\n` +
    `📌 Группа: **${s.fault_group_name}**\n` +
    `🔧 Неисправность: **${s.fault_type_name}**` +
    (s.photo ? '\n📷 Фото: **приложено**' : '')
  );
}

// Первая картинка из входящего сообщения. MAX кладёт в payload ссылку на свой
// CDN (её показывает панель и по ней бот перезаливает фото исполнителю) и токен —
// он остался запасным вариантом отправки (см. sendWithPhoto).
function photoFromMessage(msg) {
  const list = msg?.body?.attachments;
  if (!Array.isArray(list)) return null;
  const p = list.find(a => a?.type === 'image')?.payload;
  return p?.url || p?.token ? { url: p.url || null, token: p.token || null } : null;
}

// Загружает фото заявки в MAX от имени бота и возвращает токен для отправки.
// Раньше бот слал токен из входящего сообщения: MAX принимал его без ошибки
// (в логах пусто), а исполнитель картинку не видел. По документации токен для
// /messages выдаёт только своя загрузка через /uploads — поэтому скачиваем фото
// с CDN MAX по photo_url и загружаем заново. Токен загрузки многоразовый —
// храним в photo_upload_token, чтобы не грузить одно фото при каждом открытии заявки.
async function uploadTicketPhoto(t) {
  const img = await fetch(t.photo_url, { signal: AbortSignal.timeout(15000) });
  if (!img.ok) throw new Error(`CDN MAX ответил ${img.status}`);
  // CDN отдаёт webp; MAX проверяет расширение в имени файла, поэтому оно должно совпадать с типом
  const type = img.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const ext = type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'jpg';
  const { url } = await bot.api.raw.uploads.getUploadUrl({ type: 'image' });
  const form = new FormData();
  form.append('data', new Blob([await img.arrayBuffer()], { type }), `photo.${ext}`);
  const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  // Ответ на картинку: { photos: { "0": { token } } }
  const data = await res.json().catch(() => null);
  const token = data?.token || Object.values(data?.photos || {})[0]?.token;
  if (!res.ok || !token) throw new Error(`загрузка в MAX не прошла (${res.status})`);
  t.photo_upload_token = token;
  await db.run('UPDATE tickets SET photo_upload_token = $1 WHERE id = $2', [token, t.id]);
  return token;
}

// Отправляет сообщение с фото заявки. Сначала — фото, загруженное ботом, затем
// запасные варианты из входящего сообщения: ссылка и токен. Если фото не прошло
// ни одним способом — сообщение уходит без него: текст и кнопки должны дойти
// в любом случае. send(attachments) — сама отправка. Свежезагруженный файл
// MAX обрабатывает не сразу (attachment.not.ready) — эту отправку SDK повторяет сам.
// Вложения собираем plain-объектами: ImageAttachment из SDK 0.2.2 уходит в JSON
// без type и payload (у класса toJson, а JSON.stringify ищет toJSON).
async function sendWithPhoto(t, send, other = []) {
  const sources = [];
  if (t?.photo_upload_token) sources.push(['загружено ранее', () => ({ token: t.photo_upload_token })]);
  if (t?.photo_url) {
    sources.push(['загрузка ботом', async () => ({ token: await uploadTicketPhoto(t) })]);
    sources.push(['по ссылке', () => ({ url: t.photo_url })]);
  }
  if (t?.photo_token) sources.push(['по токену из сообщения', () => ({ token: t.photo_token })]);

  for (const [how, payload] of sources) {
    try {
      return await send([{ type: 'image', payload: await payload() }, ...other]);
    } catch (e) {
      console.error(`Фото к заявке №${t.id} (${how}) не отправилось:`, e?.message || e);
    }
  }
  return send(other);
}

// =================== Клавиатуры ===================

const STAFF_SPECS = [
  { code: 'teacher',     emoji: '👨‍🏫', label: 'Преподаватель',      category: 'Преподаватель',     role: 'user' },
  { code: 'electric',    emoji: '⚡',  label: 'Электрик',            category: 'Электрик',          role: 'executor', group: 'Электрика' },
  { code: 'plumber',     emoji: '🔧', label: 'Сантехник',           category: 'Сантехник',         role: 'executor', group: 'Сантехника' },
  { code: 'it',          emoji: '🖥️', label: 'ИТ-специалист',       category: 'ИТ-специалист',     role: 'executor', group: 'Компьютерная техника' },
  { code: 'carpenter',   emoji: '🪑', label: 'Плотник / мебельщик', category: 'Плотник',           role: 'executor', group: 'Мебель и оборудование' },
  { code: 'cleaner',     emoji: '🧹', label: 'Уборщик',             category: 'Уборщик',           role: 'executor', group: 'Чистота' },
  { code: 'builder',     emoji: '🏗️', label: 'Строитель',           category: 'Строитель',         role: 'executor', group: 'Строительное' },
  { code: 'other_staff', emoji: '👤', label: 'Другое',              category: 'Сотрудник',         role: 'user' },
];

function categoryKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🎓 Студент',  'cat_student')],
    [Keyboard.button.callback('🛠️ Сотрудник', 'cat_staff')],
  ]);
}

function staffSpecKeyboard() {
  const rows = STAFF_SPECS.map(s => [Keyboard.button.callback(`${s.emoji} ${s.label}`, `spec_${s.code}`)]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'change_cat')]);
  return Keyboard.inlineKeyboard(rows);
}

function mainMenu(user) {
  const rows = [
    [Keyboard.button.callback('📋 Подать заявку',  'new_ticket')],
    [Keyboard.button.callback('📷 Сканировать QR', 'scan_qr')],
    [Keyboard.button.callback('📂 Мои заявки',     'my_tickets')],
  ];
  if (user.role === 'executor') {
    rows.push([Keyboard.button.callback('🛠️ Заявки на исполнение', 'exec_tickets')]);
  }
  rows.push([Keyboard.button.callback('⚙️ Сменить категорию', 'change_cat')]);
  return Keyboard.inlineKeyboard(rows);
}

const backToMenu = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📋 В меню', 'back_to_menu')],
]);

// Кнопка сканера. Тип open_app открывает мини-апп, привязанный к боту в кабинете
// business.max.ru; SDK 0.2.2 такого типа ещё не знает, поэтому объект собираем руками.
// Ссылка в браузер остаётся всегда — как запасной вариант и для десктопа.
function scannerKeyboard(url) {
  const rows = [];
  if (MINIAPP_ENABLED) rows.push([{ type: 'open_app', text: '📷 Открыть сканер' }]);
  rows.push([Keyboard.button.link(MINIAPP_ENABLED ? '🌐 Открыть в браузере' : '📷 Открыть сканер', url)]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'back_to_menu')]);
  return Keyboard.inlineKeyboard(rows);
}

async function buildingsKeyboard() {
  const rows = (await q.buildings()).map(b => [Keyboard.button.callback(b.name, `building_${b.id}`)]);
  rows.push([Keyboard.button.callback('❌ Отмена', 'back_to_menu')]);
  return Keyboard.inlineKeyboard(rows);
}

async function floorsKeyboard(buildingId) {
  const floors = (await q.floorsOf(buildingId)).map(r => r.floor);
  const rows = floors.length
    ? floors.map(f => [Keyboard.button.callback(`${f} этаж`, `floor_${f}`)])
    : [[Keyboard.button.callback('— нет аудиторий —', 'noop')]];
  rows.push([
    Keyboard.button.callback('⬅️ Назад', 'back_to_buildings'),
    Keyboard.button.callback('❌ Отмена', 'back_to_menu'),
  ]);
  return Keyboard.inlineKeyboard(rows);
}

// Номера аудиторий не уникальны, и на этаже спокойно бывает два «Санузла».
// Одинаковые кнопки человек различить не может, поэтому дубли подписываем
// типом помещения, а если и он совпал — внутренним номером записи.
function roomLabels(rooms) {
  const count = (arr, key) => arr.reduce((m, v) => m.set(key(v), (m.get(key(v)) || 0) + 1), new Map());
  const byNumber = count(rooms, r => r.number);
  // Тип не приписываем, когда он повторяет сам номер («Санузел» / «Санузел»)
  // или его нет — такие кнопки разведёт следующий проход по id.
  const useType = (r) => r.room_type_name && r.room_type_name !== r.number;
  const first = rooms.map(r => byNumber.get(r.number) === 1 || !useType(r)
    ? r.number
    : `${r.number} · ${r.room_type_name}`);
  const byLabel = count(first, l => l);
  return new Map(rooms.map((r, i) => [r.id, byLabel.get(first[i]) === 1 ? first[i] : `${first[i]} #${r.id}`]));
}

async function roomsKeyboard(buildingId, floor) {
  const rooms = await q.roomsOf(buildingId, floor);
  const labels = roomLabels(rooms);
  // Подписанные кнопки длиннее — тогда кладём по две в ряд, иначе текст режется
  const perRow = [...labels.values()].some(l => l.length > 12) ? 2 : 3;
  const rows = [];
  for (let i = 0; i < rooms.length; i += perRow) {
    rows.push(rooms.slice(i, i + perRow)
      .map(r => Keyboard.button.callback(labels.get(r.id), `room_${r.id}`)));
  }
  if (!rows.length) rows.push([Keyboard.button.callback('— нет аудиторий —', 'noop')]);
  rows.push([
    Keyboard.button.callback('⬅️ Назад', 'back_to_floors'),
    Keyboard.button.callback('❌ Отмена', 'back_to_menu'),
  ]);
  return Keyboard.inlineKeyboard(rows);
}

async function faultGroupsKeyboard() {
  const rows = (await q.groups()).map(g => [Keyboard.button.callback(g.name, `fgroup_${g.id}`)]);
  rows.push([
    Keyboard.button.callback('⬅️ Назад', 'back_to_rooms'),
    Keyboard.button.callback('❌ Отмена', 'back_to_menu'),
  ]);
  return Keyboard.inlineKeyboard(rows);
}

async function faultTypesKeyboard(groupId, roomId) {
  const types = await q.typesOfGroup(roomId, groupId);
  const rows = types.length
    ? types.map(t => [Keyboard.button.callback(t.name, `ftype_${t.id}`)])
    : [[Keyboard.button.callback('— нет вариантов для этой аудитории —', 'noop')]];
  rows.push([
    Keyboard.button.callback('⬅️ Назад', 'back_to_groups'),
    Keyboard.button.callback('❌ Отмена', 'back_to_menu'),
  ]);
  return Keyboard.inlineKeyboard(rows);
}

function confirmKeyboard(session) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Отправить без комментария', 'submit_no_comment')],
    [Keyboard.button.callback('✏️ Добавить комментарий',     'add_comment')],
    [Keyboard.button.callback(
      session?.photo ? '🔄 Заменить фото' : '📷 Добавить фото', 'add_photo')],
    [
      Keyboard.button.callback('⬅️ Назад',  'back_to_types'),
      Keyboard.button.callback('❌ Отмена', 'back_to_menu'),
    ],
  ]);
}

function executorTicketKeyboard(ticketId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🔧 Взять в работу',      `exec_take_${ticketId}`)],
    [Keyboard.button.callback('✅ Выполнено',           `exec_done_${ticketId}`)],
    [Keyboard.button.callback('🔄 Сменить статус',      `exec_status_${ticketId}`)],
    [Keyboard.button.callback('📝 Выполнено с отчётом', `exec_donec_${ticketId}`)],
    [Keyboard.button.callback('⏸️ Отложить (причина)',  `exec_pause_${ticketId}`)],
    [Keyboard.button.callback('💬 Сообщить админу',     `exec_msg_${ticketId}`)],
    [Keyboard.button.callback('⬅️ К списку',            'exec_tickets')],
  ]);
}

// Статусы, которые ставятся одной кнопкой. Отложение сюда не входит — см. EXEC_STATUSES.
function executorStatusKeyboard(ticketId, current) {
  const rows = EXEC_STATUSES
    .filter(code => code !== current)
    .map(code => [Keyboard.button.callback(STATUS_LABEL[code], `exec_set_${code}_${ticketId}`)]);
  rows.push([Keyboard.button.callback('⬅️ К заявке', `exec_show_${ticketId}`)]);
  return Keyboard.inlineKeyboard(rows);
}

// =================== Команды ===================

// .catch обязателен: промис без обработчика при недоступности API MAX всплывает
// как unhandled rejection, а Node 20 на этом завершает процесс — бот падал бы на старте.
bot.api.setMyCommands([
  { name: 'start', description: 'Запустить бота' },
  { name: 'menu',  description: 'Открыть меню' },
]).catch(e => console.error('setMyCommands не прошёл:', e?.message || e));

// Тот же риск для любой ошибки внутри обработчика кнопки или сообщения
bot.catch((err, ctx) => {
  console.error('Ошибка в обработчике бота:', err);
  ctx?.reply?.('Что-то пошло не так. Наберите /menu и попробуйте снова.').catch(() => {});
});

// Код аудитории из deep link вида max.ru/<бот>?start=КОД. MAX кладёт его в
// payload события bot_started; если человек ввёл команду руками — это аргумент /start.
function startCode(ctx) {
  const fromPayload = ctx.update?.payload;
  const fromText = ctx.message?.body?.text?.trim().split(/\s+/)[1];
  return extractCode(fromPayload || fromText || '');
}

async function handleStart(ctx) {
  const user = await ensureUser(ctx);
  clearSession(ctx.user.user_id);

  // Пришли по наклейке: сразу подставляем аудиторию и ведём к выбору
  // неисправности. Спрашивать «кто ты» здесь неуместно — человек стоит
  // у сломанной розетки, а не проходит регистрацию.
  const code = startCode(ctx);
  if (code) {
    const applied = await applyScannedRoom(ctx.user.user_id, code);
    if (applied.ok) return;
  }

  const session = getSession(ctx.user.user_id);

  if (!user.category) {
    const sent = await reply(ctx,
      `Привет, ${ctx.user.name || ''}! 👋\nДля начала скажи, кто ты — это поможет нам быстрее обрабатывать твои заявки.`,
      [categoryKeyboard()]
    );
    if (sent?.body?.mid) session.last_mid = sent.body.mid;
    return;
  }

  const sent = await reply(ctx,
    `Привет, ${ctx.user.name || ''}! 👋\nЯ помогу подать заявку на устранение неисправности.\n\nЧем могу помочь?`,
    [mainMenu(user)]
  );
  if (sent?.body?.mid) session.last_mid = sent.body.mid;
}

bot.command('start', handleStart);
bot.on('bot_started', handleStart);

bot.command('menu', async (ctx) => {
  const user = await ensureUser(ctx);
  clearSession(ctx.user.user_id);
  const session = getSession(ctx.user.user_id);
  const sent = await reply(ctx, 'Главное меню:', [mainMenu(user)]);
  if (sent?.body?.mid) session.last_mid = sent.body.mid;
});

// =================== Текстовые сообщения ===================

bot.on('message_created', async (ctx) => {
  const text = ctx.message?.body?.text;
  if (text?.startsWith('/')) return;

  const user = await ensureUser(ctx);
  const session = getSession(ctx.user.user_id);

  const photo = photoFromMessage(ctx.message);

  if (session.awaiting_photo) {
    session.awaiting_photo = false;
    try { await ctx.api.deleteMessage(ctx.message.mid); } catch {}
    if (!photo) {
      // Вложение пришло, но картинки в нём не нашлось — пишем, что именно прислали:
      // так будет видно, если MAX начнёт присылать фото в другом виде
      const kinds = (ctx.message?.body?.attachments || []).map(a => a?.type);
      if (kinds.length) console.warn('Ждали фото, а пришло вложение:', kinds.join(', '));
      return replyAndClean(ctx, session,
        `Это не картинка. Пришлите фото или продолжите без него.\n\n` +
        formatTicketPreview(session), [confirmKeyboard(session)]);
    }
    session.photo = photo;
    return replyAndClean(ctx, session,
      `📷 Фото приложено.\n\n` + formatTicketPreview(session), [confirmKeyboard(session)]);
  }

  if (session.awaiting_comment) {
    session.awaiting_comment = false;
    try { await ctx.api.deleteMessage(ctx.message.mid); } catch {}
    // Фото могло приехать прямо с подписью — тогда берём и его
    if (photo) session.photo = photo;
    return submitTicket(ctx, text || '');
  }

  if (session.exec_action) {
    const { type, ticket_id } = session.exec_action;
    session.exec_action = null;
    try { await ctx.api.deleteMessage(ctx.message.mid); } catch {}
    return handleExecutorFeedback(ctx, user, type, ticket_id, text || '');
  }

  // Фото прислали, не нажимая кнопку, но черновик заявки уже собран —
  // намерение очевидное, прикладываем без лишних вопросов.
  if (photo && session.fault_type_id) {
    try { await ctx.api.deleteMessage(ctx.message.mid); } catch {}
    session.photo = photo;
    return replyAndClean(ctx, session,
      `📷 Фото приложено.\n\n` + formatTicketPreview(session), [confirmKeyboard(session)]);
  }

  return reply(ctx, 'Используйте меню для навигации:', [mainMenu(user)]);
});

// =================== Обратная связь исполнителя ===================

async function handleExecutorFeedback(ctx, user, type, ticketId, text) {
  const session = getSession(ctx.user.user_id);
  const t = await q.ticketById(ticketId);
  if (!t || t.executor_id !== user.id) {
    return replyAndClean(ctx, session, 'Заявка не найдена или не закреплена за вами.', [backToMenu]);
  }

  const label = user.name || user.max_id;

  if (type === 'donec') {
    await q.setStatus('done', ticketId);
    await q.insJournal(ticketId, 'executor', label, t.status, 'done', `Отчёт исполнителя: ${text}`);
    notifyAuthorStatusChange(ticketId).catch(() => {});
    return replyAndClean(ctx, session, `✅ Заявка №${ticketId} выполнена с отчётом.`, [backToMenu]);
  }
  if (type === 'pause') {
    await q.setStatus('postponed', ticketId);
    await q.insJournal(ticketId, 'executor', label, t.status, 'postponed', `Причина отложения: ${text}`);
    notifyAuthorStatusChange(ticketId).catch(() => {});
    return replyAndClean(ctx, session, `⏸️ Заявка №${ticketId} отложена.`, [backToMenu]);
  }
  if (type === 'msg') {
    await q.insJournal(ticketId, 'executor', label, null, null, `Сообщение исполнителя: ${text}`);
    return replyAndClean(ctx, session, `💬 Сообщение по заявке №${ticketId} передано администратору.`, [backToMenu]);
  }
}

// =================== Создание заявки ===================

async function submitTicket(ctx, comment) {
  const user = await ensureUser(ctx);
  const session = getSession(ctx.user.user_id);

  // Сессии живут в памяти и теряются при перезапуске сервиса. Без этой проверки
  // нажатие «Отправить» после деплоя создавало бы заявку с пустыми полями,
  // а в подтверждении светилось бы «undefined».
  if (!session.room_id || !session.fault_type_id) {
    resetSession(ctx.user.user_id);
    return replyAndClean(ctx, getSession(ctx.user.user_id),
      'Черновик заявки не сохранился — бот перезапускался. Начните заново.',
      [mainMenu(user)]);
  }

  const row = await q.insTicket(
    user.id, session.building_id, session.floor,
    session.room_id, session.fault_group_id, session.fault_type_id,
    comment || null, session.photo || null
  );
  const ticketId = row.id;

  await q.insJournal(ticketId, 'user', user.name || user.max_id, null, 'new', 'Заявка создана');

  // Исполнитель подбирается по виду или группе неисправности прямо здесь и
  // получает заявку в MAX — админу не нужно назначать его руками.
  const executor = await autoAssignExecutor(ticketId, session.fault_group_id, session.fault_type_id);

  const preview = formatTicketPreview(session);
  resetSession(ctx.user.user_id);
  const session2 = getSession(ctx.user.user_id);

  // Комментарий пишет человек и в нём может оказаться _ или *. В курсив его не
  // заворачиваем: непарный символ внутри разметки поехал бы по всему сообщению.
  const tail = comment ? `\n💬 Комментарий: ${comment}` : '';
  // Имя исполнителя тоже пришло от человека — по той же причине без разметки.
  const who = executor
    ? `\n👷 Исполнитель: ${executor.name || executor.max_id} — заявка ему уже отправлена.`
    : '\n👷 Исполнитель пока не назначен, заявку распределит администратор.';
  await replyAndClean(
    ctx, session2,
    `✅ Заявка **№${ticketId}** принята!\n\n${preview}${tail}\n${who}\n\nМы уведомим вас об изменении статуса.`,
    [backToMenu]
  );
}

// =================== Скан QR (вызывается из веб-слоя) ===================

// Кладёт аудиторию из QR в сессию пользователя и переводит его сразу к выбору
// неисправности — корпус, этаж и номер уже заполнены. Возвращает { ok, room },
// чтобы страница сканера показала, что именно распознала.
export async function applyScannedRoom(maxId, code) {
  const room = await roomByCode(code);
  if (!room) return { ok: false, error: 'unknown_code' };

  const user = await q.getUser(String(maxId));
  if (!user) return { ok: false, error: 'unknown_user' };

  const session = getSession(maxId);
  session.building_id   = room.building_id;
  session.building_name = room.building_name;
  session.floor         = room.floor;
  session.room_id       = room.id;
  session.room          = room.number;
  // Скан — это начало новой заявки: прошлый выбор неисправности сбрасываем
  session.fault_group_id   = null;
  session.fault_group_name = null;
  session.fault_type_id    = null;
  session.fault_type_name  = null;
  session.photo            = null;
  session.awaiting_comment = false;
  session.awaiting_photo   = false;
  session.exec_action      = null;

  if (session.last_mid) {
    try { await bot.api.deleteMessage(session.last_mid); } catch {}
    session.last_mid = null;
  }

  // Не дошло — человек остановил бота или MAX недоступен. Страница сканера
  // скажет об этом сама, а не повиснет на ошибке сервера
  let sent;
  try {
    sent = await sendTo(maxId,
      '📷 **QR распознан**\n\n' +
      `🏢 Корпус: **${room.building_name || '—'}**\n` +
      `🔢 Этаж: **${room.floor}**\n` +
      `🚪 Аудитория: **${room.number}**\n\n` +
      'Осталось выбрать группу неисправности:',
      [await faultGroupsKeyboard()]);
  } catch (e) {
    console.error(`Скан QR ${code}: бот не смог написать пользователю:`, e?.message || e);
    return { ok: false, error: 'send_failed' };
  }
  if (sent?.body?.mid) session.last_mid = sent.body.mid;

  return { ok: true, room };
}

// =================== Обработка кнопок ===================

bot.on('message_callback', async (ctx) => {
  const payload = ctx.callback.payload;
  const user    = await ensureUser(ctx);
  const session = getSession(ctx.user.user_id);

  // Нажатие любой кнопки отменяет ожидание текста от исполнителя
  if (session.exec_action &&
      !payload?.startsWith('exec_donec_') &&
      !payload?.startsWith('exec_pause_') &&
      !payload?.startsWith('exec_msg_')) {
    session.exec_action = null;
  }

  // --- Категория (первый запуск) ---
  if (payload === 'cat_student') {
    await db.run("UPDATE users SET category = 'Студент', role = 'user' WHERE id = $1", [user.id]);
    await db.run('DELETE FROM executor_groups WHERE user_id = $1', [user.id]);
    await db.run('UPDATE fault_types SET executor_id = NULL WHERE executor_id = $1', [user.id]);
    const fresh = await q.getUser(user.max_id);
    return replyAndClean(ctx, session, `Записал: **Студент**. Теперь можно подать заявку.`, [mainMenu(fresh)]);
  }

  if (payload === 'cat_staff') {
    return replyAndClean(ctx, session,
      'Кем ты работаешь? От этого зависит, какие заявки тебе будут поступать.',
      [staffSpecKeyboard()]);
  }

  if (payload?.startsWith('spec_')) {
    const code = payload.replace('spec_', '');
    const spec = STAFF_SPECS.find(s => s.code === code);
    if (!spec) return;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET category = $1, role = $2 WHERE id = $3',
        [spec.category, spec.role, user.id]);
      await client.query('DELETE FROM executor_groups WHERE user_id = $1', [user.id]);
      if (spec.role !== 'executor') {
        await client.query('UPDATE fault_types SET executor_id = NULL WHERE executor_id = $1', [user.id]);
      }
      if (spec.role === 'executor' && spec.group) {
        const { rows: [grp] } = await client.query(
          'SELECT id FROM fault_groups WHERE name = $1', [spec.group]);
        if (grp) {
          await client.query(
            'INSERT INTO executor_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [user.id, grp.id]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const fresh = await q.getUser(user.max_id);
    const tail = spec.role === 'executor'
      ? `\n\nТы добавлен(а) в исполнители по группе **${spec.group}**. Заявки будут приходить в личку.`
      : `\n\nТы записан(а) как обычный пользователь — можешь подавать заявки.`;
    return replyAndClean(ctx, session, `Записал: **${spec.category}**.${tail}`, [mainMenu(fresh)]);
  }

  if (payload === 'change_cat') {
    return replyAndClean(ctx, session, 'Кто ты?', [categoryKeyboard()]);
  }

  if (payload === 'noop') return;

  // --- Меню / отмена ---
  if (payload === 'back_to_menu' || payload === 'menu') {
    resetSession(ctx.user.user_id);
    const s2 = getSession(ctx.user.user_id);
    return replyAndClean(ctx, s2, 'Главное меню:', [mainMenu(user)]);
  }

  // --- Мои заявки ---
  if (payload === 'my_tickets') {
    const list = await q.myTickets(user.id);
    if (!list.length) {
      return replyAndClean(ctx, session, '📂 **Мои заявки**\n\n_Пока пусто._', [backToMenu]);
    }
    const lines = list.map(t =>
      `**№${t.id}** ${STATUS_LABEL[t.status] || t.status}\n` +
      `🏢 ${t.building_name || '—'} ${t.room_number ? '· ауд. ' + t.room_number : ''}\n` +
      `🔧 ${t.group_name || '—'} / ${t.type_name || '—'}`
    );
    return replyAndClean(ctx, session, `📂 **Мои заявки**\n\n${lines.join('\n\n')}`, [backToMenu]);
  }

  // --- Заявки на исполнение ---
  if (payload === 'exec_tickets') {
    if (user.role !== 'executor' && user.role !== 'admin') {
      return replyAndClean(ctx, session, '⛔ Доступно только исполнителям.', [backToMenu]);
    }
    const list = await q.executorTickets(user.id);
    if (!list.length) {
      return replyAndClean(ctx, session, '🛠️ **Активных заявок нет.**', [backToMenu]);
    }
    const rows = list.map(t => [
      Keyboard.button.callback(`№${t.id} · ${t.type_name || '—'} · ${t.room_number || '—'}`, `exec_show_${t.id}`)
    ]);
    rows.push([Keyboard.button.callback('📋 В меню', 'back_to_menu')]);
    return replyAndClean(ctx, session, '🛠️ **Активные заявки**\nВыберите заявку:',
      [Keyboard.inlineKeyboard(rows)]);
  }

  if (payload?.startsWith('exec_show_')) {
    const id = parseInt(payload.replace('exec_show_', ''), 10);
    const t = await q.ticketById(id);
    // Как и у остальных exec_-кнопок: карточку с комментарием и автором видит
    // только назначенный исполнитель, а не любой, кто подставит номер заявки
    if (!t || t.executor_id !== user.id) {
      return replyAndClean(ctx, session, 'Заявка не найдена или не закреплена за вами.', [backToMenu]);
    }
    const txt =
      `🛠️ **Заявка №${t.id}** · ${STATUS_LABEL[t.status] || t.status}\n` +
      `🏢 ${t.building_name || '—'} · этаж ${t.floor ?? '—'} · ауд. ${t.room_number || '—'}\n` +
      `🔧 ${t.group_name || '—'} / ${t.type_name || '—'}\n` +
      `🚦 Срочность: **${URGENCY_LABEL[t.urgency] || t.urgency}**\n` +
      (t.comment ? `💬 ${t.comment}\n` : '') +
      `👤 Автор: ${t.author_name || t.author_max_id}`;
    return sendWithPhoto(t, (att) => replyAndClean(ctx, session, txt, att), [executorTicketKeyboard(id)]);
  }

  if (payload?.startsWith('exec_take_')) {
    const id = parseInt(payload.replace('exec_take_', ''), 10);
    const t = await q.ticketById(id);
    if (!t || t.executor_id !== user.id) return;
    await q.setStatus('in_work', id);
    await q.insJournal(id, 'executor', user.name || user.max_id, t.status, 'in_work', 'Исполнитель взял в работу');
    notifyAuthorStatusChange(id).catch(() => {});
    return replyAndClean(ctx, session, `🔧 Заявка №${id} переведена в работу.`, [backToMenu]);
  }

  if (payload?.startsWith('exec_done_')) {
    const id = parseInt(payload.replace('exec_done_', ''), 10);
    const t = await q.ticketById(id);
    if (!t || t.executor_id !== user.id) return;
    await q.setStatus('done', id);
    await q.insJournal(id, 'executor', user.name || user.max_id, t.status, 'done', 'Исполнитель отметил выполнение');
    notifyAuthorStatusChange(id).catch(() => {});
    return replyAndClean(ctx, session, `✅ Заявка №${id} отмечена выполненной.`, [backToMenu]);
  }

  // --- Смена статуса исполнителем ---
  if (payload?.startsWith('exec_status_')) {
    const id = parseInt(payload.replace('exec_status_', ''), 10);
    const t = await q.ticketById(id);
    if (!t || t.executor_id !== user.id) {
      return replyAndClean(ctx, session, 'Заявка не найдена или не закреплена за вами.', [backToMenu]);
    }
    return replyAndClean(ctx, session,
      `🔄 **Заявка №${id}**\nСейчас: ${STATUS_LABEL[t.status] || t.status}\n\nВыберите новый статус:`,
      [executorStatusKeyboard(id, t.status)]);
  }

  if (payload?.startsWith('exec_set_')) {
    // Код статуса сам содержит подчёркивание (in_work), поэтому отрезаем
    // только хвостовой номер заявки, а не делим payload по всем '_'.
    const m = payload.slice('exec_set_'.length).match(/^(.+)_(\d+)$/);
    if (!m || !EXEC_STATUSES.includes(m[1])) return;
    const status = m[1];
    const id     = parseInt(m[2], 10);

    const t = await q.ticketById(id);
    if (!t || t.executor_id !== user.id) {
      return replyAndClean(ctx, session, 'Заявка не найдена или не закреплена за вами.', [backToMenu]);
    }
    if (t.status === status) {
      return replyAndClean(ctx, session,
        `Статус заявки №${id} и так «${STATUS_LABEL[status]}».`, [executorTicketKeyboard(id)]);
    }

    await q.setStatus(status, id);
    await q.insJournal(id, 'executor', user.name || user.max_id, t.status, status,
      'Исполнитель сменил статус');
    notifyAuthorStatusChange(id).catch(() => {});
    return replyAndClean(ctx, session,
      `${STATUS_LABEL[status]} — заявка №${id} обновлена, заявитель уведомлён.`, [backToMenu]);
  }

  // Выполнено с отчётом / отложить / сообщить — запрашиваем текст
  for (const [prefix, type, prompt] of [
    ['exec_donec_', 'donec', '📝 Напишите отчёт по выполнению следующим сообщением:'],
    ['exec_pause_', 'pause', '⏸️ Напишите причину отложения следующим сообщением:'],
    ['exec_msg_',   'msg',   '💬 Напишите сообщение администратору следующим сообщением:'],
  ]) {
    if (payload?.startsWith(prefix)) {
      const id = parseInt(payload.replace(prefix, ''), 10);
      const t = await q.ticketById(id);
      if (!t || t.executor_id !== user.id) {
        return replyAndClean(ctx, session, 'Заявка не найдена или не закреплена за вами.', [backToMenu]);
      }
      session.exec_action = { type, ticket_id: id };
      return replyAndClean(ctx, session, prompt,
        [Keyboard.inlineKeyboard([[Keyboard.button.callback('❌ Отмена', 'exec_tickets')]])]);
    }
  }

  // --- Сканер QR ---
  if (payload === 'scan_qr') {
    resetSession(ctx.user.user_id);
    const s2 = getSession(ctx.user.user_id);
    const token = await createScanToken(user.id, user.max_id);
    return replyAndClean(ctx, s2,
      '📷 **Сканер QR-кода аудитории**\n\n' +
      'Наведите камеру на наклейку у двери — корпус, этаж и номер аудитории заполнятся сами, ' +
      'останется выбрать неисправность.\n\n' +
      `_Ссылка действует ${SCAN_TOKEN_TTL_MIN} мин._`,
      [scannerKeyboard(`${PUBLIC_URL}/scan?t=${token}`)]);
  }

  // --- Новая заявка ---
  if (payload === 'new_ticket') {
    resetSession(ctx.user.user_id);
    const s2 = getSession(ctx.user.user_id);
    return replyAndClean(ctx, s2, 'Шаг 1 — Выберите корпус:', [await buildingsKeyboard()]);
  }

  if (payload === 'back_to_buildings') {
    return replyAndClean(ctx, session, 'Выберите корпус:', [await buildingsKeyboard()]);
  }
  if (payload === 'back_to_floors') {
    return replyAndClean(ctx, session,
      `Корпус: **${session.building_name}**\nВыберите этаж:`,
      [await floorsKeyboard(session.building_id)]);
  }
  if (payload === 'back_to_rooms') {
    return replyAndClean(ctx, session,
      `Корпус: **${session.building_name}**, ${session.floor} этаж\nВыберите аудиторию:`,
      [await roomsKeyboard(session.building_id, session.floor)]);
  }
  if (payload === 'back_to_groups') {
    return replyAndClean(ctx, session, 'Выберите группу неисправности:',
      [await faultGroupsKeyboard()]);
  }
  if (payload === 'back_to_types') {
    return replyAndClean(ctx, session,
      `Группа: **${session.fault_group_name}**\nВыберите вид неисправности:`,
      [await faultTypesKeyboard(session.fault_group_id, session.room_id)]);
  }

  if (payload?.startsWith('building_')) {
    const id = parseInt(payload.replace('building_', ''), 10);
    const b = await q.buildingById(id);
    if (!b) return;
    session.building_id   = id;
    session.building_name = b.name;
    return replyAndClean(ctx, session,
      `🏢 Корпус: **${b.name}**\n\nШаг 2 — Выберите этаж:`,
      [await floorsKeyboard(id)]);
  }

  if (payload?.startsWith('floor_')) {
    session.floor = parseInt(payload.replace('floor_', ''), 10);
    return replyAndClean(ctx, session,
      `🏢 **${session.building_name}**, ${session.floor} этаж\n\nШаг 3 — Выберите аудиторию:`,
      [await roomsKeyboard(session.building_id, session.floor)]);
  }

  if (payload?.startsWith('room_')) {
    const roomId = parseInt(payload.replace('room_', ''), 10);
    const r = await q.roomById(roomId);
    if (!r) return;
    session.room_id = roomId;
    session.room    = r.number;
    return replyAndClean(ctx, session,
      `🏢 **${session.building_name}**, ${session.floor} эт., ауд. **${r.number}**\n\nШаг 4 — Выберите группу неисправности:`,
      [await faultGroupsKeyboard()]);
  }

  if (payload?.startsWith('fgroup_')) {
    const gid = parseInt(payload.replace('fgroup_', ''), 10);
    const g = await q.groupById(gid);
    if (!g) return;
    session.fault_group_id   = gid;
    session.fault_group_name = g.name;
    return replyAndClean(ctx, session,
      `${g.name}\n\nШаг 5 — Выберите вид неисправности:`,
      [await faultTypesKeyboard(gid, session.room_id)]);
  }

  if (payload?.startsWith('ftype_')) {
    const tid = parseInt(payload.replace('ftype_', ''), 10);
    const ft = await q.typeById(tid);
    if (!ft) return;
    session.fault_type_id   = tid;
    session.fault_type_name = ft.name;
    return replyAndClean(ctx, session,
      `📋 **Предварительный просмотр заявки:**\n\n${formatTicketPreview(session)}\n\nХотите добавить комментарий?`,
      [confirmKeyboard(session)]);
  }

  if (payload === 'submit_no_comment') {
    return submitTicket(ctx, null);
  }

  if (payload === 'add_photo') {
    session.awaiting_photo = true;
    return replyAndClean(ctx, session,
      '📷 Пришлите фото следующим сообщением — исполнитель увидит его вместе с заявкой.',
      [Keyboard.inlineKeyboard([[Keyboard.button.callback('❌ Отмена', 'back_to_preview')]])]);
  }

  // Возврат к предпросмотру: нужен кнопке отмены при отправке фото
  if (payload === 'back_to_preview') {
    session.awaiting_photo = false;
    if (!session.fault_type_id) {
      return replyAndClean(ctx, session, 'Черновик не сохранился. Начните заново.', [mainMenu(user)]);
    }
    return replyAndClean(ctx, session,
      `📋 **Предварительный просмотр заявки:**\n\n` + formatTicketPreview(session) +
      `\n\nХотите добавить комментарий?`,
      [confirmKeyboard(session)]);
  }

  if (payload === 'add_comment') {
    session.awaiting_comment = true;
    return replyAndClean(ctx, session,
      '✏️ Напишите ваш комментарий следующим сообщением:',
      [Keyboard.inlineKeyboard([[Keyboard.button.callback('❌ Отмена', 'back_to_menu')]])]);
  }
});

// =================== Уведомления ===================

export async function notifyAuthorStatusChange(ticketId) {
  const t = await q.ticketById(ticketId);
  if (!t || !t.author_max_id) return;
  const text =
    `🔔 Заявка **№${t.id}** — статус: ${STATUS_LABEL[t.status] || t.status}\n` +
    `🔧 ${t.group_name || '—'} / ${t.type_name || '—'}`;
  sendTo(t.author_max_id, text).catch(() => {});
}

// Выбирает исполнителя заявки, проставляет его и шлёт уведомление в MAX.
// Порядок один для всех заявок:
//   1) исполнитель вида неисправности (Справочники → Виды неисправностей);
//   2) если у вида он не указан — исполнитель, закреплённый за группой
//      неисправности (Пользователи → Группы); если их несколько — наименее загруженный;
//   3) нет ни там, ни там — заявка остаётся новой без исполнителя.
// Раньше группа шла первой, и заявки по видам с указанным исполнителем всё равно
// уходили на группу: в группах людей не убирали, а более точная настройка вида
// не срабатывала. Вид — частный случай группы, поэтому он и главнее.
// Возвращает исполнителя или null — тогда заявку распределит администратор.
async function autoAssignExecutor(ticketId, groupId, typeId) {
  let executor = null;
  let reason = '';
  if (typeId) {
    executor = await q.executorForType(typeId);
    reason = 'по виду неисправности';
  }
  if (!executor && groupId) {
    [executor] = await q.executorsForGroup(groupId);
    reason = 'по группе';
  }
  if (!executor) return null;

  await q.setExecutor(executor.id, ticketId);
  await q.insJournal(ticketId, 'system', 'автоназначение', null, null,
    `Исполнитель назначен ${reason}: ${executor.name || executor.max_id}`);
  // Не ждём отправки: недоступный MAX не должен ронять создание заявки —
  // назначение уже в базе, исполнитель увидит заявку в своём списке.
  notifyExecutorNewTicket(ticketId).catch(e => console.error('Уведомление исполнителю не ушло:', e?.message || e));
  return executor;
}

export async function notifyExecutorNewTicket(ticketId) {
  const t = await q.ticketById(ticketId);
  if (!t || !t.executor_id) return;
  const ex = await db.one('SELECT max_id FROM users WHERE id = $1', [t.executor_id]);
  if (!ex?.max_id) return;
  const text =
    `🛠️ **Новая заявка №${t.id}**\n` +
    `🏢 ${t.building_name || '—'} · этаж ${t.floor ?? '—'} · ауд. ${t.room_number || '—'}\n` +
    `🔧 ${t.group_name || '—'} / ${t.type_name || '—'}\n` +
    `🚦 Срочность: **${URGENCY_LABEL[t.urgency] || t.urgency}**` +
    (t.comment ? `\n💬 ${t.comment}` : '');
  // Кнопки прямо в уведомлении: исполнителю не нужно идти в меню, чтобы взять
  // заявку в работу или закрыть её. Фото — в том же сообщении; не прошло —
  // уведомление всё равно уйдёт, без картинки
  await sendWithPhoto(t, (att) => sendTo(ex.max_id, text, att), [executorTicketKeyboard(t.id)]);
}
