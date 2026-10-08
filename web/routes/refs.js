import { Router } from 'express';
import db from '../../db/index.js';
import { assignRoomCode } from '../../db/qr.js';

const router = Router();

const REFS = {
  buildings: {
    title: 'Корпуса',
    columns: [
      { field: 'id',         label: 'ID',      readonly: true },
      { field: 'name',       label: 'Название', type: 'text',   required: true },
      { field: 'floors_cnt', label: 'Этажей',   type: 'number', required: true, min: 1, default: 1 },
    ],
    list:   ()        => db.many('SELECT * FROM buildings ORDER BY name'),
    insert: (d)       => db.run('INSERT INTO buildings (name, floors_cnt) VALUES ($1, $2)', [d.name, d.floors_cnt || 1]),
    update: (id, d)   => db.run('UPDATE buildings SET name = $1, floors_cnt = $2 WHERE id = $3', [d.name, d.floors_cnt || 1, id]),
    delete: (id)      => db.run('DELETE FROM buildings WHERE id = $1', [id]),
  },

  room_types: {
    title: 'Типы аудиторий',
    columns: [
      { field: 'id',   label: 'ID',       readonly: true },
      { field: 'name', label: 'Название', type: 'text', required: true },
    ],
    list:   ()      => db.many('SELECT * FROM room_types ORDER BY name'),
    insert: (d)     => db.run('INSERT INTO room_types (name) VALUES ($1)', [d.name]),
    update: (id, d) => db.run('UPDATE room_types SET name = $1 WHERE id = $2', [d.name, id]),
    delete: (id)    => db.run('DELETE FROM room_types WHERE id = $1', [id]),
  },

  rooms: {
    title: 'Аудитории',
    columns: [
      { field: 'id',           label: 'ID',      readonly: true },
      { field: 'building_id',  label: 'Корпус',  type: 'select', required: true,
        options: () => db.many('SELECT id AS value, name AS label FROM buildings ORDER BY name') },
      { field: 'floor',        label: 'Этаж',    type: 'number', required: true, min: 1 },
      { field: 'room_type_id', label: 'Тип',     type: 'select', nullable: true,
        options: () => db.many('SELECT id AS value, name AS label FROM room_types ORDER BY name') },
      { field: 'number',       label: 'Номер',   type: 'text', required: true,
        hint: 'Может повторяться — например, два «Санузла» на одном этаже' },
    ],
    list: () => db.many(`
      SELECT r.*, b.name AS building_name, rt.name AS room_type_name
      FROM rooms r
      LEFT JOIN buildings  b  ON b.id  = r.building_id
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      ORDER BY b.name, r.floor, r.number
    `),
    displayColumns: ['id', 'building_name', 'floor', 'room_type_name', 'number'],
    // Код выдаём сразу при создании. Иначе новая аудитория висит без QR до
    // перезапуска сервиса (там отрабатывает backfill) или до ручной кнопки в /qr.
    insert: async (d) => {
      const row = await db.one(
        'INSERT INTO rooms (building_id, floor, room_type_id, number) VALUES ($1, $2, $3, $4) RETURNING id',
        [d.building_id, d.floor, d.room_type_id || null, d.number]);
      const code = await assignRoomCode(row.id);
      return `Аудитория добавлена, QR-код выдан: ${code}`;
    },
    update: (id, d) => db.run(
      'UPDATE rooms SET building_id = $1, floor = $2, room_type_id = $3, number = $4 WHERE id = $5',
      [d.building_id, d.floor, d.room_type_id || null, d.number, id]),
    delete: (id)    => db.run('DELETE FROM rooms WHERE id = $1', [id]),
  },

  fault_groups: {
    title: 'Группы неисправностей',
    columns: [
      { field: 'id',   label: 'ID',       readonly: true },
      { field: 'name', label: 'Название', type: 'text', required: true },
    ],
    list:   ()      => db.many('SELECT * FROM fault_groups ORDER BY id'),
    insert: (d)     => db.run('INSERT INTO fault_groups (name) VALUES ($1)', [d.name]),
    update: (id, d) => db.run('UPDATE fault_groups SET name = $1 WHERE id = $2', [d.name, id]),
    delete: (id)    => db.run('DELETE FROM fault_groups WHERE id = $1', [id]),
  },

  fault_types: {
    title: 'Виды неисправностей',
    columns: [
      { field: 'id',           label: 'ID',      readonly: true },
      { field: 'group_id',     label: 'Группа',  type: 'select', required: true,
        options: () => db.many('SELECT id AS value, name AS label FROM fault_groups ORDER BY id') },
      { field: 'name',         label: 'Название', type: 'text', required: true },
      { field: 'room_type_id', label: 'Только для типа аудитории', type: 'select', nullable: true,
        hint: 'Если оставить пустым — доступно везде',
        options: () => db.many('SELECT id AS value, name AS label FROM room_types ORDER BY name') },
      // Порядок выбора исполнителя: сначала исполнитель вида неисправности, и только
      // если он не указан — закреплённые за группой (Пользователи → Группы)
      { field: 'executor_id',  label: 'Исполнитель', type: 'select', nullable: true,
        hint: 'Получает все заявки этого вида. Пусто — заявка уйдёт исполнителю группы',
        options: () => db.many(`
          SELECT id AS value, COALESCE(NULLIF(name, ''), 'MAX id ' || max_id) AS label
          FROM users WHERE role IN ('executor', 'admin')
          ORDER BY name
        `) },
    ],
    list: () => db.many(`
      SELECT ft.*, fg.name AS group_name, rt.name AS room_type_name,
             COALESCE(NULLIF(ex.name, ''), 'MAX id ' || ex.max_id) AS executor_name
      FROM fault_types ft
      LEFT JOIN fault_groups fg ON fg.id = ft.group_id
      LEFT JOIN room_types   rt ON rt.id = ft.room_type_id
      LEFT JOIN users        ex ON ex.id = ft.executor_id
      ORDER BY fg.id, ft.id
    `),
    displayColumns: ['id', 'group_name', 'name', 'room_type_name', 'executor_name'],
    insert: (d)     => db.run(
      'INSERT INTO fault_types (group_id, name, room_type_id, executor_id) VALUES ($1, $2, $3, $4)',
      [d.group_id, d.name, d.room_type_id || null, d.executor_id || null]),
    update: (id, d) => db.run(
      'UPDATE fault_types SET group_id = $1, name = $2, room_type_id = $3, executor_id = $4 WHERE id = $5',
      [d.group_id, d.name, d.room_type_id || null, d.executor_id || null, id]),
    delete: (id)    => db.run('DELETE FROM fault_types WHERE id = $1', [id]),
  },

  equipment_types: {
    title: 'Виды оборудования',
    columns: [
      { field: 'id',   label: 'ID',       readonly: true },
      { field: 'name', label: 'Название', type: 'text', required: true },
    ],
    list:   ()      => db.many('SELECT * FROM equipment_types ORDER BY name'),
    insert: (d)     => db.run('INSERT INTO equipment_types (name) VALUES ($1)', [d.name]),
    update: (id, d) => db.run('UPDATE equipment_types SET name = $1 WHERE id = $2', [d.name, id]),
    delete: (id)    => db.run('DELETE FROM equipment_types WHERE id = $1', [id]),
  },

  equipment: {
    title: 'Оборудование',
    columns: [
      { field: 'id',         label: 'ID',          readonly: true },
      { field: 'type_id',    label: 'Вид',          type: 'select', required: true,
        options: () => db.many('SELECT id AS value, name AS label FROM equipment_types ORDER BY name') },
      { field: 'inv_number', label: 'Инв. номер',   type: 'text' },
      { field: 'room_id',    label: 'Аудитория',    type: 'select', nullable: true,
        // Номера аудиторий не уникальны, поэтому в подписи ещё и тип помещения —
        // иначе два «Санузла» на этаже в списке неразличимы.
        options: () => db.many(`
          SELECT r.id AS value,
                 b.name || ' / ' || r.floor || ' эт. / ' || r.number ||
                   COALESCE(' · ' || rt.name, '') AS label
          FROM rooms r
          LEFT JOIN buildings  b  ON b.id  = r.building_id
          LEFT JOIN room_types rt ON rt.id = r.room_type_id
          ORDER BY b.name, r.floor, r.number
        `) },
    ],
    list: () => db.many(`
      SELECT e.*, et.name AS type_name,
             b.name || ' / ' || r.floor || ' эт. / ' || r.number ||
               COALESCE(' · ' || rt.name, '') AS room_label
      FROM equipment e
      LEFT JOIN equipment_types et ON et.id = e.type_id
      LEFT JOIN rooms           r  ON r.id  = e.room_id
      LEFT JOIN buildings       b  ON b.id  = r.building_id
      LEFT JOIN room_types      rt ON rt.id = r.room_type_id
      ORDER BY et.name, e.inv_number
    `),
    displayColumns: ['id', 'type_name', 'inv_number', 'room_label'],
    insert: (d)     => db.run(
      'INSERT INTO equipment (type_id, inv_number, room_id) VALUES ($1, $2, $3)',
      [d.type_id, d.inv_number || null, d.room_id || null]),
    update: (id, d) => db.run(
      'UPDATE equipment SET type_id = $1, inv_number = $2, room_id = $3 WHERE id = $4',
      [d.type_id, d.inv_number || null, d.room_id || null, id]),
    delete: (id)    => db.run('DELETE FROM equipment WHERE id = $1', [id]),
  },
};

