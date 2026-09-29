import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}

export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'records.json');
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new Error('Invalid store schema');
        this.records = parsed.records;
      } catch { throw new Error('Stored records could not be read. Preserve data/records.json and restore a valid backup; it was not overwritten.'); }
    } else { this.records = []; }
  }
  all() { return structuredClone(this.records); }
  get(id) { const record = this.records.find(r => r.id === id); if (!record) throw new AppError('Question not found.', 404, 'NOT_FOUND'); return structuredClone(record); }
  commit(records) {
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, records }, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, this.file);
      this.records = records;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw new AppError('Could not save the review. No in-memory change was committed.', 500, 'SAVE_FAILED');
    }
  }
  add(record) { this.commit([structuredClone(record), ...this.records]); return this.get(record.id); }
  update(id, version, transform) {
    const records = this.all();
    const index = records.findIndex(r => r.id === id);
    if (index < 0) throw new AppError('Question not found.', 404, 'NOT_FOUND');
    if (!Number.isInteger(version) || records[index].version !== version) throw new AppError('This question changed. Reload it before continuing.', 409, 'STALE_VERSION');
    const next = transform(records[index]);
    next.updatedAt = new Date().toISOString();
    records[index] = next;
    this.commit(records);
    return this.get(id);
  }
}
