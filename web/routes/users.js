import { Router } from 'express';
import db from '../../db/index.js';

const router = Router();

const ROLES = ['user', 'executor', 'admin'];

router.get('/', async (req, res) => {
  const [users, groups, links] = await Promise.all([
    db.many(`
      SELECT u.*,
        (SELECT STRING_AGG(fg.name, ', ')
           FROM executor_groups eg
           JOIN fault_groups fg ON fg.id = eg.group_id
          WHERE eg.user_id = u.id) AS groups_list,
        -- Сколько незакрытых заявок сейчас на человеке: видно, кто загружен
        (SELECT COUNT(*)::int FROM tickets t
          WHERE t.executor_id = u.id AND t.status NOT IN ('done', 'rejected')) AS active_cnt
      FROM users u
      ORDER BY u.role DESC, u.created_at DESC
    `),
    db.many('SELECT * FROM fault_groups ORDER BY id'),
    db.many('SELECT user_id, group_id FROM executor_groups'),
  ]);

  const linksByUser = {};
  for (const l of links) {
    (linksByUser[l.user_id] ||= new Set()).add(l.group_id);
  }

  // Карточка справа — для человека из ?u=; без него справа подсказка
  const uid = /^\d{1,9}$/.test(String(req.query.u ?? '')) ? parseInt(req.query.u, 10) : null;
  const selected = uid ? users.find(u => u.id === uid) || null : null;

  res.render('users/list', { users, groups, linksByUser, selected });
});

// Роль и группы одной кнопкой «Сохранить» из карточки пользователя
router.post('/:id/save', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).send('Пользователь не найден');
  const id = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!ROLES.includes(role)) {
    req.session.flash = 'Неверная роль';
    return res.redirect('/users?u=' + id);
  }
  const selectedGroups = [].concat(req.body.group_ids || []).map(g => parseInt(g, 10)).filter(Boolean);
  // Группы бывают только у исполнителей и админов: простому пользователю их не пишем,
  // даже если флажки остались отмеченными в форме
  const ids = role === 'user' ? [] : selectedGroups;

  const client = await db.connect();
  let user;
  try {
    await client.query('BEGIN');
    ({ rows: [user] } = await client.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING name, max_id', [role, id]));
    await client.query('DELETE FROM executor_groups WHERE user_id = $1', [id]);
    for (const gid of ids) {
      await client.query(
        'INSERT INTO executor_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, gid]);
    }
    if (role === 'user') {
      await client.query('UPDATE fault_types SET executor_id = NULL WHERE executor_id = $1', [id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (!user) {
    req.session.flash = 'Пользователь не найден';
    return res.redirect('/users');
  }
  req.session.flash = `Сохранено: ${user.name || 'MAX ' + user.max_id}`;
  res.redirect('/users?u=' + id);
});

router.post('/:id/role', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!ROLES.includes(role)) {
    req.session.flash = 'Неверная роль';
    return res.redirect('/users');
  }
  await db.run('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  if (role === 'user') {
    await db.run('DELETE FROM executor_groups WHERE user_id = $1', [id]);
    await db.run('UPDATE fault_types SET executor_id = NULL WHERE executor_id = $1', [id]);
  }
  req.session.flash = 'Роль обновлена';
  res.redirect('/users');
});

router.post('/:id/groups', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const selected = req.body.group_ids;
  const ids = !selected ? [] : Array.isArray(selected) ? selected : [selected];

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM executor_groups WHERE user_id = $1', [id]);
    for (const gid of ids) {
      await client.query(
        'INSERT INTO executor_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, parseInt(gid, 10)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  req.session.flash = 'Группы исполнителя обновлены';
  res.redirect('/users');
});

export default router;
