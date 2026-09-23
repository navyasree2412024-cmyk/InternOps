require('dotenv').config();
const pool = require('../src/config/db');
const argon2 = require('argon2');

async function recoverAdmin() {
  const env = process.env.NODE_ENV || 'development';

  if (
    env === 'production' &&
    process.env.ALLOW_ADMIN_RECOVERY_IN_PRODUCTION !== 'true'
  ) {
    throw new Error(
      'Refusing admin recovery in production. Set ALLOW_ADMIN_RECOVERY_IN_PRODUCTION=true to override.'
    );
  }

  const email = process.env.RECOVERY_ADMIN_EMAIL;
  const password = process.env.RECOVERY_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'RECOVERY_ADMIN_EMAIL and RECOVERY_ADMIN_PASSWORD must be set.'
    );
  }

  if (password.length < 8) {
    throw new Error('RECOVERY_ADMIN_PASSWORD must be at least 8 characters.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, role
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (existing.rowCount === 0) {
      throw new Error(
        'Recovery refused: no existing account found for this email.'
      );
    }

    const user = existing.rows[0];

    if (user.role !== 'ADMIN') {
      throw new Error(
        'Recovery refused: the existing account is not an ADMIN.'
      );
    }

    const passwordHash = await argon2.hash(password);

    await client.query(
      `UPDATE users
       SET password_hash = $1,
           suspended = FALSE,
           deleted_at = NULL
       WHERE id = $2
         AND role = 'ADMIN'`,
      [passwordHash, user.id]
    );

    await client.query('COMMIT');

    console.log('Admin recovery completed successfully.');
    console.log(`Recovered admin account: ${email}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

recoverAdmin()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Admin recovery failed: ${error.message}`);
    pool.end().finally(() => process.exit(1));
  });
