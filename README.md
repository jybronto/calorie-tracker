# 🍽️ Трекер калорий

Простой трекер калорий: страница на **GitHub Pages**, база в **Firebase (Firestore)**, вход через **Google**.
Записи о еде заносит **Claude** — через коннектор с телефона и компьютера (папка [`connector/`](connector/)).

## Компоненты
1. **Страница** (`index.html`, `config.js`) — публичный дневник, данные защищены входом Google.
2. **Firebase** — Firestore хранит записи, Authentication даёт вход через Google.
3. **Коннектор** (`connector/`) — MCP-сервер на Cloudflare Workers, через который Claude пишет в базу.

## Модель данных
`users/{uid}/meals/{id}`:
| поле | тип | описание |
|------|-----|----------|
| `name` | string | что съедено |
| `calories` | number | ккал |
| `protein` / `fat` / `carbs` | number | БЖУ в граммах |
| `portion` | string | порция (напр. «250 г») |
| `eatenAt` | timestamp | когда съедено |
| `createdAt` | timestamp | когда записано |
| `source` | string | `manual` или `claude` |

## Настройка — этап 1 (страница + Firebase)

1. **Создай проект Firebase** → https://console.firebase.google.com → Add project.
2. **Authentication** → Get started → вкладка *Sign-in method* → включи **Google**.
3. **Firestore Database** → Create database → режим **production**, регион `eur3` (Европа).
4. **Правила**: вкладка *Rules* → вставь содержимое [`firestore.rules`](firestore.rules) → Publish.
5. **Веб-конфиг**: Project settings (⚙️) → *Your apps* → значок `</>` → зарегистрируй веб-приложение → скопируй объект `firebaseConfig` в [`config.js`](config.js).
6. **Разреши домен**: Authentication → Settings → *Authorized domains* → добавь `<логин>.github.io`.
7. **Включи GitHub Pages**: Settings репозитория → Pages → Source: `main`, папка `/ (root)`.

Готово — открой `https://<логин>.github.io/<репозиторий>/` и войди через Google.

## Настройка — этап 2 (коннектор для Claude)
См. [`connector/README.md`](connector/README.md).
