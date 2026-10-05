# GG Live — Telegram Mini App

Мини‑приложение с live‑матчами, расписанием, отдельными результатами и выбором даты по Москве для Dota 2 и CS2. В разделе «Турниры» доступны сведения о турнире, составы участников, таблица, сетка и матчи, если источник их публикует. Данные загружаются через сервер, API‑ключи не попадают в браузер. CS2 использует `/csgo/` путь PandaScore.

Также есть поиск команд и турниров, избранные команды (сохраняются в браузере этого устройства), страница команды с составом и последними/ближайшими матчами, а также календарь с неделями и выбором даты.

## Запуск

1. Создайте API token в аккаунте [PandaScore](https://pandascore.co/).
2. Скопируйте `.env.example` в `.env` и укажите `PANDASCORE_TOKEN`. Чтобы включить поиск Liquipedia, задайте `LIQUIPEDIA_CONTACT` своим контактным email; он добавляется к User-Agent запросов к их API. Не добавляйте личный email в исходный код или публичный репозиторий.
3. Запустите Node.js 20+: `npm start`.
4. Откройте `http://localhost:3000`. Сборка и установка npm‑пакетов не нужны.

Сервер кэширует матчи на 25 секунд, турнирные данные на 10 минут, а результаты поиска Liquipedia на сутки; запросы к Liquipedia ограничены одним за две секунды. Для внешнего доступа нужен HTTPS URL. API доступность и лимиты зависят от вашего тарифа PandaScore.

## Подключение к Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather).
2. Разместите приложение на HTTPS хостинге, где запускается Node.js сервер, и настройте `PANDASCORE_TOKEN` как секрет окружения.
3. Скопируйте `.env.example` в `.env` и задайте `TELEGRAM_BOT_TOKEN` (токен от BotFather) и `TELEGRAM_APP_URL` (публичный HTTPS URL приложения). При запуске сервер сам настроит кнопку меню бота; команда `/start` отправит кнопку для открытия GG Live.

## Уведомления о матчах

Для подписок сервер использует базу Supabase. Создайте проект, откройте **SQL Editor → New query** и выполните:

```sql
create table if not exists public.gg_live_subscriptions (
  telegram_user_id bigint not null,
  game text not null check (game in ('dota2', 'cs2')),
  team_id text not null,
  team_name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (telegram_user_id, game, team_id)
);

create table if not exists public.gg_live_notification_events (
  event_key text primary key,
  created_at timestamptz not null default now()
);

alter table public.gg_live_subscriptions enable row level security;
alter table public.gg_live_notification_events enable row level security;
grant usage on schema public to service_role;
grant all on public.gg_live_subscriptions, public.gg_live_notification_events to service_role;
```

В Render добавьте `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` из настроек проекта Supabase. Service Role key должен храниться только в Render как секрет; не добавляйте его в GitHub или клиентский код. После деплоя отправьте боту `/start`, откройте приложение и на странице команды включите уведомления.

На бесплатном Render уведомления работают с перебоями: сервис может уснуть после 15 минут без входящих запросов, а при перезапуске проверка матчей остановится. Бесплатные проекты Supabase также могут приостановиться после недели низкой активности. Для этого режима сервер проверяет события примерно раз в минуту, когда он активен.

Для Render задайте `LIQUIPEDIA_CONTACT` как отдельную переменную окружения со своим контактным email и сохраните изменения, чтобы сервис перезапустился. Значение останется в настройках Render и не должно попадать в GitHub. Без этой переменной турнирные детали PandaScore по-прежнему работают; поиск Liquipedia можно открыть ссылкой.

Расширенные игровые показатели по картам и событиям могут требовать платных тарифов PandaScore. Автоматический сбор данных со страниц HLTV не используется; ссылки на HLTV можно открывать вручную. Liquipedia подключается через бесплатный MediaWiki API с соблюдением его лимитов и указанием источника.

Для локального просмотра без Telegram страница работает в браузере. Бэкенд не использует Telegram `initData`, потому что приложение публично показывает матчи и не выполняет персонализированных действий. Бот использует long polling, поэтому отдельный webhook не требуется; для одного токена одновременно должен работать только один экземпляр бота.
