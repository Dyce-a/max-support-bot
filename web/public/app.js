// Поведение поверх серверных страниц панели. Всё работает и без этого файла:
// ссылки и формы ведут себя обычным образом. Скрипт добавляет переходы между
// страницами без перезагрузки, живые фильтры и страницы списка, сохранение
// без перезагрузки и огонь у «Срочно».
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // «Уменьшить движение» в системе: гасим то, что ездит и прыгает; цвет и огонь оставляем
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = () => matchMedia('(max-width: 760px)').matches;
  const EASE = 'cubic-bezier(.2, 0, 0, 1)';
  const SPRING = 'cubic-bezier(.34, 1.36, .64, 1)';
  const pop = (el) => {
    if (el && !calm()) el.animate([{ transform: 'scale(.9)' }, { transform: 'scale(1.06)', offset: .6 }, { transform: 'none' }], { duration: 340, easing: EASE });
  };
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const here = () => location.pathname + location.search;
  const root = document.documentElement;

  // ---------- Всплывающие сообщения ----------
  function armToast(el) {
    const hide = () => { clearTimeout(timer); el.classList.add('is-hiding'); setTimeout(() => el.remove(), 300); };
    const timer = setTimeout(hide, 4500);
    el.addEventListener('click', hide);
  }
  function toast(text, isError = false) {
    $$('.flash').forEach(f => f.remove());
    const el = document.createElement('div');
    el.className = 'flash' + (isError ? ' is-error' : '');
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${isError ? 'i-x' : 'i-check'}"></use></svg><span></span>`;
    el.querySelector('span').textContent = text;
    document.body.appendChild(el);
    armToast(el);
  }
  // Сообщение из ответа сервера (после сохранения в фоне)
  const toastFrom = (doc) => { const t = doc.querySelector('.flash span'); if (t) toast(t.textContent); };

  // ---------- Тема ----------
  // Выбор кнопкой запоминается; без него — как в системе. Смена одним кадром:
  // снимок старой страницы перетекает в новую (View Transitions), а пока висит
  // theme-switching, переходы у элементов выключены — иначе кнопки перекрашивались бы пятнами
  const themeBtn = $('#theme-toggle');
  const effectiveTheme = () => root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const labelTheme = () => {
    if (!themeBtn) return;
    const t = effectiveTheme() === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
    themeBtn.title = t; themeBtn.setAttribute('aria-label', t);
  };
  labelTheme();
  themeBtn?.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    const apply = () => {
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch { /* приватный режим */ }
      labelTheme();
    };
    root.classList.add('theme-switching');
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
    if (!calm() && document.startViewTransition) {
      const vt = document.startViewTransition(apply);
      vt.ready.catch(() => {});   // анимацию перебил переход на другую страницу — тема всё равно сменится
      vt.finished.finally(done);
    } else { apply(); done(); }
  });

  // ---------- Ленты, которые листаются вбок ----------
  // Край гаснет только там, где за ним есть кнопки (--fl/--fr читает маска в CSS)
  function edgeFade(el) {
    const upd = () => {
      const rest = el.scrollWidth - el.clientWidth - el.scrollLeft;
      el.style.setProperty('--fl', el.scrollLeft > 2 ? '28px' : '0px');
      el.style.setProperty('--fr', rest > 2 ? '40px' : '0px');
    };
    el.addEventListener('scroll', upd, { passive: true });
    new ResizeObserver(upd).observe(el);
    upd();
  }
  // Кнопка — к центру ленты. Считаем вручную: scrollIntoView дёргал бы и страницу по вертикали
  const centerIn = (scroller, el, smooth = true) => {
    if (!el || scroller.scrollWidth <= scroller.clientWidth) return;
    const left = el.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    scroller.scrollTo({ left: left - (scroller.clientWidth - el.offsetWidth) / 2, behavior: smooth && !calm() ? 'smooth' : 'auto' });
  };

  // ---------- Бегунок у переключателей ----------
  // Подсветка выбранного варианта — отдельный слой, который переезжает к выбранной
  // кнопке, а не перескакивает. getActive возвращает выбранную кнопку.
  // Бегунки страницы собираются в pageThumbs и сбрасываются при переходе
  let pageThumbs = [];
  const allThumbs = [];
  function thumbify(group, getActive, list = pageThumbs) {
    const thumb = document.createElement('span');
    thumb.className = 'thumb'; thumb.setAttribute('aria-hidden', 'true');
    group.prepend(thumb); group.classList.add('has-thumb');
    let jump = true;
    const place = (instant) => {
      const b = getActive();
      thumb.style.opacity = b ? '' : '0';                    // ничего не выбрано — бегунка нет
      if (!b || !b.offsetWidth) { jump = true; return; }     // группа сейчас не видна
      if (instant || jump) thumb.style.transition = 'none';
      // Через getBoundingClientRect, а не offsetLeft: тот округляет до целых, и бегунок
      // стоял бы на полпикселя мимо. k — масштаб, если сама группа сейчас анимируется
      const br = b.getBoundingClientRect(), gr = group.getBoundingClientRect(), k = gr.width / group.offsetWidth || 1;
      const x = (br.left - gr.left) / k - group.clientLeft + group.scrollLeft;
      const y = (br.top - gr.top) / k - group.clientTop + group.scrollTop;
      const w = br.width / k;
      thumb.style.width = w + 'px';
      thumb.style.height = br.height / k + 'px';
      thumb.style.transform = `translate(${x}px, ${y}px)`;
      if (b.dataset.st) thumb.dataset.st = b.dataset.st;
      group.style.setProperty('--tx', x + w / 2 + 'px');
      if (instant || jump) { void thumb.offsetWidth; thumb.style.transition = ''; jump = false; }
    };
    new ResizeObserver(() => place(true)).observe(group);
    place(true);
    const t = { thumb, place };
    list.push(t);
    return t;
  }
  // Ширина кнопок меняется, когда догрузился шрифт, — бегунки встают заново
  document.fonts?.ready.then(() => [...allThumbs, ...pageThumbs].forEach(t => t.place(true)));
  const checkedOpt = (group) => () => $('input:checked', group)?.closest('.seg__opt');

  // Разделы в шапке: шапка при переходах остаётся на месте, и подсветка
  // раздела переезжает к новому пункту, а не перескакивает
  const nav = $('.topbar .nav');
  const navThumb = nav ? thumbify(nav, () => $('a[aria-current="page"]', nav), allThumbs) : null;

  // ---------- Шторки (телефон) ----------
  let sheetFrom = null;
  function openSheet(sheet) {
    if (!sheet) return;
    sheetFrom = document.activeElement;
    sheet.classList.add('is-open');
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    $('[data-scrim]')?.classList.add('is-open');
    setTimeout(() => $('select, input, textarea, button', sheet)?.focus({ preventScroll: true }), 60);
  }
  function closeSheets() {
    const open = $$('.sheet.is-open');
    if (!open.length) return;
    open.forEach(s => { s.classList.remove('is-open'); s.removeAttribute('role'); s.removeAttribute('aria-modal'); });
    if (!$('.drawer.is-open') || !mobile()) $('[data-scrim]')?.classList.remove('is-open');
    sheetFrom?.focus({ preventScroll: true });
  }
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-sheet-open]');
    if (opener) openSheet(document.getElementById(opener.dataset.sheetOpen));
    if (e.target.closest('[data-sheet-close]') || e.target.matches('[data-scrim]')) closeSheets();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

  // ---------- Список заявок: фильтры и страницы без перезагрузки ----------
  // Страница с новыми параметрами запрашивается в фоне, и из неё подменяются
  // блоки с data-live-part — счётчики и таблица. Фокус и курсор в поиске не
  // теряются. Адрес обновляется, чтобы F5 и «Назад» из заявки вернули тот же отбор.
  let list = null;
  // Последний открытый список: «← Заявки» в карточке вернёт к тому же отбору и странице
  let lastList = null;

  function initList() {
    list = null;
    const form = $('form[data-live-filter]');
    if (!form) return;
    // Номер страницы в отбор не входит: сменили фильтр — снова с первой страницы
    const query = () => {
      const params = new URLSearchParams();
      // Пустые поля в адрес не пишем: ссылка остаётся короткой
      for (const [k, v] of new FormData(form)) if (v) params.append(k, v);
      const qs = params.toString();
      return form.getAttribute('action') + (qs ? '?' + qs : '');
    };
    const filterBtn = $('.filterbtn', form);
    const markExtra = () => filterBtn?.classList.toggle('is-on',
      ['building_id', 'group_id', 'urgency'].some(n => form.elements[n]?.value));

    let current = query();
    let pending = null;
    let timer = null;

    // dir — куда листаем страницы: 1 вперёд, -1 назад, 0 — сменился отбор
    const load = async (url, dir = 0) => {
      if (pending) pending.abort();
      const ctrl = pending = new AbortController();
      form.setAttribute('aria-busy', 'true');
      const oldPager = $('[data-pager]');
      const fromX = oldPager ? pagerX(oldPager) : null;
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const doc = parse(await res.text());
        const parts = $$('[data-live-part]').map(was => [was, doc.querySelector(`[data-live-part="${was.dataset.livePart}"]`)]);
        if (!res.ok || !parts.length || parts.some(([, now]) => !now)) throw new Error('unexpected page');
        parts.forEach(([was, now]) => {
          if (was.id === 'tickets-table') flipTable(was, now, dir);
          else { was.replaceWith(now); if (was.textContent !== now.textContent && was.dataset.livePart === 'count') pop(now); }
        });
        history.replaceState(history.state, '', url);
        lastList = here();
      } catch (e) {
        if (e.name === 'AbortError') return;
        // Сессия истекла (пришла страница входа) или ошибка сервера — обычный переход разберётся
        location.href = url;
        return;
      }
      if (pending === ctrl) form.removeAttribute('aria-busy');
      const pager = $('[data-pager]');
      if (pager) pagerThumb(pager, fromX);
      // Листали внизу таблицы — показываем начало новой страницы
      if (dir) {
        const table = $('#tickets-table');
        const top = table.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(root).getPropertyValue('--topbar-h')) || 56) - 12;
        if (scrollY > top) scrollTo({ top, behavior: calm() ? 'auto' : 'smooth' });
      }
    };

    const apply = () => {
      clearTimeout(timer);
      markExtra();
      const url = query();
      // Поле поиска шлёт change при потере фокуса — тот же отбор повторно не грузим
      if (url === current) return;
      current = url;
      load(url);
    };

    form.addEventListener('change', apply);
    // Поиск — после паузы в наборе, а не на каждую букву
    form.addEventListener('input', (e) => {
      if (e.target.type !== 'text' && e.target.type !== 'search') return;
      clearTimeout(timer);
      timer = setTimeout(apply, 400);
    });
    // Enter в поле поиска — применить сразу, без перезагрузки страницы
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });

    // «Сбросить» — снять все флажки и поля на месте, без перехода
    const reset = () => {
      for (const el of form.elements) {
        if (el.type === 'checkbox') el.checked = false;
        else if (el.tagName === 'SELECT' || el.type === 'search' || el.type === 'text') el.value = '';
      }
      closeSheets();
      apply();
    };

    const pager = $('[data-pager]');
    if (pager) pagerThumb(pager);
    list = { load, reset };
  }
  document.addEventListener('click', (e) => {
    if (!list) return;
    if (e.target.closest('[data-reset]')) { e.preventDefault(); list.reset(); return; }
    const pg = e.target.closest('[data-pager] a[data-page]');
    if (pg && !e.ctrlKey && !e.metaKey && !e.shiftKey && pg.getAttribute('aria-current') !== 'page') {
      e.preventDefault();
      const cur = Number($('[data-pager] [aria-current="page"]')?.dataset.page) || 1;
      list.load(pg.getAttribute('href'), Number(pg.dataset.page) > cur ? 1 : -1);
    }
  });

  // Подсветка текущей страницы под номерами — тот же бегунок, что у переключателей.
  // Номера приходят с сервера новой разметкой, поэтому бегунок ставится заново
  // и выезжает из того места, где стоял старый (fromX — его сдвиг внутри ряда)
  const pagerX = (pager) => {
    const cur = $('[aria-current="page"]', pager);
    return cur ? cur.getBoundingClientRect().left - pager.getBoundingClientRect().left : null;
  };
  function pagerThumb(pager, fromX = null) {
    const cur = $('[aria-current="page"]', pager);
    if (!cur) return;
    const th = document.createElement('span');
    th.className = 'pager__thumb'; th.setAttribute('aria-hidden', 'true');
    pager.prepend(th); pager.classList.add('has-thumb');
    const x = pagerX(pager);
    Object.assign(th.style, { width: cur.offsetWidth + 'px', height: cur.offsetHeight + 'px', transform: `translateX(${x}px)` });
    if (fromX != null && fromX !== x && !calm()) {
      th.animate([{ transform: `translateX(${fromX}px)` }, { transform: `translateX(${x}px)` }], { duration: 380, easing: SPRING });
    }
  }

  // Плавная перестановка строк: оставшиеся съезжают на новые места, лишние тают,
  // новые проявляются, а сама таблица меняет высоту без рывка. При листании
  // страниц (dir) новые строки въезжают с той стороны, куда листали
  function flipTable(oldEl, newEl, dir = 0) {
    const oldRows = $$('[data-key]', oldEl);
    if (calm() || oldRows.length + $$('[data-key]', newEl).length > 240) { oldEl.replaceWith(newEl); return; }
    const before = new Map(oldRows.map(r => [r.dataset.key, r.getBoundingClientRect()]));
    const foot = $('.tfoot, .empty', oldEl)?.getBoundingClientRect();
    const h0 = oldEl.getBoundingClientRect().height;
    oldEl.replaceWith(newEl);
    const cr = newEl.getBoundingClientRect();
    const keep = new Set();
    const enter = dir ? `translateX(${dir * 28}px)` : 'translateY(8px) scale(.98)';
    let k = 0;
    $$('[data-key]', newEl).forEach(row => {
      const b = before.get(row.dataset.key);
      if (b) {
        keep.add(row.dataset.key);
        const dy = b.top - row.getBoundingClientRect().top;
        if (Math.abs(dy) > .5) row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
      } else {
        row.animate([{ opacity: 0, transform: enter }, { opacity: 1, transform: 'none' }],
          { duration: 300, delay: 60 + Math.min(k++, 10) * 22, easing: EASE, fill: 'backwards' });
      }
    });
    // Ушедшие строки: копия на старом месте тает под живыми строками
    oldRows.forEach(row => {
      if (keep.has(row.dataset.key)) return;
      const b = before.get(row.dataset.key);
      const g = row.cloneNode(true);
      g.removeAttribute('href'); g.removeAttribute('data-key'); g.setAttribute('aria-hidden', 'true'); g.inert = true;
      Object.assign(g.style, {
        position: 'absolute', margin: '0', pointerEvents: 'none', zIndex: '-1',
        left: (b.left - cr.left - newEl.clientLeft) + 'px', top: (b.top - cr.top - newEl.clientTop) + 'px',
        width: b.width + 'px', height: b.height + 'px',
      });
      newEl.appendChild(g);
      g.animate([{ opacity: 1 }, { opacity: 0, transform: dir ? `translateX(${dir * -20}px)` : 'scale(.97)' }],
        { duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' })
        .finished.finally(() => g.remove());
    });
    const newFoot = $('.tfoot, .empty', newEl);
    if (newFoot && foot) {
      const dy = foot.top - newFoot.getBoundingClientRect().top;
      if (Math.abs(dy) > .5) newFoot.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
    }
    if (Math.abs(h0 - cr.height) > .5) newEl.animate([{ height: h0 + 'px' }, { height: cr.height + 'px' }], { duration: 320, easing: EASE });
  }

  // ---------- Срочность: огонь вокруг кнопки ----------
  // Частицы рисуются на холсте за кнопками: пламя выбивается из-за бегунка
  // сверху и по бокам, искры летят выше. В тёмной теме частицы складываются
  // светом (сгустки становятся жёлто-белыми), в светлой — обычным наложением,
  // иначе на белом огонь бледнеет до невидимости
  function createFire(seg, thumb) {
    const cv = document.createElement('canvas');
    cv.className = 'urg-fire'; cv.setAttribute('aria-hidden', 'true');
    seg.prepend(cv);
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, dpr = 1;
    const size = () => {
      W = cv.clientWidth; H = cv.clientHeight; dpr = Math.min(2, devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
    };
    new ResizeObserver(size).observe(seg);
    size();

    // Круглое пятно с мягким краем; c2 — цвет края, у него альфа растёт с 0 до .18 к середине радиуса
    const sprite = (c0, c1, c2) => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, c0); gr.addColorStop(.38, c1); gr.addColorStop(.72, c2.slice(0, c2.lastIndexOf(',')) + ',.18)'); gr.addColorStop(1, c2);
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      return c;
    };
    const SPR = {
      hot: sprite('rgba(255,246,196,1)', 'rgba(255,196,80,.62)', 'rgba(255,140,0,0)'),
      orange: sprite('rgba(255,168,56,1)', 'rgba(255,104,20,.55)', 'rgba(255,60,0,0)'),
      red: sprite('rgba(238,58,22,.95)', 'rgba(196,28,10,.45)', 'rgba(150,10,0,0)'),
      smoke: sprite('rgba(128,128,138,.55)', 'rgba(128,128,138,.24)', 'rgba(128,128,138,0)'),
      spark: sprite('rgba(255,255,232,1)', 'rgba(255,222,120,.75)', 'rgba(255,160,40,0)'),
    };

    const P = [], S = [], K = [];
    // Множитель прозрачности у краёв холста: у верха и боков частица тает, а не обрезается
    const edge = (p) => Math.max(0, Math.min(1, p.y / 22, p.x / 16, (W - p.x) / 16));
    const rnd = (a, b) => a + Math.random() * (b - a);
    let level = seg.dataset.level, raf = 0, last = 0, visible = false, dark = false, darkAt = -1e9, fAcc = 0, sAcc = 0;
    // heat — сила огня от 0 до 1. Огонь не включается рывком, а разгорается
    // (~1.2 с, сначала робкие язычки) и так же затухает (~0.7 с).
    // anchor — где огонь догорает: бегунок уже уехал на другой уровень, а пламя остаётся на «Срочно»
    let heat = 0, anchor = null;
    // soft — в системе включено «уменьшить движение»: огонь тише и без искр, но не пропадает
    let soft = false;
    const box = (el = thumb) => {
      const r = el.getBoundingClientRect(), c = cv.getBoundingClientRect();
      return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
    };
    function emitFlame(b, n, t, e = 1) {
      // e — текущая сила огня: слабый огонь ниже, мельче и медленнее
      const boost = .4 + .6 * e, grow = .55 + .45 * e;
      for (let i = 0; i < n; i++) {
        const side = Math.random();
        let x, y;
        if (side < .7) { x = rnd(b.x + 3, b.x + b.w - 3); y = b.y + rnd(3, b.h * .6); }   // верхний край, из-за кнопки
        else if (side < .85) { x = b.x + rnd(-3, 4); y = b.y + rnd(5, b.h - 3); }          // левый бок
        else { x = b.x + b.w + rnd(-4, 3); y = b.y + rnd(5, b.h - 3); }                    // правый бок
        // Языки: по ширине кнопки пламя то выше, то ниже, и эта «гребёнка» всё время гуляет
        const tongue = .75 + .55 * Math.sin(x * .13 + t * 7.3) * Math.sin(x * .051 - t * 4.1);
        const cx = b.x + b.w / 2;
        P.push({ x, y, vx: (cx - x) * rnd(.35, .8) + rnd(-8, 8), vy: -rnd(50, 105) * tongue * boost,
          life: 1, decay: rnd(1.8, 2.9), size: rnd(12, 19) * (.8 + .3 * tongue) * grow, ph: rnd(0, 6.3), sway: rnd(6, 16) });
      }
    }
    function emitSpark(b, n, boost = 1) {
      for (let i = 0; i < n; i++) {
        S.push({ x: rnd(b.x + 4, b.x + b.w - 4), y: b.y + rnd(0, 6), vx: rnd(-22, 22), vy: -rnd(70, 150) * boost,
          life: 1, decay: rnd(.6, 1.1), ph: rnd(0, 6.3), r: rnd(.9, 1.8) });
      }
    }
    function puff(b, n) {
      for (let i = 0; i < n; i++) {
        K.push({ x: rnd(b.x + 4, b.x + b.w - 4), y: b.y + rnd(0, b.h * .6), vx: rnd(-16, 16), vy: -rnd(18, 48),
          life: 1, decay: rnd(.7, 1.1), size: rnd(10, 18) });
      }
    }
    function frame(ms) {
      raf = 0;
      // Карточку заявки уже сменила другая страница — холст больше не нужен
      if (!cv.isConnected) return;
      // real — сколько прошло на самом деле. Частицы считаем по урезанному dt (после
      // паузы вкладки не должно быть скачка), а разгорание — по настоящему времени:
      // иначе при редких кадрах огонь разгорался бы в разы дольше
      const real = last ? Math.max(0, (ms - last) / 1000) : 1 / 60; last = ms;
      const dt = Math.min(.05, real);
      const t = ms / 1000;
      if (ms - darkAt > 400) {
        dark = getComputedStyle(root).colorScheme.includes('dark');
        soft = calm(); darkAt = ms;
      }
      heat = level === 'critical' ? Math.min(1, heat + Math.min(.25, real) / 1.2) : Math.max(0, heat - Math.min(.25, real) / .7);
      const e = heat * heat * (3 - 2 * heat);                       // плавный старт и плавный выход на полную силу
      const b = level === 'critical' ? box() : (anchor || box());
      if (visible && b.w) {
        fAcc += dt * 380 * e * (soft ? .5 : 1);
        sAcc += soft ? 0 : dt * (14 * e + (level === 'high' ? 6 : 0));     // «Высокая» только тлеет: редкие угольки, без пламени
        const nf = fAcc | 0, ns = sAcc | 0; fAcc -= nf; sAcc -= ns;
        if (nf) emitFlame(b, nf, t, e);
        if (ns) emitSpark(level === 'high' ? box() : b, ns, level === 'critical' ? .5 + .5 * e : .55);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      ctx.globalCompositeOperation = 'source-over';
      for (let i = K.length - 1; i >= 0; i--) {
        const p = K[i];
        p.life -= p.decay * dt; if (p.life <= 0) { K.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt;
        const s = p.size * (1 + (1 - p.life) * 1.8);
        ctx.globalAlpha = p.life * (dark ? .35 : .5) * edge(p);
        ctx.drawImage(SPR.smoke, p.x - s, p.y - s, s * 2, s * 2);
      }

      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        p.life -= p.decay * dt; if (p.life <= 0) { P.splice(i, 1); continue; }
        p.vy -= 40 * dt;                                         // горячее тянет вверх всё быстрее
        p.x += (p.vx + Math.sin(t * 9 + p.ph) * p.sway * (1 - p.life)) * dt;
        p.y += p.vy * dt;
        const k = p.life, s = p.size * (.35 + .65 * k);
        const img = dark ? (k > .5 ? SPR.orange : SPR.red) : (k > .62 ? SPR.hot : k > .28 ? SPR.orange : SPR.red);
        ctx.globalAlpha = Math.pow(Math.sin(Math.PI * k), .6) * (dark ? .62 : .85) * edge(p);
        ctx.drawImage(img, p.x - s, p.y - s, s * 2, s * 2);
      }
      for (let i = S.length - 1; i >= 0; i--) {
        const p = S[i];
        p.life -= p.decay * dt; if (p.life <= 0) { S.splice(i, 1); continue; }
        p.vx += Math.sin(t * 6 + p.ph) * 60 * dt; p.vy *= 1 - .5 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const s = p.r * (dark ? 3.2 : 2.2);
        ctx.globalAlpha = Math.min(1, p.life * 1.6) * edge(p);
        ctx.drawImage(dark ? SPR.spark : SPR.orange, p.x - s, p.y - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
      const burning = visible && (level === 'critical' || level === 'high' || heat > 0);
      if (burning || P.length || S.length || K.length) raf = requestAnimationFrame(frame);
      else { last = 0; ctx.clearRect(0, 0, W, H); }
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }).observe(seg);
    return {
      set(next) {
        const prev = level; level = next;
        if (!visible) return;
        if (prev === 'critical' && next !== 'critical') {
          // Бегунок только начал уезжать — его прямоугольник ещё на «Срочно»: там огонь и догорит
          anchor = box();
          puff(anchor, Math.round(18 * heat));                                   // потушили — остаётся дымок
        }
        if (next === 'critical') anchor = null;
        kick();
      },
    };
  }

  // ---------- Карточка заявки ----------
  function initTicket() {
    const tform = $('form[data-ticket-form]');
    if (!tform) return;
    // «← Заявки» возвращает к тому же отбору и странице, с которых открыли заявку.
    // Пришли из списка внутри панели — помним его сами; открыли заявку по ссылке
    // с другой страницы — смотрим, откуда пришли
    const back = $('[data-back]');
    try {
      const ref = lastList ? new URL(lastList, location.href) : new URL(document.referrer);
      if (back && ref.origin === location.origin && ref.pathname === '/tickets') back.href = ref.pathname + ref.search;
    } catch { /* пустой referrer */ }

    const bar = $('.statusbar', tform);
    const stThumb = thumbify(bar, () => $('.stbtn[aria-pressed="true"]', bar));
    const useg = $('.urgseg', tform);
    const urgThumb = thumbify(useg, checkedOpt(useg));
    const fire = createFire(useg, urgThumb.thumb);

    // «Сохранить» активна, только когда исполнитель или привязка правда изменились
    const saveBtn = $('[data-action="assign"]', tform);
    const dirtyEls = $$('[data-dirty]', tform);
    const saved = new Map(dirtyEls.map(el => [el, el.value]));
    const refreshDirty = () => { saveBtn.disabled = dirtyEls.every(el => el.value === saved.get(el)); };
    dirtyEls.forEach(el => el.addEventListener('change', refreshDirty));
    refreshDirty();
    const note = tform.elements.comment_add;
    const noteBtn = $('[data-action="note"]', tform);
    const refreshNote = () => { noteBtn.disabled = !note.value.trim(); };
    note.addEventListener('input', refreshNote);
    refreshNote();

    // Сохранения идут по очереди: два быстрых клика не обгоняют друг друга
    let chain = Promise.resolve();
    const save = (fields, busy) => (chain = chain.then(() => send(fields, busy)));
    async function send(fields, busy) {
      busy?.classList.add('is-busy');
      try {
        const res = await fetch(tform.action, { method: 'POST', body: new URLSearchParams(fields) });
        if (new URL(res.url).pathname === '/login') { location.href = '/login'; return false; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        applyTicket(parse(await res.text()));
        return true;
      } catch {
        toast('Не сохранилось — нет связи с сервером. Обновляю страницу…', true);
        setTimeout(() => location.reload(), 1800);
        return false;
      } finally {
        busy?.classList.remove('is-busy');
      }
    }
    // Ответ сервера — свежая страница заявки: берём из неё шапку и историю
    function applyTicket(doc) {
      const head = $('[data-live-part="head"]'), newHead = doc.querySelector('[data-live-part="head"]');
      if (head && newHead) {
        const oldPill = $('.pill', head)?.textContent, oldUrg = $('.urg', head)?.textContent;
        head.replaceWith(newHead);
        if ($('.pill', newHead)?.textContent !== oldPill) pop($('.pill', newHead));
        if ($('.urg', newHead) && $('.urg', newHead).textContent !== oldUrg) pop($('.urg', newHead));
      }
      const journal = $('[data-live-part="journal"]'), newJournal = doc.querySelector('[data-live-part="journal"]');
      if (journal && newJournal) {
        const had = new Set($$('[data-key]', journal).map(li => li.dataset.key));
        journal.replaceWith(newJournal);
        if (!calm()) {
          $$('[data-key]', newJournal).filter(li => !had.has(li.dataset.key)).forEach((li, i) => {
            li.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
              { duration: 320, delay: i * 60, easing: EASE, fill: 'backwards' });
            pop($('.tl-dot', li));
          });
        }
      }
      toastFrom(doc);
    }

    // Какая кнопка отправила форму (e.submitter есть не во всех браузерах)
    let lastSubmitter = null;
    tform.addEventListener('click', (e) => { lastSubmitter = e.target.closest('button[type="submit"]'); });
    tform.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || lastSubmitter;
      if (!btn) return;
      if (btn.classList.contains('stbtn')) {
        if (btn.getAttribute('aria-pressed') === 'true') return;
        $$('.stbtn', bar).forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
        stThumb.place();
        centerIn(bar, btn);
        save({ status: btn.value });
      } else if (btn.dataset.action === 'assign') {
        const fields = Object.fromEntries(dirtyEls.map(el => [el.name, el.value]));
        if (await save(fields, btn)) { dirtyEls.forEach(el => saved.set(el, el.value)); refreshDirty(); }
      } else if (btn.dataset.action === 'note') {
        const text = note.value.trim();
        if (!text) { note.focus(); return; }
        if (await save({ comment_add: text }, btn)) { note.value = ''; refreshNote(); }
      }
    });

    // Срочность сохраняется сразу. Картинка меняется мгновенно, запрос — после
    // короткой паузы: стрелками с клавиатуры можно пролистать уровни, не отправляя каждый
    let urgTimer = null;
    useg.addEventListener('change', (e) => {
      if (e.target.name !== 'urgency') return;
      useg.dataset.level = e.target.value;
      urgThumb.place();
      fire.set(e.target.value);
      clearTimeout(urgTimer);
      urgTimer = setTimeout(() => save({ urgency: e.target.value }), 350);
    });
  }

  // ---------- Пользователи ----------
  let users = null;
  const drawer = () => $('#user-drawer');
  const syncScrim = () => $('[data-scrim]')?.classList.toggle('is-open', mobile() && drawer()?.classList.contains('is-open'));
  function initUsers() {
    users = null;
    const rows = $('#user-rows');
    if (!rows) return;
    const search = $('[data-user-search]');
    const filterUsers = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      $$('.ur[data-user]').forEach(r => { r.hidden = !!q && !r.dataset.search.includes(q); if (!r.hidden) shown++; });
      const empty = $('[data-search-empty]');
      if (empty) empty.hidden = shown > 0;
    };
    search?.addEventListener('input', filterUsers);
    users = { rows, search, filterUsers };
    initDrawer();
  }
  function initDrawer() {
    const seg = $('#user-drawer .seg');
    const roleThumb = seg ? thumbify(seg, checkedOpt(seg)) : null;
    seg?.addEventListener('change', () => roleThumb.place());
    syncScrim();
  }
  // Подмена карточки справа (и списка — после сохранения) из свежей страницы
  function applyUsers(doc, url, withRows = false) {
    const fresh = doc.querySelector('#user-drawer');
    if (!fresh) throw new Error('unexpected page');
    drawer().replaceWith(fresh);
    const rows = doc.querySelector('#user-rows');
    if (rows && withRows) users.rows.replaceChildren(...rows.childNodes);
    const id = new URL(url, location.href).searchParams.get('u');
    $$('.ur[data-user]').forEach(r => (r.dataset.user === id ? r.setAttribute('aria-current', 'true') : r.removeAttribute('aria-current')));
    if (users.search?.value) users.filterUsers();
    initDrawer();
    if (!calm() && !mobile()) {
      fresh.animate([{ opacity: .3, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE });
    }
  }
  async function openUser(url) {
    try {
      const res = await fetch(url);
      if (new URL(res.url).pathname === '/login') { location.href = '/login'; return; }
      applyUsers(parse(await res.text()), url);
      history.replaceState(history.state, '', url);
    } catch { location.href = url; }
  }
  document.addEventListener('click', (e) => {
    if (!users) return;
    const row = e.target.closest('.ur[data-user]');
    if (row && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); openUser(row.getAttribute('href')); return; }
    if (e.target.closest('[data-drawer-close]') || (e.target.matches('[data-scrim]') && drawer()?.classList.contains('is-open'))) {
      e.preventDefault();
      if (mobile()) {
        drawer().classList.remove('is-open'); syncScrim();
        $$('.ur[aria-current]').forEach(r => r.removeAttribute('aria-current'));
        history.replaceState(history.state, '', '/users');
      } else {
        openUser('/users');
      }
    }
  });
  // Сохранение роли и групп — в фоне: список и карточка обновляются на месте
  document.addEventListener('submit', async (e) => {
    const form = users && e.target.closest('#user-drawer form');
    if (!form) return;
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    btn?.classList.add('is-busy');
    try {
      const res = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)) });
      if (new URL(res.url).pathname === '/login') { location.href = '/login'; return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = parse(await res.text());
      applyUsers(doc, res.url, true);
      history.replaceState(history.state, '', new URL(res.url).pathname + new URL(res.url).search);
      toastFrom(doc);
    } catch {
      form.submit();
    }
  });
  addEventListener('keydown', (e) => {
    if (users && e.key === 'Escape' && mobile() && drawer()?.classList.contains('is-open')) $('[data-drawer-close]')?.click();
  });

  // ---------- Переходы между страницами без перезагрузки ----------
  // Ссылки и формы панели не перезагружают страницу: новая запрашивается в фоне,
  // и подменяется только <main>. Шапка стоит на месте, а содержимое перетекает
  // через View Transitions — и в Firefox тоже, где переходы между отдельными
  // загрузками страниц не анимируются, и раньше каждый клик мигал белым.
  // Адреса остаются настоящими: F5, «Назад» и закладки работают как прежде.
  // Свои адреса, которые не страницы панели: картинки QR, лист печати, сканер, вход и выход
  const SKIP = /^\/(qr\/(png|svg|print)|s\/|scan|api\/|vendor\/|fonts\/|login|logout)/;
  let navCtrl = null;
  let navSeq = 0;
  // Какая страница сейчас на экране. При «Назад» адрес уже новый, а откуда
  // уходим (для направления и перелёта номера), знает только эта переменная
  let shown = here();

  // Прокрутку при «Назад» возвращаем сами: браузер не знает, что страница сменилась
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const saveScroll = () => history.replaceState({ ...history.state, scroll: scrollY }, '');
  addEventListener('pagehide', saveScroll);
  if (history.state?.scroll) scrollTo(0, history.state.scroll);

  // Глубже (список → заявка) — новая страница въезжает справа, обратно — слева,
  // между разделами — просто проявляется
  const depth = (path) => path.split('/').filter(Boolean).length;
  const direction = (from, to) => {
    const a = new URL(from, location.href).pathname, b = new URL(to, location.href).pathname;
    if (a.split('/')[1] !== b.split('/')[1]) return 'swap';
    return depth(b) > depth(a) ? 'forward' : depth(b) < depth(a) ? 'back' : 'swap';
  };

  // Номер и статус заявки перелетают из строки списка в шапку карточки и обратно.
  // Имена для перехода ставим только на одну пару элементов: повтор имени ломает переход
  const MORPH = [['.t-no', '.tk-head h1 .mono', 'tk-no'], ['.t-st .pill', '.tk-head .pill', 'tk-pill']];
  const named = [];
  const nameEls = (pairs) => pairs.forEach(([el, name]) => { if (el) { el.style.viewTransitionName = name; named.push(el); } });
  // inHead — элементы из шапки карточки, иначе из строки этой заявки в списке
  function morphPairs(scope, id, inHead) {
    const row = inHead ? null : $(`.tr[data-key="${id}"]`, scope);
    return MORPH.map(([inRow, head, name]) => [inHead ? $(head, scope) : row && $(inRow, row), name]);
  }
  const ticketId = (url) => new URL(url, location.href).pathname.match(/^\/tickets\/(\d+)$/)?.[1];

  // Скрипты внутри подменённой страницы сами не запускаются — пересоздаём их
  function runScripts(scope) {
    $$('script', scope).forEach(old => {
      if (old.type && old.type !== 'text/javascript' && old.type !== 'module') return;   // данные (application/json)
      const s = document.createElement('script');
      [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
      s.textContent = old.textContent;
      old.replaceWith(s);
    });
  }
  // Подсветка раздела в шапке и в нижнем меню — как на новой странице
  function syncNav(doc) {
    ['.topbar .nav', '.bottomnav'].forEach(sel => {
      const was = $$(`${sel} a`), now = [...doc.querySelectorAll(`${sel} a`)];
      was.forEach((a, i) => (now[i]?.hasAttribute('aria-current') ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    });
    navThumb?.place();
  }

  async function go(url, { method = 'GET', body = null, push = true, scroll = 0, dir = 'swap', from = here() } = {}) {
    navCtrl?.abort();
    const ctrl = navCtrl = new AbortController();
    // Полоска загрузки — только если ответ задержался: на быстрых переходах она бы мелькала
    const slow = setTimeout(() => root.classList.add('is-loading'), 150);
    let res, html;
    try {
      res = await fetch(url, { method, body, signal: ctrl.signal });
      html = await res.text();
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (method === 'GET') location.href = url;
      else toast('Не сохранилось — нет связи с сервером', true);
      return;
    } finally {
      clearTimeout(slow);
      if (navCtrl === ctrl) root.classList.remove('is-loading');
    }
    if (navCtrl !== ctrl) return;

    const doc = parse(html);
    const main = doc.querySelector('main.container');
    // Пришла не страница панели: вход (сессия истекла), текст ошибки и т. п.
    if (!(res.headers.get('content-type') || '').includes('text/html') || !main || !doc.querySelector('.topbar')) {
      if (method === 'GET') { location.href = res.url; return; }
      // Ответ на отправку формы показываем как есть — повторять её нельзя
      document.open(); document.write(html); document.close();
      return;
    }

    const fin = new URL(res.url);
    const to = fin.pathname + fin.search;
    if (push && to !== from) {
      saveScroll();
      history.pushState({ prev: from }, '', to);
    } else if (to !== here()) {
      history.replaceState(history.state, '', to);
    }

    // Перелёт номера и статуса — только между списком и карточкой одной заявки
    const id = ticketId(to) || ticketId(from);
    const morph = !calm() && document.startViewTransition && id &&
      ((ticketId(to) && new URL(from, location.href).pathname === '/tickets') || (ticketId(from) && fin.pathname === '/tickets'));
    if (morph) nameEls(morphPairs(document, id, !!ticketId(from)));

    const swap = () => {
      document.title = doc.title;
      if (document.startViewTransition) main.style.animation = 'none';   // проявление делает сам переход
      $('main.container').replaceWith(main);
      shown = here();
      syncNav(doc);
      scrollTo(0, scroll);
      runScripts(main);
      initPage();
      if (morph) {
        named.splice(0).forEach(el => (el.style.viewTransitionName = ''));
        nameEls(morphPairs(main, id, !!ticketId(to)));
      }
    };
    if (!document.startViewTransition) { swap(); return; }
    const seq = ++navSeq;
    root.dataset.nav = dir;
    const vt = document.startViewTransition(swap);
    // ready отклоняется, когда анимацию пропустили (её перебил следующий клик), —
    // страница при этом всё равно подменяется, это не ошибка
    vt.ready.catch(() => {});
    const cleanup = () => {
      if (seq !== navSeq) return;   // следом начался другой переход — его метки не трогаем
      delete root.dataset.nav;
      named.splice(0).forEach(el => (el.style.viewTransitionName = ''));
    };
    vt.finished.then(cleanup, (e) => {
      cleanup();
      // Подменить не вышло — пусть браузер просто откроет страницу
      if (!main.isConnected) { console.error('Переход не удался:', e); location.href = to; }
    });
  }

  // Ссылки: только свои страницы панели, в этой же вкладке и без клавиш-модификаторов
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || !$('.topbar') || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || SKIP.test(url.pathname)) return;
    if (url.pathname + url.search === here() && url.hash) return;   // якорь на этой же странице
    e.preventDefault();
    // «← Заявки» туда, откуда пришли, — это шаг назад по истории: вернётся и прокрутка
    if (a.matches('[data-back]') && history.state?.prev === url.pathname + url.search) { history.back(); return; }
    go(url.pathname + url.search, { dir: a.matches('[data-back]') ? 'back' : direction(here(), url.href) });
  });

  // Формы, которые не забрал себе никакой обработчик выше (справочники, QR, пароль)
  document.addEventListener('submit', (e) => {
    if (e.defaultPrevented || !$('.topbar')) return;
    const form = e.target;
    const btn = e.submitter;
    const target = btn?.getAttribute('formtarget') ?? form.getAttribute('target');
    if (target && target !== '_self') return;
    const method = (btn?.getAttribute('formmethod') || form.getAttribute('method') || 'get').toUpperCase();
    const url = new URL(btn?.getAttribute('formaction') || form.getAttribute('action') || here(), location.href);
    if (url.origin !== location.origin || SKIP.test(url.pathname) || form.enctype === 'multipart/form-data') return;
    let data;
    try { data = new FormData(form, btn); } catch {
      data = new FormData(form);
      if (btn?.name) data.append(btn.name, btn.value);
    }
    e.preventDefault();
    if (method === 'GET') {
      url.search = new URLSearchParams(data).toString();
      go(url.pathname + url.search);
    } else {
      // Сохранили и остались на той же странице — прокрутку не сбрасываем
      const stay = url.pathname === location.pathname;
      go(url.pathname + url.search, { method, body: new URLSearchParams(data), scroll: stay ? scrollY : 0 });
    }
  });

  addEventListener('popstate', (e) => {
    if (!$('.topbar')) { location.reload(); return; }
    go(here(), { push: false, scroll: e.state?.scroll || 0, from: shown, dir: direction(shown, location.href) });
  });

  // ---------- Запуск частей страницы ----------
  // При первой загрузке и после каждого перехода: подменённая страница —
  // новые элементы, и всё, что на них висело, ставится заново
  function initPage() {
    pageThumbs = [];
    const main = $('main.container') || document.body;
    $$('.flash', main).forEach(armToast);
    $$('.hscroll', main).forEach(el => {
      edgeFade(el);
      centerIn(el, $('[aria-current="page"], [aria-pressed="true"]', el), false);
    });
    if (location.pathname === '/tickets') lastList = here();
    initList();
    initTicket();
    initUsers();
  }
  initPage();
})();
