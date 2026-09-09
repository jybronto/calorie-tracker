# Коннектор трекера калорий (MCP на Cloudflare Workers)

Маленький сервис, через который приложение Claude пишет еду в твою базу Firebase.
Инструменты: `log_meal` (записать), `list_meals` (показать за день), `delete_meal` (удалить).

Все команды выполняются из папки `connector/`.

---

## Что понадобится
- Аккаунт **Cloudflare** (бесплатный, без карты) — https://dash.cloudflare.com/sign-up
- `wrangler` и Node — уже установлены.

## Шаг 1. Вход в Cloudflare
```bash
npx wrangler login
```
Откроется браузер → **Allow**. Это связывает CLI с твоим аккаунтом.

## Шаг 2. Ключ service account из Firebase
1. https://console.firebase.google.com/project/calorie-tracker-e6c92/settings/serviceaccounts/adminsdk
2. Нажми **Generate new private key** → **Generate key** → скачается `.json`-файл.
3. **Открой этот файл, скопируй всё его содержимое** (понадобится в шаге 4). Не клади его в репозиторий.

## Шаг 3. Свой UID
1. Открой трекер: https://jybronto.github.io/calorie-tracker/ (войди, если не вошёл).
2. Внизу раскрой **⚙️ Мой ID для коннектора** → **Копировать**.
3. Вставь его в [`wrangler.toml`](wrangler.toml) в поле `USER_UID` (вместо `ЗАМЕНИ_НА_СВОЙ_UID`).
   Заодно проверь `TIMEZONE` (по умолчанию `Europe/London`).

## Шаг 4. Секреты
Токен доступа к коннектору (придумай длинную случайную строку или сгенерируй):
```bash
openssl rand -hex 24        # скопируй вывод — это твой CONNECTOR_TOKEN
npx wrangler secret put CONNECTOR_TOKEN
# вставь строку из openssl, Enter
```
Ключ service account (вставь всё содержимое .json из шага 2):
```bash
npx wrangler secret put SERVICE_ACCOUNT_JSON
# вставь весь JSON одной строкой/блоком, Enter
```

## Шаг 5. Деплой
```bash
npx wrangler deploy
```
В конце увидишь адрес вида `https://calorie-connector.ТВОЙ-САБДОМЕН.workers.dev`.

**Адрес коннектора** = этот адрес + `/mcp/` + твой `CONNECTOR_TOKEN`:
```
https://calorie-connector.ТВОЙ-САБДОМЕН.workers.dev/mcp/ВСТАВЬ_CONNECTOR_TOKEN
```

Проверка, что сервер жив (должно вернуть `ok`):
```bash
curl https://calorie-connector.ТВОЙ-САБДОМЕН.workers.dev/health
```

## Шаг 6. Подключить в приложении Claude
1. Claude → **Settings → Connectors → Add custom connector**.
2. **Name:** `Трекер калорий`
3. **URL:** адрес коннектора из шага 5 (со `/mcp/<token>` на конце).
4. Сохрани. Коннектор появится и на телефоне, и на компьютере (один аккаунт).

## Шаг 7. Пользоваться
В любом чате Claude:
> Съел тарелку борща и два куска чёрного хлеба

Claude прикинет калории/БЖУ и вызовет `log_meal`. Обнови страницу трекера — запись там.
Другие фразы: «сколько я сегодня съел?» (→ `list_meals`), «удали последнюю запись» (→ `delete_meal`).

---

### Обновить код коннектора позже
```bash
npx wrangler deploy
```
### Поменять секрет
```bash
npx wrangler secret put CONNECTOR_TOKEN   # (не забудь обновить URL в Claude)
```
