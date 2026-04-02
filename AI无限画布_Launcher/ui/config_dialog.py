from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from core.config_manager import ConfigManager


class ProjectEditWidget(QWidget):
    def __init__(self, project: dict, parent=None):
        super().__init__(parent)
        self._project = dict(project)
        form = QFormLayout(self)
        form.setSpacing(10)

        self._name_edit = QLineEdit(project.get("name", ""))
        form.addRow("项目名称:", self._name_edit)

        dir_row = QHBoxLayout()
        self._dir_edit = QLineEdit(project.get("directory", ""))
        btn_browse = QPushButton("浏览...")
        btn_browse.clicked.connect(self._browse_dir)
        dir_row.addWidget(self._dir_edit)
        dir_row.addWidget(btn_browse)
        form.addRow("项目目录:", dir_row)

        self._cmd_edit = QTextEdit()
        self._cmd_edit.setPlainText("\n".join(project.get("commands", [])))
        self._cmd_edit.setFixedHeight(80)
        self._cmd_edit.setPlaceholderText("每行一条启动命令")
        form.addRow("启动命令:", self._cmd_edit)

        self._build_cmd_edit = QTextEdit()
        self._build_cmd_edit.setPlainText("\n".join(project.get("build_commands", [])))
        self._build_cmd_edit.setFixedHeight(80)
        self._build_cmd_edit.setPlaceholderText("每行一条构建命令")
        form.addRow("构建命令:", self._build_cmd_edit)

        self._port_spin = QSpinBox()
        self._port_spin.setRange(0, 65535)
        self._port_spin.setSpecialValueText("无")
        self._port_spin.setValue(project.get("port") or 0)
        form.addRow("监听端口:", self._port_spin)

        self._delay_spin = QSpinBox()
        self._delay_spin.setRange(0, 120)
        self._delay_spin.setSuffix(" 秒")
        self._delay_spin.setValue(project.get("delay", 0))
        form.addRow("启动延迟:", self._delay_spin)

        self._env_edit = QTextEdit()
        env = project.get("env", {})
        self._env_edit.setPlainText(
            "\n".join(f"{k}={v}" for k, v in env.items())
        )
        self._env_edit.setFixedHeight(60)
        self._env_edit.setPlaceholderText("每行一个: KEY=VALUE")
        form.addRow("环境变量:", self._env_edit)

        self._depends_edit = QLineEdit(
            ", ".join(project.get("depends_on", []))
        )
        self._depends_edit.setPlaceholderText("逗号分隔的项目 ID")
        form.addRow("依赖项目:", self._depends_edit)

    def _browse_dir(self):
        d = QFileDialog.getExistingDirectory(self, "选择项目目录", self._dir_edit.text())
        if d:
            self._dir_edit.setText(d)

    def get_data(self) -> dict:
        env = {}
        for line in self._env_edit.toPlainText().strip().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()

        depends = [
            s.strip()
            for s in self._depends_edit.text().split(",")
            if s.strip()
        ]

        cmds = [
            line.strip()
            for line in self._cmd_edit.toPlainText().strip().splitlines()
            if line.strip()
        ]

        build_cmds = [
            line.strip()
            for line in self._build_cmd_edit.toPlainText().strip().splitlines()
            if line.strip()
        ]

        return {
            **self._project,
            "name": self._name_edit.text(),
            "directory": self._dir_edit.text(),
            "commands": cmds,
            "build_commands": build_cmds,
            "port": self._port_spin.value() or None,
            "delay": self._delay_spin.value(),
            "env": env,
            "depends_on": depends,
        }


class ConfigDialog(QDialog):
    config_saved = Signal()

    def __init__(self, config: ConfigManager, parent=None):
        super().__init__(parent)
        self.setWindowTitle("项目设置")
        self.setMinimumSize(720, 580)
        self._config = config
        self._editors: dict[str, ProjectEditWidget] = {}

        layout = QHBoxLayout(self)

        left = QVBoxLayout()
        self._list = QListWidget()
        self._list.setFixedWidth(180)
        self._list.currentRowChanged.connect(self._on_select)
        left.addWidget(QLabel("项目列表"))
        left.addWidget(self._list)

        btn_row = QHBoxLayout()
        btn_add = QPushButton("添加")
        btn_add.clicked.connect(self._add_project)
        btn_remove = QPushButton("删除")
        btn_remove.clicked.connect(self._remove_project)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_remove)
        left.addLayout(btn_row)

        layout.addLayout(left)

        self._right_area = QVBoxLayout()
        self._right_placeholder = QLabel("← 选择一个项目进行编辑")
        self._right_placeholder.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._right_area.addWidget(self._right_placeholder)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        self._right_area.addWidget(buttons)

        layout.addLayout(self._right_area, 1)

        self._load_projects()

    def _load_projects(self):
        self._list.clear()
        self._editors.clear()
        for proj in self._config.projects:
            item = QListWidgetItem(proj["name"])
            item.setData(Qt.ItemDataRole.UserRole, proj["id"])
            self._list.addItem(item)

    def _on_select(self, row: int):
        if self._right_placeholder.isVisible():
            self._right_placeholder.hide()

        for editor in self._editors.values():
            editor.hide()

        item = self._list.item(row)
        if item is None:
            return
        pid = item.data(Qt.ItemDataRole.UserRole)

        if pid not in self._editors:
            proj = self._config.get_project(pid)
            if proj:
                editor = ProjectEditWidget(proj)
                self._right_area.insertWidget(
                    self._right_area.count() - 1, editor
                )
                self._editors[pid] = editor

        if pid in self._editors:
            self._editors[pid].show()

    def _add_project(self):
        new_id = f"new_project_{self._list.count()}"
        new_proj = {
            "id": new_id,
            "name": "新项目",
            "type": "frontend",
            "icon": "",
            "directory": "",
            "commands": [],
            "build_commands": [],
            "port": None,
            "env": {},
            "delay": 0,
            "depends_on": [],
        }
        self._config.add_project(new_proj)
        self._load_projects()
        self._list.setCurrentRow(self._list.count() - 1)

    def _remove_project(self):
        item = self._list.currentItem()
        if item is None:
            return
        pid = item.data(Qt.ItemDataRole.UserRole)
        self._config.remove_project(pid)
        if pid in self._editors:
            self._editors[pid].deleteLater()
            del self._editors[pid]
        self._load_projects()

    def _save(self):
        for pid, editor in self._editors.items():
            data = editor.get_data()
            self._config.update_project(pid, data)
        self.config_saved.emit()
        self.accept()
