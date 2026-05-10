const GARMIN_SSO_URL = "https://sso.garmin.com/sso/signin";
const GARMIN_BASE_URL = "https://connect.garmin.com";

const GARMIN_SSO_PARAMS = {
  service: "https://connect.garmin.com/modern",
  webhost: "https://connect.garmin.com",
  source: "https://connect.garmin.com/modern",
  redirectAfterAccountLoginUrl: "https://connect.garmin.com/modern",
  redirectAfterAccountCreationUrl: "https://connect.garmin.com/modern",
  gauthHost: "https://sso.garmin.com/sso",
  locale: "en_US",
  id: "gauth-widget",
  cssUrl: "https://connect.garmin.com/modern/css/gauth-custom.css",
  privacyStatementUrl: "https://connect.garmin.com/modern/privacyPolicy",
  termsOfUseUrl: "https://connect.garmin.com/modern/termsOfUse",
  rememberMeShown: "true",
  rememberMeChecked: "false",
  createAccountShown: "true",
  openCreateAccount: "false",
  displayNameShown: "false",
  consumeServiceTicket: "false",
  initialFocus: "true",
  embedWidget: "true",
};

function buildSigninUrl() {
  const url = new URL(GARMIN_SSO_URL);
  url.search = new URLSearchParams(GARMIN_SSO_PARAMS).toString();
  return url.toString();
}

function getSetCookies(response) {
  if (!response || !response.headers) return [];
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  if (response.headers.raw && typeof response.headers.raw === "function") {
    return response.headers.raw()["set-cookie"] || [];
  }
  const header = response.headers.get("set-cookie");
  return header ? [header] : [];
}

function updateCookieJar(jar, response) {
  const setCookies = getSetCookies(response);
  setCookies.forEach((cookieStr) => {
    if (!cookieStr) return;
    const pair = cookieStr.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  });
}

function cookieHeader(jar) {
  if (!jar.size) return "";
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchWithCookies(url, options, jar) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
    ...(options.headers || {}),
  };
  const cookie = cookieHeader(jar);
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(url, { ...options, headers, redirect: "manual" });
  updateCookieJar(jar, response);
  return response;
}

async function garminLogin(email, password) {
  const jar = new Map();
  const signinUrl = buildSigninUrl();

  await fetchWithCookies(signinUrl, { method: "GET" }, jar);

  const form = new URLSearchParams();
  form.set("username", email);
  form.set("password", password);
  form.set("embed", "true");
  form.set("_eventId", "submit");
  form.set("displayNameRequired", "false");

  const loginResponse = await fetchWithCookies(
    signinUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
    jar
  );

  const loginText = await loginResponse.text();
  const ticketMatch = loginText.match(/ticket=([^"'\s]+)/i);
  if (!ticketMatch) {
    throw new Error("Garmin login failed: ticket not found");
  }

  const ticket = ticketMatch[1];
  const connectUrl = `${GARMIN_BASE_URL}/modern/?ticket=${ticket}`;
  await fetchWithCookies(connectUrl, { method: "GET" }, jar);

  return jar;
}

async function garminApiRequest(path, jar) {
  const url = `${GARMIN_BASE_URL}/modern/proxy${path}`;
  const response = await fetchWithCookies(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Referer: "https://connect.garmin.com/modern/",
      },
    },
    jar
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Garmin request failed (${response.status})`);
  }
  return response.json();
}

function resolveDate(queryDate) {
  if (queryDate && /^\d{4}-\d{2}-\d{2}$/.test(queryDate)) return queryDate;
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!email || !password) {
    res.status(500).json({ error: "Missing GARMIN_EMAIL or GARMIN_PASSWORD" });
    return;
  }

  try {
    const date = resolveDate(req.query?.date || req.query?.day);
    const jar = await garminLogin(email, password);

    const sleep = await garminApiRequest(`/wellness-service/wellness/dailySleepData/${date}`, jar);

    let summary = null;
    let bodyBattery = null;
    try {
      summary = await garminApiRequest(`/wellness-service/wellness/dailySummary/${date}`, jar);
    } catch (err) {
      summary = null;
    }

    try {
      bodyBattery = await garminApiRequest(`/wellness-service/wellness/bodyBattery/reports/daily/${date}`, jar);
    } catch (err) {
      bodyBattery = null;
    }

    res.status(200).json({ date, sleep, summary, bodyBattery });
  } catch (err) {
    console.error("Garmin function error", {
      message: err.message || "Server error",
    });
    res.status(500).json({ error: err.message || "Server error" });
  }
}
