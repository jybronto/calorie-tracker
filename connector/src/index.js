/**
 * Коннектор трекера калорий — MCP-сервер на Cloudflare Workers.
 *
 * Даёт приложению Claude инструменты для записи еды в Firestore:
 *   - log_meal    — записать приём пищи
 *   - list_meals  — показать записи и суммы за день
 *   - delete_meal — удалить запись по id
 *
 * Пишет в Firestore через service account (обходит правила безопасности).
 * Доступ к серверу защищён секретным токеном в URL-пути: /mcp/<CONNECTOR_TOKEN>.
 *
 * Требуемые переменные окружения (см. wrangler.toml и `wrangler secret put`):
 *   FIREBASE_PROJECT_ID  (var)     — id проекта Firebase
 *   USER_UID             (var)     — uid владельца (куда писать)
 *   TIMEZONE             (var)     — часовой пояс для «сегодня», напр. Europe/London
 *   CONNECTOR_TOKEN      (secret)  — секрет в URL-пути
 *   SERVICE_ACCOUNT_JSON (secret)  — JSON ключа service account целиком
 */

const SERVER_INFO = { name: "calorie-tracker", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

// ---------- Определения инструментов ----------
const TOOLS = [
  {
    name: "log_meal",
    description:
      "Записать приём пищи в дневник калорий. Оцени калории и БЖУ по описанию еды и порции, затем вызови этот инструмент. Все числа — итог на съеденную порцию, не на 100 г.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Что съедено, кратко. Напр. «Борщ», «Куриная грудка с рисом»." },
        calories: { type: "number", description: "Калории (ккал) на всю съеденную порцию." },
        protein: { type: "number", description: "Белки, граммы." },
        fat: { type: "number", description: "Жиры, граммы." },
        carbs: { type: "number", description: "Углеводы, граммы." },
        portion: { type: "string", description: "Порция словами, напр. «тарелка», «250 г», «1 шт». Необязательно." },
        meal_type: { type: "string", enum: ["завтрак", "обед", "ужин", "перекус"], description: "Приём пищи: завтрак, обед, ужин или перекус. Заполни, ТОЛЬКО если пользователь явно упомянул (например «на обед», «в качестве перекуса»). Если не упомянул — НЕ указывай, сервер сам определит по времени." },
        eaten_at: { type: "string", description: "Время приёма пищи в ISO 8601 (напр. 2026-09-09T13:30:00). Если не указано — текущий момент." },
      },
      required: ["name", "calories"],
    },
  },
  {
    name: "list_meals",
    description: "Показать записи о еде и суммарные калории/БЖУ за день.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Дата в формате YYYY-MM-DD. Если не указано — сегодня." },
      },
    },
  },
  {
    name: "delete_meal",
    description: "Удалить запись о еде по её id (id можно узнать через list_meals).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Идентификатор записи." } },
      required: ["id"],
    },
  },
];

// ---------- HTTP-вход ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && parts[0] === "health") {
      return new Response("ok", { status: 200, headers: cors() });
    }

    if (parts[0] !== "mcp") return new Response("Not found", { status: 404 });
    if (!env.CONNECTOR_TOKEN || parts[1] !== env.CONNECTOR_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    // GET на MCP-эндпоинт = запрос SSE-потока; мы его не предоставляем.
    if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: cors() });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors() });

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, makeError(null, -32700, "Parse error"));
    }

    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    const responses = [];
    for (const msg of messages) {
      const res = await handleMessage(msg, env);
      if (res !== null) responses.push(res);
    }

    if (responses.length === 0) return new Response(null, { status: 202, headers: cors() });
    return jsonResponse(request, batch ? responses : responses[0]);
  },
};

// ---------- Роутинг JSON-RPC ----------
async function handleMessage(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return makeError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // уведомления без ответа

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOLS });

      case "resources/list":
        return ok(id, { resources: [] });

      case "prompts/list":
        return ok(id, { prompts: [] });

      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const result = await callTool(name, args, env);
          return ok(id, { content: [{ type: "text", text: result }], isError: false });
        } catch (e) {
          return ok(id, { content: [{ type: "text", text: "Ошибка: " + (e.message || e) }], isError: true });
        }
      }

      default:
        if (isNotification) return null;
        return makeError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return makeError(id ?? null, -32603, e.message || "Internal error");
  }
}

