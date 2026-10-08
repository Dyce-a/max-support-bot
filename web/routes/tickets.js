import { Router } from 'express';
import db from '../../db/index.js';
import { notifyAuthorStatusChange, notifyExecutorNewTicket } from '../../bot/bot.js';

const router = Router();

const STATUSES = [
  { code: 'new',       label: 'Новая' },
  { code: 'reviewed',  label: 'Рассмотрена' },
  { code: 'in_work',   label: 'В работе' },
  { code: 'postponed', label: 'Отложена' },
  { code: 'done',      label: 'Выполнена' },
  { code: 'rejected',  label: 'Отклонена' },
];

const URGENCIES = [
  { code: 'low',      label: 'Низкая' },
  { code: 'normal',   label: 'Обычная' },
  { code: 'high',     label: 'Высокая' },
  { code: 'critical', label: 'Срочно' },
];

// Числовой параметр из адреса. Мусор («abc», «1;drop») превращаем в null, а не
// отдаём в SQL: pg падал на нём ошибкой, которая уходила на страницу
const intParam = (v) => (/^\d{1,9}$/.test(String(v ?? '')) ? parseInt(v, 10) : null);

// Заявок на странице списка. Раньше выводились все разом (до 500), и с ростом
// базы страница тяжелела, а до старых заявок приходилось долго листать
const PER_PAGE = 25;

// Номера страниц под таблицей: первая, последняя и соседи текущей, остальное — «…».
// [1, '…', 4, 5, 6, '…', 12]. Всегда семь кнопок, чтобы ряд не прыгал по ширине
function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, '…', pages];
  if (page >= pages - 3) return [1, '…', pages - 4, pages - 3, pages - 2, pages - 1, pages];
  return [1, '…', page - 1, page, page + 1, '…', pages];
}

// ----- Список заявок (с фильтрами)
router.get('/', async (req, res) => {
  const building_id = intParam(req.query.building_id);
  const group_id    = intParam(req.query.group_id);
  const urgency     = URGENCIES.some(u => u.code === req.query.urgency) ? req.query.urgency : null;
  const search      = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const unassigned  = req.query.unassigned === '1';

  // Статусы отмечаются флажками, и в адресе их может быть несколько:
  // ?status=new&status=in_work. Один флажок приходит строкой, несколько — массивом
  const status = [].concat(req.query.status || [])
    .filter(code => STATUSES.some(s => s.code === code));

  // Условия отбора. Числа на флажках считаются тем же отбором, но без «своего»
  // условия: у флажка «В работе» — сколько заявок в работе при остальных
  // фильтрах, отмечен он сейчас или нет
  const buildWhere = ({ skipStatus = false, skipUnassigned = false } = {}) => {
    const where  = [];
    const params = [];
    if (status.length && !skipStatus) {
      params.push(status);
      where.push(`t.status = ANY($${params.length})`);
    }
    if (unassigned && !skipUnassigned) where.push('t.executor_id IS NULL');
    if (building_id) {
      params.push(building_id);
      where.push(`t.building_id = $${params.length}`);
    }
    if (group_id) {
      params.push(group_id);
      where.push(`t.fault_group_id = $${params.length}`);
    }
    if (urgency) {
      params.push(urgency);
      where.push(`t.urgency = $${params.length}`);
    }
    if (search) {
      params.push(intParam(search) ?? -1);
      const pn = params.length;
      params.push(`%${search}%`);
      const pl = params.length;
      where.push(`(t.id = $${pn} OR t.comment ILIKE $${pl} OR u.name ILIKE $${pl})`);
    }
    return { sqlWhere: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  };
  const { sqlWhere, params } = buildWhere();
  const byStatus = buildWhere({ skipStatus: true });
  const noExec   = buildWhere({ skipUnassigned: true });

  // Сколько всего по отбору — до выборки страницы: номер страницы из адреса
  // может оказаться за концом списка (заявки удалили, отбор сузили)
  const { n: total } = await db.one(`
    SELECT COUNT(*)::int AS n FROM tickets t LEFT JOIN users u ON u.id = t.user_id ${sqlWhere}
  `, params);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page  = Math.min(intParam(req.query.page) || 1, pages);

  const sql = `
    SELECT t.*, b.name AS building_name, r.number AS room_number,
           fg.name AS group_name, ft.name AS type_name,
           u.name AS author_name, u.max_id AS author_max_id,
           ex.name AS executor_name
    FROM tickets t
    LEFT JOIN buildings    b  ON b.id = t.building_id
    LEFT JOIN rooms        r  ON r.id = t.room_id
    LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
    LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
    LEFT JOIN users        u  ON u.id = t.user_id
    LEFT JOIN users        ex ON ex.id = t.executor_id
    ${sqlWhere}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}
  `;

  const [tickets, buildings, groups, statusRows, unassignedRow] = await Promise.all([
    db.many(sql, params),
    db.many('SELECT * FROM buildings ORDER BY name'),
    db.many('SELECT * FROM fault_groups ORDER BY id'),
    db.many(`SELECT t.status, COUNT(*)::int AS n FROM tickets t LEFT JOIN users u ON u.id = t.user_id
             ${byStatus.sqlWhere} GROUP BY t.status`, byStatus.params),
    db.one(`SELECT COUNT(*)::int AS n FROM tickets t LEFT JOIN users u ON u.id = t.user_id
            ${noExec.sqlWhere ? noExec.sqlWhere + ' AND' : 'WHERE'} t.executor_id IS NULL`, noExec.params),
  ]);
  const counts = Object.fromEntries(statusRows.map(r => [r.status, r.n]));
  counts.unassigned = unassignedRow.n;

  // Ссылка на страницу с тем же отбором: берём параметры из адреса как есть,
  // меняем только page. Первая страница — без page, адрес короче
  const pageUrl = (n) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== 'page') [].concat(v).forEach(x => typeof x === 'string' && x && qs.append(k, x));
    }
    if (n > 1) qs.set('page', n);
    const s = qs.toString();
    return '/tickets' + (s ? '?' + s : '');
  };
  const pager = {
    page, pages, total,
    from: total ? (page - 1) * PER_PAGE + 1 : 0,
    to: (page - 1) * PER_PAGE + tickets.length,
    items: pageList(page, pages).map(n => (n === '…' ? null : { n, url: pageUrl(n) })),
    prev: page > 1 ? pageUrl(page - 1) : null,
    next: page < pages ? pageUrl(page + 1) : null,
  };

  res.render('tickets/list', {
    tickets, statuses: STATUSES, urgencies: URGENCIES, buildings, groups, counts, pager,
    filters: { status, unassigned, building_id, group_id, urgency, q: search },
  });
});

