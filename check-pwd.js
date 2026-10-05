const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('./data/delta.db');
const users = db.prepare('SELECT id, username, role FROM users').all();
console.log('Users:', JSON.stringify(users));
// Test password
const hash = db.prepare('SELECT password FROM users WHERE username=?').get('jtzqm');
if (hash) {
  const test1 = bcrypt.compareSync('jjq228568', hash.password);
  const test2 = bcrypt.compareSync('jjq2288568', hash.password);
  console.log('Password jjq228568:', test1);
  console.log('Password jjq2288568:', test2);
}
db.close();
