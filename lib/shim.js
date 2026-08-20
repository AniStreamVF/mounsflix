// Shim de compatibilité : remplace le SDK Hatchable par du Node standard.
//   config.get('KEY')          -> process.env.KEY (ou '')
//   db.query(sql, params)      -> PostgreSQL via `pg` si DATABASE_URL est définie,
//                                 sinon cache en mémoire (perdu au redémarrage).

export const config = {
  async get(key) {
    return process.env[key] || '';
  },
};

function keyFromSql(sql, params) {
  const m = sql.match(/WHERE key\s*=\s*\$1/i);
  if (m) return params ? params[0] : null;
  const m2 = sql.match(/WHERE key\s*=\s*'([^']+)'/i);
  if (m2) return m2[1];
  const m3 = sql.match(/VALUES\s*\(\s*\$1/);
  if (m3) return params ? params[0] : null;
  return null;
}

const mem = new Map();

function memQuery(sql, params) {
  const key = keyFromSql(sql, params);
  if (/^SELECT/i.test(sql.trim())) {
    if (key == null) return Promise.resolve({ rows: [] });
    const hit = mem.get(key);
    if (!hit) return Promise.resolve({ rows: [] });
    let value = hit.value;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* garder brut */ } }
    return Promise.resolve({ rows: [{ value, updated_at: hit.updated_at }] });
  }
  if (/INSERT/i.test(sql.trim())) {
    if (key == null) return Promise.resolve({ changes: 0 });
    const val = params && params[1] ? params[1] : null;
    mem.set(key, { value: val, updated_at: new Date() });
    return Promise.resolve({ changes: 1 });
  }
  return Promise.resolve({ rows: [], changes: 0 });
}

let pg = null;
let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = import('pg').then(({ default: pgmod }) => {
      const { Pool } = pgmod;
      pg = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
      return pg;
    });
  }
  return poolPromise;
}

export const db = {
  async query(sql, params) {
    if (process.env.DATABASE_URL) {
      const pool = await getPool();
      const r = await pool.query(sql, params || []);
      return { rows: r.rows, changes: r.rowCount ?? 0 };
    }
    return memQuery(sql, params);
  },
};