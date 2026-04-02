import os
import re
import shutil
import socket
import subprocess
import time

from PySide6.QtCore import QObject, QThread, Signal, QTimer

ANSI_ESCAPE_PATTERN = re.compile(r'\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07')


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_PATTERN.sub('', text)


class LogReaderThread(QThread):
    log_line = Signal(str, str)
    process_exited = Signal(str, int)

    def __init__(self, project_id: str, process: subprocess.Popen, parent=None):
        super().__init__(parent)
        self.project_id = project_id
        self.process = process
        self._stop_flag = False

    def run(self):
        try:
            for line in iter(self.process.stdout.readline, ""):
                if self._stop_flag:
                    break
                text = line.rstrip("\n").rstrip("\r")
                if text:
                    text = strip_ansi(text)
                    self.log_line.emit(self.project_id, text)
            self.process.stdout.close()
        except Exception:
            pass

        try:
            exit_code = self.process.wait()
        except Exception:
            exit_code = -1

        if not self._stop_flag:
            self.process_exited.emit(self.project_id, exit_code)

    def stop(self):
        self._stop_flag = True


class FileCopyThread(QThread):
    copy_done = Signal(str, bool, str)

    def __init__(self, project_id: str, src: str, dst_dir: str, parent=None):
        super().__init__(parent)
        self.project_id = project_id
        self.src = src
        self.dst_dir = dst_dir

    def run(self):
        try:
            os.makedirs(self.dst_dir, exist_ok=True)
            dst = os.path.join(self.dst_dir, os.path.basename(self.src))
            shutil.copy2(self.src, dst)
            self.copy_done.emit(self.project_id, True, dst)
        except Exception as e:
            self.copy_done.emit(self.project_id, False, str(e))


