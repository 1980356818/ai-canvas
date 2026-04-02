import os

from PySide6.QtCore import Qt, QTimer, Slot
from PySide6.QtGui import QCloseEvent, QIcon, QPixmap, QPainter, QColor, QFont
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QHBoxLayout,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
    QGridLayout,
)

from core.config_manager import ConfigManager
from core.process_manager import ProcessManager
from ui.config_dialog import ConfigDialog
from ui.log_panel import LogPanel
from ui.project_card import ProjectCard


def _make_app_icon() -> QIcon:
    size = 64
    pixmap = QPixmap(size, size)
    pixmap.fill(QColor("transparent"))
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setBrush(QColor("#0ea5e9"))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.drawRoundedRect(0, 0, size, size, 12, 12)
    painter.setPen(QColor("#ffffff"))
    painter.setFont(QFont("Segoe UI", 22, QFont.Weight.Bold))
    painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "AI\n画")
    painter.end()
    return QIcon(pixmap)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("AI 无限画布 Launcher")

        self._icon = _make_app_icon()
        self.setWindowIcon(self._icon)

        self._config = ConfigManager()
        self._process_mgr = ProcessManager(self)
        self._cards: dict[str, ProjectCard] = {}

        wc = self._config.window_config
        self.resize(wc.get("width", 1060), wc.get("height", 720))
        if wc.get("x") is not None:
            self.move(wc["x"], wc["y"])

        self._build_ui()
        self._connect_signals()

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        toolbar = QWidget()
        toolbar.setObjectName("toolbar")
        tb_layout = QHBoxLayout(toolbar)
        tb_layout.setContentsMargins(12, 8, 12, 8)

        self._btn_start_all = QPushButton("▶ 全部启动")
        self._btn_start_all.setObjectName("btn_start_all")
        tb_layout.addWidget(self._btn_start_all)

        self._btn_stop_all = QPushButton("■ 全部停止")
        self._btn_stop_all.setObjectName("btn_stop_all")
        tb_layout.addWidget(self._btn_stop_all)

        self._btn_build_all = QPushButton("🔨 全部构建")
        self._btn_build_all.setObjectName("btn_build_all")
        tb_layout.addWidget(self._btn_build_all)

        tb_layout.addSpacing(16)

        self._preset_combo = QComboBox()
        self._preset_combo.addItem("选择预设组合...")
        for name in self._config.presets:
            self._preset_combo.addItem(name)
        tb_layout.addWidget(self._preset_combo)

        self._btn_preset_run = QPushButton("运行预设")
        tb_layout.addWidget(self._btn_preset_run)

        tb_layout.addStretch()

        self._btn_settings = QPushButton("⚙ 设置")
        tb_layout.addWidget(self._btn_settings)

        main_layout.addWidget(toolbar)

        splitter = QSplitter(Qt.Orientation.Vertical)

        cards_container = QWidget()
        cards_container.setObjectName("cards_area")
        cards_scroll = QScrollArea()
        cards_scroll.setWidgetResizable(True)
        cards_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        cards_scroll.setWidget(cards_container)
        cards_scroll.setObjectName("cards_area")

        self._cards_layout = QGridLayout(cards_container)
        self._cards_layout.setSpacing(12)
        self._cards_layout.setContentsMargins(16, 16, 16, 16)

        self._populate_cards()
        splitter.addWidget(cards_scroll)

        project_ids = [p["id"] for p in self._config.projects]
        project_names = {p["id"]: p["name"] for p in self._config.projects}
        self._log_panel = LogPanel(project_ids, project_names)
        splitter.addWidget(self._log_panel)

        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 3)

        main_layout.addWidget(splitter, 1)

    def _populate_cards(self):
        while self._cards_layout.count():
            item = self._cards_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self._cards.clear()

        projects = self._config.projects
        cols = max(1, min(4, len(projects)))

        for i, proj in enumerate(projects):
            card = ProjectCard(proj)
            card.start_clicked.connect(self._on_start)
            card.stop_clicked.connect(self._on_stop)
            card.restart_clicked.connect(self._on_restart)
            card.folder_clicked.connect(self._on_open_folder)
            card.build_clicked.connect(self._on_build)
            card.cancel_build_clicked.connect(self._on_cancel_build)
            self._cards[proj["id"]] = card
            self._cards_layout.addWidget(card, i // cols, i % cols)

    def _connect_signals(self):
        self._btn_start_all.clicked.connect(self._start_all)
        self._btn_stop_all.clicked.connect(self._stop_all)
        self._btn_build_all.clicked.connect(self._build_all)
        self._btn_preset_run.clicked.connect(self._run_preset)
        self._btn_settings.clicked.connect(self._open_settings)

        self._process_mgr.status_changed.connect(self._on_status_changed)
        self._process_mgr.log_output.connect(self._log_panel.append_log)
        self._process_mgr.build_status_changed.connect(self._on_build_status_changed)
        self._process_mgr.build_log_output.connect(self._log_panel.append_log)

    @Slot(str)
    def _on_start(self, project_id: str):
        proj = self._config.get_project(project_id)
        if proj:
            self._log_panel.activate_tab(project_id)
            self._process_mgr.start_project(proj)

    @Slot(str)
    def _on_stop(self, project_id: str):
        self._process_mgr.stop_project(project_id)

    @Slot(str)
    def _on_restart(self, project_id: str):
        proj = self._config.get_project(project_id)
        if proj:
            self._log_panel.activate_tab(project_id)
            self._process_mgr.stop_project(project_id)
            QTimer.singleShot(800, lambda: self._process_mgr.start_project(proj))

    @Slot(str)
    def _on_open_folder(self, project_id: str):
        proj = self._config.get_project(project_id)
        if proj and os.path.isdir(proj["directory"]):
            os.startfile(proj["directory"])

    @Slot(str)
    def _on_build(self, project_id: str):
        proj = self._config.get_project(project_id)
        if proj:
            self._log_panel.activate_tab(project_id)
            self._process_mgr.build_project(proj)

    @Slot(str)
    def _on_cancel_build(self, project_id: str):
        self._process_mgr.cancel_build(project_id)

    @Slot(str, str)
    def _on_status_changed(self, project_id: str, status: str):
        card = self._cards.get(project_id)
        if card:
            card.set_status(status)

    @Slot(str, str)
    def _on_build_status_changed(self, project_id: str, status: str):
        card = self._cards.get(project_id)
        if card:
            card.set_build_status(status)

    def _start_all(self):
        ids = [p["id"] for p in self._config.projects if p.get("commands")]
        sorted_ids = self._config.topo_sort(ids)
        for pid in sorted_ids:
            proj = self._config.get_project(pid)
            if proj and not self._process_mgr.is_running(pid):
                self._process_mgr.start_project(proj)

    def _stop_all(self):
        self._process_mgr.stop_all()

    def _build_all(self):
        ids = [p["id"] for p in self._config.projects if p.get("build_commands")]
        sorted_ids = self._config.topo_sort(ids)
        for pid in sorted_ids:
            proj = self._config.get_project(pid)
            if proj and not self._process_mgr.is_building(pid):
                self._process_mgr.build_project(proj)

    def _run_preset(self):
        name = self._preset_combo.currentText()
        preset_ids = self._config.presets.get(name)
        if not preset_ids:
            return
        sorted_ids = self._config.topo_sort(preset_ids)
        for pid in sorted_ids:
            proj = self._config.get_project(pid)
            if proj and not self._process_mgr.is_running(pid):
                self._process_mgr.start_project(proj)

    def _open_settings(self):
        dlg = ConfigDialog(self._config, self)
        dlg.config_saved.connect(self._reload_ui)
        dlg.exec()

    def _reload_ui(self):
        self._populate_cards()
        self._log_panel.append_log(
            self._config.projects[0]["id"] if self._config.projects else "",
            "[INFO] 配置已更新，部分更改需重启启动器生效",
        )

    def _quit(self):
        self._process_mgr.stop_all()
        self._save_window_state()
        QApplication.instance().quit()

    def _save_window_state(self):
        geo = self.geometry()
        self._config.window_config = {
            "width": geo.width(),
            "height": geo.height(),
            "x": geo.x(),
            "y": geo.y(),
        }

    def closeEvent(self, event: QCloseEvent):
        self._quit()
        event.accept()