// ----- Карточка заявки
router.get('/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(404).send('Заявка не найдена');

  const t = await db.one(`
    SELECT t.*, b.name AS building_name, r.number AS room_number,
           fg.name AS group_name, ft.name AS type_name,
           u.name AS author_name, u.max_id AS author_max_id, u.category AS author_category,
           ex.name AS executor_name
    FROM tickets t
    LEFT JOIN buildings    b  ON b.id = t.building_id
    LEFT JOIN rooms        r  ON r.id = t.room_id
    LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
    LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
    LEFT JOIN users        u  ON u.id  = t.user_id
    LEFT JOIN users        ex ON ex.id = t.executor_id
    WHERE t.id = $1
  `, [id]);

  if (!t) return res.status(404).send('Заявка не найдена');

  const [journal, children, executors, possibleParents] = await Promise.all([
    db.many('SELECT * FROM ticket_journal WHERE ticket_id = $1 ORDER BY id ASC', [id]),

    db.many(`
      SELECT t.id, t.status, t.created_at,
             ft.name AS type_name, fg.name AS group_name
      FROM tickets t
      LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
      LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
      WHERE t.parent_id = $1
      ORDER BY t.id
    `, [id]),

    db.many(`
      SELECT u.* FROM users u
      WHERE u.role IN ('executor', 'admin')
      ORDER BY
        CASE WHEN EXISTS (
          SELECT 1 FROM executor_groups eg WHERE eg.user_id = u.id AND eg.group_id = $1
        ) THEN 0 ELSE 1 END,
        u.name
    `, [t.fault_group_id]),

    db.many(`
      SELECT t.id, ft.name AS type_name, fg.name AS group_name, t.status
      FROM tickets t
      LEFT JOIN fault_groups fg ON fg.id = t.fault_group_id
      LEFT JOIN fault_types  ft ON ft.id = t.fault_type_id
      WHERE t.id != $1 AND t.parent_id IS NULL AND t.status NOT IN ('done', 'rejected')
      ORDER BY t.id DESC
      LIMIT 100
    `, [id]),
  ]);

  res.render('tickets/show', {
    t, journal, children, executors, possibleParents,
    statuses: STATUSES, urgencies: URGENCIES,
  });
});

