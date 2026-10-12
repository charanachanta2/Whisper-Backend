// Minimal in-memory stand-in for the MongoDB collections + GridFS this app
// uses, so the test-suite runs with no database installed. It implements only
// the query/update operators the server actually calls.
const { Readable, Writable } = require("stream");
const clone = v => (v === undefined ? v : structuredClone(v));
const dup = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

function matchValue(actual, cond) {
  if (cond instanceof RegExp) return typeof actual === "string" && cond.test(actual);
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === "$in") return v.some(x => (Array.isArray(actual) ? actual.includes(x) : actual === x));
      if (op === "$ne") return Array.isArray(actual) ? !actual.includes(v) : actual !== v;
      if (op === "$gt") return actual > v;
      if (op === "$lt") return actual < v;
      if (op === "$exists") return (actual !== undefined) === v;
      if (op === "$type") return typeof actual === v;
      throw new Error("fake: unsupported operator " + op);
    });
  }
  return Array.isArray(actual) ? actual.includes(cond) : actual === cond;
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, c]) => {
    if (k === "$or") return c.some(f => matches(doc, f));
    return matchValue(doc[k], c);
  });
}
function applyUpdate(doc, u) {
  for (const [k, v] of Object.entries(u.$set || {})) doc[k] = clone(v);
  for (const k of Object.keys(u.$unset || {})) delete doc[k];
  for (const [k, v] of Object.entries(u.$addToSet || {})) { doc[k] = doc[k] || []; if (!doc[k].includes(v)) doc[k].push(v); }
}

class Cursor {
  constructor(docs) { this.docs = docs; }
  sort(spec) { const [[k, dir]] = Object.entries(spec); this.docs.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); return this; }
  limit(n) { this.docs = this.docs.slice(0, n); return this; }
  async toArray() { return this.docs.map(clone); }
  async next() { return this.docs.length ? clone(this.docs.shift()) : null; }
}

class Collection {
  constructor(unique = []) { this.docs = []; this.unique = unique; }
  _checkUnique(doc, ignore) {
    for (const k of this.unique) if (doc[k] != null && this.docs.some(d => d !== ignore && d[k] === doc[k])) throw dup();
    if (doc._id !== undefined && this.docs.some(d => d !== ignore && d._id === doc._id)) throw dup();
  }
  async insertOne(doc) { this._checkUnique(doc); this.docs.push(clone(doc)); return { acknowledged: true }; }
  async insertMany(docs) { let err; for (const d of docs) { try { await this.insertOne(d); } catch (e) { err = e; } } if (err) throw Object.assign(err, { writeErrors: [{ code: 11000 }] }); }
  find(filter = {}) { return new Cursor(this.docs.filter(d => matches(d, filter))); }
  async findOne(filter = {}) { return clone(this.docs.find(d => matches(d, filter))) || null; }
  async updateOne(filter, update, opts = {}) {
    const d = this.docs.find(x => matches(x, filter));
    if (d) applyUpdate(d, update); else if (opts.upsert) this.docs.push({ ...Object.fromEntries(Object.entries(filter).filter(([k]) => !k.startsWith("$"))), ...clone(update.$set || {}) });
    return { matchedCount: d ? 1 : 0 };
  }
  async findOneAndUpdate(filter, update) { const d = this.docs.find(x => matches(x, filter)); if (!d) return null; const before = clone(d); applyUpdate(d, update); return before; }
  async deleteOne(filter) { const i = this.docs.findIndex(d => matches(d, filter)); if (i >= 0) this.docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }
  async createIndex() {}
}

class FakeBucket {
  constructor() { this.files = []; this.n = 0; }
  openUploadStream(filename, opts = {}) {
    const chunks = []; const self = this;
    return new Writable({
      write(c, _e, cb) { chunks.push(c); cb(); },
      final(cb) { const data = Buffer.concat(chunks); self.files.push({ _id: `f${++self.n}`, filename, length: data.length, metadata: opts.metadata, data }); cb(); },
    });
  }
  find({ filename }) { return new Cursor(this.files.filter(f => f.filename === filename).map(({ data, ...f }) => ({ ...f }))); }
  openDownloadStream(fileId, { start = 0, end } = {}) { const f = this.files.find(x => x._id === fileId); return Readable.from([f.data.subarray(start, end)]); }
  async delete(fileId) { this.files = this.files.filter(f => f._id !== fileId); }
}

function createFakeStore() {
  const bucket = new FakeBucket();
  return {
    users: new Collection(["username"]), rooms: new Collection(["directKey"]), messages: new Collection(), invites: new Collection(),
    friendRequests: new Collection(), posts: new Collection(), stories: new Collection(), meta: new Collection(), legacy: new Collection(),
    bucket, db: { command: async () => ({ ok: 1 }) },
  };
}
module.exports = { createFakeStore };
