import { simpleGit, type SimpleGit } from 'simple-git';
import { existsSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { FILTER_SKRIPT, MSG_SKRIPT } from './filter-script.js';
import { join } from 'node:path';
import { slugify } from './util.js';

export interface Commit { commit: string; von: string; am: string; grund: string; dateien?: string[]; }

/** Dünne Schicht über git. Autor = Benutzername, Nachricht = Grund. */
export class Git {
  private g: SimpleGit;
  constructor(private dir: string) {
    this.g = simpleGit({ baseDir: dir, config: ['core.quotepath=false'] });
  }

  async init(): Promise<void> {
    if (!existsSync(join(this.dir, '.git'))) {
      await this.g.init();
      await this.g.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    // Lokale Identität als Rückfall, damit Commits ohne globale git-Konfiguration funktionieren
    await this.g.addConfig('user.name', 'kern', false, 'local');
    await this.g.addConfig('user.email', 'kern@localhost', false, 'local');
    await this.g.addConfig('core.autocrlf', 'false', false, 'local');
  }

  private autor(name: string): string {
    const n = name.replace(/[<>\n]/g, '').trim() || 'kern';
    return `${n} <${slugify(n)}@kern.local>`;
  }

  /** Staged die Pfade und committet nur, wenn es Änderungen gibt. Gibt Commit-Hash oder null zurück. */
  async commit(pfade: string[], autor: string, grund: string, text?: string): Promise<string | null> {
    if (!pfade.length) return null;
    await this.g.raw(['add', '-A', '--ignore-errors', '--', ...pfade]).catch(async () => {
      // einzeln, damit ein nie verfolgter, gelöschter Pfad den Rest nicht blockiert
      for (const p of pfade) await this.g.raw(['add', '-A', '--', p]).catch(() => undefined);
    });
    const staged = (await this.g.raw(['diff', '--cached', '--name-only', '--', ...pfade])).trim();
    if (!staged) return null;
    const nachricht = grund.trim() || 'ohne Grund';
    const geaendert = staged.split('\n').filter(Boolean);
    await this.g.raw(['commit', '-q', '--no-verify', '--author', this.autor(autor), '-m', nachricht, ...(text ? ['-m', text] : []), '--', ...geaendert]);
    return (await this.g.revparse(['HEAD'])).trim();
  }

  /** Nicht committete Änderungen (relativ) unter den angegebenen Ordnern. */
  async offeneAenderungen(ordner: string[]): Promise<string[]> {
    const s = await this.g.raw(['status', '--porcelain', '-uall', '-z', '--', ...ordner]);
    const out: string[] = [];
    const teile = s.split('\0').filter(Boolean);
    for (let i = 0; i < teile.length; i++) {
      const t = teile[i]!;
      const code = t.slice(0, 2);
      out.push(t.slice(3));
      if (code.startsWith('R') || code.startsWith('C')) i++; // Quellpfad überspringen
    }
    return out;
  }

  /**
   * Pfade aus dem gesamten Verlauf entfernen (Art. 17 DSGVO): filter-branch über alle Refs, Titel/Pfade in
   * Commit-Nachrichten und index.md/log.md ersetzen, danach Reflog leeren und unerreichbare Objekte löschen.
   */
  async entferneAusVerlauf(pfade: string[], ersetzen: string[]): Promise<void> {
    const gitDir = join(this.dir, '.git');
    const f = join(gitDir, 'kern-index-filter.cjs');
    const m = join(gitDir, 'kern-msg-filter.cjs');
    await writeFile(f, FILTER_SKRIPT);
    await writeFile(m, MSG_SKRIPT);
    const node = JSON.stringify(process.execPath);
    const basis: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']) if (process.env[k]) basis[k] = process.env[k]!;
    const env = {
      ...basis,
      FILTER_BRANCH_SQUELCH_WARNING: '1',
      KERN_ENTFERNEN: JSON.stringify(pfade),
      KERN_ERSETZEN: JSON.stringify([...new Set([...ersetzen, ...pfade])].sort((a, b) => b.length - a.length)),
    };
    const g = simpleGit({ baseDir: this.dir }).env(env);
    try {
      await g.raw(['filter-branch', '-f', '--index-filter', `${node} ${JSON.stringify(f)}`, '--msg-filter', `${node} ${JSON.stringify(m)}`, '--', '--all']);
    } finally {
      await rm(f, { force: true });
      await rm(m, { force: true });
    }
    const refs = (await this.g.raw(['for-each-ref', '--format=%(refname)', 'refs/original/'])).split('\n').filter(Boolean);
    for (const r of refs) await this.g.raw(['update-ref', '-d', r]);
    await this.g.raw(['reflog', 'expire', '--expire=now', '--all']);
    await this.g.raw(['gc', '--prune=now', '--quiet']);
  }

  async head(): Promise<string | null> {
    try {
      return (await this.g.revparse(['HEAD'])).trim();
    } catch {
      return null;
    }
  }

  async log(opt: { pfad?: string; seit?: string; folge?: boolean; max?: number } = {}): Promise<Commit[]> {
    const args = ['log', '--format=%x1e%H%x1f%an%x1f%aI%x1f%s', '--name-only'];
    if (opt.seit) args.push(`--since=${opt.seit}`);
    if (opt.max) args.push(`-n${opt.max}`);
    if (opt.pfad && opt.folge) args.push('--follow');
    if (opt.pfad) args.push('--', opt.pfad);
    let roh = '';
    try {
      roh = await this.g.raw(args);
    } catch {
      return []; // leeres Repo
    }
    return roh
      .split('\x1e')
      .filter((x) => x.trim())
      .map((block) => {
        const [kopf, ...rest] = block.split('\n');
        const [commit, von, am, grund] = (kopf ?? '').split('\x1f');
        return {
          commit: commit ?? '',
          von: von ?? '',
          am: am ?? '',
          grund: grund ?? '',
          dateien: rest.map((r) => r.trim()).filter(Boolean),
        };
      });
  }
}
