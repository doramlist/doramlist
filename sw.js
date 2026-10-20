/* =========================================================
   Service worker DoramList.

   Задачи ровно две:
     1) сделать приложение ставимым (для установки нужен SW с
        обработчиком fetch — без него Chrome не покажет промпт);
     2) не дать интерфейсу «застыть» на тостах при смене сети.

   Что НЕ кешируем и почему:
     • запросы к kodik-api.com — каталог на 66 570 записей, отдаётся
       постранично, ссылки-токены в URL и срок жизни короткий.
       Кеш здесь только вредит: показывал бы устаревшую выдачу и
       съедал бы квоту места на устройстве;
     • TMDB (find/images) — то же самое, полезнее грузить свежим;
     • прокси allorigins — чужие, ответы нестабильны, кеш только
       в память уйдёт.
   Кешируем только картинки (постеры, фоны, логотипы) — они
   иммутабельны по URL и составляют весь вес страницы.
   ========================================================= */

const VERSION = '1.4.0';
const SHELL_CACHE = 'dorama-shell-' + VERSION;
const IMG_CACHE = 'dorama-img-' + VERSION;

/* оболочка: всё, без чего приложение не запустится офлайн */
const SHELL = [
  './',
  './index.html',
  './404.html',
  './app.locked.js',
  './style.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

/* Максимум картинок в кеше. Мобильные браузеры начинают выкидывать
   записи молча при нехватке места — 120 картинок примерно 15–25 МБ,
   для каталога с постерами этого достаточно, а нагрузка не уходит. */
const IMG_LIMIT = 120;

/* Сайт работает на своих доменах: на чужом worker ничего не кеширует
   и снимает себя с регистрации. Список тот же, что в app.js. */
const ALLOWED_HOSTS = [
  'doramlist.github.io',
  'www.doramlist.github.io',
  'vkader.ucoz.net',
  'www.vkader.ucoz.net',
  'localhost',
  '127.0.0.1'
];

function hostAllowed() {
  var h = String(self.location.hostname || '').toLowerCase();
  while (h.length > 1 && h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
  return ALLOWED_HOSTS.indexOf(h) !== -1;
}

self.addEventListener('install', (e) => {
  if (!hostAllowed()) {
    self.registration.unregister();
    return;
  }
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* addAll падает целиком, если хоть один файл недоступен (например,
       при file:// или без сети). Кладём по одному — оболочка соберётся
       из того, что реально отдалось. */
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] не закэширован', url, err.message);
      }
    }));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('dorama-') && k !== SHELL_CACHE && k !== IMG_CACHE)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

/* Картинка: сперва кеш, при промахе — сеть и доливка */
async function imageStrategy(req) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;

  try {
    const res = await fetch(req);
    /* кладём только успешные ответы и только картинки/шрифты:
       ошибка и редирект в кеш попадать не должны */
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
      cache.put(req, res.clone()).catch(() => {});
      trim(cache, IMG_LIMIT);
    }
    return res;
  } catch (err) {
    return Response.error();
  }
}

/* Статика приложения: сначала сеть (чтобы подхватить правки),
   при оффлайне — кеш. Stale-while-revalidate не годится: файл
   содержит логику, и устаревшая версия может сломать разметку. */
async function shellStrategy(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = (await cache.match(req)) ||
                (await cache.match('./index.html'));
    if (hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Нет сети</title>' +
      '<body style="margin:0;display:grid;place-items:center;height:100vh;' +
      'background:#12171d;color:#e9eff6;font:15px system-ui;text-align:center">' +
      'Нет соединения и приложение ещё не сохранено</body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* Кэш с ограничением размера. Cache API не умеет считать сам,
   поэтому держим порядок вставки и подрезаем хвост. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map(k => cache.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* чужие домены: kodik, TMDB, прокси, CDN картинок.
     Картинки кешируем, остальное — мимо, свежим. */
  if (url.origin !== self.location.origin) {
    if (req.destination === 'image') e.respondWith(imageStrategy(req));
    return;                       /* без respondWith — уходит в сеть как обычно */
  }

  /* Навигация: адресов два — «/» и «/watch/<id>». Второй на GitHub Pages
     отдаётся через 404.html (внутри — та же оболочка приложения), поэтому
     любой навигационный запрос просто идёт в сеть, а без сети достаём
     оболочку из кеша: роутер сам разберёт путь и покажет нужный экран. */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (err) {
        const cache = await caches.open(SHELL_CACHE);
        const hit = (await cache.match('./index.html')) ||
                    (await cache.match('./404.html'));
        return hit || Response.error();
      }
    })());
    return;
  }

  /* расширение вытаскиваем без точки — дальше проверяем ровно его,
     иначе шаблон вида /\.css$/ никогда не совпадёт с "css" */
  const ext = (url.pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || '';

  if (/^(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(ext)) {
    e.respondWith(imageStrategy(req));
    return;
  }

  /* шрифты Google лежат на другом домене и уедут в imageStrategy только
     если попадут под image — но сюда доходят лишь свои */
  if (/^(woff2?|ttf|otf)$/i.test(ext) || /^(css|js|json|webmanifest)$/i.test(ext)) {
    e.respondWith(shellStrategy(req));
  }
});