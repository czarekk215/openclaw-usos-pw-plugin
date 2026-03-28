import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const USOS_BASE_URL = "https://usosweb.usos.pw.edu.pl";
const USOS_HOST = "usosweb.usos.pw.edu.pl";
const DEFAULT_CONTROLLER_PATH = "/kontroler.php";
const DEFAULT_NEWS_URL = `${USOS_BASE_URL}${DEFAULT_CONTROLLER_PATH}?_action=news/default`;
const MAX_REDIRECTS = 12;
const DEFAULT_OUTPUT_CHARS = 12000;
const MIN_OUTPUT_CHARS = 500;
const MAX_OUTPUT_CHARS = 50000;
const DEFAULT_DISCOVERY_LIMIT = 200;
const MAX_DISCOVERY_LIMIT = 1000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;
const MAX_PAGE_CACHE = 40;

const sessions = new Map();

class CookieJar {
  constructor() {
    this.byHost = new Map();
  }

  apply(url, headers) {
    const host = new URL(url).hostname;
    const hostCookies = this.byHost.get(host);
    if (!hostCookies || hostCookies.size === 0) return;

    const cookieValue = Array.from(hostCookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    if (cookieValue) headers.set("cookie", cookieValue);
  }

  absorb(url, responseHeaders) {
    const host = new URL(url).hostname;
    const current = this.byHost.get(host) ?? new Map();
    for (const raw of getSetCookieHeaders(responseHeaders)) {
      const firstPart = raw.split(";")[0]?.trim();
      if (!firstPart) continue;
      const separatorIndex = firstPart.indexOf("=");
      if (separatorIndex <= 0) continue;
      const name = firstPart.slice(0, separatorIndex).trim();
      const value = firstPart.slice(separatorIndex + 1).trim();
      if (!name) continue;
      current.set(name, value);
    }
    this.byHost.set(host, current);
  }
}

function isRedirect(status) {
  return status >= 300 && status < 400 && status !== 304;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function truncateText(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[...obcieto ${value.length - maxChars} znakow...]`;
}

function normalizeOutputChars(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_OUTPUT_CHARS;
  return Math.max(MIN_OUTPUT_CHARS, Math.min(MAX_OUTPUT_CHARS, Math.floor(value)));
}

function normalizeDiscoveryLimit(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_DISCOVERY_LIMIT;
  return Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.floor(value)));
}

function normalizePageLimit(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(value)));
}

function getTagAttribute(tag, attributeName) {
  const pattern = new RegExp(`${attributeName}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = tag.match(pattern);
  return match ? match[1] : undefined;
}

function hasBooleanAttribute(tag, attributeName) {
  const pattern = new RegExp(`\\b${attributeName}(?:\\s*=\\s*["'][^"']*["'])?(?:\\s|>|/)`, "i");
  return pattern.test(tag);
}

function extractAttribute(html, attributeName) {
  const pattern = new RegExp(`${attributeName}\\s*=\\s*['"]([^'"]+)['"]`, "i");
  const match = html.match(pattern);
  return match ? match[1] : undefined;
}

function extractLoginFormTag(html) {
  const match = html.match(/<form\b[^>]*id=["']fm1["'][^>]*>/i);
  return match ? match[0] : undefined;
}

function parseHiddenInputs(html) {
  const hidden = {};
  const inputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  let match = inputPattern.exec(html);
  while (match) {
    const tag = match[0];
    const name = getTagAttribute(tag, "name");
    if (name) hidden[name] = decodeHtmlEntities(getTagAttribute(tag, "value") ?? "");
    match = inputPattern.exec(html);
  }
  return hidden;
}

function extractCasMessage(html) {
  const match = html.match(/<div class="message-body"[^>]*>([\s\S]*?)<\/div>/i);
  if (!match) return "";
  return cleanHtmlText(match[1]);
}

function extractCsrfToken(bodyText) {
  const scriptToken = bodyText.match(/csrftoken\s*=\s*["']([^"']+)["']/i);
  if (scriptToken) return scriptToken[1];

  const inputToken = bodyText.match(
    /<input\b[^>]*name=["'](?:csrf|csrftoken|csrf_token)["'][^>]*value=["']([^"']+)["']/i,
  );
  if (inputToken) return decodeHtmlEntities(inputToken[1]);
  return undefined;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    if (raw && Array.isArray(raw["set-cookie"])) return raw["set-cookie"];
  }
  const merged = headers.get("set-cookie");
  if (!merged) return [];
  return splitMergedSetCookie(merged);
}

function splitMergedSetCookie(value) {
  const result = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    const tail = value.slice(i).toLowerCase();
    if (!inExpires && tail.startsWith("expires=")) {
      inExpires = true;
      continue;
    }
    if (inExpires && c === ";") {
      inExpires = false;
      continue;
    }
    if (!inExpires && c === ",") {
      const part = value.slice(start, i).trim();
      if (part) result.push(part);
      start = i + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function ensureUsosHost(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== USOS_HOST) {
    throw new Error(`Dozwolony host to tylko ${USOS_HOST}. Otrzymano: ${parsed.hostname}`);
  }
}

function resolveTargetUrl(url, query) {
  const resolved = /^https?:\/\//i.test(url) ? new URL(url) : new URL(url, USOS_BASE_URL);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) resolved.searchParams.set(key, String(value));
  }
  ensureUsosHost(resolved.toString());
  return resolved.toString();
}

function buildActionUrl(action, controllerPath = DEFAULT_CONTROLLER_PATH, query = {}) {
  const controller = controllerPath.startsWith("/") ? controllerPath : `/${controllerPath}`;
  const resolved = new URL(controller, USOS_BASE_URL);
  resolved.searchParams.set("_action", action);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (key !== "_action") resolved.searchParams.set(key, String(value));
    }
  }
  ensureUsosHost(resolved.toString());
  return resolved.toString();
}

function looksLikeHtml(bodyText, contentType) {
  if (typeof contentType === "string" && contentType.toLowerCase().includes("text/html")) return true;
  return /^\s*(?:<!doctype html|<html\b)/i.test(bodyText);
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanHtmlText(match[1]) : "";
}

function extractUsosActionsFromHtml(html, baseUrl) {
  const entries = [];
  const seen = new Set();

  function addCandidate(rawUrl, sourceType, methodHint = "GET") {
    if (!rawUrl) return;
    const decoded = decodeHtmlEntities(rawUrl.trim());
    if (!decoded || decoded.startsWith("javascript:") || decoded.startsWith("#")) return;
    let parsed;
    try {
      parsed = new URL(decoded, baseUrl);
    } catch {
      return;
    }
    if (parsed.hostname !== USOS_HOST) return;
    const action = parsed.searchParams.get("_action");
    if (!action) return;
    const key = `${action}|${sourceType}|${methodHint}|${parsed.pathname}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ action, methodHint, sourceType, url: parsed.toString(), path: parsed.pathname });
  }

  const hrefPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let hrefMatch = hrefPattern.exec(html);
  while (hrefMatch) {
    addCandidate(hrefMatch[1], "link", "GET");
    hrefMatch = hrefPattern.exec(html);
  }

  const formPattern = /<form\b([^>]*)>/gi;
  let formMatch = formPattern.exec(html);
  while (formMatch) {
    const tag = `<form ${formMatch[1]}>`;
    const formAction = getTagAttribute(tag, "action");
    const formMethod = (getTagAttribute(tag, "method") ?? "GET").toUpperCase();
    addCandidate(formAction, "form", formMethod);
    formMatch = formPattern.exec(html);
  }

  const rawActionPattern = /_action=([a-zA-Z0-9_/\-.]+)/g;
  let rawActionMatch = rawActionPattern.exec(html);
  while (rawActionMatch) {
    const action = rawActionMatch[1];
    addCandidate(`${DEFAULT_CONTROLLER_PATH}?_action=${action}`, "raw", "GET");
    rawActionMatch = rawActionPattern.exec(html);
  }

  return entries.sort((a, b) => a.action.localeCompare(b.action));
}

function extractLinksFromHtml(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = pattern.exec(html);
  let index = 0;
  while (match) {
    index += 1;
    const hrefRaw = decodeHtmlEntities((match[1] ?? "").trim());
    const text = cleanHtmlText(match[2] ?? "");
    if (!hrefRaw || hrefRaw.startsWith("javascript:") || hrefRaw.startsWith("#")) {
      match = pattern.exec(html);
      continue;
    }
    let url;
    try {
      url = new URL(hrefRaw, baseUrl);
    } catch {
      match = pattern.exec(html);
      continue;
    }
    if (url.hostname !== USOS_HOST) {
      match = pattern.exec(html);
      continue;
    }
    const key = `${url.toString()}|${text}`;
    if (seen.has(key)) {
      match = pattern.exec(html);
      continue;
    }
    seen.add(key);
    links.push({ id: `L${index}`, text, url: url.toString(), action: url.searchParams.get("_action") ?? undefined });
    match = pattern.exec(html);
  }
  return links;
}

function extractFormInputs(formInnerHtml) {
  const inputs = [];
  const inputPattern = /<input\b([^>]*)>/gi;
  let inputMatch = inputPattern.exec(formInnerHtml);
  while (inputMatch) {
    const tag = `<input ${inputMatch[1]}>`;
    const type = (getTagAttribute(tag, "type") ?? "text").toLowerCase();
    const name = getTagAttribute(tag, "name");
    if (name) {
      inputs.push({
        kind: "input",
        type,
        name,
        value: decodeHtmlEntities(getTagAttribute(tag, "value") ?? ""),
        required: hasBooleanAttribute(tag, "required"),
        checked: hasBooleanAttribute(tag, "checked"),
      });
    }
    inputMatch = inputPattern.exec(formInnerHtml);
  }

  const textareaPattern = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  let textareaMatch = textareaPattern.exec(formInnerHtml);
  while (textareaMatch) {
    const tag = `<textarea ${textareaMatch[1]}>`;
    const name = getTagAttribute(tag, "name");
    if (name) {
      inputs.push({
        kind: "textarea",
        type: "textarea",
        name,
        value: decodeHtmlEntities(textareaMatch[2] ?? "").trim(),
        required: hasBooleanAttribute(tag, "required"),
        checked: false,
      });
    }
    textareaMatch = textareaPattern.exec(formInnerHtml);
  }

  const selectPattern = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch = selectPattern.exec(formInnerHtml);
  while (selectMatch) {
    const selectTag = `<select ${selectMatch[1]}>`;
    const name = getTagAttribute(selectTag, "name");
    const optionsHtml = selectMatch[2] ?? "";
    if (!name) {
      selectMatch = selectPattern.exec(formInnerHtml);
      continue;
    }
    let selectedValue = "";
    let firstValue = "";
    const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch = optionPattern.exec(optionsHtml);
    while (optionMatch) {
      const optionTag = `<option ${optionMatch[1]}>`;
      const valueAttr = getTagAttribute(optionTag, "value");
      const optionText = cleanHtmlText(optionMatch[2] ?? "");
      const optionValue = decodeHtmlEntities(valueAttr ?? optionText);
      if (!firstValue) firstValue = optionValue;
      if (hasBooleanAttribute(optionTag, "selected")) selectedValue = optionValue;
      optionMatch = optionPattern.exec(optionsHtml);
    }
    inputs.push({
      kind: "select",
      type: "select",
      name,
      value: selectedValue || firstValue || "",
      required: hasBooleanAttribute(selectTag, "required"),
      checked: false,
    });
    selectMatch = selectPattern.exec(formInnerHtml);
  }
  return inputs;
}

function buildDefaultFormEntries(form) {
  const entries = [];
  for (const input of form.inputs) {
    const type = (input.type ?? "text").toLowerCase();
    const name = input.name;
    if (!name) continue;
    if (["submit", "button", "reset", "image", "file"].includes(type)) continue;
    if (type === "radio" || type === "checkbox") {
      if (input.checked) entries.push([name, input.value ?? "on"]);
      continue;
    }
    if (type === "hidden") {
      entries.push([name, input.value ?? ""]);
      continue;
    }
    if (typeof input.value === "string" && input.value.length > 0) entries.push([name, input.value]);
  }
  return entries;
}

function extractFormsFromHtml(html, baseUrl) {
  const forms = [];
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match = pattern.exec(html);
  let index = 0;
  while (match) {
    index += 1;
    const formTag = `<form ${match[1]}>`;
    const formInner = match[2] ?? "";
    const method = (getTagAttribute(formTag, "method") ?? "GET").toUpperCase();
    const actionRaw = decodeHtmlEntities(getTagAttribute(formTag, "action") ?? "");
    let actionUrl;
    if (actionRaw) {
      try {
        actionUrl = new URL(actionRaw, baseUrl);
      } catch {
        actionUrl = new URL(baseUrl);
      }
    } else {
      actionUrl = new URL(baseUrl);
    }
    if (actionUrl.hostname !== USOS_HOST) {
      match = pattern.exec(html);
      continue;
    }
    const inputs = extractFormInputs(formInner);
    const fieldNames = Array.from(new Set(inputs.map((item) => item.name)));
    const hiddenFields = Array.from(new Set(inputs.filter((item) => item.type === "hidden").map((item) => item.name)));
    const requiredFields = Array.from(new Set(inputs.filter((item) => item.required).map((item) => item.name)));
    const defaultEntries = buildDefaultFormEntries({ inputs });
    forms.push({
      id: `F${index}`,
      htmlId: getTagAttribute(formTag, "id") ?? "",
      name: getTagAttribute(formTag, "name") ?? "",
      method,
      action: actionUrl.searchParams.get("_action") ?? undefined,
      url: actionUrl.toString(),
      fieldNames,
      hiddenFields,
      requiredFields,
      defaultEntries,
      inputs,
    });
    match = pattern.exec(html);
  }
  return forms;
}

function buildPageSnapshot(html, finalUrl) {
  return {
    url: finalUrl,
    title: extractTitle(html),
    links: extractLinksFromHtml(html, finalUrl),
    forms: extractFormsFromHtml(html, finalUrl),
    actions: extractUsosActionsFromHtml(html, finalUrl),
  };
}

function createSession(username, jar) {
  return { jar, username, createdAt: Date.now(), lastUsedAt: Date.now(), pages: new Map(), pageCounter: 0, lastPageId: undefined };
}

function storePageSnapshot(session, snapshot) {
  session.pageCounter += 1;
  const pageId = `P${session.pageCounter}`;
  session.pages.set(pageId, { ...snapshot, pageId, createdAt: Date.now() });
  session.lastPageId = pageId;
  while (session.pages.size > MAX_PAGE_CACHE) {
    const oldestKey = session.pages.keys().next().value;
    session.pages.delete(oldestKey);
  }
  return pageId;
}

function getPageOrThrow(session, requestedPageId) {
  const pageId = requestedPageId ?? session.lastPageId;
  if (!pageId) throw new Error("Brak zapisanej strony w sesji.");
  const page = session.pages.get(pageId);
  if (!page) throw new Error(`Nie znaleziono page_id: ${pageId}`);
  return page;
}

function summarizePage(page, limit = DEFAULT_PAGE_LIMIT) {
  const normalizedLimit = normalizePageLimit(limit);
  return {
    page_id: page.pageId,
    title: page.title,
    url: page.url,
    links_count: page.links.length,
    forms_count: page.forms.length,
    actions_count: page.actions.length,
    links: page.links.slice(0, normalizedLimit).map((link) => ({ id: link.id, text: link.text, action: link.action, url: link.url })),
    forms: page.forms.slice(0, normalizedLimit).map((form) => ({
      id: form.id,
      html_id: form.htmlId,
      name: form.name,
      method: form.method,
      action: form.action,
      url: form.url,
      field_names: form.fieldNames,
      required_fields: form.requiredFields,
      hidden_fields: form.hiddenFields,
    })),
    actions: page.actions.slice(0, normalizedLimit),
  };
}

function formatRequestResult({ status, statusText, finalUrl, contentType, sessionId, csrfToken, bodyPreview, pageSummary }) {
  const lines = [
    `status: ${status} ${statusText || ""}`.trim(),
    `final_url: ${finalUrl}`,
    `content_type: ${contentType || "unknown"}`,
    `session_id: ${sessionId}`,
  ];
  if (csrfToken) lines.push(`csrf_token: ${csrfToken}`);
  if (pageSummary) {
    lines.push(`page_id: ${pageSummary.page_id}`);
    lines.push(`page_title: ${pageSummary.title || ""}`);
    lines.push(`page_links: ${pageSummary.links_count}`);
    lines.push(`page_forms: ${pageSummary.forms_count}`);
    lines.push(`page_actions: ${pageSummary.actions_count}`);
  }
  lines.push("body_preview:");
  lines.push(bodyPreview);
  if (pageSummary) {
    lines.push("page_json:");
    lines.push(JSON.stringify(pageSummary, null, 2));
  }
  return lines.join("\n");
}

function findLink(page, params) {
  if (params.link_id) {
    const byId = page.links.find((item) => item.id === params.link_id);
    if (byId) return byId;
  }
  if (params.action) {
    const byAction = page.links.find((item) => item.action === params.action);
    if (byAction) return byAction;
  }
  if (params.text_contains) {
    const needle = params.text_contains.toLowerCase();
    const byText = page.links.find((item) => item.text.toLowerCase().includes(needle));
    if (byText) return byText;
  }
  if (typeof params.link_index === "number" && Number.isFinite(params.link_index)) {
    const idx = Math.floor(params.link_index) - 1;
    if (idx >= 0 && idx < page.links.length) return page.links[idx];
  }
  if (page.links.length > 0) return page.links[0];
  return undefined;
}

function findForm(page, params) {
  if (params.form_id) {
    const byId = page.forms.find((item) => item.id === params.form_id);
    if (byId) return byId;
  }
  if (params.form_action) {
    const exact = page.forms.find((item) => item.action === params.form_action);
    if (exact) return exact;
    const contains = page.forms.find((item) => (item.action ?? "").includes(params.form_action));
    if (contains) return contains;
  }
  if (typeof params.form_index === "number" && Number.isFinite(params.form_index)) {
    const idx = Math.floor(params.form_index) - 1;
    if (idx >= 0 && idx < page.forms.length) return page.forms[idx];
  }
  if (page.forms.length > 0) return page.forms[0];
  return undefined;
}

async function requestWithJar({ url, jar, method = "GET", headers = {}, body, followRedirects = true }) {
  let currentUrl = url;
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  const currentHeaders = { ...headers };
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const requestHeaders = new Headers(currentHeaders);
    jar.apply(currentUrl, requestHeaders);
    const response = await fetch(currentUrl, { method: currentMethod, headers: requestHeaders, body: currentBody, redirect: "manual" });
    jar.absorb(currentUrl, response.headers);
    if (!followRedirects || !isRedirect(response.status)) return { response, finalUrl: currentUrl };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl };
    const nextUrl = new URL(location, currentUrl).toString();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      currentBody = undefined;
      delete currentHeaders["content-type"];
      delete currentHeaders["Content-Type"];
    }
    currentUrl = nextUrl;
  }
  throw new Error(`Too many redirects while requesting ${url}`);
}

async function loginToUsos(username, password) {
  const jar = new CookieJar();
  const home = await requestWithJar({ url: DEFAULT_NEWS_URL, jar, method: "GET", followRedirects: true });
  const homeHtml = await home.response.text();
  const loginUrlRaw = extractAttribute(homeHtml, "login-url");
  if (!loginUrlRaw) throw new Error("Nie znalazlem adresu logowania CAS na stronie USOSWeb.");
  const loginUrl = new URL(decodeHtmlEntities(loginUrlRaw), home.finalUrl).toString();
  const loginPage = await requestWithJar({ url: loginUrl, jar, method: "GET", followRedirects: true });
  const loginHtml = await loginPage.response.text();
  const formTag = extractLoginFormTag(loginHtml);
  if (!formTag) throw new Error("Nie znalazlem formularza logowania CAS.");
  const formActionRaw = getTagAttribute(formTag, "action");
  if (!formActionRaw) throw new Error("Formularz logowania nie ma pola action.");
  const actionUrl = new URL(decodeHtmlEntities(formActionRaw), loginPage.finalUrl).toString();
  const hiddenInputs = parseHiddenInputs(loginHtml);
  if (!hiddenInputs.execution) throw new Error("Brak tokena execution w formularzu CAS.");
  const bodyParams = new URLSearchParams();
  for (const [key, value] of Object.entries(hiddenInputs)) bodyParams.set(key, value);
  bodyParams.set("username", username.trim());
  bodyParams.set("password", password);
  if (!bodyParams.has("_eventId")) bodyParams.set("_eventId", "submit");
  if (!bodyParams.has("geolocation")) bodyParams.set("geolocation", "");
  const auth = await requestWithJar({
    url: actionUrl,
    jar,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: bodyParams.toString(),
    followRedirects: true,
  });
  const authHtml = await auth.response.text();
  const stillOnLoginForm = /<form[^>]+id=["']fm1["']/i.test(authHtml) && /name=["']password["']/i.test(authHtml);
  const success = !stillOnLoginForm && auth.finalUrl.includes(USOS_HOST);
  return {
    success,
    jar,
    finalUrl: auth.finalUrl,
    message: extractCasMessage(authHtml),
    html: authHtml,
    contentType: auth.response.headers.get("content-type") ?? "text/html",
  };
}

function createSessionFromLogin(username, loginResult) {
  const sessionId = randomUUID();
  const session = createSession(username, loginResult.jar);
  if (looksLikeHtml(loginResult.html, loginResult.contentType)) {
    const snapshot = buildPageSnapshot(loginResult.html, loginResult.finalUrl);
    storePageSnapshot(session, snapshot);
  }
  sessions.set(sessionId, session);
  return { sessionId, session };
}

async function ensureSession(params) {
  if (params.session_id) {
    const existing = sessions.get(params.session_id);
    if (!existing) throw new Error(`Nie znaleziono sesji o id: ${params.session_id}`);
    existing.lastUsedAt = Date.now();
    return { sessionId: params.session_id, session: existing };
  }
  if (!params.username || !params.password) throw new Error("Podaj session_id albo username i password.");
  const login = await loginToUsos(params.username, params.password);
  if (!login.success) {
    const suffix = login.message ? ` CAS: ${login.message}` : "";
    throw new Error(`Logowanie nie powiodlo sie.${suffix}`);
  }
  return createSessionFromLogin(params.username, login);
}

async function executeUsosRequest(rawParams, resolveUrl) {
  if (rawParams.form && rawParams.body) throw new Error("Podaj form albo body, nie oba jednoczesnie.");
  const { session, sessionId } = await ensureSession(rawParams);
  session.lastUsedAt = Date.now();
  const method = (rawParams.method ?? "GET").toUpperCase();
  const headers = { ...(rawParams.headers ?? {}) };
  let requestBody;
  if (rawParams.form) {
    const encoded = new URLSearchParams(rawParams.form);
    requestBody = encoded.toString();
    if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (typeof rawParams.body === "string") {
    requestBody = rawParams.body;
  }
  if ((method === "GET" || method === "HEAD") && typeof requestBody === "string") {
    throw new Error("Metody GET/HEAD nie obsluguja body. Uzyj query albo zmien metode.");
  }
  const targetUrl = resolveUrl();
  const responseResult = await requestWithJar({
    url: targetUrl,
    jar: session.jar,
    method,
    headers,
    body: requestBody,
    followRedirects: rawParams.follow_redirects ?? true,
  });
  const responseText = await responseResult.response.text();
  const maxChars = normalizeOutputChars(rawParams.max_output_chars);
  const bodyPreview = truncateText(responseText, maxChars);
  const contentType = responseResult.response.headers.get("content-type") ?? "";
  const csrfToken = extractCsrfToken(responseText);
  let pageSummary;
  if (looksLikeHtml(responseText, contentType)) {
    const snapshot = buildPageSnapshot(responseText, responseResult.finalUrl);
    const pageId = storePageSnapshot(session, snapshot);
    pageSummary = summarizePage(session.pages.get(pageId), DEFAULT_PAGE_LIMIT);
  }
  return { sessionId, status: responseResult.response.status, statusText: responseResult.response.statusText, finalUrl: responseResult.finalUrl, contentType, csrfToken, bodyPreview, rawBody: responseText, pageSummary };
}

function formEntriesToParams(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  return params;
}

function mergeEntries(defaultEntries, extraFields = {}, submitName, submitValue) {
  const merged = new Map();
  for (const [key, value] of defaultEntries) merged.set(key, value);
  for (const [key, value] of Object.entries(extraFields)) merged.set(key, String(value));
  if (submitName) merged.set(submitName, submitValue ?? "1");
  return Array.from(merged.entries());
}

async function executeFormSubmit(rawParams) {
  const { session, sessionId } = await ensureSession(rawParams);
  session.lastUsedAt = Date.now();
  const page = getPageOrThrow(session, rawParams.page_id);
  const form = findForm(page, rawParams);
  if (!form) {
    const knownForms = page.forms.map((item) => item.id).join(", ");
    throw new Error(`Nie znaleziono formularza. Dostepne form_id: ${knownForms || "(brak)"}`);
  }
  const method = (rawParams.method_override ?? form.method ?? "GET").toUpperCase();
  const entries = mergeEntries(form.defaultEntries, rawParams.fields ?? {}, rawParams.submit_name, rawParams.submit_value);
  let targetUrl = form.url;
  let body;
  const headers = { ...(rawParams.headers ?? {}) };
  if (method === "GET" || method === "HEAD") {
    const url = new URL(form.url);
    const params = formEntriesToParams(entries);
    for (const [k, v] of params.entries()) url.searchParams.append(k, v);
    targetUrl = url.toString();
  } else {
    body = formEntriesToParams(entries).toString();
    if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/x-www-form-urlencoded";
  }
  ensureUsosHost(targetUrl);
  const responseResult = await requestWithJar({ url: targetUrl, jar: session.jar, method, headers, body, followRedirects: rawParams.follow_redirects ?? true });
  const responseText = await responseResult.response.text();
  const maxChars = normalizeOutputChars(rawParams.max_output_chars);
  const bodyPreview = truncateText(responseText, maxChars);
  const contentType = responseResult.response.headers.get("content-type") ?? "";
  const csrfToken = extractCsrfToken(responseText);
  let pageSummary;
  if (looksLikeHtml(responseText, contentType)) {
    const snapshot = buildPageSnapshot(responseText, responseResult.finalUrl);
    const pageId = storePageSnapshot(session, snapshot);
    pageSummary = summarizePage(session.pages.get(pageId), DEFAULT_PAGE_LIMIT);
  }
  return { sessionId, status: responseResult.response.status, statusText: responseResult.response.statusText, finalUrl: responseResult.finalUrl, contentType, csrfToken, bodyPreview, pageSummary, usedFormId: form.id, usedFormAction: form.action };
}

function textContent(text) {
  return { content: [{ type: "text", text }] };
}

function errorContent(error) {
  return textContent(`ERROR: ${String(error?.message ?? error)}`);
}

function createUsosTools() {
  return [
    {
      name: "usos_login",
      description: "Loguje do USOSWeb PW przez CAS. Zwraca session_id do dalszych akcji.",
      parameters: Type.Object({ username: Type.String({ minLength: 1 }), password: Type.String({ minLength: 1 }) }),
      async execute(_id, params) {
        try {
          const login = await loginToUsos(params.username, params.password);
          if (!login.success) {
            const suffix = login.message ? ` CAS: ${login.message}` : "";
            return textContent(`ERROR: Logowanie nie powiodlo sie.${suffix}`);
          }
          const { sessionId, session } = createSessionFromLogin(params.username, login);
          const page = session.lastPageId && session.pages.get(session.lastPageId)
            ? summarizePage(session.pages.get(session.lastPageId))
            : undefined;
          return textContent([
            "authenticated: true",
            `session_id: ${sessionId}`,
            `final_url: ${login.finalUrl}`,
            ...(page ? [`page_id: ${page.page_id}`, "page_json:", JSON.stringify(page, null, 2)] : []),
          ].join("\n"));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_request",
      description: "Wysyla dowolne zapytanie HTTP do USOSWeb PW na zalogowanej sesji (lub loguje automatycznie username/password).",
      parameters: Type.Object({
        url: Type.String({ minLength: 1, description: "Absolutny URL albo sciezka wzgledem https://usosweb.usos.pw.edu.pl" }),
        method: Type.Optional(Type.String({ default: "GET" })),
        session_id: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
        query: Type.Optional(Type.Record(Type.String(), Type.String())),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        form: Type.Optional(Type.Record(Type.String(), Type.String())),
        body: Type.Optional(Type.String()),
        follow_redirects: Type.Optional(Type.Boolean({ default: true })),
        max_output_chars: Type.Optional(Type.Number({ default: DEFAULT_OUTPUT_CHARS })),
      }),
      async execute(_id, params) {
        try {
          const result = await executeUsosRequest(params, () => resolveTargetUrl(params.url, params.query));
          return textContent(formatRequestResult(result));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_action_request",
      description: "Wysyla request po samym parametrze _action (np. grades/index), bez recznego skladania URL.",
      parameters: Type.Object({
        action: Type.String({ minLength: 1 }),
        controller_path: Type.Optional(Type.String({ default: DEFAULT_CONTROLLER_PATH })),
        method: Type.Optional(Type.String({ default: "GET" })),
        session_id: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
        query: Type.Optional(Type.Record(Type.String(), Type.String())),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        form: Type.Optional(Type.Record(Type.String(), Type.String())),
        body: Type.Optional(Type.String()),
        follow_redirects: Type.Optional(Type.Boolean({ default: true })),
        max_output_chars: Type.Optional(Type.Number({ default: DEFAULT_OUTPUT_CHARS })),
      }),
      async execute(_id, params) {
        try {
          const result = await executeUsosRequest(params, () => buildActionUrl(params.action, params.controller_path, params.query));
          return textContent([`action: ${params.action}`, formatRequestResult(result)].join("\n"));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_discover_endpoints",
      description: "Pobiera strone USOS i zwraca wykryte endpointy (_action) z linkow, formularzy i tresci HTML.",
      parameters: Type.Object({
        page_url: Type.Optional(Type.String({ default: DEFAULT_NEWS_URL })),
        page_action: Type.Optional(Type.String()),
        controller_path: Type.Optional(Type.String({ default: DEFAULT_CONTROLLER_PATH })),
        session_id: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ default: DEFAULT_DISCOVERY_LIMIT })),
      }),
      async execute(_id, params) {
        try {
          const url = params.page_action?.trim()
            ? buildActionUrl(params.page_action, params.controller_path)
            : resolveTargetUrl(params.page_url ?? DEFAULT_NEWS_URL);
          const result = await executeUsosRequest({
            ...params,
            method: "GET",
            url,
            query: undefined,
            headers: undefined,
            form: undefined,
            body: undefined,
            follow_redirects: true,
            max_output_chars: MAX_OUTPUT_CHARS,
          }, () => url);
          const allEndpoints = extractUsosActionsFromHtml(result.rawBody, result.finalUrl);
          const limit = normalizeDiscoveryLimit(params.limit);
          const endpoints = allEndpoints.slice(0, limit);
          return textContent([
            `scanned_url: ${result.finalUrl}`,
            `session_id: ${result.sessionId}`,
            `found_total: ${allEndpoints.length}`,
            `returned: ${endpoints.length}`,
            "endpoints_json:",
            JSON.stringify(endpoints, null, 2),
          ].join("\n"));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_get_page_state",
      description: "Zwraca zcacheowany stan strony (linki, formularze, akcje) z ostatniej odpowiedzi lub po page_id.",
      parameters: Type.Object({
        session_id: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
        page_id: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ default: DEFAULT_PAGE_LIMIT })),
      }),
      async execute(_id, params) {
        try {
          const { session, sessionId } = await ensureSession(params);
          const page = getPageOrThrow(session, params.page_id);
          const summary = summarizePage(page, params.limit);
          return textContent([`session_id: ${sessionId}`, `page_id: ${summary.page_id}`, "page_json:", JSON.stringify(summary, null, 2)].join("\n"));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_click_link",
      description: "Klikniecie linku z poprzednio pobranej strony po link_id, action, text_contains lub link_index.",
      parameters: Type.Object({
        session_id: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
        page_id: Type.Optional(Type.String()),
        link_id: Type.Optional(Type.String()),
        action: Type.Optional(Type.String()),
        text_contains: Type.Optional(Type.String()),
        link_index: Type.Optional(Type.Number()),
        follow_redirects: Type.Optional(Type.Boolean({ default: true })),
        max_output_chars: Type.Optional(Type.Number({ default: DEFAULT_OUTPUT_CHARS })),
      }),
      async execute(_id, params) {
        try {
          const { session, sessionId } = await ensureSession(params);
          const page = getPageOrThrow(session, params.page_id);
          const link = findLink(page, params);
          if (!link) throw new Error("Nie znaleziono linku na stronie.");
          const result = await executeUsosRequest({
            session_id: sessionId,
            method: "GET",
            url: link.url,
            follow_redirects: params.follow_redirects,
            max_output_chars: params.max_output_chars,
          }, () => link.url);
          return textContent([
            `clicked_link_id: ${link.id}`,
            `clicked_link_text: ${link.text}`,
            `clicked_link_url: ${link.url}`,
            ...(link.action ? [`clicked_action: ${link.action}`] : []),
            formatRequestResult(result),
          ].join("\n"));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_submit_form",
      description: "Wysyla formularz ze strony w sesji (domyslnie pierwszy), lacznie z ukrytymi polami i tokenami.",
      parameters: Type.Object({
        session_id: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
        page_id: Type.Optional(Type.String()),
        form_id: Type.Optional(Type.String()),
        form_action: Type.Optional(Type.String()),
        form_index: Type.Optional(Type.Number()),
        fields: Type.Optional(Type.Record(Type.String(), Type.String())),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        submit_name: Type.Optional(Type.String()),
        submit_value: Type.Optional(Type.String()),
        method_override: Type.Optional(Type.String()),
        follow_redirects: Type.Optional(Type.Boolean({ default: true })),
        max_output_chars: Type.Optional(Type.Number({ default: DEFAULT_OUTPUT_CHARS })),
      }),
      async execute(_id, params) {
        try {
          const result = await executeFormSubmit(params);
          return textContent([
            `submitted_form_id: ${result.usedFormId}`,
            ...(result.usedFormAction ? [`submitted_form_action: ${result.usedFormAction}`] : []),
            formatRequestResult(result),
          ].join("\n"));
        } catch (error) {
          return errorContent(error);
        }
      },
    },
    {
      name: "usos_logout",
      description: "Usuwa lokalna sesje pluginu po session_id.",
      parameters: Type.Object({ session_id: Type.String({ minLength: 1 }) }),
      async execute(_id, params) {
        const existed = sessions.delete(params.session_id);
        return textContent(existed ? `session_removed: ${params.session_id}` : `session_not_found: ${params.session_id}`);
      },
    },
  ];
}

export default definePluginEntry({
  id: "openclaw-usos-pw-plugin",
  name: "USOS PW",
  description: "Logowanie CAS i wykonywanie dowolnych akcji HTTP w USOSWeb PW.",
  register(api) {
    api.registerTool(() => createUsosTools(), {
      names: [
        "usos_login",
        "usos_request",
        "usos_action_request",
        "usos_discover_endpoints",
        "usos_get_page_state",
        "usos_click_link",
        "usos_submit_form",
        "usos_logout",
      ],
      optional: true,
    });
  },
});
