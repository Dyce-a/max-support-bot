// Конструктор листа QR-наклеек (страница /qr/print).
//
// Два режима:
//   «Сетка»    — наклейки раскладываются пресетом (1, 2, 4, 8… на листе).
//                Разбиение на колонки и строки подбирается само: из всех вариантов
//                c×r берётся тот, где наклейка выходит крупнее.
//   «Свободно» — наклейки лежат на листе по своим координатам, у каждой свой
//                размер и угол поворота, таскаются мышью.
//
// Размеры всюду в миллиметрах: лист и наклейка свёрстаны в мм, поэтому
// то, что видно на экране, совпадает с тем, что выходит из принтера.
(() => {
  const $ = (id) => document.getElementById(id);

  const ROOMS  = JSON.parse($('data-rooms').textContent  || '[]');
  const PICKED = JSON.parse($('data-picked').textContent || '[]');
  const byId   = new Map(ROOMS.map(r => [r.id, r]));

  const PAPERS = { a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148] };
  const PRESETS = [1, 2, 3, 4, 6, 8, 9, 12, 16];

  // Базовая наклейка — те же значения, что в --sw/--sh на странице
  const SW = 62, SH = 89;
  const QR_MM = 27;              // размер картинки кода на наклейке в масштабе 1:1
  const QR_MIN_MM = 17;          // ниже этого модуль кода тоньше 0.5 мм — читается плохо
  const LS_KEY = 'qr-sheet-settings';

  // Значки рисуем линиями, а не символами «+» и «×»: глиф в шрифте сидит выше
  // середины строки, и в круглой кнопке это заметно как перекос.
  const ICON_PLUS  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  const MAX_LIST = 400;          // строк в боковом списке за раз, дальше — уточнить поиск

  // Пресет по умолчанию — 9 на A4 с полями 8 мм и зазором 4 мм: ровно та
  // раскладка, которая печаталась до появления конструктора.
  const st = {
    paper: 'a4', pw: 210, ph: 297, orient: 'portrait',
    preset: 9, custom: false, cols: 3, rows: 3,
    margin: 8, gap: 4, size: 100, cuts: true,
    mode: 'grid', zoom: 100,
    // Сетка — это места на листах, а не просто список: null значит «место пустое».
    // Иначе брошенная в пятую ячейку наклейка прыгала бы в первую свободную.
    items: [],        // [{ uid, roomId } | null] по местам, подряд через все листы
    sheets: [[]],     // режим «свободно»: по массиву на лист, [{ uid, roomId, x, y, k, rot }]
    sel: null,        // uid выделенной наклейки
  };

  let seq = 0;
  const uid = () => 'i' + (++seq);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

  // ==================== Геометрия листа ====================

  function paper() {
    const [w, h] = st.paper === 'custom' ? [st.pw, st.ph] : PAPERS[st.paper];
    return st.orient === 'landscape' ? { w: h, h: w } : { w, h };
  }

  // Раскладка под заданное число наклеек: перебираем варианты «сколько в ряд» и
  // берём тот, где наклейка выходит крупнее. Ряд может быть неполным — для 8 на A4
  // это 3 в ряд (3+3+2) с наклейкой 62×89 мм, тогда как ровное 2×4 дало бы 47×67.
  // При равном размере предпочитаем раскладку с меньшим числом пустых мест.
  function bestGrid(n, innerW, innerH) {
    let best = { cols: n, rows: 1, k: -1 };
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const cw = (innerW - st.gap * (c - 1)) / c;
      const ch = (innerH - st.gap * (r - 1)) / r;
      const k = Math.min(cw / SW, ch / SH);
      const better = k > best.k + 1e-6 ||
        (Math.abs(k - best.k) <= 1e-6 && c * r < best.cols * best.rows);
      if (better) best = { cols: c, rows: r, k };
    }
    return best;
  }

  function geom() {
    const p = paper();
    const innerW = Math.max(10, p.w - st.margin * 2);
    const innerH = Math.max(10, p.h - st.margin * 2);

    const g = st.custom
      ? { cols: clamp(st.cols, 1, 20), rows: clamp(st.rows, 1, 20) }
      : bestGrid(st.preset, innerW, innerH);

    const cellW = (innerW - st.gap * (g.cols - 1)) / g.cols;
    const cellH = (innerH - st.gap * (g.rows - 1)) / g.rows;
    // Масштаб «вписать в ячейку», умноженный на ручную поправку размера
    const fit = Math.min(cellW / SW, cellH / SH);

    return {
      p, innerW, innerH,
      cols: g.cols, rows: g.rows,
      // Своя сетка задаёт число наклеек сама; у пресета последний ряд бывает неполным,
      // поэтому на листе ровно столько наклеек, сколько выбрано кнопкой.
      per: st.custom ? g.cols * g.rows : st.preset,
      cellW, cellH,
      k: Math.max(0.05, fit * st.size / 100),
    };
  }

  // ==================== Наклейка ====================

  const tpl = $('tpl');

  function sticker(room) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const num = String(room.number || '');

    const roomEl = el.querySelector('[data-f=number]');
    roomEl.textContent = num;
    // Кегль номера: 4 знака — крупно, до 7 — средне, длиннее — мелко в две строки
    roomEl.className = 'room' + (num.length <= 4 ? '' : (num.length <= 7 ? ' room--md' : ' room--sm'));

    el.querySelector('[data-f=where]').textContent =
      [room.building_name, room.floor + ' этаж'].filter(Boolean).join(' · ');

    const img = el.querySelector('[data-f=qr]');
    img.src = '/qr/svg/' + encodeURIComponent(room.qr_code);
    img.alt = 'QR ' + num;

    el.querySelector('[data-f=code]').textContent = room.qr_code;
    return el;
  }

  // ==================== Отрисовка листов ====================

  const sheetsEl = $('sheets');

  // Масштаб предпросмотра. Тем же числом делятся размеры ручек и подписей
  // (переменная --z в стилях), чтобы они не мельчали вместе с листом.
  function applyZoom() {
    sheetsEl.style.zoom = st.zoom / 100;
    sheetsEl.style.setProperty('--z', st.zoom / 100);
    $('zoomVal').textContent = st.zoom + '%';
  }

  function newSheet(g, idx, total) {
    // Подпись и «убрать лист» кладём в обёртку, а не в сам лист: у листа
    // overflow: hidden, и всё, что выше его верхней кромки, срезается.
    const box = document.createElement('div');
    box.className = 'sheet__box';

    const el = document.createElement('div');
    el.className = 'sheet';
    el.dataset.p = idx;
    el.style.setProperty('--pw', g.p.w + 'mm');
    el.style.setProperty('--ph', g.p.h + 'mm');
    el.style.setProperty('--pad', st.margin + 'mm');

    const no = document.createElement('div');
    no.className = 'sheet__no';
    no.textContent = `Лист ${idx + 1} из ${total} · ${g.p.w}×${g.p.h} мм`;
    box.appendChild(no);

    if (st.mode === 'free' && total > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sheet__del';
      del.dataset.delSheet = idx;
      del.textContent = 'Убрать лист';
      box.appendChild(del);
    }

    box.appendChild(el);
    sheetsEl.appendChild(box);
    return el;
  }

  function renderGrid(g) {
    const pages = Math.max(1, Math.ceil(st.items.length / g.per));

    for (let p = 0; p < pages; p++) {
      const sheet = newSheet(g, p, pages);
      const grid = document.createElement('div');
      grid.className = 'sheet__grid';
      grid.style.gridTemplateColumns = `repeat(${g.cols}, 1fr)`;
      grid.style.gap = st.gap + 'mm';

      for (let i = 0; i < g.per; i++) {
        const idx  = p * g.per + i;
        const item = st.items[idx];

        const cell = document.createElement('div');
        cell.className = 'cell' + (st.cuts ? ' cuts' : '');
        cell.dataset.idx = idx;

        const room = item && byId.get(item.roomId);
        if (room) {
          cell.dataset.uid = item.uid;
          cell.draggable = true;

          // Коробка по видимому размеру наклейки — к ней и цепляется крестик
          const box = document.createElement('div');
          box.className = 'cell__box';
          box.style.width  = round(SW * g.k, 2) + 'mm';
          box.style.height = round(SH * g.k, 2) + 'mm';

          const s = sticker(room);
          s.style.setProperty('--k', g.k);
          box.appendChild(s);

          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'cell__x';
          x.dataset.del = item.uid;
          x.title = 'Убрать наклейку';
          x.innerHTML = ICON_CLOSE;
          box.appendChild(x);

          cell.appendChild(box);
        }
        grid.appendChild(cell);
      }
      sheet.appendChild(grid);
    }
  }

  function renderFree(g) {
    if (!st.sheets.length) st.sheets = [[]];

    st.sheets.forEach((items, p) => {
      const sheet = newSheet(g, p, st.sheets.length);

      // Слой во весь лист: у абсолютных потомков точка отсчёта — внутренний край
      // полей, а координаты наклеек хотим считать от угла бумаги.
      const layer = document.createElement('div');
      layer.className = 'sheet__free';
      sheet.appendChild(layer);

      // Подсказка «где поля» — только на экране
      const guide = document.createElement('div');
      guide.className = 'sheet__margins';
      guide.style.inset = st.margin + 'mm';
      layer.appendChild(guide);

      items.forEach(it => {
        const room = byId.get(it.roomId);
        if (!room) return;

        const place = document.createElement('div');
        place.className = 'place' + (st.cuts ? ' cuts' : '') + (st.sel === it.uid ? ' sel' : '');
        place.dataset.uid = it.uid;
        place.dataset.p = p;
        place.style.left = it.x + 'mm';
        place.style.top  = it.y + 'mm';
        place.style.setProperty('--k', it.k);
        place.style.setProperty('--rot', it.rot + 'deg');

        place.appendChild(sticker(room));
        place.insertAdjacentHTML('beforeend',
          '<div class="handle h-rot" data-h="rot" title="Поворот (Shift — шаг 15°)"></div>' +
          '<div class="handle h-scale" data-h="scale" title="Размер"></div>');

        layer.appendChild(place);
      });
    });
  }

  function render() {
    const g = geom();

    // Размер бумаги для принтера. Поля нулевые: отступ рисует сам лист,
    // иначе браузер добавил бы к нашим полям ещё свои.
    $('page-rule').textContent = `@page { size: ${g.p.w}mm ${g.p.h}mm; margin: 0; }`;

    applyZoom();
    sheetsEl.innerHTML = '';
    if (st.mode === 'grid') renderGrid(g); else renderFree(g);

    const flat   = st.sheets.flat();
    const total  = st.mode === 'grid' ? st.items.filter(Boolean).length : flat.length;
    const pages  = sheetsEl.children.length;
    const wh     = `${round(SW * g.k)}×${round(SH * g.k)} мм`;
    $('counter').textContent =
      `Наклеек: ${total} · листов: ${pages} · ${g.per} на листе (${g.cols} в ряд), наклейка ${wh}`;
    $('empty').classList.toggle('hidden', total > 0);

    // Картинка кода на наклейке — 27 мм при 33 модулях. Меньше 17 мм даёт модуль
    // тоньше 0.5 мм: лазерник такое ещё печатает, а камера телефона читает через раз.
    const minK = st.mode === 'grid' ? g.k : Math.min(...flat.map(i => i.k), 1);
    const qrMm = round(QR_MM * minK);
    const tiny = total > 0 && qrMm < QR_MIN_MM;
    $('warn').classList.toggle('hidden', !tiny);
    if (tiny) $('warn').textContent = `QR всего ${qrMm} мм — телефон может не прочитать. Крупнее: меньше наклеек на листе или лист побольше.`;

    syncInspector();
    renderList();
  }

  // ==================== Диалог подтверждения ====================

  // Обещание с ответом «да/нет». Возвращаем фокус туда, откуда позвали, и
  // закрываем по Esc и по клику мимо карточки — как ведёт себя системный диалог.
  function ask({ title, text = '', ok = 'Убрать' }) {
    const box = $('modal');
    const yes = $('modalYes');
    const no  = $('modalNo');
    const was = document.activeElement;

    $('modalTitle').textContent = title;
    $('modalText').textContent  = text;
    $('modalText').classList.toggle('hidden', !text);
    yes.textContent = ok;
    box.classList.remove('hidden');
    yes.focus();

    return new Promise(resolve => {
      const done = (v) => {
        box.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        box.removeEventListener('mousedown', onBack);
        document.removeEventListener('keydown', onKey, true);
        if (was && was.focus) was.focus();
        resolve(v);
      };
      const onYes = () => done(true);
      const onNo  = () => done(false);
      const onBack = (e) => { if (e.target === box) done(false); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        if (e.key === 'Enter')  { e.preventDefault(); done(true); }
      };

      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      box.addEventListener('mousedown', onBack);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ==================== Список аудиторий и поиск ====================

  const listEl = $('list');

  const hay = (r) => [r.number, r.building_name, r.room_type_name, r.qr_code, r.floor]
    .filter(v => v !== null && v !== undefined).join(' ').toLowerCase();

  function used() {
    const map = new Map();
    const src = st.mode === 'grid' ? st.items : st.sheets.flat();
    src.forEach(it => { if (it) map.set(it.roomId, (map.get(it.roomId) || 0) + 1); });
    return map;
  }

  function renderList() {
    const q = ($('q').value || '').trim().toLowerCase();
    // Слова ищем по И: «а 2» найдёт второй этаж корпуса А
    const words = q ? q.split(/\s+/) : [];
    const found = ROOMS.filter(r => !words.length || words.every(w => hay(r).includes(w)));
    const counts = used();

    listEl.innerHTML = '';
    if (!found.length) {
      listEl.innerHTML = '<div class="side__empty">Ничего не найдено</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    found.slice(0, MAX_LIST).forEach(r => {
      const n = counts.get(r.id) || 0;
      const row = document.createElement('div');
      row.className = 'item';
      row.draggable = true;
      row.dataset.room = r.id;
      row.title = 'Перетащите на лист';
      row.innerHTML =
        `<img src="/qr/png/${encodeURIComponent(r.qr_code)}?size=96" alt="" loading="lazy" draggable="false" />` +
        `<span class="item__txt">` +
          `<span class="item__num"></span>` +
          `<span class="item__sub"></span>` +
        `</span>` +
        (n ? `<span class="item__n">${n}</span>` : '') +
        `<button type="button" class="item__add" data-add="${r.id}" title="Добавить на лист">${ICON_PLUS}</button>`;
      row.querySelector('.item__num').textContent = r.number;
      row.querySelector('.item__sub').textContent =
        [r.building_name, r.floor + ' эт.', r.room_type_name].filter(Boolean).join(' · ');
      frag.appendChild(row);
    });

    if (found.length > MAX_LIST) {
      const more = document.createElement('div');
      more.className = 'side__empty';
      more.textContent = `…и ещё ${found.length - MAX_LIST}. Уточните поиск.`;
      frag.appendChild(more);
    }
    listEl.appendChild(frag);
  }

  // ==================== Добавление и удаление ====================

  // Хвост из пустых мест не держим: иначе после удаления последней наклейки
  // остался бы висеть пустой лист.
  function trimSlots() {
    while (st.items.length && !st.items[st.items.length - 1]) st.items.pop();
  }

  const firstFree = () => {
    const i = st.items.findIndex(v => !v);
    return i < 0 ? st.items.length : i;
  };

  function addRoom(roomId, at) {
    if (!byId.has(roomId)) return;
    const g = geom();
    if (st.mode === 'grid') {
      const idx  = at && Number.isFinite(at.idx) ? at.idx : firstFree();
      const item = { uid: uid(), roomId };
      if (st.items[idx]) {
        st.items.splice(idx, 0, item);          // место занято — вставляем со сдвигом
      } else {
        while (st.items.length < idx) st.items.push(null);
        st.items[idx] = item;                    // пустое место — кладём ровно туда
      }
      trimSlots();
    } else {
      const p = at && Number.isFinite(at.p) ? at.p : 0;
      if (!st.sheets[p]) st.sheets[p] = [];
      const it = {
        uid: uid(), roomId,
        x: at && Number.isFinite(at.x) ? round(at.x) : g.p.w / 2,
        y: at && Number.isFinite(at.y) ? round(at.y) : g.p.h / 2,
        k: round(g.k, 3), rot: 0,
      };
      st.sheets[p].push(it);
      st.sel = it.uid;
    }
    render();
  }

  function removeItem(id) {
    // В сетке место освобождается, а не схлопывается: соседние наклейки остаются
    // на своих местах, а не съезжают на одну позицию назад.
    st.items = st.items.map(i => (i && i.uid === id ? null : i));
    trimSlots();
    st.sheets = st.sheets.map(s => s.filter(i => i.uid !== id));
    if (st.sel === id) st.sel = null;
    render();
  }

  function findItem(id) {
    for (const s of st.sheets) {
      const it = s.find(i => i.uid === id);
      if (it) return it;
    }
    return null;
  }

  // Разложить всё, что есть, по текущей сетке — используется и при переходе
  // «сетка → свободно», чтобы свободный режим стартовал с готовой раскладки.
  function arrangeToGrid(src) {
    const g = geom();
    // Из сетки берём места как есть — пустые остаются пустыми, и свободный режим
    // стартует ровно с той картинки, что была на экране.
    const flat = src || (st.mode === 'grid' ? st.items : st.sheets.flat());

    const sheets = [];
    flat.forEach((it, i) => {
      if (!it) return;
      const p   = Math.floor(i / g.per);
      const idx = i % g.per;
      const col = idx % g.cols;
      const row = Math.floor(idx / g.cols);
      if (!sheets[p]) sheets[p] = [];
      sheets[p].push({
        uid: it.uid, roomId: it.roomId,
        x: round(st.margin + col * (g.cellW + st.gap) + g.cellW / 2),
        y: round(st.margin + row * (g.cellH + st.gap) + g.cellH / 2),
        k: round(g.k, 3), rot: 0,
      });
    });
    // Лист, на котором не оказалось ни одной наклейки, всё равно должен быть
    // массивом — иначе дырка в st.sheets собьёт нумерацию листов при отрисовке.
    for (let i = 0; i < sheets.length; i++) if (!sheets[i]) sheets[i] = [];
    st.sheets = sheets.length ? sheets : [[]];
  }

  // Обратный перевод «свободно → сетка»: каждая наклейка садится в ближайшее по
  // центру место. Если ничего не двигали, раскладка возвращается в точности такой,
  // какой была, вместе с пустыми местами.
  function slotsFromFree(g) {
    const out = [];
    st.sheets.forEach((items, p) => {
      items.forEach(it => {
        const col = clamp(Math.round((it.x - st.margin - g.cellW / 2) / (g.cellW + st.gap)), 0, g.cols - 1);
        const row = clamp(Math.round((it.y - st.margin - g.cellH / 2) / (g.cellH + st.gap)), 0, g.rows - 1);
        // Последний ряд бывает неполным — за край листа не выходим
        let idx = p * g.per + Math.min(row * g.cols + col, g.per - 1);
        while (out[idx]) idx++;                     // место занято — берём следующее
        while (out.length < idx) out.push(null);
        out[idx] = { uid: it.uid, roomId: it.roomId };
      });
    });
    return out;
  }

  // ==================== Панель выбранной наклейки ====================

  function select(id) {
    st.sel = id;
    sheetsEl.querySelectorAll('.place').forEach(el =>
      el.classList.toggle('sel', el.dataset.uid === id));
    syncInspector();
  }

  function syncInspector() {
    const it = st.mode === 'free' && st.sel ? findItem(st.sel) : null;
    $('inspector').classList.toggle('hidden', !it);
    if (!it) return;
    const room = byId.get(it.roomId);
    $('insTitle').textContent = room ? room.number : '';
    $('insX').value = round(it.x);
    $('insY').value = round(it.y);
    $('insK').value = Math.round(it.k * 100);
    $('insR').value = Math.round(it.rot);
  }

  // Обновить одну наклейку на месте, без пересборки всего листа —
  // иначе перетаскивание дёргалось бы на каждом движении мыши.
  function applyItem(it) {
    const el = sheetsEl.querySelector(`.place[data-uid="${it.uid}"]`);
    if (!el) return;
    el.style.left = it.x + 'mm';
    el.style.top  = it.y + 'mm';
    el.style.setProperty('--k', it.k);
    el.style.setProperty('--rot', it.rot + 'deg');
  }

  // ==================== Перетаскивание мышью (свободный режим) ====================

  let drag = null;

  sheetsEl.addEventListener('pointerdown', (e) => {
    if (st.mode !== 'free' || e.button !== 0) return;

    const place = e.target.closest('.place');
    if (!place) { select(null); return; }

    const it = findItem(place.dataset.uid);
    if (!it) return;
    select(it.uid);

    const sheetEl = place.closest('.sheet');
    const rect = sheetEl.getBoundingClientRect();
    const P = paper();
    // Пикселей на миллиметр берём из реального размера листа — так математика
    // не ломается ни от масштаба предпросмотра, ни от зума браузера.
    const pxPerMm = rect.width / P.w;
    const cx = rect.left + it.x * pxPerMm;
    const cy = rect.top  + it.y * pxPerMm;

    const kind = e.target.closest('.handle')?.dataset.h || 'move';
    drag = {
      it, kind, pxPerMm, cx, cy, P,
      x0: it.x, y0: it.y, k0: it.k, rot0: it.rot,
      mx: e.clientX, my: e.clientY,
      d0: Math.hypot(e.clientX - cx, e.clientY - cy),
      a0: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI,
    };
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { it, kind } = drag;

    if (kind === 'move') {
      const dx = (e.clientX - drag.mx) / drag.pxPerMm;
      const dy = (e.clientY - drag.my) / drag.pxPerMm;
      // Шаг 0.5 мм, с Alt — совсем свободно
      const step = e.altKey ? 0 : 0.5;
      const snap = (v) => step ? Math.round(v / step) * step : round(v, 2);
      it.x = clamp(snap(drag.x0 + dx), 0, drag.P.w);
      it.y = clamp(snap(drag.y0 + dy), 0, drag.P.h);
    } else if (kind === 'scale') {
      const d = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy);
      it.k = round(clamp(drag.k0 * (d / Math.max(1, drag.d0)), 0.15, 4), 3);
    } else if (kind === 'rot') {
      const a = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180 / Math.PI;
      let rot = drag.rot0 + (a - drag.a0);
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;   // ровные 15° по Shift
      it.rot = round(((rot % 360) + 360) % 360);
    }

    applyItem(it);
    syncInspector();
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
  });

  // ==================== Перетаскивание из списка (HTML5 drag&drop) ====================

  listEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.item');
    if (!row) return;
    e.dataTransfer.setData('text/plain', 'room:' + row.dataset.room);
    e.dataTransfer.effectAllowed = 'copy';
  });

  sheetsEl.addEventListener('dragstart', (e) => {
    const cell = e.target.closest('.cell[data-uid]');
    if (!cell) return;
    e.dataTransfer.setData('text/plain', 'move:' + cell.dataset.uid);
    e.dataTransfer.effectAllowed = 'move';
  });

  const clearDropHi = () =>
    sheetsEl.querySelectorAll('.drop-to').forEach(el => el.classList.remove('drop-to'));

  sheetsEl.addEventListener('dragover', (e) => {
    if (!e.target.closest('.sheet')) return;
    e.preventDefault();
    clearDropHi();
    e.target.closest('.cell')?.classList.add('drop-to');
  });

  sheetsEl.addEventListener('dragleave', (e) => {
    e.target.closest('.cell')?.classList.remove('drop-to');
  });

  // Подсветку снимаем на любом конце перетаскивания: если наклейку бросили на её
  // же место или мимо листа, перерисовки не будет — и ячейка так и осталась бы
  // притухшей до следующего перетаскивания.
  window.addEventListener('dragend', clearDropHi);
  window.addEventListener('drop', clearDropHi);

  sheetsEl.addEventListener('drop', (e) => {
    clearDropHi();
    const sheetEl = e.target.closest('.sheet');
    const payload = e.dataTransfer.getData('text/plain');
    if (!sheetEl || !payload) return;
    e.preventDefault();

    const [what, id] = [payload.slice(0, payload.indexOf(':')), payload.slice(payload.indexOf(':') + 1)];

    if (st.mode === 'grid') {
      const cell = e.target.closest('.cell');
      const idx  = cell ? Number(cell.dataset.idx) : st.items.length;
      if (what === 'room') {
        addRoom(Number(id), { idx });
      } else if (what === 'move') {
        const from = st.items.findIndex(i => i && i.uid === id);
        if (from < 0 || from === idx) return;
        if (st.items[idx]) {
          // Занятое место — меняем наклейки местами: остальные не разъезжаются
          [st.items[from], st.items[idx]] = [st.items[idx], st.items[from]];
        } else {
          while (st.items.length <= idx) st.items.push(null);
          st.items[idx] = st.items[from];
          st.items[from] = null;
        }
        trimSlots();
        render();
      }
      return;
    }

    if (what === 'room') {
      const rect = sheetEl.getBoundingClientRect();
      const P = paper();
      addRoom(Number(id), {
        p: Number(sheetEl.dataset.p),
        x: (e.clientX - rect.left) / rect.width * P.w,
        y: (e.clientY - rect.top) / rect.height * P.h,
      });
    }
  });

  // ==================== Клики по листам и списку ====================

  sheetsEl.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { removeItem(del.dataset.del); return; }

    const delSheet = e.target.closest('[data-del-sheet]');
    if (!delSheet) return;

    const i = Number(delSheet.dataset.delSheet);
    const n = (st.sheets[i] || []).length;
    // Пустой лист убираем молча, с наклейками — переспрашиваем
    if (n) {
      const yes = await ask({
        title: `Убрать лист ${i + 1}?`,
        text: `Наклейки с этого листа (${n}) пропадут вместе с ним.`,
      });
      if (!yes) return;
    }
    st.sheets.splice(i, 1);
    if (!st.sheets.length) st.sheets = [[]];
    render();
  });

  listEl.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) addRoom(Number(add.dataset.add));
  });

  // ==================== Клавиатура ====================

  window.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (st.mode !== 'free' || !st.sel) return;
    const it = findItem(st.sel);
    if (!it) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeItem(it.uid);
      return;
    }
    const step = e.shiftKey ? 0.2 : 1;
    const P = paper();
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    it.x = clamp(round(it.x + m[0], 2), 0, P.w);
    it.y = clamp(round(it.y + m[1], 2), 0, P.h);
    applyItem(it);
    syncInspector();
  });

  // ==================== Настройки ====================

  const SAVED = ['paper', 'pw', 'ph', 'orient', 'preset', 'custom', 'cols', 'rows',
                 'margin', 'gap', 'size', 'cuts', 'mode', 'zoom'];

  function save() {
    try {
      const out = {};
      SAVED.forEach(k => { out[k] = st[k]; });
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch { /* приватный режим — просто не запоминаем */ }
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      SAVED.forEach(k => { if (raw[k] !== undefined) st[k] = raw[k]; });
      // Формат мог исчезнуть из списка (так ушли Letter и Legal) — тогда
      // запомненное значение уже ни на что не ссылается, откатываемся на A4.
      if (st.paper !== 'custom' && !PAPERS[st.paper]) st.paper = 'a4';
      if (!PRESETS.includes(st.preset)) st.preset = 9;
      return Object.keys(raw).length > 0;
    } catch { return false; }
  }

  function syncControls() {
    $('paper').value  = st.paper;
    $('paperW').value = st.pw;
    $('paperH').value = st.ph;
    $('orient').value = st.orient;
    $('margin').value = st.margin;
    $('gap').value    = st.gap;
    $('size').value   = st.size;
    $('cuts').checked = st.cuts;
    $('cols').value   = st.cols;
    $('rows').value   = st.rows;
    $('zoom').value   = st.zoom;
    $('zoomVal').textContent = st.zoom + '%';

    $('customBox').classList.toggle('hidden', st.paper !== 'custom');
    $('customGrid').classList.toggle('hidden', !st.custom);
    $('addSheet').classList.toggle('hidden', st.mode !== 'free');
    // В сетке раскладывать нечего — там всё и так по местам
    $('arrange').classList.toggle('hidden', st.mode !== 'free');

    $('presets').querySelectorAll('button').forEach(b => {
      const isCustom = b.dataset.preset === 'custom';
      b.classList.toggle('on', isCustom ? st.custom : (!st.custom && Number(b.dataset.preset) === st.preset));
    });
    $('modes').querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === st.mode));
  }

  function update(fn) {
    fn();
    syncControls();
    save();
    render();
  }

  // --- кнопки пресетов ---
  const presetsEl = $('presets');
  PRESETS.forEach(n => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = n;
    b.textContent = n;
    b.title = `${n} наклеек на листе`;
    presetsEl.appendChild(b);
  });
  {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = 'custom';
    b.textContent = 'своя';
    b.title = 'Задать колонки и строки вручную';
    presetsEl.appendChild(b);
  }

  presetsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    update(() => {
      if (b.dataset.preset === 'custom') {
        st.custom = true;
      } else {
        st.custom = false;
        st.preset = Number(b.dataset.preset);
      }
    });
  });

  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.mode === st.mode) return;
    update(() => {
      if (b.dataset.mode === 'free') {
        arrangeToGrid();                 // свободный режим стартует с текущей раскладки
        st.mode = 'free';
      } else {
        st.items = slotsFromFree(geom());
        st.mode = 'grid';
        st.sel = null;
      }
    });
  });

  const num = (el, lo, hi, dflt) => {
    const v = parseFloat(el.value.replace(',', '.'));
    return Number.isFinite(v) ? clamp(v, lo, hi) : dflt;
  };

  $('paper').addEventListener('change', () => update(() => { st.paper = $('paper').value; }));
  $('orient').addEventListener('change', () => update(() => { st.orient = $('orient').value; }));
  $('paperW').addEventListener('input', () => update(() => { st.pw = num($('paperW'), 40, 1000, 210); }));
  $('paperH').addEventListener('input', () => update(() => { st.ph = num($('paperH'), 40, 1000, 297); }));
  $('margin').addEventListener('input', () => update(() => { st.margin = num($('margin'), 0, 40, 8); }));
  $('gap').addEventListener('input',    () => update(() => { st.gap    = num($('gap'), 0, 40, 4); }));
  $('size').addEventListener('input',   () => update(() => { st.size   = num($('size'), 20, 100, 100); }));
  $('cols').addEventListener('input',   () => update(() => { st.cols   = num($('cols'), 1, 20, 3); }));
  $('rows').addEventListener('input',   () => update(() => { st.rows   = num($('rows'), 1, 20, 3); }));
  $('cuts').addEventListener('change',  () => update(() => { st.cuts   = $('cuts').checked; }));
  // Масштаб предпросмотра не меняет раскладку, поэтому листы не пересобираем:
  // иначе на каждый шаг ползунка все QR перезапрашивались бы и моргали.
  $('zoom').addEventListener('input', () => {
    st.zoom = num($('zoom'), 20, 150, 100);
    applyZoom();
    save();
  });

  $('q').addEventListener('input', renderList);

  $('arrange').addEventListener('click', () => update(() => {
    if (st.mode === 'grid') return;      // в сетке и так всё разложено
    arrangeToGrid();
  }));

  $('addSheet').addEventListener('click', () => update(() => { st.sheets.push([]); }));

  $('clearAll').addEventListener('click', async () => {
    const yes = await ask({
      title: 'Убрать все наклейки с листов?',
      text: 'Листы станут пустыми. Аудитории из списка слева никуда не денутся — их можно добавить заново.',
    });
    if (yes) update(() => { st.items = []; st.sheets = [[]]; st.sel = null; });
  });

  // --- панель выбранной наклейки ---
  const insApply = (fn) => {
    const it = findItem(st.sel);
    if (!it) return;
    fn(it);
    applyItem(it);
    syncInspector();
  };
  const P = () => paper();

  $('insX').addEventListener('input', () => insApply(it => { it.x = clamp(num($('insX'), -500, 1000, it.x), 0, P().w); }));
  $('insY').addEventListener('input', () => insApply(it => { it.y = clamp(num($('insY'), -500, 1000, it.y), 0, P().h); }));
  $('insK').addEventListener('input', () => insApply(it => { it.k = round(num($('insK'), 10, 400, 100) / 100, 3); }));
  $('insR').addEventListener('input', () => insApply(it => { it.rot = num($('insR'), -360, 360, 0); }));

  $('inspector').addEventListener('click', (e) => {
    const rot = e.target.closest('[data-rot]');
    if (rot) insApply(it => { it.rot = (((it.rot + Number(rot.dataset.rot)) % 360) + 360) % 360; });
  });

  $('insCopy').addEventListener('click', () => {
    const it = findItem(st.sel);
    if (!it) return;
    const p = st.sheets.findIndex(s => s.includes(it));
    const copy = { ...it, uid: uid(), x: clamp(it.x + 6, 0, paper().w), y: clamp(it.y + 6, 0, paper().h) };
    st.sheets[p].push(copy);
    st.sel = copy.uid;
    render();
  });

  $('insDel').addEventListener('click', () => { if (st.sel) removeItem(st.sel); });

  // Перед печатью ждём картинки: без этого свежедобавленные QR могут уйти
  // в принтер пустыми рамками.
  $('doPrint').addEventListener('click', async () => {
    const imgs = [...sheetsEl.querySelectorAll('img')].filter(i => !i.complete);
    await Promise.all(imgs.map(i => i.decode().catch(() => {})));
    window.print();
  });

  // ==================== Старт ====================

  const hadSettings = load();
  st.items = PICKED.filter(id => byId.has(id)).map(id => ({ uid: uid(), roomId: id }));
  // Расстановка не сохраняется между заходами: набор наклеек каждый раз приходит
  // из выбора на странице /qr. Если прошлый раз закончили в свободном режиме —
  // раскладываем этот набор по сетке, дальше уже двигай мышью.
  if (st.mode === 'free') arrangeToGrid(st.items);

  // Первый заход: подбираем масштаб предпросмотра так, чтобы лист влез в окно
  if (!hadSettings) {
    const avail = Math.max(320, window.innerWidth - 260 - 60);
    const mmToPx = 96 / 25.4;
    st.zoom = clamp(Math.floor(avail / (paper().w * mmToPx) * 20) * 5, 20, 100);
  }

  syncControls();
  render();
})();