// ---------- Инструменты ----------
async function callTool(name, args, env) {
  switch (name) {
    case "log_meal":
      return await logMeal(args, env);
    case "list_meals":
      return await listMeals(args, env);
    case "delete_meal":
      return await deleteMeal(args, env);
    default:
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

async function logMeal(args, env) {
  if (!args.name) throw new Error("Не указано название еды (name).");
  if (args.calories == null) throw new Error("Не указаны калории (calories).");

  const nowIso = new Date().toISOString();
  const eatenIso = args.eaten_at ? new Date(args.eaten_at).toISOString() : nowIso;
  let mealType = normalizeMealType(args.meal_type);
  if (!mealType) mealType = inferMealType(eatenIso, env.TIMEZONE || "Europe/London");
  const fields = {
    name: { stringValue: String(args.name) },
    calories: { doubleValue: num(args.calories) },
    protein: { doubleValue: num(args.protein) },
    fat: { doubleValue: num(args.fat) },
    carbs: { doubleValue: num(args.carbs) },
    portion: { stringValue: args.portion ? String(args.portion) : "" },
    mealType: { stringValue: mealType },
    eatenAt: { timestampValue: eatenIso },
    createdAt: { timestampValue: nowIso },
    source: { stringValue: "claude" },
  };

  const token = await getAccessToken(env);
  const base = firestoreBase(env);
  const resp = await fetch(`${base}/users/${env.USER_UID}/meals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Firestore: ${resp.status} ${await resp.text()}`);
  const doc = await resp.json();
  const docId = doc.name.split("/").pop();

  return (
    `✅ Записал${mealType ? ` (${mealType})` : ""}: ${args.name} — ${Math.round(num(args.calories))} ккал ` +
    `(Б ${Math.round(num(args.protein))} / Ж ${Math.round(num(args.fat))} / У ${Math.round(num(args.carbs))} г)` +
    `${args.portion ? `, ${args.portion}` : ""}. id: ${docId}`
  );
}

async function listMeals(args, env) {
  const tz = env.TIMEZONE || "Europe/London";
  const { startIso, endIso, ymd } = dayRange(args.date, tz);

  const token = await getAccessToken(env);
  const base = firestoreBase(env);
  const query = {
    structuredQuery: {
      from: [{ collectionId: "meals" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "eatenAt" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: startIso } } },
            { fieldFilter: { field: { fieldPath: "eatenAt" }, op: "LESS_THAN_OR_EQUAL", value: { timestampValue: endIso } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "eatenAt" }, direction: "ASCENDING" }],
    },
  };

  const resp = await fetch(`${base}/users/${env.USER_UID}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!resp.ok) throw new Error(`Firestore: ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();

  let kcal = 0, p = 0, f = 0, c = 0;
  const byType = {};
  let count = 0;
  for (const row of rows) {
    if (!row.document) continue;
    const d = readFields(row.document.fields);
    d.id = row.document.name.split("/").pop();
    kcal += d.calories; p += d.protein; f += d.fat; c += d.carbs;
    if (!byType[d.mealType]) byType[d.mealType] = [];
    byType[d.mealType].push(d);
    count++;
  }

  if (!count) return `За ${ymd} записей нет.`;

  const blocks = [];
  for (const g of MEAL_GROUPS) {
    const meals = byType[g.key];
    if (!meals || !meals.length) continue;
    const sub = meals.reduce((s, m) => s + m.calories, 0);
    const lines = meals.map((d) => {
      const t = d.eatenAt ? new Date(d.eatenAt) : null;
      const time = t
        ? new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(t)
        : "--:--";
      return `  • ${time} — ${d.name}: ${Math.round(d.calories)} ккал${d.portion ? ` (${d.portion})` : ""} [id: ${d.id}]`;
    });
    blocks.push(`${g.label} — ${Math.round(sub)} ккал\n${lines.join("\n")}`);
  }

  return (
    `Дневник за ${ymd}:\n${blocks.join("\n\n")}\n\n` +
    `Итого: ${Math.round(kcal)} ккал · Б ${Math.round(p)} / Ж ${Math.round(f)} / У ${Math.round(c)} г`
  );
}

async function deleteMeal(args, env) {
  if (!args.id) throw new Error("Не указан id записи.");
  const token = await getAccessToken(env);
  const base = firestoreBase(env);
  const resp = await fetch(`${base}/users/${env.USER_UID}/meals/${encodeURIComponent(args.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Firestore: ${resp.status} ${await resp.text()}`);
  return `🗑️ Удалил запись ${args.id}.`;
}

// ---------- Firestore / Google авторизация ----------
function firestoreBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

function readFields(fields = {}) {
  const val = (v) => {
    if (!v) return undefined;
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("integerValue" in v) return Number(v.integerValue);
    if ("stringValue" in v) return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("booleanValue" in v) return v.booleanValue;
    return undefined;
  };
  return {
    name: val(fields.name) || "Приём пищи",
    calories: Number(val(fields.calories)) || 0,
    protein: Number(val(fields.protein)) || 0,
    fat: Number(val(fields.fat)) || 0,
    carbs: Number(val(fields.carbs)) || 0,
    portion: val(fields.portion) || "",
    mealType: val(fields.mealType) || "",
    eatenAt: val(fields.eatenAt) || null,
  };
}

// Канонизация типа приёма пищи (поддержка англ. вариантов на всякий случай).
function normalizeMealType(v) {
  if (!v) return "";
  const s = String(v).toLowerCase().trim();
  const map = {
    "завтрак": "завтрак", breakfast: "завтрак",
    "обед": "обед", lunch: "обед",
    "ужин": "ужин", dinner: "ужин", supper: "ужин",
    "перекус": "перекус", snack: "перекус", "снек": "перекус",
  };
  return map[s] || "";
}

// Определение приёма пищи по времени: до 12:00 — завтрак, после 17:00 — ужин, иначе обед.
function inferMealType(iso, tz) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }).format(new Date(iso))
  );
  if (hour < 12) return "завтрак";
  if (hour >= 17) return "ужин";
  return "обед";
}

