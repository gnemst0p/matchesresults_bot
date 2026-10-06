# GG Live — Telegram Mini App

Мини‑приложение с live‑матчами, расписанием, отдельными результатами и выбором даты по Москве для Dota 2 и CS2. В разделе «Турниры» доступны сведения о турнире, составы участников, таблица, сетка и матчи, если источник их публикует. Данные загружаются через сервер, API‑ключи не попадают в браузер. CS2 использует `/csgo/` путь PandaScore.

Также есть поиск команд и турниров, избранные команды (до входа хранятся в браузере; после входа синхронизируются через Supabase), страница команды с составом и последними/ближайшими матчами, календарь с неделями и выбором даты. Один и тот же HTTPS-адрес открывает адаптивный сайт в обычном браузере компьютера/ноутбука и мини-приложение в Telegram.

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

В Render добавьте `SUPABASE_URL` и `SUPABASE_SECRET_KEY` из настроек проекта Supabase. Secret key должен храниться только в Render как секрет; не добавляйте его в GitHub или клиентский код. Старый `service_role` ключ тоже поддерживается. После деплоя отправьте боту `/start`, откройте приложение и на странице команды включите уведомления.

## Аккаунты, облачное избранное и вход через Telegram

Аккаунт GG Live создаётся через email и пароль или через Telegram. Избранные команды, добавленные до входа, объединяются с избранным аккаунта; затем изменения доступны на других устройствах после входа в тот же аккаунт. Приложение распознаёт уже подключённый Telegram и не предлагает привязать его повторно.

Чтобы пользователь с email мог привязать Telegram, включите ручную привязку идентификаторов в Supabase: **Authentication → Sign In / Providers → Allow manual linking**. После сохранения войдите в email-аккаунт GG Live и нажмите **Привязать Telegram**. Supabase проверит Telegram через OAuth, затем вернёт пользователя на сайт. Подробности есть в [документации Supabase по привязке идентификаторов](https://supabase.com/docs/guides/auth/auth-identity-linking).

### 1. Создайте таблицу избранного

В Supabase откройте **SQL Editor → New query**, вставьте SQL ниже и нажмите **Run**. Правила RLS разрешают пользователю видеть и менять только свои строки.

```sql
create table if not exists public.gg_live_user_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  game text not null check (game in ('dota2', 'cs2')),
  team_id text not null,
  team_name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, game, team_id)
);

alter table public.gg_live_user_favorites enable row level security;
grant select, insert, update, delete on public.gg_live_user_favorites to authenticated;

drop policy if exists "Read own favorites" on public.gg_live_user_favorites;
create policy "Read own favorites" on public.gg_live_user_favorites
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Insert own favorites" on public.gg_live_user_favorites;
create policy "Insert own favorites" on public.gg_live_user_favorites
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Update own favorites" on public.gg_live_user_favorites;
create policy "Update own favorites" on public.gg_live_user_favorites
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Delete own favorites" on public.gg_live_user_favorites;
create policy "Delete own favorites" on public.gg_live_user_favorites
  for delete to authenticated using ((select auth.uid()) = user_id);
```

### 2. Настройте ключ приложения

В Render у сервиса откройте **Environment** и добавьте:

- `SUPABASE_URL` — корневой Project URL из **Supabase → Project Settings → API**, например `https://abcdefgh.supabase.co`. Не добавляйте к нему `/rest/v1`, `/auth/v1` или адрес панели Supabase;
- `SUPABASE_PUBLISHABLE_KEY` — новый **Publishable key** из настроек API. Если в панели отображается старый ключ `anon`, его можно указать вместо publishable key.

Существующий `SUPABASE_SECRET_KEY` оставьте только для серверных уведомлений. Никогда не вставляйте secret/service-role key в клиентский код и не указывайте его как `SUPABASE_PUBLISHABLE_KEY`. Нажмите **Save Changes** и дождитесь повторного деплоя Render.

### 3. Включите Telegram-вход в Supabase

1. В Supabase откройте **Authentication → Sign In / Providers → Custom Providers → New Provider** и выберите **Auto-discovery (OIDC)**.
2. Укажите identifier `custom:telegram`, имя `Telegram`, issuer `https://oauth.telegram.org`, scopes `openid profile`, и включите **Email optional**. Callback URL, который покажет Supabase, скопируйте.
3. В Telegram откройте мини-приложение @BotFather, выберите используемого GG Live бота → **Login Widget** → **OpenID Connect Login**. Добавьте адрес сайта `https://matchesresults-bot.onrender.com` и скопированный callback Supabase в список разрешённых адресов. Скопируйте выданные **Client ID** и **Client Secret**.
4. Вернитесь в настройки провайдера Supabase, вставьте эти Client ID и Client Secret и сохраните провайдера.
5. В **Authentication → URL Configuration** укажите Site URL `https://matchesresults-bot.onrender.com` (обязательно вместе с `https://`) и добавьте этот же адрес в Redirect URLs. Это адрес сайта, куда пользователь возвращается после входа. В BotFather при этом должен остаться callback Supabase, который начинается с `https://<project-ref>.supabase.co/auth/v1/callback`.

Client Secret от BotFather — это отдельный секрет авторизации, не `TELEGRAM_BOT_TOKEN`. Храните его только в настройках провайдера Supabase. Для входа через Telegram Supabase использует официальный OIDC с проверкой токена; адрес сайта и callback должны точно совпадать с добавленными в BotFather.

После деплоя откройте сайт на компьютере или мини-приложение, нажмите **Войти**, зарегистрируйтесь или продолжите через Telegram. Подтвердите email, если Supabase попросит это сделать. Войдите в тот же аккаунт на телефоне, чтобы увидеть облачное избранное.

На бесплатном Render уведомления работают с перебоями: сервис может уснуть после 15 минут без входящих запросов, а при перезапуске проверка матчей остановится. Бесплатные проекты Supabase также могут приостановиться после недели низкой активности. Для этого режима сервер проверяет события примерно раз в минуту, когда он активен.

Для Render задайте `LIQUIPEDIA_CONTACT` как отдельную переменную окружения со своим контактным email и сохраните изменения, чтобы сервис перезапустился. Значение останется в настройках Render и не должно попадать в GitHub. Без этой переменной турнирные детали PandaScore по-прежнему работают; поиск Liquipedia можно открыть ссылкой.

Расширенные игровые показатели по картам и событиям могут требовать платных тарифов PandaScore. Автоматический сбор данных со страниц HLTV не используется; ссылки на HLTV можно открывать вручную. Liquipedia подключается через бесплатный MediaWiki API с соблюдением его лимитов и указанием источника.

Для локального просмотра без Telegram страница работает в браузере. Бэкенд не использует Telegram `initData`, потому что приложение публично показывает матчи и не выполняет персонализированных действий. Бот использует long polling, поэтому отдельный webhook не требуется; для одного токена одновременно должен работать только один экземпляр бота.
