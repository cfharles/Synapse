// Google Calendar integration. Zero dependencies: plain fetch + a loopback
// OAuth flow. SYNAPSE_MOCK=1 swaps in a file-backed mock for tests.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_FILE = "token-gcal.json"; // matches .gitignore's token*.json

/** Returns a calendar, or null when not configured (pipeline falls back to inbox). */
export function getCalendar(cfg, vault) {
  if (process.env.SYNAPSE_MOCK === "1") return new MockCalendar(vault);
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return new GoogleCalendar(cfg);
  }
  return null;
}

export class GoogleCalendar {
  constructor(cfg) {
    this.cfg = cfg;
    this.tokenPath = path.join(cfg.repoRoot, TOKEN_FILE);
    this.calendarId = cfg.calendarId || "primary";
  }

  // ---- auth ----

  loadToken() {
    if (!fs.existsSync(this.tokenPath)) {
      throw new Error("Google Calendar not authorized yet. Run: node src/index.js auth-gcal");
    }
    return JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
  }

  saveToken(t) {
    fs.writeFileSync(this.tokenPath, JSON.stringify(t, null, 2), { mode: 0o600 });
  }

  async accessToken() {
    const t = this.loadToken();
    if (t.expiry && Date.now() < t.expiry - 60_000) return t.access_token;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: t.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
    const fresh = await res.json();
    this.saveToken({
      ...t,
      access_token: fresh.access_token,
      expiry: Date.now() + fresh.expires_in * 1000,
    });
    return fresh.access_token;
  }

  /** One-time interactive authorization via loopback redirect. */
  async authFlow() {
    const port = 8765 + Math.floor(Math.random() * 1000);
    const redirect = `http://127.0.0.1:${port}`;
    const url =
      `${AUTH_URL}?client_id=${encodeURIComponent(process.env.GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code` +
      `&scope=${encodeURIComponent(SCOPE)}&access_type=offline&prompt=consent`;

    console.log("Open this URL in your browser and approve access:\n\n" + url + "\n");

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, redirect);
        const c = u.searchParams.get("code");
        res.end(c ? "Synapse is authorized. You can close this tab." : "No code received.");
        server.close();
        c ? resolve(c) : reject(new Error("Authorization denied"));
      });
      server.listen(port);
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
    const t = await res.json();
    this.saveToken({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expiry: Date.now() + t.expires_in * 1000,
    });
    console.log("✓ Google Calendar authorized (token-gcal.json, gitignored)");
  }

  // ---- api ----

  async api(method, p, body) {
    const token = await this.accessToken();
    const res = await fetch(`${API}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async create({ title, date, time, durationMin = 60, location = null, attendees = [] }) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let body;
    let start, end;
    if (!time) {
      // All-day event (used for task deadlines).
      const next = new Date(new Date(`${date}T00:00:00`).getTime() + 86_400_000);
      const p = (n) => String(n).padStart(2, "0");
      const nextStr = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
      body = { summary: title, start: { date }, end: { date: nextStr } };
      start = new Date(`${date}T00:00:00`);
      end = next;
    } else {
      start = new Date(`${date}T${time}:00`);
      end = new Date(start.getTime() + durationMin * 60_000);
      body = {
        summary: title,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz },
      };
    }
    if (location) body.location = location;
    if (attendees.length) body.attendees = attendees.map((email) => ({ email }));
    const ev = await this.api(
      "POST",
      `/calendars/${encodeURIComponent(this.calendarId)}/events`,
      body
    );
    return { start, end, link: ev.htmlLink || "" };
  }

  async conflicts(start, end) {
    const data = await this.api(
      "GET",
      `/calendars/${encodeURIComponent(this.calendarId)}/events` +
        `?timeMin=${encodeURIComponent(start.toISOString())}` +
        `&timeMax=${encodeURIComponent(end.toISOString())}` +
        `&singleEvents=true&orderBy=startTime`
    );
    return (data.items || []).map((e) => e.summary || "(untitled)");
  }

  async agenda(days = 7) {
    const now = new Date();
    const until = new Date(now.getTime() + days * 86_400_000);
    const data = await this.api(
      "GET",
      `/calendars/${encodeURIComponent(this.calendarId)}/events` +
        `?timeMin=${encodeURIComponent(now.toISOString())}` +
        `&timeMax=${encodeURIComponent(until.toISOString())}` +
        `&singleEvents=true&orderBy=startTime`
    );
    return (data.items || []).map((e) => {
      const when = e.start?.dateTime || e.start?.date || "?";
      return `${when}  ${e.summary || "(untitled)"}`;
    });
  }
}

// ---------- mock (tests / offline) ----------

export class MockCalendar {
  constructor(vault) {
    this.file = vault.p("archive", "mock-calendar.jsonl");
  }

  read() {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async create({ title, date, time, durationMin = 60 }) {
    const start = new Date(`${date}T${time || "00:00"}:00`);
    const end = time
      ? new Date(start.getTime() + durationMin * 60_000)
      : new Date(start.getTime() + 86_400_000);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(
      this.file,
      JSON.stringify({ title, start: start.toISOString(), end: end.toISOString() }) + "\n"
    );
    return { start, end, link: "(mock)" };
  }

  async conflicts(start, end) {
    return this.read()
      .filter((e) => new Date(e.start) < end && new Date(e.end) > start)
      .map((e) => e.title);
  }

  async agenda() {
    return this.read().map((e) => `${e.start}  ${e.title}`);
  }
}
