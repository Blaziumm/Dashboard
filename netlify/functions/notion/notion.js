const NOTION_VERSION = "2026-03-11";

function formatNotionId(id) {
  if (!id) return "";
  const cleaned = id.replace(/-/g, "");
  if (cleaned.length !== 32) return id;
  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
}

async function notionRequest(path, body, token, method = "POST") {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      Authorization: `Bearer ${token}`,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || "Notion request failed");
  }
  return text ? JSON.parse(text) : {};
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing NOTION_TOKEN" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const databaseId = formatNotionId(payload.databaseId || process.env.NOTION_DATABASE_ID || "");

  try {
    if (payload.action === "query") {
      if (!databaseId) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing databaseId" }) };
      }
      const database = await notionRequest(`/databases/${databaseId}`, null, token, "GET");
      const dataSourceId = Array.isArray(database.data_sources) && database.data_sources[0]
        ? database.data_sources[0].id
        : null;

      if (dataSourceId) {
        const result = await notionRequest(`/data_sources/${dataSourceId}/query`, {
          sorts: payload.sorts || [],
          filter: payload.filter || undefined,
        }, token);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      const legacyResult = await notionRequest(`/databases/${databaseId}/query`, {
        sorts: payload.sorts || [],
        filter: payload.filter || undefined,
      }, token);
      return { statusCode: 200, body: JSON.stringify(legacyResult) };
    }

    if (payload.action === "create") {
      if (!databaseId) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing databaseId" }) };
      }
      const result = await notionRequest("/pages", {
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: payload.properties.title } }] },
          Status: payload.properties.status ? { status: { name: payload.properties.status } } : undefined,
          "Due Date": payload.properties.due ? { date: { start: payload.properties.due } } : undefined,
        },
      }, token);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    if (payload.action === "update") {
      const result = await notionRequest(`/pages/${payload.pageId}`, {
        properties: {
          Name: { title: [{ text: { content: payload.properties.title } }] },
          Status: payload.properties.status ? { status: { name: payload.properties.status } } : undefined,
          "Due Date": payload.properties.due ? { date: { start: payload.properties.due } } : undefined,
        },
      }, token, "PATCH");
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    return { statusCode: 404, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};
