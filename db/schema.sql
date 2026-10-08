-- =================== Справочники ===================

CREATE TABLE IF NOT EXISTS buildings (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  floors_cnt  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS room_types (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS rooms (
  id           SERIAL PRIMARY KEY,
  building_id  INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor        INTEGER NOT NULL,
  room_type_id INTEGER REFERENCES room_types(id) ON DELETE SET NULL,
  -- Номер намеренно НЕ уникален: в одном корпусе на разных этажах бывают
  -- одноимённые помещения («Санузел», «Серверная»), и админ должен иметь
  -- возможность завести их все. Различаются они id и своим QR-кодом.
  number       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment_types (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS equipment (
  id          SERIAL PRIMARY KEY,
  type_id     INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE CASCADE,
  inv_number  TEXT,
  room_id     INTEGER REFERENCES rooms(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS fault_groups (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS fault_types (
  id            SERIAL PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES fault_groups(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  room_type_id  INTEGER REFERENCES room_types(id) ON DELETE SET NULL
);

-- =================== Пользователи бота ===================

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  max_id        TEXT NOT NULL UNIQUE,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  category      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS executor_groups (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES fault_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

-- =================== Учётки веб-панели ===================

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =================== Заявки ===================

CREATE TABLE IF NOT EXISTS tickets (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  building_id     INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
  floor           INTEGER,
  room_id         INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  fault_group_id  INTEGER REFERENCES fault_groups(id) ON DELETE SET NULL,
  fault_type_id   INTEGER REFERENCES fault_types(id) ON DELETE SET NULL,
  comment         TEXT,
  photo_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'new',
  urgency         TEXT NOT NULL DEFAULT 'normal',
  executor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  done_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_executor ON tickets(executor_id);
CREATE INDEX IF NOT EXISTS idx_tickets_parent   ON tickets(parent_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created  ON tickets(created_at);

-- =================== Журнал движений ===================

CREATE TABLE IF NOT EXISTS ticket_journal (
  id            SERIAL PRIMARY KEY,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_kind    TEXT NOT NULL,
  actor_label   TEXT,
  status_from   TEXT,
  status_to     TEXT,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_journal_ticket ON ticket_journal(ticket_id);

-- =================== QR-коды аудиторий ===================

-- Короткий код аудитории (напр. R7K2M9) — он зашит в QR-наклейку на двери.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_qr_code ON rooms(qr_code);

-- Одноразовые ссылки на сканер: бот выдаёт токен, страница сканера им представляется.
CREATE TABLE IF NOT EXISTS scan_tokens (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_id      TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scan_tokens_created ON scan_tokens(created_at);

-- =================== Миграции ===================

-- Снимаем старое ограничение уникальности номера аудитории в корпусе —
-- см. комментарий в CREATE TABLE rooms. Имя constraint'а сгенерировано
-- PostgreSQL автоматически из UNIQUE(building_id, number).
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_building_id_number_key;

-- Хеш предыдущего пароля админки. По нему страница входа узнаёт старый пароль
-- и подсказывает, у кого спросить новый, вместо безликого «неверный пароль»
ALTER TABLE admins ADD COLUMN IF NOT EXISTS prev_password_hash TEXT;

-- Исполнитель вида неисправности. Заявка уходит ему в первую очередь, исполнителю
-- группы — только если здесь пусто (см. autoAssignExecutor в bot/bot.js)
ALTER TABLE fault_types ADD COLUMN IF NOT EXISTS executor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Токен фото из MAX: по нему бот пересылает картинку исполнителю. Ссылки
-- photo_url для этого мало — её хватает только чтобы показать фото в панели
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS photo_token TEXT;

-- Токен того же фото, загруженного ботом через /uploads: по документации MAX
-- токен для отправки выдаёт только своя загрузка (см. uploadTicketPhoto в bot/bot.js)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS photo_upload_token TEXT;
