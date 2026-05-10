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

function resolveStatusProp(status, statusType) {
  if (!status) return undefined;
  if (statusType === "select") return { select: { name: status } };
  if (statusType === "status") return { status: { name: status } };
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Missing NOTION_TOKEN" });
    return;
  }

  const payload = req.body || {};
  const databaseId = formatNotionId(payload.databaseId || process.env.NOTION_DATABASE_ID || "");

  try {
    if (payload.action === "query") {
      if (!databaseId) {
        res.status(400).json({ error: "Missing databaseId" });
        return;
      }
      const database = await notionRequest(`/databases/${databaseId}`, null, token, "GET");
      const dataSourceId = Array.isArray(database.data_sources) && database.data_sources[0]
        ? database.data_sources[0].id
        : null;

      const allResults = [];
      let cursor = undefined;
      let hasMore = true;

      while (hasMore) {
        const queryBody = {
          sorts: payload.sorts || [],
          filter: payload.filter || undefined,
          start_cursor: cursor,
          page_size: 100,
        };

        let result;
        if (dataSourceId) {
          result = await notionRequest(`/data_sources/${dataSourceId}/query`, queryBody, token);
        } else {
          result = await notionRequest(`/databases/${databaseId}/query`, queryBody, token);
        }

        if (Array.isArray(result.results)) {
          allResults.push(...result.results);
        }
        hasMore = !!result.has_more;
        cursor = result.next_cursor || undefined;
      }

      res.status(200).json({ results: allResults });
      return;
    }

    if (payload.action === "create") {
      if (!databaseId) {
        res.status(400).json({ error: "Missing databaseId" });
        return;
      }
      const statusProp = resolveStatusProp(payload.properties.status, payload.properties.statusType);
      const baseProperties = {
        Name: { title: [{ text: { content: payload.properties.title } }] },
        "Due Date": payload.properties.due ? { date: { start: payload.properties.due } } : undefined,
      };
      const properties = statusProp ? { ...baseProperties, Status: statusProp } : baseProperties;
      const result = await notionRequest("/pages", {
        parent: { database_id: databaseId },
        properties,
      }, token);
      res.status(200).json(result);
      return;
    }

    if (payload.action === "update") {
      const statusProp = resolveStatusProp(payload.properties.status, payload.properties.statusType);
      const baseProperties = {
        Name: { title: [{ text: { content: payload.properties.title } }] },
        "Due Date": payload.properties.due ? { date: { start: payload.properties.due } } : undefined,
      };
      const properties = statusProp ? { ...baseProperties, Status: statusProp } : baseProperties;

      if (payload.properties.statusType && payload.properties.statusType !== "auto") {
        const result = await notionRequest(`/pages/${payload.pageId}`, { properties }, token, "PATCH");
        res.status(200).json(result);
        return;
      }

      try {
        const result = await notionRequest(`/pages/${payload.pageId}`, {
          properties: { ...baseProperties, Status: { status: { name: payload.properties.status } } },
        }, token, "PATCH");
        res.status(200).json(result);
        return;
      } catch (err) {
        const fallback = await notionRequest(`/pages/${payload.pageId}`, {
          properties: { ...baseProperties, Status: { select: { name: payload.properties.status } } },
        }, token, "PATCH");
        res.status(200).json(fallback);
        return;
      }
    }

    res.status(404).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Notion function error", {
      action: payload.action,
      pageId: payload.pageId,
      message: err.message || "Server error",
    });
    res.status(500).json({ error: err.message || "Server error" });
  }
}
