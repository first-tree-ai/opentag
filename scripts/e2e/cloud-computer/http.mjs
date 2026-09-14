export function createCookieJar() {
  const cookies = new Map();

  function store(setCookieHeaders) {
    for (const header of setCookieHeaders) {
      const pair = String(header).split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "") cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  return {
    store,
    header() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    get(name) {
      const value = cookies.get(name);
      if (!value) return undefined;
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    },
  };
}

function requestHeaders(baseUrl, cookies, method, body, headers) {
  const values = { origin: baseUrl, ...headers };
  const cookie = cookies.header();
  const csrf = cookies.get("opentag_csrf");
  if (cookie) values.cookie = cookie;
  if (csrf && method !== "GET" && method !== "HEAD") values["x-opentag-csrf"] = csrf;
  if (body !== undefined) values["content-type"] = "application/json";
  return values;
}

async function responseBody(response, cookies) {
  cookies.store(response.headers.getSetCookie());
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseError(response, body, method, path) {
  const message = body?.error?.message ?? `${method} ${path} failed with ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  return error;
}

export function createBrowserApi({ baseUrl, cookies }) {
  async function request(method, path, { body, headers } = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "manual",
      headers: requestHeaders(baseUrl, cookies, method, body, headers),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await responseBody(response, cookies);
    if (!response.ok) {
      throw responseError(response, parsed, method, path);
    }
    return parsed;
  }

  return {
    get: (path, options) => request("GET", path, options),
    post: (path, body, options) => request("POST", path, { ...options, body }),
    patch: (path, body, options) => request("PATCH", path, { ...options, body }),
    delete: (path, options) => request("DELETE", path, options),
  };
}

export async function signInDev({ baseUrl, cookies, next = "/agents/setup" }) {
  const url = new URL("/api/v1/auth/dev/callback", baseUrl);
  url.searchParams.set("next", next);
  let current = url;
  for (let hop = 0; hop < 8; hop += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        origin: baseUrl,
        ...(cookies.header() ? { cookie: cookies.header() } : {}),
      },
    });
    const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (setCookie.length > 0) cookies.store(setCookie);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Development sign-in redirected without Location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Development sign-in failed with ${response.status}`);
    }
    return;
  }
  throw new Error("Development sign-in exceeded redirect limit");
}