class ProcessManager(QObject):
    status_changed = Signal(str, str)
    log_output = Signal(str, str)
    process_finished = Signal(str, int)

    build_status_changed = Signal(str, str)
    build_log_output = Signal(str, str)
    build_finished = Signal(str, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._processes: dict[str, subprocess.Popen] = {}
        self._readers: dict[str, LogReaderThread] = {}
        self._stale_readers: list[LogReaderThread] = []
        self._port_timer = QTimer(self)
        self._port_timer.setInterval(3000)
        self._port_timer.timeout.connect(self._check_ports)
        self._port_checks: dict[str, int] = {}

        self._build_processes: dict[str, subprocess.Popen] = {}
        self._build_readers: dict[str, LogReaderThread] = {}
        self._build_start_times: dict[str, float] = {}
        self._build_project_configs: dict[str, dict] = {}
        self._copy_threads: list[FileCopyThread] = []

    def start_project(self, project: dict) -> bool:
        pid = project["id"]
        if pid in self._processes:
            return False

        directory = project.get("directory", "")
        if not os.path.isdir(directory):
            self.log_output.emit(pid, f"[ERROR] 目录不存在: {directory}")
            self.status_changed.emit(pid, "error")
            return False

        commands = project.get("commands", [])
        if not commands:
            self.log_output.emit(pid, "[WARN] 没有配置启动命令")
            self.status_changed.emit(pid, "stopped")
            return False

        cmd = commands[0]
        env = os.environ.copy()
        env.update(project.get("env", {}))

        self.log_output.emit(pid, f"[INFO] 启动: {cmd}")
        self.log_output.emit(pid, f"[INFO] 工作目录: {directory}")

        try:
            creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
            process = subprocess.Popen(
                cmd,
                shell=True,
                cwd=directory,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation_flags,
            )
        except Exception as e:
            self.log_output.emit(pid, f"[ERROR] 启动失败: {e}")
            self.status_changed.emit(pid, "error")
            return False

        self._processes[pid] = process

        reader = LogReaderThread(pid, process)
        reader.log_line.connect(self._on_log_line)
        reader.process_exited.connect(self._on_process_finished)
        self._readers[pid] = reader
        reader.start()

        port = project.get("port")
        if port:
            self._port_checks[pid] = port
            if not self._port_timer.isActive():
                self._port_timer.start()

        self.status_changed.emit(pid, "running")
        return True

    def stop_project(self, project_id: str):
        process = self._processes.get(project_id)
        if process is None:
            return

        self.log_output.emit(project_id, "[INFO] 正在停止...")
        reader = self._readers.get(project_id)
        if reader:
            reader.stop()

        try:
            subprocess.call(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

        if reader and reader.isRunning():
            if not reader.wait(5000):
                self._stale_readers.append(reader)
                reader.finished.connect(
                    lambda r=reader: self._discard_stale_reader(r)
                )

        self._cleanup(project_id)
        self.log_output.emit(project_id, "[INFO] 已停止")
        self.status_changed.emit(project_id, "stopped")

    def stop_all(self):
        for pid in list(self._processes.keys()):
            self.stop_project(pid)

    def restart_project(self, project: dict):
        self.stop_project(project["id"])
        self.start_project(project)

    def is_running(self, project_id: str) -> bool:
        return project_id in self._processes

    def build_project(self, project: dict) -> bool:
        pid = project["id"]
        if pid in self._build_processes:
            return False

        directory = project.get("directory", "")
        if not os.path.isdir(directory):
            self.build_log_output.emit(pid, f"[BUILD] 目录不存在: {directory}")
            self.build_status_changed.emit(pid, "failed")
            return False

        build_commands = project.get("build_commands", [])
        if not build_commands:
            self.build_log_output.emit(pid, "[BUILD] 没有配置构建命令")
            return False

        cmd = build_commands[0]
        env = os.environ.copy()
        env.update(project.get("env", {}))

        self.build_log_output.emit(pid, f"[BUILD] 开始构建: {cmd}")
        self.build_log_output.emit(pid, f"[BUILD] 工作目录: {directory}")
        self.build_status_changed.emit(pid, "building")
        self._build_start_times[pid] = time.time()

        try:
            creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
            process = subprocess.Popen(
                cmd,
                shell=True,
                cwd=directory,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation_flags,
            )
        except Exception as e:
            self.build_log_output.emit(pid, f"[BUILD] 构建启动失败: {e}")
            self.build_status_changed.emit(pid, "failed")
            return False

        self._build_processes[pid] = process
        self._build_project_configs[pid] = project

        reader = LogReaderThread(pid, process)
        reader.log_line.connect(self._on_build_log_line)
        reader.process_exited.connect(self._on_build_finished)
        self._build_readers[pid] = reader
        reader.start()
        return True

    def cancel_build(self, project_id: str):
        process = self._build_processes.get(project_id)
        if process is None:
            return

        reader = self._build_readers.get(project_id)
        if reader:
            reader.stop()

        try:
            subprocess.call(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

        self._build_cleanup(project_id)
        self.build_log_output.emit(project_id, "[BUILD] 构建已取消")
        self.build_status_changed.emit(project_id, "idle")

    def is_building(self, project_id: str) -> bool:
        return project_id in self._build_processes

    def _on_log_line(self, project_id: str, text: str):
        self.log_output.emit(project_id, text)

    def _on_process_finished(self, project_id: str, exit_code: int):
        self._cleanup(project_id)
        status = "stopped" if exit_code == 0 else "error"
        self.log_output.emit(
            project_id, f"[INFO] 进程退出，退出码: {exit_code}"
        )
        self.status_changed.emit(project_id, status)
        self.process_finished.emit(project_id, exit_code)

    def _on_build_log_line(self, project_id: str, text: str):
        self.build_log_output.emit(project_id, text)

    def _on_build_finished(self, project_id: str, exit_code: int):
        elapsed = time.time() - self._build_start_times.get(project_id, time.time())
        proj = self._build_project_configs.get(project_id)
        self._build_cleanup(project_id)
        if exit_code == 0:
            self.build_log_output.emit(
                project_id, f"[BUILD] 构建成功 (耗时 {elapsed:.1f}s)"
            )
            self.build_status_changed.emit(project_id, "success")
            self._try_deploy_copy(project_id, proj)
        else:
            self.build_log_output.emit(
                project_id, f"[BUILD] 构建失败 退出码: {exit_code} (耗时 {elapsed:.1f}s)"
            )
            self.build_status_changed.emit(project_id, "failed")
        self.build_finished.emit(project_id, exit_code)

    def _cleanup(self, project_id: str):
        self._processes.pop(project_id, None)
        self._readers.pop(project_id, None)
        self._port_checks.pop(project_id, None)
        if not self._port_checks and self._port_timer.isActive():
            self._port_timer.stop()

    def _build_cleanup(self, project_id: str):
        self._build_processes.pop(project_id, None)
        self._build_readers.pop(project_id, None)
        self._build_start_times.pop(project_id, None)
        self._build_project_configs.pop(project_id, None)

    def _try_deploy_copy(self, project_id: str, proj: dict | None):
        if not proj:
            return
        artifact = proj.get("build_artifact")
        deploy_target = proj.get("deploy_target")
        if not artifact or not deploy_target:
            return
        src = os.path.join(proj.get("directory", ""), artifact)
        if not os.path.isfile(src):
            self.build_log_output.emit(
                project_id, f"[DEPLOY] 构建产物不存在: {src}"
            )
            return
        self.build_log_output.emit(
            project_id, f"[DEPLOY] 异步复制 → {deploy_target}"
        )
        thread = FileCopyThread(project_id, src, deploy_target)
        thread.copy_done.connect(self._on_deploy_copy_done)
        thread.finished.connect(lambda t=thread: self._discard_copy_thread(t))
        self._copy_threads.append(thread)
        thread.start()

    def _on_deploy_copy_done(self, project_id: str, success: bool, msg: str):
        if success:
            self.build_log_output.emit(
                project_id, f"[DEPLOY] 部署完成: {msg}"
            )
        else:
            self.build_log_output.emit(
                project_id, f"[DEPLOY] 部署失败: {msg}"
            )

    def _discard_copy_thread(self, thread: FileCopyThread):
        try:
            self._copy_threads.remove(thread)
        except ValueError:
            pass

    def _discard_stale_reader(self, reader: LogReaderThread):
        try:
            self._stale_readers.remove(reader)
        except ValueError:
            pass

    def _check_ports(self):
        for pid, port in list(self._port_checks.items()):
            if self._is_port_open(port):
                self.log_output.emit(pid, f"[INFO] 端口 {port} 已就绪")
                self._port_checks.pop(pid, None)
        if not self._port_checks:
            self._port_timer.stop()

    @staticmethod
    def _is_port_open(port: int, host: str = "127.0.0.1") -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                return s.connect_ex((host, port)) == 0
        except Exception:
            return False
