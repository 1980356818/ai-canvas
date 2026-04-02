pub mod migrations;

use rusqlite::Connection;
use std::path::Path;

pub fn init(db_path: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let conn = Connection::open(db_path)?;

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;

    migrations::run(&conn)?;

    tracing::info!("database initialized at {:?}", db_path);
    Ok(conn)
}
