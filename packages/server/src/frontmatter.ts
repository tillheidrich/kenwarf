import YAML from 'yaml';

/** Trennt YAML-Kopf und Text einer Markdown-Datei. */
export function teileFrontmatter(roh: string): { kopf: Record<string, unknown>; text: string; kopfZeilen: number } {
  const t = roh.replace(/^﻿/, '');
  if (!t.startsWith('---')) return { kopf: {}, text: t, kopfZeilen: 0 };
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { kopf: {}, text: t, kopfZeilen: 0 };
  const parsed: unknown = YAML.parse(m[1] ?? '') ?? {};
  const kopf = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { kopf, text: t.slice(m[0].length), kopfZeilen: m[0].split('\n').length - 1 };
}

export function bauFrontmatter(kopf: Record<string, unknown>, text: string): string {
  return `---\n${YAML.stringify(kopf).trimEnd()}\n---\n${text.startsWith('\n') ? text.slice(1) : text}`;
}
