use rusqlite::Connection;

const CURRENT_VERSION: u32 = 6;

pub fn run(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    tracing::info!("database version: {}, target: {}", version, CURRENT_VERSION);

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    if version < 3 {
        migrate_v3(conn)?;
    }
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }
    if version < 6 {
        migrate_v6(conn)?;
    }

    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v1: initial schema");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT 'Untitled',
            thumbnail   TEXT,
            node_count  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS cards (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            type        TEXT NOT NULL,
            x           REAL NOT NULL DEFAULT 0,
            y           REAL NOT NULL DEFAULT 0,
            width       REAL NOT NULL DEFAULT 320,
            height      REAL NOT NULL DEFAULT 240,
            z_index     INTEGER NOT NULL DEFAULT 0,
            locked      INTEGER NOT NULL DEFAULT 0,
            collapsed   INTEGER NOT NULL DEFAULT 0,
            color       TEXT,
            title       TEXT,
            data        TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);

        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );

        PRAGMA user_version = 1;
        ",
    )?;

    Ok(())
}

fn migrate_v2(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v2: agent sessions");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            messages    TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON agent_sessions(project_id);

        PRAGMA user_version = 2;
        ",
    )?;

    Ok(())
}

fn migrate_v3(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v3: soft delete for projects");

    conn.execute_batch(
        "
        ALTER TABLE projects ADD COLUMN deleted_at TEXT;

        PRAGMA user_version = 3;
        ",
    )?;

    Ok(())
}

fn migrate_v4(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v4: seed default API base URL");

    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params!["openai_base_url", "https://ai.comfly.chat"],
    )?;

    conn.execute_batch("PRAGMA user_version = 4;")?;
    Ok(())
}

fn migrate_v5(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v5: connections table");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS connections (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source_card_id  TEXT NOT NULL,
            target_card_id  TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(project_id, source_card_id, target_card_id)
        );
        CREATE INDEX IF NOT EXISTS idx_connections_project ON connections(project_id);
        CREATE INDEX IF NOT EXISTS idx_connections_source ON connections(source_card_id);
        CREATE INDEX IF NOT EXISTS idx_connections_target ON connections(target_card_id);

        PRAGMA user_version = 5;
        ",
    )?;

    Ok(())
}

fn migrate_v6(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v6: chat sessions & messages");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT,
            title       TEXT NOT NULL DEFAULT 'New Chat',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '[]',
            metadata    TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

        PRAGMA user_version = 6;
        ",
    )?;

    Ok(())
}
