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