// Через REFS[key] пролезали ключи из прототипа: /refs/constructor возвращал функцию,
// проверка «справочник не найден» пропускала запрос дальше и он падал 500-й.
// Имя ключа к тому же подставляется в SQL в обработчике редактирования.
const getRef = (key) => (Object.hasOwn(REFS, key) ? REFS[key] : null);

async function resolveColumns(cols) {
  return Promise.all(cols.map(async c =>
    c.type === 'select' && typeof c.options === 'function'
      ? { ...c, options: await c.options() }
      : c
  ));
}

router.get('/', (req, res) => {
  res.render('refs/index', {
    refKey: null,
    refs: Object.entries(REFS).map(([k, v]) => ({ key: k, title: v.title })),
  });
});

router.get('/:key', async (req, res) => {
  const ref = getRef(req.params.key);
  if (!ref) return res.status(404).send('Справочник не найден');

  const editingId = req.query.edit ? parseInt(req.query.edit, 10) : null;

  const [cols, items, editing] = await Promise.all([
    resolveColumns(ref.columns),
    ref.list(),
    editingId
      ? db.one(`SELECT * FROM ${req.params.key} WHERE id = $1`, [editingId])
      : Promise.resolve(null),
  ]);

  res.render('refs/index', {
    refKey:  req.params.key,
    refTitle: ref.title,
    refs: Object.entries(REFS).map(([k, v]) => ({ key: k, title: v.title })),
    cols,
    items,
    displayColumns: ref.displayColumns || cols.map(c => c.field),
    editing,
  });
});

