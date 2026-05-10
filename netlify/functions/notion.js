const NOTION_VERSION = "2023-06-01";

async function notionRequest(path, body, token) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
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

  try {
    if (payload.action === "query") {
      const result = await notionRequest(`/databases/${payload.databaseId}/query`, {
        sorts: payload.sorts || [],
        filter: payload.filter || undefined,
      }, token);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    if (payload.action === "create") {
      const result = await notionRequest("/pages", {
        parent: { database_id: payload.databaseId },
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
      }, token);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    return { statusCode: 404, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};
