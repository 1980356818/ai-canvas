import paramiko
import time

SERVER = "101.37.80.236"
USER = "root"
PASSWORD = "AImao123456!"
MYSQL_PWD = "AImao123456!"
LOCAL_JAR = r"d:\Project\AI无限画布\ai-canvas-server\target\ai-canvas-server-0.1.0.jar"
REMOTE_JAR = "/opt/ai-canvas/ai-canvas-server.jar"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(SERVER, port=22, username=USER, password=PASSWORD, timeout=10)
print("[OK] SSH connected")

# 1. ALTER TABLE - add plain_password column
print("\n=== Step 1: ALTER TABLE ===")
alter_sql = (
    "ALTER TABLE aicat.user ADD COLUMN plain_password VARCHAR(64) "
    "DEFAULT NULL COMMENT '明文密码' AFTER password"
)
cmd = f"mysql -u root -p'{MYSQL_PWD}' -e \"{alter_sql}\" 2>&1"
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode().strip()
if "Duplicate column" in out:
    print("[SKIP] Column already exists")
elif out:
    print(out)
else:
    print("[OK] Column added")

# Verify column exists
stdin, stdout, stderr = client.exec_command(
    f"mysql -u root -p'{MYSQL_PWD}' -e \"DESCRIBE aicat.user plain_password\" 2>&1"
)
print(stdout.read().decode().strip())

# 1a. ALTER TABLE - add token_version column (老库可能没有, schema.sql 是后加的)
print("\n=== Step 1a: token_version column ===")
alter_token = (
    "ALTER TABLE aicat.user ADD COLUMN token_version INT NOT NULL DEFAULT 1 "
    "COMMENT '登录版本号' AFTER status"
)
cmd = f"mysql -u root -p'{MYSQL_PWD}' -e \"{alter_token}\" 2>&1"
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode().strip()
if "Duplicate column" in out:
    print("[SKIP] Column already exists")
elif out and "Warning" not in out:
    print(out)
else:
    print("[OK] token_version added")

# 1b. CREATE TABLE app_release (自动更新 / 版本切换所需; 幂等)
# schema 见 ai-canvas-server/src/main/resources/db/schema.sql,这里只是给已部署机器补一份。
print("\n=== Step 1b: app_release table ===")
app_release_sql = """
CREATE TABLE IF NOT EXISTS aicat.app_release (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    version       VARCHAR(32)  NOT NULL,
    version_code  BIGINT       NOT NULL,
    target        VARCHAR(16)  NOT NULL,
    arch          VARCHAR(16)  NOT NULL,
    file_name     VARCHAR(256) NOT NULL,
    file_path     VARCHAR(512) NOT NULL,
    file_size     BIGINT       NOT NULL,
    signature     TEXT         NOT NULL,
    sha256        VARCHAR(64)  NOT NULL,
    release_notes TEXT         DEFAULT NULL,
    min_version   VARCHAR(32)  DEFAULT NULL,
    is_active     TINYINT      NOT NULL DEFAULT 1,
    pub_date      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted       TINYINT      NOT NULL DEFAULT 0,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_ver_target_arch (version, target, arch, deleted),
    KEY idx_active_target_arch (is_active, target, arch, version_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应用发布版本';
""".strip().replace("\n", " ")
cmd = f"mysql -u root -p'{MYSQL_PWD}' -e \"{app_release_sql}\" 2>&1"
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode().strip()
print(out if out else "[OK] app_release ready")

# 确保 release 落盘目录存在;application.yml 默认 ./data/releases (相对 jar 工作目录)
# systemd unit 一般 WorkingDirectory=/opt/ai-canvas,所以实际路径 /opt/ai-canvas/data/releases。
stdin, stdout, stderr = client.exec_command(
    "mkdir -p /opt/ai-canvas/data/releases && chmod 755 /opt/ai-canvas/data/releases && echo OK"
)
print("[releases dir]", stdout.read().decode().strip())

# 2. Upload JAR
print("\n=== Step 2: Upload JAR ===")
sftp = client.open_sftp()
sftp.put(LOCAL_JAR, REMOTE_JAR)
sftp.close()
print("[OK] JAR uploaded to", REMOTE_JAR)

# 3. Restart service
print("\n=== Step 3: Restart service ===")
stdin, stdout, stderr = client.exec_command(
    "systemctl daemon-reload && systemctl restart ai-canvas"
)
exit_code = stdout.channel.recv_exit_status()
if exit_code == 0:
    print("[OK] Service restarted")
else:
    print("[ERROR] Restart failed:", stderr.read().decode())

# 4. Wait and verify
print("\n=== Step 4: Verify (waiting 8s) ===")
time.sleep(8)

stdin, stdout, stderr = client.exec_command("systemctl is-active ai-canvas")
status = stdout.read().decode().strip()
print(f"Service status: {status}")

stdin, stdout, stderr = client.exec_command(
    "journalctl -u ai-canvas --no-pager -n 15"
)
print(stdout.read().decode())

client.close()

if status == "active":
    print("=== DEPLOY SUCCESS ===")
else:
    print("=== DEPLOY FAILED - check logs ===")
