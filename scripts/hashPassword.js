const bcrypt = require('bcrypt');

async function generateHash() {
  const password = '123456';
  const hash = await bcrypt.hash(password, 10);
  console.log('\n===========================================');
  console.log('Password goc: ', password);
  console.log('Password hash:', hash);
  console.log('===========================================\n');
  console.log('Copy hash nay va thay vao file seed.sql');
}

generateHash();