const MEAL_GROUPS = [
  { key: "завтрак", label: "🍳 Завтрак" },
  { key: "обед", label: "🍲 Обед" },
  { key: "ужин", label: "🌙 Ужин" },
  { key: "перекус", label: "🍎 Перекус" },
  { key: "", label: "🍽️ Без категории" },
];

// Кэш токена в пределах жизни изолята.
let _token = { value: null, exp: 0 };

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_token.value && _token.exp - 60 > now) return _token.value;

  const sa = JSON.parse(env.SERVICE_ACCOUNT_JSON);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(enc(JSON.stringify(header)))}.${b64url(enc(JSON.stringify(claim)))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("OAuth: " + JSON.stringify(data));

  _token = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return _token.value;
}

async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// ---------- Дата/время ----------
function dayRange(dateStr, tz) {
  let ymd = dateStr;
  if (!ymd) {
    // Сегодняшняя дата в нужном часовом поясе (en-CA даёт формат YYYY-MM-DD).
    ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  const start = zonedToUtc(`${ymd}T00:00:00.000`, tz);
  const end = zonedToUtc(`${ymd}T23:59:59.999`, tz);
  return { startIso: start.toISOString(), endIso: end.toISOString(), ymd };
}

// Переводит «наивное» локальное время в указанном поясе в UTC.
function zonedToUtc(naive, tz) {
  const asUtc = new Date(naive + "Z"); // сначала трактуем как UTC
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(asUtc).reduce((a, x) => ((a[x.type] = x.value), a), {});
  let hour = parts.hour === "24" ? 0 : +parts.hour;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
  const offset = wall - asUtc.getTime(); // насколько пояс впереди UTC
  return new Date(asUtc.getTime() - offset);
}

// ---------- Утилиты ----------
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function enc(s) {
  return new TextEncoder().encode(s);
}
function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}
function jsonResponse(request, payload) {
  const accept = request.headers.get("Accept") || "";
  const sseOnly = accept.includes("text/event-stream") && !accept.includes("application/json");
  if (sseOnly) {
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new Response(body, {
      status: 200,
      headers: { ...cors(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...cors(), "Content-Type": "application/json" },
  });
}
