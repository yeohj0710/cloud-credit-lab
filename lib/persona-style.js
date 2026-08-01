import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function normalized(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function features(value) {
  const text = normalized(value);
  const result = new Set(text.match(/[\p{L}\p{N}]{2,}/gu) || []);
  const compact = text.replace(/\s/g, "");
  for (let i = 0; i + 1 < compact.length; i += 1) result.add(compact.slice(i, i + 2));
  return result;
}

function score(query, candidate) {
  const left = features(query);
  const right = features(candidate);
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.max(1, Math.sqrt(left.size * right.size));
}

export function buildStyleIndex(rows, { maxPerAlias = 160 } = {}) {
  const index = new Map();
  for (const row of rows) {
    const alias = String(row?.target || "");
    const query = String(row?.query || "").trim();
    const reply = String(row?.reply || "").trim();
    if (!alias || !query || !reply || reply.length > 240) continue;
    const entries = index.get(alias) || [];
    if (entries.length < maxPerAlias) entries.push({ query, reply });
    index.set(alias, entries);
  }
  return index;
}

export async function loadStyleIndex(jsonlPath, { maxPerAlias = 160 } = {}) {
  const index = new Map();
  const input = createInterface({ input: createReadStream(jsonlPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of input) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const target = String(row?.target || "");
    const messages = Array.isArray(row?.messages) ? row.messages : [];
    const user = messages.findLast?.((message) => message?.role === "user") || [...messages].reverse().find((message) => message?.role === "user");
    const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
    const content = String(user?.content || "");
    const speakerLines = [...content.matchAll(/^P_[A-Z0-9]+:\s*(.+)$/gmu)];
    const query = speakerLines.at(-1)?.[1] || content;
    const reply = String(assistant?.content || "").trim();
    if (!target || !query || !reply || reply.length > 240) continue;
    const entries = index.get(target) || [];
    if (entries.length < maxPerAlias) entries.push({ query, reply });
    index.set(target, entries);
  }
  return index;
}

export function retrieveStyleExamples(index, alias, query, { limit = 3 } = {}) {
  return (index.get(alias) || [])
    .map((entry, position) => ({ ...entry, position, score: score(query, entry.query) }))
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, limit)
    .map((entry) => entry.reply);
}

export function hasPrivateOverlap(reply, examples, { minLength = 12 } = {}) {
  const output = normalized(reply).replace(/\s/g, "");
  if (output.length < minLength) return false;
  for (const example of examples) {
    const source = normalized(example).replace(/\s/g, "");
    for (let start = 0; start + minLength <= output.length; start += 1) {
      if (source.includes(output.slice(start, start + minLength))) return true;
    }
  }
  return false;
}
