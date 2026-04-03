# Warframe Prime Tracker

Личное веб-приложение на `Vite + React` для учёта прайм-предметов и оценки их стоимости по данным `warframe.market`.

## Что умеет

- загружает каталог прайм-предметов из `warframe.market`
- позволяет добавлять предметы в личный список
- хранит список и количества в `localStorage`
- показывает `min sell`, `max buy` и суммарную стоимость
- кэширует каталог и цены, чтобы не дёргать API лишний раз

## Запуск

```bash
pnpm install
pnpm dev
```

Для сборки и локального запуска production-версии:

```bash
pnpm build:start
```

Если `pnpm` ещё не активирован, можно включить его через `corepack`:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
```

## Примечание про API

Для локальной разработки запросы идут не напрямую в `api.warframe.market`, а через proxy Vite:

- фронт обращается к `/api/warframe-market/v2`
- `vite` проксирует эти запросы в `https://api.warframe.market`

Это убирает `CORS`-ошибку в режиме `pnpm dev`.

Если потом захочешь публиковать не dev-сервер, а собранный `dist`, понадобится такой же proxy на хостинге или небольшой backend.
