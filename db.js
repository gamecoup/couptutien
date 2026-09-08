const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DB_URL,
  ssl: {
    rejectUnauthorized: false // Bắt buộc để kết nối an toàn với Supabase
  }
});

// 1. Lưu hoặc lấy thông tin người chơi khi đăng nhập Google
async function loginOrRegisterUser(googleId, email, name, avatar) {
  try {
    const res = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    if (res.rows.length > 0) {
      return res.rows[0];
    } else {
      const insert = `
        INSERT INTO users (google_id, email, display_name, avatar_url, elo, wins, losses, draws)
        VALUES ($1, $2, $3, $4, 1200, 0, 0, 0)
        RETURNING *;
      `;
      const newUser = await pool.query(insert, [googleId, email, name, avatar]);
      return newUser.rows[0];
    }
  } catch (err) {
    console.error('Lỗi Database khi Login:', err);
    return null;
  }
}

// 2. Cập nhật kết quả sau khi kết thúc ván cờ
async function recordMatch(redId, blackId, winnerId, deltaRed, deltaBlack) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cập nhật người cầm Đỏ
    await client.query(`
      UPDATE users 
      SET elo = elo + $1, wins = wins + $2, losses = losses + $3, draws = draws + $4, updated_at = NOW()
      WHERE google_id = $5
    `, [deltaRed, winnerId === 'RED' ? 1 : 0, winnerId === 'BLACK' ? 1 : 0, winnerId === 'DRAW' ? 1 : 0, redId]);

    // Cập nhật người cầm Đen
    await client.query(`
      UPDATE users 
      SET elo = elo + $1, wins = wins + $2, losses = losses + $3, draws = draws + $4, updated_at = NOW()
      WHERE google_id = $5
    `, [deltaBlack, winnerId === 'BLACK' ? 1 : 0, winnerId === 'RED' ? 1 : 0, winnerId === 'DRAW' ? 1 : 0, blackId]);

    // Lưu lịch sử
    await client.query(`
      INSERT INTO match_history (red_player_id, black_player_id, winner_id, elo_red_change, elo_black_change)
      VALUES ($1, $2, $3, $4, $5)
    `, [redId, blackId, winnerId, deltaRed, deltaBlack]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi khi lưu kết quả ván cờ:', err);
  } finally {
    client.release();
  }
}

module.exports = { loginOrRegisterUser, recordMatch, pool };