// ----- Обновление заявки
router.post('/:id/update', async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(404).send('Заявка не найдена');
  const t  = await db.one('SELECT * FROM tickets WHERE id = $1', [id]);
  if (!t) return res.status(404).send('Заявка не найдена');

  const { status, urgency, executor_id, parent_id, comment_add } = req.body;
  const adminLabel = req.session.admin?.login || 'admin';

  const setClauses = [];
  const params     = [];
  let newStatus     = null;
  let statusChanged = false;
  let executorChanged = false;
  let newExecutorId   = undefined;
  // Что поменялось — для всплывающего сообщения после сохранения
  const done = [];

  if (status && status !== t.status && STATUSES.find(s => s.code === status)) {
    params.push(status); setClauses.push(`status = $${params.length}`);
    newStatus = status; statusChanged = true;
    done.push(`статус «${STATUSES.find(s => s.code === status).label}»`);
  }
  if (urgency && urgency !== t.urgency && URGENCIES.find(u => u.code === urgency)) {
    params.push(urgency); setClauses.push(`urgency = $${params.length}`);
    done.push(`срочность «${URGENCIES.find(u => u.code === urgency).label}»`);
  }
  if (executor_id !== undefined) {
    const newEx = executor_id === '' ? null : parseInt(executor_id, 10) || null;
    if (newEx !== t.executor_id) {
      params.push(newEx); setClauses.push(`executor_id = $${params.length}`);
      executorChanged = true; newExecutorId = newEx;
    }
  }
  if (parent_id !== undefined) {
    const newParent = parent_id === '' ? null : parseInt(parent_id, 10) || null;
    if (newParent !== t.parent_id && newParent !== id) {
      params.push(newParent); setClauses.push(`parent_id = $${params.length}`);
      done.push(newParent ? `привязана к заявке №${newParent}` : 'отвязана от родительской заявки');
    }
  }

  if (setClauses.length) {
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    if (statusChanged && (newStatus === 'done' || newStatus === 'rejected')) {
      setClauses.push('done_at = CURRENT_TIMESTAMP');
    }
    params.push(id);
    await db.run(`UPDATE tickets SET ${setClauses.join(', ')} WHERE id = $${params.length}`, params);
  }

  const insJournal = (tid, lbl, sfrom, sto, msg) => db.run(
    `INSERT INTO ticket_journal (ticket_id, actor_kind, actor_label, status_from, status_to, message)
     VALUES ($1, 'admin', $2, $3, $4, $5)`,
    [tid, lbl, sfrom, sto, msg]
  );

  if (statusChanged) {
    await insJournal(id, adminLabel, t.status, newStatus, null);
    notifyAuthorStatusChange(id).catch(console.error);
    const kids = await db.many('SELECT id, status FROM tickets WHERE parent_id = $1', [id]);
    for (const k of kids) {
      await db.run('UPDATE tickets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newStatus, k.id]);
      await insJournal(k.id, adminLabel, k.status, newStatus, `Каскад от родительской заявки №${id}`);
      notifyAuthorStatusChange(k.id).catch(console.error);
    }
  }
  if (executorChanged) {
    // В истории — имя, а не id: «Назначен исполнитель (id=5)» никому ничего не говорил
    const ex = newExecutorId ? await db.one('SELECT name, max_id FROM users WHERE id = $1', [newExecutorId]) : null;
    const exName = ex ? (ex.name || `MAX ${ex.max_id}`) : null;
    await insJournal(id, adminLabel, null, null,
      exName ? `Назначен исполнитель: ${exName}` : 'Исполнитель снят');
    if (newExecutorId) notifyExecutorNewTicket(id).catch(console.error);
    done.push(exName ? `исполнитель ${exName}` : 'исполнитель снят');
  }
  if (comment_add?.trim()) {
    await insJournal(id, adminLabel, null, null, comment_add.trim());
    done.push('запись добавлена в историю');
  }

  req.session.flash = done.length
    ? 'Сохранено: ' + done.join('; ')
    : 'Изменений нет';
  res.redirect('/tickets/' + id);
});

export default router;
