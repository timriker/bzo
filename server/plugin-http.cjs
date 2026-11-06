/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// plugin-http.cjs - a plugin's web pages, shaped as upstream's
// (include/bzfsHTTPAPI.h) so a VDir ports line for line. Upstream serves them
// at `/<name>/` on the game port; bzo serves them at `/plugins/<name>/` on its
// own web server, with upstream's index of them at `/plugins/`.
//
// A VDir's `RequiredAuthentiction` is upstream's: eBZID sends a visitor to
// bzflag.org's weblogin and checks the token that comes back, eHTTPBasic and
// eHTTPOther ask the VDir's AuthenticateHTTPUser. Not offered: upstream's
// SessionData, templates and resource directories.

'use strict';

const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

// bzhttp_eRequestType, bzhttp_eReturnCode, bzhttp_eDocumentType and
// bzhttp_ePageGenStatus, by upstream's names and in its order.
const REQUEST_TYPES = Object.freeze(['eHTTPUnknown', 'eHTTPGet', 'eHTTPHead', 'eHTTPPost', 'eHTTPPut',
  'eHTTPDelete', 'eHTTPTrace', 'eHTTPOptions', 'eHTTPConnect']);
const RETURN_CODES = Object.freeze(['e200OK', 'e301Redirect', 'e302Found', 'e401Unauthorized', 'e403Forbiden',
  'e404NotFound', 'e418IAmATeapot', 'e500ServerError']);
const STATUS_BY_CODE = Object.freeze([200, 301, 302, 401, 403, 404, 418, 500]);
const DOCUMENT_TYPES = Object.freeze(['eText', 'eOctetStream', 'eBinary', 'eHTML', 'eCSS', 'eXML', 'eJSON', 'eOther']);
const PAGE_STATUS = Object.freeze(['eNoPage', 'eWaitForIt', 'ePageDone']);
const AUTH_METHODS = Object.freeze(['eNoAuth', 'eHTTPBasic', 'eHTTPOther', 'eBZID']);
const AUTH_STATUS = Object.freeze(['eAuthFail', 'eAuthOK', 'eNotAuthedYet']);

// getMimeType (bzfsHTTPAPI.cxx:1246).
const MIME_TYPES = Object.freeze([
  'text/plain', 'application/octet-stream', 'application/binary', 'text/html', 'text/css',
  'application/xml', 'application/json', 'text/plain',
]);

// What a plugin's `bz` gains: the enums by name, as upstream's are.
const HTTP_CONSTANTS = Object.freeze(Object.fromEntries([REQUEST_TYPES, RETURN_CODES, DOCUMENT_TYPES, PAGE_STATUS,
  AUTH_METHODS, AUTH_STATUS]
  .flatMap((names) => names.map((name, index) => [name, index]))));

// A name list's lookups, upstream's GetX(name) and GetX(index) both.
function lookup(pairs, folded) {
  return (key) => {
    if (typeof key === 'number') return pairs[key]?.[0] ?? null;
    const want = folded ? String(key).toLowerCase() : String(key);
    const found = pairs.find(([name]) => (folded ? name.toLowerCase() : name) === want);
    return found ? found[1] : null;
  };
}

