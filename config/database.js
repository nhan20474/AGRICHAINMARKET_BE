const { Pool } = require('pg');
require('dotenv').config();

// Cau hinh ket noi PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',                    // Ten user PostgreSQL (mac dinh la postgres)
  host: process.env.DB_HOST || 'localhost',                   // Dia chi server
  database: process.env.DB_NAME || 'do_an_chuyen_nganh',     // Ten database tu pgAdmin cua ban
  password: process.env.DB_PASSWORD ,      // Mat khau ban dat khi cai PostgreSQL
  port: process.env.DB_PORT || 5432,                          // Cong mac dinh cua PostgreSQL
});

// Kiem tra ket noi
pool.connect((err, client, release) => {
  if (err) {
    console.error('Loi ket noi database:', err.stack);
    console.error('Kiem tra lai thong tin ket noi: user, password, database name');
    // Khong exit process de server van chay duoc
  } else {
    console.log('Ket noi database thanh cong!');
    release();
  }
});

// Xu ly loi pool
pool.on('error', (err) => {
  console.error('Loi database pool:', err);
});

module.exports = pool;