router.post('/:key', async (req, res) => {
  const ref = getRef(req.params.key);
  if (!ref) return res.status(404).send('Справочник не найден');
  try {
    // Справочник может вернуть свой текст — аудитории так сообщают выданный код
    const info = await ref.insert(req.body);
    req.session.flash = typeof info === 'string' ? info : 'Добавлено';
  } catch (e) {
    req.session.flash = 'Ошибка: ' + e.message;
  }
  res.redirect('/refs/' + req.params.key);
});

router.post('/:key/:id/update', async (req, res) => {
  const ref = getRef(req.params.key);
  if (!ref) return res.status(404).send('Справочник не найден');
  try {
    await ref.update(parseInt(req.params.id, 10), req.body);
    req.session.flash = 'Обновлено';
  } catch (e) {
    req.session.flash = 'Ошибка: ' + e.message;
  }
  res.redirect('/refs/' + req.params.key);
});

router.post('/:key/:id/delete', async (req, res) => {
  const ref = getRef(req.params.key);
  if (!ref) return res.status(404).send('Справочник не найден');
  try {
    await ref.delete(parseInt(req.params.id, 10));
    req.session.flash = 'Удалено';
  } catch (e) {
    req.session.flash = 'Ошибка: ' + e.message;
  }
  res.redirect('/refs/' + req.params.key);
});

export default router;