// bzhttp_Request, from Express's. `body` is the raw bytes; a form POST's
// fields join the query's parameters, as upstream's parseParams adds both.
// `url` is the one the page answers, which after a BZID login is the one the
// visitor first asked for.
function makeRequest(req, body, address, url = req.originalUrl) {
  const headers = Object.entries(req.headers).map(([name, value]) => [name, String(value)]);
  const cookies = String(req.headers.cookie || '').split(';')
    .map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part, ''] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
    });
  const text = body ? body.toString('utf8') : '';
  const params = [...new URL(url, 'http://x').searchParams];
  if (req.method === 'POST' && /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) {
    params.push(...new URLSearchParams(text));
  }
  const typeIndex = REQUEST_TYPES.indexOf(`eHTTP${req.method.charAt(0)}${req.method.slice(1).toLowerCase()}`);
  return {
    RequestType: Math.max(0, typeIndex),
    URL: url,
    Resource: url.split('?')[0],
    RequesterIP: address,
    RequesterHost: '',
    BZID: '',
    BZIDCallsign: '',
    BZIDGroups: [],
    Body: text,
    BodyBytes: body || Buffer.alloc(0),
    UserHasPerm: () => false,
    InBZIDGroup: () => false,
    GetHeader: lookup(headers, true),
    GetHeaderCount: () => headers.length,
    GetCookie: lookup(cookies, false),
    GetCookieCount: () => cookies.length,
    GetParamater: lookup(params, false),
    GetParamaterCount: () => params.length,
    Version: 1,
  };
}

// bzhttp_Response, which the page fills.
function makeResponse() {
  const response = {
    ReturnCode: 0,
    DocumentType: 0,
    ForceNoCache: false,
    RedirectLocation: '',
    MimeType: '',
    MD5Hash: '',
    CookieDomain: '',
    CookiePath: '',
    headers: [],
    cookies: [],
    body: [],
    AddHeader(name, value) { response.headers.push([String(name), String(value)]); },
    AddCookies(name, value) { response.cookies.push([String(name), String(value)]); },
    AddBodyData(value) { response.body.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); },
    Version: 1,
  };
  return response;
}

// GenerateResponse (bzfsHTTPAPI.cxx:1358): the status, its type only on a
// 200, the redirect, no-cache, MD5, the page's own headers and cookies.
function sendResponse(res, response, vdirName) {
  const status = STATUS_BY_CODE[response.ReturnCode] ?? 500;
  res.status(status);
  if (status === 301 || status === 302) {
    if (response.RedirectLocation) res.set('Location', response.RedirectLocation);
  }
  const body = Buffer.concat(response.body);
  if (body.length > 0) {
    const ownType = response.DocumentType === DOCUMENT_TYPES.indexOf('eOther') && response.MimeType;
    res.type(status === 200 ? (ownType || MIME_TYPES[response.DocumentType] || 'text/plain') : 'text/html');
  }
  if (response.ForceNoCache) res.set('Cache-Control', 'no-cache');
  if (response.MD5Hash) res.set('Content-MD5', response.MD5Hash);
  for (const [name, value] of response.headers) res.set(name, value);
  for (const [name, value] of response.cookies) {
    res.cookie(name, value, {
      domain: response.CookieDomain || undefined,
      path: response.CookiePath || `/plugins/${vdirName}`,
      maxAge: 3600 * 1000,
      httpOnly: true,
    });
  }
  res.end(body);
}

// Upstream's HTTPIndexHandler: each page with a link and its description.
function indexPage(vdirs, host) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const lines = vdirs.length === 0
    ? 'No HTTP Services are running on this server'
    : vdirs.map(({ name, description }) => `<a href="/plugins/${encodeURIComponent(name)}/">${escape(name)}</a>`
      + `&nbsp;${escape(description)}<br/>`).join('');
  return `<!DOCTYPE html><html><head><title>Index page for ${escape(host)}</title></head><body>${lines}</body></html>`;
}

// What a BZID login keeps: the visitor's way back from bzflag.org, good once
// and for ten minutes, and, for a VDir with CacheAuthentication, who they
// proved to be, for an hour behind a cookie. Few enough held at once that
// nobody can fill memory with unfinished logins.
const PENDING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const HELD_LIMIT = 500;
const SESSION_COOKIE = 'bzhttp_session';
const BZFLAG_LOGIN_URL = 'https://my.bzflag.org/weblogin.php';

