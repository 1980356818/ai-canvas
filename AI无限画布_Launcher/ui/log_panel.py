from PySide6.QtCore import Qt, Slot
from PySide6.QtGui import QTextCharFormat, QColor, QFont
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

MAX_LOG_LINES = 5000

LOG_COLORS = {
    "ERROR": "#e74c3c",
    "WARN": "#e67e22",
    "INFO": "#a78bfa",
    "DEBUG": "#888",
}


class LogView(QPlainTextEdit):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("log_view")
        self.setReadOnly(True)
        self.setMaximumBlockCount(MAX_LOG_LINES)
        self.setFont(QFont("Cascadia Code", 11))
        self._auto_scroll = True

    def append_line(self, text: str):
        fmt = QTextCharFormat()
        for keyword, color in LOG_COLORS.items():
            if keyword in text[:80]:
                fmt.setForeground(QColor(color))
                break
        else:
            fmt.setForeground(QColor("#c8c8c8"))

        cursor = self.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        cursor.insertText(text + "\n", fmt)

        if self._auto_scroll:
            scrollbar = self.verticalScrollBar()
            scrollbar.setValue(scrollbar.maximum())


class LogPanel(QWidget):
    def __init__(self, project_ids: list[str], project_names: dict[str, str], parent=None):
        super().__init__(parent)
        self.setObjectName("log_panel")
        self._views: dict[str, LogView] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._tabs = QTabWidget()
        layout.addWidget(self._tabs)

        for pid in project_ids:
            view = LogView()
            self._views[pid] = view

            tab_widget = QWidget()
            tab_layout = QVBoxLayout(tab_widget)
            tab_layout.setContentsMargins(0, 0, 0, 0)
            tab_layout.setSpacing(0)

            toolbar = QHBoxLayout()
            toolbar.setContentsMargins(8, 4, 8, 4)

            search_input = QLineEdit()
            search_input.setObjectName("log_search")
            search_input.setPlaceholderText("搜索日志...")
            search_input.setClearButtonEnabled(True)
            search_input.textChanged.connect(lambda t, v=view: self._highlight_search(v, t))
            toolbar.addWidget(search_input)

            btn_clear = QPushButton("清空")
            btn_clear.setObjectName("btn_folder")
            btn_clear.setFixedWidth(60)
            btn_clear.clicked.connect(view.clear)
            toolbar.addWidget(btn_clear)

            btn_scroll = QPushButton("自动滚动: 开")
            btn_scroll.setObjectName("btn_folder")
            btn_scroll.setFixedWidth(100)

            def toggle_scroll(checked, v=view, b=btn_scroll):
                v._auto_scroll = not v._auto_scroll
                b.setText(f"自动滚动: {'开' if v._auto_scroll else '关'}")

            btn_scroll.clicked.connect(toggle_scroll)
            toolbar.addWidget(btn_scroll)

            tab_layout.addLayout(toolbar)
            tab_layout.addWidget(view)

            name = project_names.get(pid, pid)
            self._tabs.addTab(tab_widget, name)

    @Slot(str, str)
    def append_log(self, project_id: str, text: str):
        view = self._views.get(project_id)
        if view:
            view.append_line(text)

    def activate_tab(self, project_id: str):
        ids = list(self._views.keys())
        if project_id in ids:
            self._tabs.setCurrentIndex(ids.index(project_id))

    @staticmethod
    def _highlight_search(view: LogView, text: str):
        cursor = view.textCursor()
        fmt_normal = QTextCharFormat()
        fmt_normal.setBackground(QColor("transparent"))
        cursor.select(cursor.SelectionType.Document)
        cursor.setCharFormat(fmt_normal)

        if not text:
            return

        fmt_highlight = QTextCharFormat()
        fmt_highlight.setBackground(QColor("#7c3aed"))
        fmt_highlight.setForeground(QColor("#fff"))

        document = view.document()
        cursor = document.find(text)
        while not cursor.isNull():
            cursor.mergeCharFormat(fmt_highlight)
            cursor = document.find(text, cursor)
