const mysql = require('mysql2/promise');

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 4000),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionLimit: 1,
      maxIdle: 1,
      idleTimeout: 60000,
      enableKeepAlive: true,
    });
  }
  return pool;
}

module.exports = async (req, res) => {
  try {
    const [rows] = await getPool().query(
      'SELECT label, value FROM chart_data ORDER BY id'
    );
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
};
