from PySide6.QtCore import Signal, Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


TYPE_LABELS = {
    "backend": ("后端服务", "#f59e0b"),
    "frontend": ("Web 前端", "#0ea5e9"),
    "desktop": ("桌面客户端", "#8b5cf6"),
    "miniprogram": ("微信小程序", "#10b981"),
    "admin": ("管理后台", "#06b6d4"),
    "infra": ("基础设施", "#64748b"),
}

ICON_MAP = {
    "spring-boot": "🍃",
    "vue": "💚",
    "react": "⚛",
    "tauri": "🦀",
    "wechat": "💬",
    "docker": "🐳",
    "python": "🐍",
    "node": "🟩",
}

STATUS_TEXT = {
    "running": ("● 运行中", "status_running"),
    "stopped": ("○ 已停止", "status_stopped"),
    "error": ("✖ 异常", "status_error"),
}


class ProjectCard(QFrame):
    start_clicked = Signal(str)
    stop_clicked = Signal(str)
    restart_clicked = Signal(str)
    folder_clicked = Signal(str)
    build_clicked = Signal(str)
    cancel_build_clicked = Signal(str)

    def __init__(self, project: dict, parent: QWidget = None):
        super().__init__(parent)
        self.project = project
        self.project_id = project["id"]
        self.setObjectName("project_card")
        self.setFixedHeight(190)
        self.setMinimumWidth(230)
        self._build_ui()
        self.set_status("stopped")

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(8)
        layout.setContentsMargins(16, 14, 16, 14)

        row1 = QHBoxLayout()
        icon_char = ICON_MAP.get(self.project.get("icon", ""), "📦")
        icon_label = QLabel(icon_char)
        icon_label.setFont(QFont("Segoe UI Emoji", 20))
        row1.addWidget(icon_label)

        title = QLabel(self.project["name"])
        title.setObjectName("card_title")
        row1.addWidget(title)
        row1.addStretch()

        type_key = self.project.get("type", "")
        type_text, type_color = TYPE_LABELS.get(type_key, (type_key, "#888"))
        type_badge = QLabel(type_text)
        type_badge.setObjectName("card_type")
        type_badge.setStyleSheet(f"color: {type_color};")
        row1.addWidget(type_badge)
        layout.addLayout(row1)

        row2 = QHBoxLayout()
        self._status_label = QLabel()
        row2.addWidget(self._status_label)

        self._build_status_label = QLabel()
        self._build_status_label.setVisible(False)
        row2.addWidget(self._build_status_label)

        row2.addStretch()

        port = self.project.get("port")
        if port:
            port_label = QLabel(f":{port}")
            port_label.setObjectName("card_port")
            row2.addWidget(port_label)
        layout.addLayout(row2)

        layout.addStretch()

        row3 = QHBoxLayout()
        row3.setSpacing(6)

        self._btn_start = QPushButton("启动")
        self._btn_start.setObjectName("btn_start")
        self._btn_start.clicked.connect(lambda: self.start_clicked.emit(self.project_id))

        self._btn_stop = QPushButton("停止")
        self._btn_stop.setObjectName("btn_stop")
        self._btn_stop.clicked.connect(lambda: self.stop_clicked.emit(self.project_id))
        self._btn_stop.setVisible(False)

        self._btn_restart = QPushButton("重启")
        self._btn_restart.setObjectName("btn_folder")
        self._btn_restart.clicked.connect(lambda: self.restart_clicked.emit(self.project_id))
        self._btn_restart.setVisible(False)

        has_build = bool(self.project.get("build_commands"))
        self._btn_build = QPushButton("构建")
        self._btn_build.setObjectName("btn_build")
        self._btn_build.clicked.connect(lambda: self.build_clicked.emit(self.project_id))
        self._btn_build.setVisible(has_build)

        self._btn_cancel_build = QPushButton("取消")
        self._btn_cancel_build.setObjectName("btn_stop")
        self._btn_cancel_build.clicked.connect(
            lambda: self.cancel_build_clicked.emit(self.project_id)
        )
        self._btn_cancel_build.setVisible(False)

        btn_folder = QPushButton("目录")
        btn_folder.setObjectName("btn_folder")
        btn_folder.setToolTip("打开项目目录")
        btn_folder.clicked.connect(lambda: self.folder_clicked.emit(self.project_id))

        row3.addWidget(self._btn_start)
        row3.addWidget(self._btn_stop)
        row3.addWidget(self._btn_restart)
        row3.addWidget(self._btn_build)
        row3.addWidget(self._btn_cancel_build)
        row3.addStretch()
        row3.addWidget(btn_folder)
        layout.addLayout(row3)

    def set_status(self, status: str):
        text, obj_name = STATUS_TEXT.get(status, STATUS_TEXT["stopped"])
        self._status_label.setText(text)
        self._status_label.setObjectName(obj_name)
        self._status_label.setStyleSheet("")
        self._status_label.style().unpolish(self._status_label)
        self._status_label.style().polish(self._status_label)

        is_running = status == "running"
        self._btn_start.setVisible(not is_running)
        self._btn_stop.setVisible(is_running)
        self._btn_restart.setVisible(is_running)

    def set_build_status(self, status: str):
        if status == "building":
            self._build_status_label.setText("构建中...")
            self._build_status_label.setStyleSheet("color: #f59e0b; font-weight: bold;")
            self._build_status_label.setVisible(True)
            self._btn_build.setVisible(False)
            self._btn_cancel_build.setVisible(True)
        elif status == "success":
            self._build_status_label.setText("构建成功")
            self._build_status_label.setStyleSheet("color: #10b981; font-weight: bold;")
            self._build_status_label.setVisible(True)
            self._btn_build.setVisible(bool(self.project.get("build_commands")))
            self._btn_cancel_build.setVisible(False)
        elif status == "failed":
            self._build_status_label.setText("构建失败")
            self._build_status_label.setStyleSheet("color: #ef4444; font-weight: bold;")
            self._build_status_label.setVisible(True)
            self._btn_build.setVisible(bool(self.project.get("build_commands")))
            self._btn_cancel_build.setVisible(False)
        else:
            self._build_status_label.setVisible(False)
            self._btn_build.setVisible(bool(self.project.get("build_commands")))
            self._btn_cancel_build.setVisible(False)