function createHeld(ttl, now) {
  const records = new Map();
  const prune = () => {
    for (const [key, record] of records) if (record.at < now() - ttl) records.delete(key);
    while (records.size >= HELD_LIMIT) records.delete(records.keys().next().value);
  };
  return {
    add(record) {
      prune();
      const key = crypto.randomBytes(24).toString('base64url');
      records.set(key, { ...record, at: now() });
      return key;
    },
    get(key) {
      const record = typeof key === 'string' ? records.get(key) : null;
      return record && record.at >= now() - ttl ? record : null;
    },
    take(key) {
      const record = this.get(key);
      if (typeof key === 'string') records.delete(key);
      return record;
    },
  };
}

// The authentication a VDir asks for, before its page is made (the
// connection's handling, bzfsHTTPAPI.cxx:980). `checkToken(callsign, token,
// groups)` asks CHECKTOKENS and resolves to `{ good, bzid, callsign, groups }`;
// `serverGroups()` are asked about for every login, as upstream adds its own
// groups to a VDir's `BZIDAuthenicationGroups`; `groupsHavePerm(groups,
// perm)` is what a signed-in visitor in those groups may do.
function createWebAuth({ checkToken, serverGroups = () => [], groupsHavePerm, log = () => {}, now = Date.now }) {
  const pending = createHeld(PENDING_TTL_MS, now);
  const sessions = createHeld(SESSION_TTL_MS, now);

  const identify = (request, who) => {
    const groups = who.groups.map(String);
    request.BZID = String(who.bzid);
    request.BZIDCallsign = String(who.callsign);
    request.BZIDGroups = groups;
    request.UserHasPerm = (perm) => groupsHavePerm(groups, perm);
    request.InBZIDGroup = (group) => groups.some((held) => held.toUpperCase() === String(group).toUpperCase());
  };

  // Refused: the VDir's own page if it makes one, upstream's 403 if not.
  const refuse = async (vdir, request, response) => {
    if (typeof vdir.GenerateNoAuthPage === 'function' && await vdir.GenerateNoAuthPage(request, response)) return;
    response.ReturnCode = RETURN_CODES.indexOf('e403Forbiden');
    response.body.length = 0;
  };

  // eHTTPBasic and eHTTPOther: the VDir decides from the Authorization header,
  // and with none a Basic one is asked for.
  async function httpUser(vdir, request, response) {
    const header = request.GetHeader('Authorization');
    if (!header && vdir.RequiredAuthentiction === AUTH_METHODS.indexOf('eHTTPBasic')) {
      response.ReturnCode = RETURN_CODES.indexOf('e401Unauthorized');
      response.AddHeader('WWW-Authenticate', `Basic realm="${String(vdir.HTTPAuthenicationRelalm || vdir.VDirName?.() || '')
        .replace(/["\\]/g, '')}"`);
      return false;
    }
    const decoded = header ? Buffer.from(header.replace(/^\s*Basic\s+/i, ''), 'base64').toString('utf8') : '';
    const colon = decoded.indexOf(':');
    const status = typeof vdir.AuthenticateHTTPUser === 'function'
      ? await vdir.AuthenticateHTTPUser(request.RequesterIP, colon < 0 ? null : decoded.slice(0, colon),
        colon < 0 ? null : decoded.slice(colon + 1), request)
      : AUTH_STATUS.indexOf('eAuthFail');
    if (status === AUTH_STATUS.indexOf('eAuthOK')) return true;
    await refuse(vdir, request, response);
    return false;
  }

  // eBZID: a cached login, a way back from bzflag.org, or off to bzflag.org.
  // `%TOKEN%` and `%USERNAME%` ride in one parameter with the key, as
  // /login's do, since an unencoded `&` would belong to weblogin.php's own
  // query; the page the visitor asked for is kept here, not in that URL.
  async function bzid(vdir, name, req, res, request, response, base) {
    const cached = vdir.CacheAuthentication ? sessions.get(request.GetCookie(SESSION_COOKIE)) : null;
    if (cached?.vdir === name) {
      identify(request, cached);
      return { ok: true };
    }
    const back = request.GetParamater('bzauth');
    if (back !== null) {
      const [key, token, ...rest] = String(back).split(':');
      const callsign = rest.join(':');
      const started = pending.take(key);
      if (!started || started.vdir !== name || !token || !callsign) {
        await refuse(vdir, request, response);
        return { ok: false };
      }
      const groups = [...serverGroups(), ...(vdir.BZIDAuthenicationGroups || [])].map(String);
      let reply;
      try {
        reply = await checkToken(callsign, token, [...new Set(groups)]);
      } catch (error) {
        log(`[PLUGIN] ${name}: CHECKTOKENS failed: ${error?.message || error}`);
        reply = null;
      }
      if (!reply?.good || !reply.bzid) {
        await refuse(vdir, request, response);
        return { ok: false };
      }
      const who = { vdir: name, bzid: reply.bzid, callsign: reply.callsign || callsign, groups: reply.groups || [] };
      if (vdir.CacheAuthentication) {
        res.cookie(SESSION_COOKIE, sessions.add(who), {
          path: `/plugins/${name}`, maxAge: SESSION_TTL_MS, httpOnly: true, sameSite: 'lax', secure: base.startsWith('https:'),
        });
      }
      return { ok: true, url: started.url, who };
    }
    const key = pending.add({ vdir: name, url: req.originalUrl });
    const resource = req.originalUrl.split('?')[0];
    response.ReturnCode = RETURN_CODES.indexOf('e302Found');
    response.RedirectLocation = `${BZFLAG_LOGIN_URL}?action=weblogin&url=${base}${resource}`
      + `?bzauth=${key}:%TOKEN%:%USERNAME%`;
    return { ok: false };
  }

  return { bzid, httpUser, identify };
}

