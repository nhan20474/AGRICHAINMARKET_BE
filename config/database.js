const { Pool } = require('pg');

// Cau hinh ket noi PostgreSQL
const pool = new Pool({
  user: 'postgres',                    // Ten user PostgreSQL (mac dinh la postgres)
  host: 'localhost',                   // Dia chi server
  database: 'do_an_chuyen_nganh',     // Ten database tu pgAdmin cua ban
  password: 'phuocloc7824',      // Mat khau ban dat khi cai PostgreSQL
  port: 5432,                          // Cong mac dinh cua PostgreSQL
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
