// Pure helpers for imported MQL5 EAs: read the input list out of the .mq5 source, read and write MT5 .set files.
// No dependencies, so it can be tested without MT5.

const INT_TYPES = new Set(['int', 'uint', 'long', 'ulong', 'short', 'ushort', 'char', 'uchar']);
const NUM_TYPES = new Set(['double', 'float']);
const LINE = /^\s*(?:input|sinput)\s+([A-Za-z_][A-Za-z0-9_:<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]*?)\s*;\s*(?:\/\/\s*(.*?))?\s*$/;

export const kindOf = type => type === 'bool' ? 'bool' : INT_TYPES.has(type) ? 'int' : NUM_TYPES.has(type) ? 'num' : type === 'string' ? 'str' : 'other';

// input double InpLots = 0.01; // lots per leg   ->   { name, type, kind, def, comment }
export function parseInputs(source) {
  const out = [], seen = new Set();
  for (const raw of String(source || '').split(/\r?\n/)) {
    const m = LINE.exec(raw); if (!m) continue;
    const [, type, name, def, comment] = m;
    if (seen.has(name) || out.length >= 80) continue;
    seen.add(name);
    out.push({ name, type, kind: kindOf(type), def: def.replace(/^"(.*)"$/, '$1'), comment: (comment || '').slice(0, 120) });
  }
  return out;
}

// Returns the cleaned value if it is valid for this input, otherwise null.
export function cleanValue(inp, v) {
  let s = String(v ?? '').trim().replace(',', inp.kind === 'num' ? '.' : ',');
  if (inp.kind === 'bool') { s = s.toLowerCase(); return s === 'true' || s === '1' ? 'true' : s === 'false' || s === '0' ? 'false' : null; }
  if (inp.kind === 'int') return /^-?\d{1,12}$/.test(s) ? s : null;
  if (inp.kind === 'num') return /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? s : null;
  if (inp.kind === 'str') return s.length <= 80 && !/[\r\n\u0000]/.test(s) ? s : null;
  return /^[A-Za-z0-9_.:+\-]{1,40}$/.test(s) ? s : null;   // enums, colors, dates
}

// Read the "Name=value" lines of a .set file. Ignores comments, [sections] and the optimiser tail "||0||1||2||N".
export function parseSet(text) {
  const out = {};
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '[' || line[0] === '#') continue;
    const i = line.indexOf('='); if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.keys(out).length >= 200) continue;
    out[key] = line.slice(i + 1).split('||')[0].trim();
  }
  return out;
}

// Build the text of a .set file. With a known input list every input is written (default unless changed).
export function renderSet(inputs, values) {
  const v = values || {};
  const rows = inputs && inputs.length ? inputs.map(i => [i.name, v[i.name] ?? i.def]) : Object.entries(v);
  return rows.map(([k, x]) => `${k}=${x}`).join('\r\n') + '\r\n';
}

// Apply a map of new values to a known input list. Returns what was applied and which names were rejected.
export function applyValues(inputs, current, incoming) {
  const byName = new Map(inputs.map(i => [i.name.toLowerCase(), i]));
  const values = { ...current }, applied = [], rejected = [];
  for (const [k, raw] of Object.entries(incoming || {})) {
    const inp = byName.get(String(k).toLowerCase());
    const val = inp ? cleanValue(inp, raw) : null;
    if (val === null) { rejected.push(k); continue; }
    values[inp.name] = val; applied.push(inp.name);
  }
  return { values, applied, rejected };
}

// ---------- Python bots ----------
// Settings of a Python bot are its top-level UPPER_CASE constants:   LOTS = 0.01   # lots per trade
const PY_LINE = /^([A-Z][A-Z0-9_]{1,40})\s*(?::\s*\w+\s*)?=\s*(True|False|-?\d+\.\d*(?:[eE][+-]?\d+)?|-?\.\d+|-?\d+(?:[eE][+-]?\d+)?|"[^"\\\r\n]*"|'[^'\\\r\n]*')\s*(?:#\s*(.*?))?\s*$/;
export function parsePyInputs(source) {
  const out = [], seen = new Set();
  for (const raw of String(source || '').split(/\r?\n/)) {
    const m = PY_LINE.exec(raw); if (!m || seen.has(m[1]) || out.length >= 80) continue;
    seen.add(m[1]);
    const lit = m[2], isStr = /^["']/.test(lit);
    const kind = isStr ? 'str' : /^(True|False)$/.test(lit) ? 'bool' : /^-?\d+$/.test(lit) ? 'int' : 'num';
    out.push({ name: m[1], type: kind === 'bool' ? 'bool' : kind === 'int' ? 'int' : kind === 'num' ? 'float' : 'str', kind, def: kind === 'bool' ? lit.toLowerCase() : isStr ? lit.slice(1, -1) : lit, comment: (m[3] || '').slice(0, 120) });
  }
  return out;
}
const pyLit = (inp, v) => inp.kind === 'bool' ? (v === 'true' ? 'True' : 'False') : inp.kind === 'str' ? JSON.stringify(String(v)) : String(v);
// Same script with the chosen values written into the constants (values are already validated by cleanValue).
export function patchPySource(source, inputs, values) {
  const by = new Map(inputs.map(i => [i.name, i]));
  return String(source).split(/(\r?\n)/).map(line => {
    const m = PY_LINE.exec(line); if (!m) return line;
    const inp = by.get(m[1]); const v = values && values[m[1]];
    if (!inp || v === undefined) return line;
    return line.replace(m[2], () => pyLit(inp, v));
  }).join('');
}