// A page that answers eWaitForIt is asked again, with the same request and
// response, as upstream's Think asks it each pass of its loop; this often,
// and for this long before the request is given up as a 500.
const WAIT_MS = 100;
const WAIT_LIMIT_MS = 120 * 1000;

// Runs one page. `vdir` is the plugin's object, registered as `name`;
// `report` hears what it throws. GeneratePage may also return a promise of its
// status. `webAuth` (createWebAuth) and `base`, the scheme and host the
// visitor used, serve a VDir that asks for authentication.
async function servePage(vdir, name, req, res, { body, address, report, webAuth, base = '', timers = globalThis }) {
  let request = makeRequest(req, body, address);
  const response = makeResponse();
  const waitForIt = PAGE_STATUS.indexOf('eWaitForIt');
  const started = Date.now();
  let status;
  try {
    const method = vdir.RequiredAuthentiction || 0;
    if (method !== 0 && !webAuth) throw new Error('authentication asked for, and none offered');
    if (method === AUTH_METHODS.indexOf('eBZID')) {
      const outcome = await webAuth.bzid(vdir, name, req, res, request, response, base);
      if (!outcome.ok) {
        sendResponse(res, response, name);
        return;
      }
      if (outcome.who) {
        request = makeRequest(req, body, address, outcome.url);
        webAuth.identify(request, outcome.who);
      }
    } else if (method !== 0 && !await webAuth.httpUser(vdir, request, response)) {
      sendResponse(res, response, name);
      return;
    }
    status = await vdir.GeneratePage(request, response);
    while (status === waitForIt && Date.now() - started < WAIT_LIMIT_MS && !res.writableEnded) {
      await new Promise((resolve) => { timers.setTimeout(resolve, WAIT_MS); });
      status = await vdir.GeneratePage(request, response);
    }
  } catch (error) {
    report(error);
    res.status(500).type('text/plain').end('Server Error\n');
    return;
  }
  if (status === waitForIt) {
    res.status(500).type('text/plain').end('Server Error\n');
    return;
  }
  if (status === PAGE_STATUS.indexOf('eNoPage') || status === undefined || status === false) {
    res.status(404).type('text/plain').end('Not Found\n');
    return;
  }
  sendResponse(res, response, name);
}

module.exports = { HTTP_CONSTANTS, createWebAuth, indexPage, servePage };
