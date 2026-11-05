const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_FILE || 'meet.db');
db.exec(`
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists users (
    id integer primary key,
    username text unique not null collate nocase,
    password_hash text not null,
    created_at text not null default current_timestamp
  );
  create table if not exists sessions (
    token text primary key,
    user_id integer not null references users(id) on delete cascade,
    expires_at integer not null
  );
`);

module.exports = db;
